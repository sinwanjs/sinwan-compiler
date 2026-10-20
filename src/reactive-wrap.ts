/**
 * SinwanJS Compiler — Reactive JSX Expression Wrapping
 *
 * Wraps JSX expressions that read reactive values in zero-arity arrow
 * functions so the runtime renderer can create an effect and update the DOM
 * when the value changes.
 *
 * Supported reactive sources:
 *   - `createMutable` / `createStore` from `sinway`
 *   - `signal` / `computed` from `sinwan/reactivity`
 *   - `useState` from `sinwan/react`
 *   - `.value` reads of signals returned from other modules (`useTheme`,
 *     `inject`, custom hooks) even when those identifiers were not created
 *     by a local `signal()` call
 *   - zero-arity getter calls returned from hooks (`counter()`, `api.count()`)
 *     the same way local `useState` getters (`count()`) are wrapped
 *
 * Example:
 *   <p>{state.name}</p>        → <p>{() => state.name}</p>
 *   <p>{count.value}</p>        → <p>{() => count.value}</p>
 *   <p>{getCount()}</p>         → <p>{() => getCount()}</p>
 */

import * as t from "./ast/types";
import {
  traverse,
  singlePath,
  type Binding as AstBinding,
  type NodePath,
  type TraverseOptions,
} from "./ast/traverse";
import * as path from "path";
import { parse } from "./ast/parse";
import * as fs from "fs";

import { loadMetadata } from "./analyze";

// ─── Reactive source import tracking ───────────────────────

export interface ImportNames {
  createMutable: Set<string>;
  createStore: Set<string>;
  signal: Set<string>;
  computed: Set<string>;
  useState: Set<string>;
  useFetch: Set<string>;
  cc: Set<string>;
}

const REACTIVE_SOURCE_MODULES: Record<string, Set<string>> = {
  sinway: new Set(["createMutable", "createStore"]),
  "sinwan/reactivity": new Set(["signal", "computed"]),
  "sinwan/react": new Set(["useState"]),
  "sinwan/hook": new Set(["useFetch"]),
};

function addImportLocal(
  names: ImportNames,
  imported: string,
  local: string,
): void {
  switch (imported) {
    case "createMutable":
    case "createStore":
    case "signal":
    case "computed":
    case "useState":
    case "useFetch":
    case "cc":
      names[imported].add(local);
      break;
  }
}

const COMPONENT_FACTORY_MODULES: Record<string, Set<string>> = {
  sinwan: new Set(["cc"]),
  "sinwan/component": new Set(["cc"]),
};

// ─── Built-in component reactive prop registry ─────────────

interface BuiltinComponentEntry {
  readonly reactiveProps: ReadonlySet<string>;
}

const BUILTIN_REACTIVE_PROPS: ReadonlyMap<string, BuiltinComponentEntry> =
  new Map([
    ["For", { reactiveProps: new Set(["each"]) }],
    ["Show", { reactiveProps: new Set(["when"]) }],
    ["Switch", { reactiveProps: new Set(["when"]) }],
    ["Match", { reactiveProps: new Set(["when"]) }],
    ["Index", { reactiveProps: new Set(["each"]) }],
    ["Key", { reactiveProps: new Set(["when"]) }],
    ["Dynamic", { reactiveProps: new Set(["component"]) }],
    ["Visible", { reactiveProps: new Set(["when", "style"]) }],
    ["Portal", { reactiveProps: new Set(["mount"]) }],
    ["Virtual", { reactiveProps: new Set(["each"]) }],
    ["Activity", { reactiveProps: new Set(["mode"]) }],
  ]);

function isBuiltinReactiveProp(
  componentName: string,
  attrName: string,
): boolean {
  const entry = BUILTIN_REACTIVE_PROPS.get(componentName);
  if (!entry) return false;
  return entry.reactiveProps.has(attrName);
}

/**
 * True when the expression is only passing a reactive container through
 * (`count`, `user`, `state`) rather than reading it (`count.value`,
 * `checked.value ? "On" : "Off"`). Those objects must stay unwrapped so the
 * child can subscribe itself; wrapping would turn a live proxy/signal into a
 * getter of the same object.
 */
function isReactiveContainerPassThrough(
  expr: t.Expression,
  scope: ReactiveScope,
): boolean {
  let node: t.Node = t.unwrapParens(expr);
  while (t.isTSNonNullExpression(node)) {
    node = node.expression;
  }
  if (!t.isIdentifier(node)) return false;
  const binding = scope.bindings.get(node.name);
  if (!binding) return false;
  return binding.kind === "mutable" || binding.kind === "prop";
}

export function trackReactiveImports(ast: t.Node): ImportNames {
  const names: ImportNames = {
    createMutable: new Set(),
    createStore: new Set(),
    signal: new Set(),
    computed: new Set(),
    useState: new Set(),
    useFetch: new Set(),
    cc: new Set(),
  };

  traverse(ast, {
    ImportDeclaration(path: any) {
      const source = t.moduleSourceValue(path.node.source);
      if (!source) return;
      const reactiveAllowed = REACTIVE_SOURCE_MODULES[source];
      const componentAllowed = COMPONENT_FACTORY_MODULES[source];
      if (!reactiveAllowed && !componentAllowed) return;

      for (const spec of path.node.specifiers ?? []) {
        if (!t.isImportSpecifier(spec)) continue;
        const imported = t.importedBindingName(spec.imported);
        if (imported && reactiveAllowed?.has(imported)) {
          addImportLocal(names, imported, spec.local.name);
        } else if (imported && componentAllowed?.has(imported)) {
          names.cc.add(spec.local.name);
        }
      }
    },
  });

  return names;
}

// ─── @sinwan-pure JSDoc import detection ─────────────────

/**
 * Kind of a pure export, determining how it can be called:
 * - "function": direct call `cn(...)` — `export function cn()` or `export const cn = () =>`
 * - "class": member call `Utils.merge(...)` — `export class Utils { static merge() }`
 * - "object": member call `helpers.merge(...)` — `export const helpers = { merge: () => }`
 */
type PureExportKind = "function" | "class" | "object";

/**
 * Pure import info collected for the current file.
 * - `direct`: local names of pure imported functions (named or default)
 *   → `cn(...)` is a pure call
 * - `namespace`: namespace local name → set of pure member names
 *   → `ns.cn(...)` is a pure call when `cn` is in the set
 * - `member`: local names of pure imported classes/objects
 *   → `Utils.merge(...)` or `helpers.merge(...)` is a pure call (any member)
 */
interface PureImports {
  direct: Set<string>;
  namespace: Map<string, Set<string>>;
  member: Set<string>;
}

const pureImportCache = new Map<string, Map<string, PureExportKind>>();
const PURE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
];

function tryResolveFile(base: string): string | null {
  // If the path already has a recognized extension, check it directly.
  if (PURE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
    try {
      if (fs.existsSync(base)) return base;
    } catch {}
    return null;
  }
  for (const ext of PURE_EXTENSIONS) {
    try {
      if (fs.existsSync(base + ext)) return base + ext;
    } catch {}
  }
  return null;
}

function tryResolveIndex(dir: string): string | null {
  for (const ext of PURE_EXTENSIONS) {
    try {
      const candidate = path.join(dir, "index") + ext;
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Resolve a relative import (`./foo`, `../bar`) to a file path.
 * Tries the exact path with extensions, then `index` in the directory.
 */
function tryResolveRelative(source: string, fromFile: string): string | null {
  const base = path.resolve(path.dirname(fromFile), source);
  return tryResolveFile(base) ?? tryResolveIndex(base);
}

/**
 * Resolve a bare specifier (`clsx`, `sinwan/reactivity`, `@scope/pkg`)
 * by walking up the directory tree looking for `node_modules/<pkg>`.
 * Reads `package.json` to find the entry point (`exports`, `module`,
 * `main`, `source`). Handles subpath exports (`pkg/sub`).
 */
function tryResolveBare(source: string, fromFile: string): string | null {
  const parts = source.split("/");
  const pkgName = source.startsWith("@")
    ? `${parts[0]}/${parts[1]}`
    : parts[0]!;
  const subpath = parts.slice(source.startsWith("@") ? 2 : 1).join("/");

  let dir = path.dirname(fromFile);
  for (let i = 0; i < 30; i++) {
    const nodeModules = path.join(dir, "node_modules", pkgName);
    if (fs.existsSync(nodeModules)) {
      return resolvePackageEntry(nodeModules, subpath);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a package entry point from its directory.
 * Reads `package.json` and checks `exports`, `module`, `main`, `source`
 * fields. For subpath exports, matches the `./subpath` key.
 * Falls back to `src/` or `dist/` directories for source resolution.
 */
function resolvePackageEntry(pkgDir: string, subpath: string): string | null {
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"),
    );
  } catch {
    return null;
  }

  // Try exports field — handles both subpath ("./sub") and main (".") keys,
  // including conditional exports ({ import: "...", default: "..." }).
  if (typeof pkgJson.exports === "object" && pkgJson.exports) {
    const exports = pkgJson.exports as Record<
      string,
      string | Record<string, string>
    >;
    const exportKey = subpath ? `./${subpath}` : ".";
    const entry = exports[exportKey];
    if (typeof entry === "string") {
      const resolved = tryResolveFile(path.resolve(pkgDir, entry));
      if (resolved) return resolved;
    } else if (entry && typeof entry === "object") {
      // Conditional exports: { ".": { import: "./index.mjs", default: "./index.js" } }
      for (const condValue of Object.values(entry)) {
        if (typeof condValue === "string") {
          const resolved = tryResolveFile(path.resolve(pkgDir, condValue));
          if (resolved) return resolved;
        }
      }
    }
  }

  // Try main exports for bare package name (no subpath)
  if (!subpath) {
    for (const field of ["source", "module", "main", "types"]) {
      const entry = pkgJson[field];
      if (typeof entry === "string") {
        const resolved = tryResolveFile(path.resolve(pkgDir, entry));
        if (resolved) return resolved;
      }
    }
    // Try root index
    const indexResolved = tryResolveIndex(pkgDir);
    if (indexResolved) return indexResolved;
  }

  // Try common source directories for subpath or fallback
  if (subpath) {
    for (const srcDir of ["src", "dist", "."]) {
      const base = path.join(pkgDir, srcDir, subpath);
      const resolved = tryResolveFile(base) ?? tryResolveIndex(base);
      if (resolved) return resolved;
    }
  }

  return null;
}

/**
 * Resolve any import — relative or bare specifier — to a file path.
 * Uses `resolveImport` callback if provided (by plugins), otherwise
 * falls back to direct filesystem resolution.
 */
function resolveAnyImport(
  source: string,
  fromFile: string,
  resolveImport:
    | ((source: string, fromFile: string) => string | null)
    | undefined,
): string | null {
  if (resolveImport) {
    try {
      const resolved = resolveImport(source, fromFile);
      if (resolved) return resolved;
    } catch {}
  }
  if (source.startsWith(".")) {
    return tryResolveRelative(source, fromFile);
  }
  return tryResolveBare(source, fromFile);
}

/**
 * Scan a file for exported declarations annotated with @sinwan-pure JSDoc.
 * Also follows re-exports: if `export { cn } from "./utils"` is found, the
 * compiler resolves `./utils` and scans it recursively. This handles barrel
 * files (`index.ts` re-exports from `utils.ts`).
 *
 * `resolveImport` is threaded through for re-export resolution. Without it,
 * the compiler falls back to direct filesystem resolution.
 *
 * `depth` limits recursion to prevent infinite loops on circular re-exports.
 */
function scanPureExports(
  filePath: string,
  resolveImport?:
    | ((source: string, fromFile: string) => string | null)
    | undefined,
  depth = 0,
): Map<string, PureExportKind> {
  const pure = new Map<string, PureExportKind>();
  if (depth > 10) return pure; // prevent infinite re-export cycles
  let code: string;
  try {
    code = fs.readFileSync(filePath, "utf-8");
  } catch {
    return pure;
  }
  let ast: t.Node;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      sourceFilename: filePath,
    });
  } catch {
    return pure;
  }
  const hasPureJSDoc = (node: any): boolean =>
    node?.leadingComments?.some(
      (c: any) => c.type === "CommentBlock" && c.value.includes("@sinwan-pure"),
    ) ?? false;

  traverse(ast, {
    ExportNamedDeclaration(p: any) {
      // Case 1: Direct declaration with @sinwan-pure JSDoc
      //   /** @sinwan-pure */ export function cn(...) {}   → "function"
      //   /** @sinwan-pure */ export const merge = () =>   → "function"
      //   /** @sinwan-pure */ export const helpers = { ... } → "object"
      //   /** @sinwan-pure */ export class Utils { ... }    → "class"
      if (hasPureJSDoc(p.node)) {
        const decl = p.node.declaration;
        if (t.isFunctionDeclaration(decl) && t.isIdentifier(decl.id)) {
          pure.set(decl.id.name, "function");
        } else if (t.isClassDeclaration(decl) && t.isIdentifier(decl.id)) {
          pure.set(decl.id.name, "class");
        } else if (t.isVariableDeclaration(decl)) {
          for (const d of decl.declarations) {
            if (!t.isIdentifier(d.id)) continue;
            const init = d.init;
            if (t.isObjectExpression(init)) {
              pure.set(d.id.name, "object");
            } else {
              // Arrow function, function expression, or other — treat as function
              pure.set(d.id.name, "function");
            }
          }
        }
      }

      // Case 2: Re-export from another module
      //   export { cn } from "./utils";
      //   export { cn as merge } from "./utils";
      //   export { default } from "./utils";
      //   export { default as merge } from "./utils";
      // The compiler resolves the source and scans it recursively.
      const source = t.moduleSourceValue(p.node.source);
      if (source && p.node.specifiers) {
        const resolved = resolveAnyImport(source, filePath, resolveImport);
        if (resolved) {
          let reExportPure = pureImportCache.get(resolved);
          if (!reExportPure) {
            reExportPure = scanPureExports(resolved, resolveImport, depth + 1);
            pureImportCache.set(resolved, reExportPure);
          }
          for (const spec of p.node.specifiers ?? []) {
            if (!t.isExportSpecifier(spec)) continue;
            const exported = t.isIdentifier(spec.exported)
              ? spec.exported.name
              : spec.exported.value;
            const original = spec.local.name;
            const kind = reExportPure.get(original);
            if (kind) {
              pure.set(exported, kind);
            }
          }
        }
      }
    },
    ExportDefaultDeclaration(p: any) {
      // Case 3: Default export with @sinwan-pure JSDoc
      //   /** @sinwan-pure */ export default function helper() {}  → "default" → "function"
      //   /** @sinwan-pure */ export default () => {}              → "default" → "function"
      //   /** @sinwan-pure */ export default class {}              → "default" → "class"
      if (!hasPureJSDoc(p.node)) return;
      const decl = p.node.declaration;
      if (
        t.isFunctionDeclaration(decl) ||
        t.isArrowFunctionExpression(decl) ||
        t.isFunctionExpression(decl)
      ) {
        pure.set("default", "function");
      } else if (t.isClassDeclaration(decl)) {
        pure.set("default", "class");
      }
    },
    ExportAllDeclaration(p: any) {
      // export * from "./utils"
      // Re-exports ALL named exports from the source module.
      // Resolve the source and add all its pure exports to this file.
      const source = t.moduleSourceValue(p.node.source);
      if (!source) return;
      const resolved = resolveAnyImport(source, filePath, resolveImport);
      if (!resolved) return;
      let reExportPure = pureImportCache.get(resolved);
      if (!reExportPure) {
        reExportPure = scanPureExports(resolved, resolveImport, depth + 1);
        pureImportCache.set(resolved, reExportPure);
      }
      for (const [name, kind] of reExportPure) {
        if (name !== "default") {
          pure.set(name, kind);
        }
      }
    },
  });
  return pure;
}

function collectPureImports(
  ast: t.Node,
  filename: string | undefined,
  resolveImport:
    | ((source: string, fromFile: string) => string | null)
    | undefined,
): PureImports {
  const result: PureImports = {
    direct: new Set(),
    namespace: new Map(),
    member: new Set(),
  };
  if (!filename) return result;
  const absoluteFilename = path.resolve(filename);
  traverse(ast, {
    ImportDeclaration(p) {
      const source = t.moduleSourceValue(p.node.source);
      if (!source) return;
      // Skip type-only imports — they don't produce runtime calls.
      if (p.node.importKind === "type") return;
      const resolved = resolveAnyImport(
        source,
        absoluteFilename,
        resolveImport,
      );
      if (!resolved) return;
      let filePure = pureImportCache.get(resolved);
      if (!filePure) {
        filePure = scanPureExports(resolved, resolveImport);
        pureImportCache.set(resolved, filePure);
      }
      for (const spec of p.node.specifiers ?? []) {
        if (t.isImportSpecifier(spec)) {
          // Named import: import { cn } from "./utils"
          // or aliased: import { cn as merge } from "./utils"
          const imported = t.importedBindingName(spec.imported);
          if (!imported) continue;
          const kind = filePure.get(imported);
          if (!kind) continue;
          if (kind === "function") {
            result.direct.add(spec.local.name);
          } else {
            // class or object — member call: Utils.merge(...)
            result.member.add(spec.local.name);
          }
        } else if (t.isImportDefaultSpecifier(spec)) {
          // Default import: import helper from "./utils"
          const kind = filePure.get("default");
          if (!kind) continue;
          if (kind === "function") {
            result.direct.add(spec.local.name);
          } else {
            // class or object — member call: helper.merge(...)
            result.member.add(spec.local.name);
          }
        } else if (t.isImportNamespaceSpecifier(spec)) {
          // Namespace import: import * as ns from "./utils"
          // Any pure export is accessible as ns.cn(...)
          const pureMembers = new Set<string>();
          for (const [name, kind] of filePure) {
            if (name === "default") continue; // default not accessible via namespace
            if (kind === "function") {
              pureMembers.add(name);
            } else {
              // class or object — ns.Utils.merge(...) is a nested member call.
              // Track the class/object name so ns.Utils is recognized as pure.
              pureMembers.add(name);
            }
          }
          if (pureMembers.size > 0) {
            result.namespace.set(spec.local.name, pureMembers);
          }
        }
      }
    },
  });
  return result;
}

type BindingKind = "mutable" | "signal" | "computed" | "getter" | "function";

export interface MutableBinding {
  kind: "mutable";
  root: string;
  path: string[];
}

export interface SignalBinding {
  kind: "signal";
}

export interface ComputedBinding {
  kind: "computed";
}

export interface GetterBinding {
  kind: "getter";
}

/** Local helper that is not a useState-style getter. `{greet()}` stays eager. */
export interface FunctionBinding {
  kind: "function";
}

/**
 * Binding for a variable holding the object returned by `useFetch()` /
 * `createFetch()(...)`. Every property on that object is a `Signal` or
 * `Computed`, so a read like `f.data.value` (path `["data", "value"]`) is
 * reactive. The shell object itself (`f`) and a bare property (`f.data`, the
 * signal object) are NOT reactive reads — the runtime `resolve()` unwraps them
 * inside effects when forwarded to control-flow props such as `<Show when>`.
 */
export interface SignalObjectBinding {
  kind: "signalObject";
}

export interface PropBinding {
  kind: "prop";
}

export type Binding =
  | MutableBinding
  | SignalBinding
  | ComputedBinding
  | GetterBinding
  | FunctionBinding
  | SignalObjectBinding
  | PropBinding;

export interface ReactiveScope {
  bindings: Map<string, Binding>;
}

function isReactiveSourceCall(
  expr: t.Expression,
  names: ImportNames,
): { kind: BindingKind; isArray: boolean } | null {
  if (!t.isCallExpression(expr)) return null;
  const callee = expr.callee;
  if (!t.isIdentifier(callee)) return null;

  if (names.createMutable.has(callee.name)) {
    return { kind: "mutable", isArray: false };
  }
  if (names.createStore.has(callee.name)) {
    return { kind: "mutable", isArray: true };
  }
  if (names.signal.has(callee.name)) {
    return { kind: "signal", isArray: false };
  }
  if (names.computed.has(callee.name)) {
    return { kind: "computed", isArray: false };
  }
  if (names.useState.has(callee.name)) {
    return { kind: "getter", isArray: true };
  }
  return null;
}

/**
 * Methods on the `useFetch` shell that return another shell (so the result is
 * still a signal-bearing object). Used to recognize chained calls such as
 * `useFetch(url).json()` and `useFetch(url).get(payload)` as useFetch calls.
 */
const USEFETCH_CHAIN_METHODS = new Set([
  "json",
  "text",
  "blob",
  "arrayBuffer",
  "formData",
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
]);

/**
 * True if `expr` is a call that produces a `useFetch` shell — either a direct
 * `useFetch(...)` call or a chained `useFetch(...).<method>(...)` where
 * `<method>` is one of the shell-returning methods (json/text/get/...).
 */
function isUseFetchCall(expr: t.Expression, names: ImportNames): boolean {
  if (!t.isCallExpression(expr)) return false;
  const callee = expr.callee;
  if (t.isIdentifier(callee)) {
    return names.useFetch.has(callee.name);
  }
  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property) &&
    USEFETCH_CHAIN_METHODS.has(callee.property.name)
  ) {
    return isUseFetchCall(callee.object as t.Expression, names);
  }
  return false;
}

function trackLocalScopeBindings(
  path: NodePath,
  names: ImportNames,
  scope: ReactiveScope,
  shallow = false,
): void {
  const collect = (visitors: TraverseOptions): void => {
    path.traverse(
      shallow
        ? {
            ...visitors,
            Function(p) {
              p.skip();
            },
          }
        : visitors,
    );
  };
  // First pass: collect reactive source bindings (signals, mutables, getters).
  collect({
    VariableDeclarator(p: any) {
      const id = p.node.id as t.Node;
      const init = p.node.init as t.Expression | undefined | null;
      if (!init) return;

      if (
        t.isIdentifier(id) &&
        t.isCallExpression(init) &&
        t.isIdentifier(init.callee) &&
        (init.callee.name === "_$createLiveRest" ||
          init.callee.name === "createLiveRest")
      ) {
        scope.bindings.set(id.name, { kind: "prop" });
        return;
      }

      const source = isReactiveSourceCall(init, names);
      if (source) {
        if (source.isArray) {
          if (t.isArrayPattern(id) && id.elements[0]) {
            const first = id.elements[0];
            if (t.isIdentifier(first)) {
              scope.bindings.set(first.name, { kind: source.kind } as Binding);
            }
          }
          return;
        }

        if (t.isIdentifier(id)) {
          if (source.kind === "mutable") {
            scope.bindings.set(id.name, {
              kind: "mutable",
              root: id.name,
              path: [],
            });
          } else {
            scope.bindings.set(id.name, { kind: source.kind } as Binding);
          }
        }
        return;
      }

      // useFetch() / createFetch()(...) return an object whose properties are
      // Signals/Computeds. Destructured properties become signal bindings; the
      // whole object becomes a signalObject binding (property accesses like
      // `f.data.value` are reactive).
      if (isUseFetchCall(init, names)) {
        if (t.isObjectPattern(id)) {
          for (const prop of id.properties) {
            if (
              t.isObjectProperty(prop) &&
              !prop.computed &&
              t.isIdentifier(prop.value)
            ) {
              scope.bindings.set(prop.value.name, {
                kind: "signal",
              } as Binding);
            }
          }
        } else if (t.isIdentifier(id)) {
          scope.bindings.set(id.name, { kind: "signalObject" } as Binding);
        }
        return;
      }
    },
  });

  // Second pass: collect destructured bindings that derive from tracked mutable
  // objects. These behave the same as direct property reads on the root.
  collect({
    VariableDeclarator(p: any) {
      const id = p.node.id as t.Node;
      const init = p.node.init as t.Expression | undefined | null;
      if (!init || !t.isIdentifier(init)) return;

      const initBinding = scope.bindings.get(init.name);
      if (!initBinding || initBinding.kind !== "mutable") return;

      if (t.isObjectPattern(id)) {
        for (const prop of id.properties) {
          if (!t.isObjectProperty(prop)) continue;
          const key = prop.key;
          const value = prop.value;
          if (!t.isIdentifier(key) || !t.isIdentifier(value)) continue;
          scope.bindings.set(value.name, {
            kind: "mutable",
            root: initBinding.root,
            path: [...initBinding.path, key.name],
          });
        }
      }
    },
  });

  // Third pass: collect local functions/arrow functions whose body contains
  // reactive reads. Calls to these functions in JSX should be wrapped too.
  collect({
    "FunctionDeclaration|VariableDeclarator"(p: any) {
      const node = p.node as t.FunctionDeclaration | t.VariableDeclarator;
      let fn: t.Function | null = null;
      let name: string | null = null;

      if (t.isFunctionDeclaration(node)) {
        fn = node;
        name = t.isIdentifier(node.id) ? node.id.name : null;
      } else if (t.isVariableDeclarator(node)) {
        const init = node.init;
        if (
          init &&
          (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init))
        ) {
          fn = init;
        }
        if (t.isIdentifier(node.id)) {
          name = node.id.name;
        }
      }

      if (!fn || !name || scope.bindings.has(name)) return;

      const body = fn.body;
      if (body && containsReactiveRead(body as t.Expression, scope)) {
        scope.bindings.set(name, { kind: "getter" });
      } else {
        scope.bindings.set(name, { kind: "function" });
      }
    },
  });
}

function trackPropBindings(
  scope: ReactiveScope,
  params: t.Node | undefined,
  reactiveProps: Set<string>,
): void {
  if (!params || reactiveProps.size === 0) return;
  if (t.isIdentifier(params)) {
    scope.bindings.set(params.name, { kind: "prop" });
  } else if (t.isObjectPattern(params)) {
    for (const prop of params.properties) {
      if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
        const key = prop.key;
        if (t.isIdentifier(key) && reactiveProps.has(key.name)) {
          scope.bindings.set(prop.value.name, { kind: "prop" });
        }
      }
    }
  }
}

export function getAllPropNames(params: t.Node | undefined): Set<string> {
  if (!params) return new Set();
  if (t.isIdentifier(params)) return new Set(["*"]);
  if (t.isObjectPattern(params)) {
    const names = new Set<string>();
    for (const prop of params.properties) {
      if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
        names.add(prop.key.name);
      }
    }
    // Components may also receive children; include it in fallback sets so
    // exported components conservatively treat children as reactive too.
    names.add("children");
    return names;
  }
  return new Set();
}

export function resolveLocalObjectLiteral(
  fn: t.Function,
  name: string,
): t.ObjectExpression | null {
  const body = fn.body;
  if (!t.isBlockStatement(body)) return null;
  for (const stmt of body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || decl.id.name !== name) continue;
      const init = decl.init;
      if (!t.isObjectExpression(init)) continue;
      return init;
    }
  }
  return null;
}

function analyzeObjectLiteralSpread(
  spread: t.ObjectExpression,
  fullScope: ReactiveScope,
  calleeReactive: Set<string>,
): void {
  for (const prop of spread.properties) {
    if (t.isObjectProperty(prop) && !prop.computed) {
      const key = prop.key;
      const name = t.isIdentifier(key)
        ? key.name
        : t.isStringLiteral(key)
          ? key.value
          : null;
      if (
        name &&
        containsReactiveValue(prop.value as t.Expression, fullScope)
      ) {
        calleeReactive.add(name);
      }
    }
  }
}

// ─── Detect reactive reads inside an expression ────────────

/** True for `a.b`, optional `a?.b`, and ChainExpression wrapping them. */
function isMemberLike(node: any): boolean {
  if (t.isChainExpression(node)) return isMemberLike(t.unwrapChain(node));
  return t.isMemberExpression(node);
}

function isFunctionLike(
  node: t.Node,
): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return t.isArrowFunctionExpression(node) || t.isFunctionExpression(node);
}

function isCallLike(node: t.Node): boolean {
  const inner = t.unwrapCall(node);
  return t.isCallExpression(inner);
}

const COMPILER_BINDING_CALLEES = new Set([
  "_$bindText",
  "_$bindAttr",
  "_$bindStyle",
  "_$bindClass",
  "_$unwrap",
]);

/**
 * `_$bindText(() => expr)` and friends are already lazy. Entering their
 * getter arguments would re-wrap the same JSX container forever.
 */
function isCompilerBindingCall(
  node: t.CallExpression | t.OptionalCallExpression | t.Node,
): boolean {
  const call = t.unwrapCall(node);
  if (!t.isCallExpression(call)) return false;
  const callee = t.unwrapParens((call as { callee: t.Node }).callee);
  return t.isIdentifier(callee) && COMPILER_BINDING_CALLEES.has(callee.name);
}

/**
 * Call arguments and IIFE callees run while the outer JSX expression is
 * evaluated (`.map` / `.filter` callbacks, `fn(...spread)`). Render props and
 * returned handlers do not.
 */
function visitCallCalleeAndArgs(
  node: t.CallExpression | t.OptionalCallExpression | t.Node,
  visitExpr: (expr: t.Node, enterFunction: boolean) => void,
): void {
  const call = t.unwrapCall(node);
  if (!t.isCallExpression(call)) return;
  if (isCompilerBindingCall(call)) return;
  const callee = t.unwrapParens((call as { callee: t.Node }).callee);
  visitExpr(callee, true);
  for (const arg of (call as { arguments: t.Node[] }).arguments) {
    if (t.isSpreadElement(arg)) {
      visitExpr(arg.argument as t.Node, true);
      continue;
    }
    visitExpr(arg, true);
  }
}

/**
 * Sinwan signal reads use `.value` on the signal (`theme.value`) or on a
 * property of a signal-bearing object (`api.theme.value`). Used when the root
 * identifier was not created by a local `signal()` / `useFetch()` call.
 */
function isSignalValuePath(path: string[]): boolean {
  return path[0] === "value" || (path.length >= 2 && path[1] === "value");
}

/**
 * Walk a (possibly optional / non-null-asserted) member-expression chain to its
 * root identifier, returning the root name and the property path.
 *
 *   data?.value?.message          -> { root: "data", path: ["value", "message"] }
 *   user.data.value!.name         -> { root: "user", path: ["data", "value", "name"] }
 *   fetch.data.value               -> { root: "fetch", path: ["data", "value"] }
 *
 * `TSNonNullExpression` wrappers (`expr!`) are unwrapped. Computed member
 * access (`a[b]`) and non-identifier properties yield `null`.
 */
function getMemberExpressionRootAndPath(
  node: t.Node,
): { root: string; path: string[] } | null {
  const path: string[] = [];
  let current: t.Node = node;
  while (true) {
    current = t.unwrapParens(current);
    if (t.isTSNonNullExpression(current)) {
      current = current.expression as t.Node;
      continue;
    }
    if (t.isChainExpression(current)) {
      current = t.unwrapChain(current);
      continue;
    }
    if (isMemberLike(current)) {
      const member = t.isChainExpression(current)
        ? t.unwrapChain(current)
        : current;
      if ((member as { computed?: boolean }).computed) return null;
      const property = (member as { property: t.Node }).property;
      if (!t.isIdentifier(property)) return null;
      path.push(property.name);
      current = (member as { object: t.Node }).object;
      continue;
    }
    break;
  }
  if (t.isIdentifier(current)) {
    return { root: current.name, path: path.reverse() };
  }
  return null;
}

function isReactiveRead(node: t.Node, scope: ReactiveScope): boolean {
  if (t.isTSNonNullExpression(node)) {
    return isReactiveRead(node.expression as t.Node, scope);
  }
  if (t.isChainExpression(node)) {
    return isReactiveRead(t.unwrapChain(node), scope);
  }

  if (t.isIdentifier(node)) {
    const binding = scope.bindings.get(node.name);
    if (!binding) return false;
    // Treat destructured mutable property values and prop values as reactive reads.
    // The root mutable object itself is not wrapped so it can be passed around.
    if (binding.kind === "prop") {
      return true;
    }
    if (binding.kind === "mutable" && binding.path.length > 0) {
      return true;
    }
    return false;
  }

  if (!isMemberLike(node)) return false;
  const rootPath = getMemberExpressionRootAndPath(node);
  if (!rootPath) return false;
  const binding = scope.bindings.get(rootPath.root);
  if (!binding) {
    // Signals from inject / useTheme / other modules are not local `signal()`
    // bindings. `{theme.value}` and `{api.theme.value}` still need wrapping.
    return isSignalValuePath(rootPath.path);
  }

  // Prop reads (including nested member expressions like props.user.name) are reactive.
  if (binding.kind === "prop") {
    return true;
  }
  if (binding.kind === "mutable") {
    return true;
  }
  if (binding.kind === "signal" || binding.kind === "computed") {
    return rootPath.path[0] === "value";
  }
  // useFetch shell: `f.<prop>.value...` reads the underlying signal.
  // `f` alone or `f.<prop>` (the signal object) is not a reactive read — the
  // runtime resolve() unwraps it inside effects when forwarded to control flow.
  if (binding.kind === "signalObject") {
    return rootPath.path.length >= 2 && rootPath.path[1] === "value";
  }
  return false;
}

function isGetterCall(
  node: t.CallExpression | t.OptionalCallExpression | t.Node,
  scope: ReactiveScope,
): boolean {
  const call = t.unwrapCall(node);
  if (!t.isCallExpression(call)) return false;
  const callee = t.unwrapParens((call as { callee: t.Node }).callee);
  if (t.isIdentifier(callee)) {
    const binding = scope.bindings.get(callee.name);
    if (binding?.kind === "getter") return true;
    if (binding) return false;
    return (call as { arguments: unknown[] }).arguments.length === 0;
  }
  if (
    isMemberLike(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property)
  ) {
    if ((call as { arguments: unknown[] }).arguments.length !== 0) return false;
    const rootPath = getMemberExpressionRootAndPath(callee);
    if (!rootPath) return false;
    const binding = scope.bindings.get(rootPath.root);
    if (
      binding?.kind === "mutable" ||
      binding?.kind === "function" ||
      binding?.kind === "signal" ||
      binding?.kind === "computed" ||
      binding?.kind === "prop" ||
      binding?.kind === "getter" ||
      binding?.kind === "signalObject"
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export function isReactiveValue(node: t.Node, scope: ReactiveScope): boolean {
  if (t.isParenthesizedExpression(node)) {
    return isReactiveValue(t.unwrapParens(node), scope);
  }
  if (t.isTSNonNullExpression(node)) {
    return isReactiveValue(node.expression, scope);
  }
  if (t.isChainExpression(node)) {
    return isReactiveValue(t.unwrapChain(node), scope);
  }

  if (t.isIdentifier(node)) {
    const binding = scope.bindings.get(node.name);
    if (!binding) return false;
    return (
      binding.kind === "prop" ||
      binding.kind === "signal" ||
      binding.kind === "computed" ||
      binding.kind === "mutable"
    );
  }

  if (!isMemberLike(node)) return false;
  const rootPath = getMemberExpressionRootAndPath(node);
  if (!rootPath) return false;
  const binding = scope.bindings.get(rootPath.root);
  if (!binding) {
    return isSignalValuePath(rootPath.path);
  }

  if (binding.kind === "prop" || binding.kind === "mutable") {
    return true;
  }
  if (binding.kind === "signal" || binding.kind === "computed") {
    return rootPath.path[0] === "value";
  }
  if (binding.kind === "signalObject") {
    return rootPath.path.length >= 2 && rootPath.path[1] === "value";
  }
  return false;
}

export function containsReactiveValue(
  expr: t.Expression,
  scope: ReactiveScope,
): boolean {
  let found = false;

  function visit(node: any): void {
    if (found) return;
    if (!node || typeof node !== "object") return;

    if (node.type === "ParenthesizedExpression") {
      visit(node.expression);
      return;
    }

    if (t.isChainExpression(node)) {
      visit(t.unwrapChain(node));
      return;
    }

    if (
      isMemberLike(node) ||
      t.isTSNonNullExpression(node) ||
      t.isIdentifier(node)
    ) {
      if (isReactiveValue(node, scope)) {
        found = true;
        return;
      }
    }

    if (isCallLike(node) && isGetterCall(node, scope)) {
      found = true;
      return;
    }

    // Do not recurse into nested function bodies — those are separate scopes
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      return;
    }

    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const value = (node as any)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") visit(item);
        }
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }

  visit(expr);
  return found;
}

function containsReactiveRead(
  expr: t.Expression,
  scope: ReactiveScope,
): boolean {
  let found = false;

  function visit(node: any, enterFunction: boolean): void {
    if (found) return;
    if (!node || typeof node !== "object") return;

    if (node.type === "ParenthesizedExpression") {
      visit(node.expression, enterFunction);
      return;
    }

    if (t.isChainExpression(node)) {
      visit(t.unwrapChain(node), enterFunction);
      return;
    }

    if (isFunctionLike(node)) {
      if (!enterFunction) return;
      for (const param of node.params) {
        visit(param, false);
      }
      visit(node.body, false);
      return;
    }

    // Nested JSX has its own expression containers; wrapping the outer
    // `.map()` would remount that tree instead of updating the inner slots.
    if (t.isJSXElement(node) || t.isJSXFragment(node)) {
      return;
    }

    if (
      isMemberLike(node) ||
      t.isTSNonNullExpression(node) ||
      t.isIdentifier(node)
    ) {
      if (isReactiveRead(node, scope)) {
        found = true;
        return;
      }
    }

    if (isCallLike(node) && isGetterCall(node, scope)) {
      found = true;
      return;
    }

    if (isCallLike(node)) {
      visitCallCalleeAndArgs(node, visit);
      return;
    }

    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const value = (node as any)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") visit(item, false);
        }
      } else if (value && typeof value === "object") {
        visit(value, false);
      }
    }
  }

  visit(expr, false);
  return found;
}

// ─── Wrap JSX expressions ──────────────────────────────────

export interface ComponentExpressionInfo {
  isComponent: boolean;
  componentName: string | null;
  attributeName: string | null;
}

export function getComponentExpressionInfo(exprPath: {
  parentPath?: unknown;
}): ComponentExpressionInfo {
  const parent = exprPath.parentPath as
    | {
        isJSXAttribute?: () => boolean;
        isJSXElement?: () => boolean;
        node: t.Node & { name?: t.Node };
        parentPath?: { parentPath?: unknown };
      }
    | null
    | undefined;
  if (!parent) {
    return { isComponent: false, componentName: null, attributeName: null };
  }

  let elementPath: any = null;
  let attributeName: string | null = null;

  if (parent.isJSXAttribute && parent.isJSXAttribute()) {
    const attrName = parent.node.name;
    if (t.isJSXIdentifier(attrName)) {
      attributeName = attrName.name;
    }
    const openingElementPath = parent.parentPath;
    elementPath = openingElementPath?.parentPath;
  } else if (parent.isJSXElement && parent.isJSXElement()) {
    elementPath = parent;
  }

  if (
    !elementPath ||
    !elementPath.isJSXElement ||
    !elementPath.isJSXElement()
  ) {
    return { isComponent: false, componentName: null, attributeName: null };
  }

  const name = elementPath.node.openingElement.name;
  let firstChar: string | null = null;
  let componentName: string | null = null;
  if (t.isJSXIdentifier(name)) {
    componentName = name.name;
    firstChar = name.name?.[0] ?? null;
  } else if (t.isJSXMemberExpression(name)) {
    let current: t.Node = name;
    while (t.isJSXMemberExpression(current)) {
      current = current.object;
    }
    if (t.isJSXIdentifier(current)) {
      componentName = current.name;
      firstChar = current.name?.[0] ?? null;
    }
  }

  if (
    !firstChar ||
    firstChar !== firstChar.toUpperCase() ||
    !/[A-Z]/.test(firstChar)
  ) {
    return { isComponent: false, componentName: null, attributeName };
  }

  return { isComponent: true, componentName, attributeName };
}

function isReactiveComponentProp(
  componentName: string,
  attributeName: string,
  componentNames: Map<string, t.Function>,
  reactiveProps: Map<t.Function, Set<string>>,
  importedReactiveProps: Map<string, Set<string>>,
): boolean {
  if (isBuiltinReactiveProp(componentName, attributeName)) {
    return true;
  }

  const componentFn = componentNames.get(componentName);
  if (componentFn) {
    const props = reactiveProps.get(componentFn);
    if (!props) return false;
    return props.has(attributeName);
  }

  // Component is imported from another module: consult cross-file metadata
  // resolved from analyzeMetadata. The localName used at the call site maps
  // to the reactive prop set computed for the imported component's export.
  const importedProps = importedReactiveProps.get(componentName);
  if (!importedProps) return false;
  return importedProps.has(attributeName);
}

function shouldWrap(expr: t.Expression, scope: ReactiveScope): boolean {
  const inner = t.unwrapParens(expr);
  // Already a function — leave event handlers and manual getters alone
  if (t.isArrowFunctionExpression(inner) || t.isFunctionExpression(inner))
    return false;
  // Empty JSX expression
  if (t.isJSXEmptyExpression(inner)) return false;
  return containsReactiveRead(inner, scope);
}

/**
 * Identifier used for the runtime `resolve` helper imported from
 * `sinwan/reactivity` when prop-rooted member expressions need unwrapping.
 * Prefixed with `_$` to avoid collisions with user code.
 */
const RESOLVE_HELPER = "_$unwrap";

/**
 * Walk an expression tree and replace the root identifier of every member
 * expression chain rooted at a **prop** binding with `resolve(root)`.
 *
 * This is necessary because reactive values forwarded through component props
 * arrive as zero-arity getter functions (the compiler wraps them at the call
 * site). A member access like `user.name` on a getter function returns
 * `Function.name` rather than the data. Wrapping the root in `resolve()`
 * unwraps the getter chain to the underlying value (e.g. a `createMutable`
 * proxy) before the member access, so reactivity is preserved.
 *
 * Member expressions rooted at non-prop bindings (local mutables, signals,
 * etc.) are left untouched — their roots are already the actual reactive
 * objects, not getters.
 *
 * Returns `{ changed: true }` when any replacement was made, so the caller
 * knows to emit the `resolve` import.
 */
function transformPropMemberAccess(
  expr: t.Expression,
  scope: ReactiveScope,
): boolean {
  let changed = false;

  function resolveRoot(rootName: string): t.Expression {
    return t.callExpression(t.identifier(RESOLVE_HELPER), [
      t.identifier(rootName),
    ]);
  }

  // Replace the innermost `.object` of a (possibly optional / non-null)
  // member-expression chain with `resolve(rootIdentifier)`. Mutates the chain
  // in place — safe because the expression is about to be wrapped and the
  // original JSX container replaced.
  function replaceMemberRoot(
    node: t.MemberExpression | t.OptionalMemberExpression,
    rootName: string,
  ): void {
    // `any` avoids brittle control-flow narrowing across the mixed
    // MemberExpression / OptionalMemberExpression / TSNonNullExpression chain.
    let current: any = node;
    let parent: any = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (t.isParenthesizedExpression(current)) {
        current = t.unwrapParens(current);
        continue;
      }
      if (t.isChainExpression(current)) {
        current = t.unwrapChain(current);
        continue;
      }
      if (t.isTSNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      if (!t.isMemberExpression(current)) break;
      parent = current;
      current = current.object;
    }
    if (parent && t.isIdentifier(current) && current.name === rootName) {
      parent.object = resolveRoot(rootName);
    }
  }

  function visit(node: any, enterFunction: boolean): void {
    if (!node || typeof node !== "object") return;

    if (node.type === "ParenthesizedExpression") {
      visit(node.expression, enterFunction);
      return;
    }

    if (isFunctionLike(node)) {
      if (!enterFunction) return;
      for (const param of node.params) {
        visit(param, false);
      }
      visit(node.body, false);
      return;
    }

    if (t.isJSXElement(node) || t.isJSXFragment(node)) {
      return;
    }

    if (isMemberLike(node)) {
      const rootPath = getMemberExpressionRootAndPath(node);
      if (rootPath) {
        const binding = scope.bindings.get(rootPath.root);
        if (binding && binding.kind === "prop") {
          replaceMemberRoot(node, rootPath.root);
          changed = true;
          // Don't recurse further into this chain — the root is already
          // resolved and intermediate members are on the resolved value.
          return;
        }
      }
      // Root is not a prop — member access is safe as-is. Nested call
      // arguments (`.map` callbacks) are visited from the CallExpression.
      return;
    }

    if (isCallLike(node)) {
      visitCallCalleeAndArgs(node, visit);
      return;
    }

    // Recurse into children of non-member-expression nodes.
    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const value = (node as any)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") visit(item, false);
        }
      } else if (value && typeof value === "object") {
        visit(value, false);
      }
    }
  }

  visit(expr, false);
  return changed;
}

function wrapExpression(expr: t.Expression): t.Expression {
  return t.arrowFunctionExpression([], expr);
}

/**
 * Build either a legacy zero-arity arrow function or a Phase 2 explicit
 * binding descriptor for a reactive JSX expression.
 */
function isPropRoot(expr: t.Expression, scope: ReactiveScope): boolean {
  if (t.isIdentifier(expr)) {
    return scope.bindings.get(expr.name)?.kind === "prop";
  }
  if (
    t.isCallExpression(expr) &&
    t.isIdentifier(expr.callee, { name: "_$unwrap" }) &&
    expr.arguments.length === 1 &&
    t.isIdentifier(expr.arguments[0])
  ) {
    return scope.bindings.get(expr.arguments[0].name)?.kind === "prop";
  }
  return false;
}

function isChildrenPropRead(expr: t.Expression, scope: ReactiveScope): boolean {
  let node: t.Node = t.unwrapParens(expr);
  if (t.isChainExpression(node)) node = t.unwrapParens(t.unwrapChain(node));
  if (t.isIdentifier(node, { name: "children" })) return true;
  if (!t.isMemberExpression(node) || node.computed) return false;
  if (!t.isIdentifier(node.property, { name: "children" })) return false;
  return isPropRoot(node.object as t.Expression, scope);
}

function createBindingDescriptor(
  expr: t.Expression,
  exprPath: any,
  options: { explicitBindings?: boolean },
  scope: ReactiveScope,
  childrenGetter: boolean,
): t.Expression {
  if (!options.explicitBindings) {
    return wrapExpression(expr);
  }

  const parent = exprPath.parentPath;
  if (parent && parent.isJSXAttribute && parent.isJSXAttribute()) {
    const compInfo = getComponentExpressionInfo(exprPath);
    // Control-flow and user components call `resolve(prop)`. A bindAttr
    // descriptor is not an array/boolean, so `<For each>` would render empty.
    if (compInfo.isComponent) {
      return wrapExpression(expr);
    }
    const attrName = parent.node.name.name as string;
    if (attrName === "style") {
      return t.callExpression(t.identifier("_$bindStyle"), [
        wrapExpression(expr),
      ]);
    }
    if (attrName === "class") {
      return t.callExpression(t.identifier("_$bindClass"), [
        wrapExpression(expr),
      ]);
    }
    return t.callExpression(t.identifier("_$bindAttr"), [
      t.stringLiteral(attrName),
      wrapExpression(expr),
    ]);
  }

  // Component children (and a `children` / `props.children` read on native
  // hosts) are a node tree, not a string. `_$bindText` stringifies vnodes as
  // `[object Object]`. Keep a getter so the runtime can render text *or* nodes.
  const compInfo = getComponentExpressionInfo(exprPath);
  if (
    isChildrenPropRead(expr, scope) ||
    childrenGetter ||
    (compInfo.isComponent && compInfo.attributeName === null)
  ) {
    return wrapExpression(expr);
  }

  // Native element text children default to a reactive text binding.
  return t.callExpression(t.identifier("_$bindText"), [wrapExpression(expr)]);
}

// ─── Main entry point ──────────────────────────────────────

export function collectComponentFunctions(
  ast: t.Node,
  ccNames: Set<string>,
): {
  functions: Set<t.Function>;
  names: Map<string, t.Function>;
  exported: Set<t.Function>;
} {
  const functions = new Set<t.Function>();
  const names = new Map<string, t.Function>();
  const exported = new Set<t.Function>();
  if (ccNames.size === 0) return { functions, names, exported };

  // First pass: collect component functions and their binding names.
  traverse(ast, {
    CallExpression(path: any) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !ccNames.has(callee.name)) return;

      const firstArg = path.node.arguments[0];
      if (!firstArg || !t.isFunction(firstArg)) return;

      const componentFn = firstArg as t.Function;
      functions.add(componentFn);

      const parent = path.parentPath;
      if (
        parent &&
        parent.isVariableDeclarator &&
        parent.isVariableDeclarator()
      ) {
        const id = parent.node.id;
        if (t.isIdentifier(id)) {
          names.set(id.name, componentFn);
        }
      }
    },
  });

  // Second pass: determine which component functions are exported.
  traverse(ast, {
    ExportNamedDeclaration(path: any) {
      const declaration = path.node.declaration;
      if (!t.isVariableDeclaration(declaration)) return;
      for (const decl of declaration.declarations) {
        const init = decl.init;
        if (!init || !t.isCallExpression(init)) continue;
        const callee = init.callee;
        if (!t.isIdentifier(callee) || !ccNames.has(callee.name)) continue;
        const firstArg = init.arguments[0];
        if (!firstArg || !t.isFunction(firstArg)) continue;
        exported.add(firstArg as t.Function);
      }
    },
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isIdentifier(decl)) {
        const componentFn = names.get(decl.name);
        if (componentFn) {
          exported.add(componentFn);
        }
      } else if (t.isCallExpression(decl)) {
        const callee = decl.callee;
        if (t.isIdentifier(callee) && ccNames.has(callee.name)) {
          const firstArg = decl.arguments[0];
          if (firstArg && t.isFunction(firstArg)) {
            exported.add(firstArg as t.Function);
          }
        }
      }
    },
  });

  return { functions, names, exported };
}

export function computeLocalScopes(
  ast: t.Node,
  names: ImportNames,
): Map<t.Function, ReactiveScope> {
  const scopes = new Map<t.Function, ReactiveScope>();
  traverse(ast, {
    Function(path: any) {
      const scope: ReactiveScope = { bindings: new Map() };
      trackLocalScopeBindings(path, names, scope);
      scopes.set(path.node, scope);
    },
  });
  return scopes;
}

export type CallSite = {
  callee: t.Function;
  props: { name: string; value: t.Expression }[];
  /** Spread expressions forwarded to the child. */
  spreads: t.Expression[];
};

export function collectComponentCallGraph(
  ast: t.Node,
  componentNames: Map<string, t.Function>,
): Map<t.Function, CallSite[]> {
  const callGraph = new Map<t.Function, CallSite[]>();
  if (componentNames.size === 0) return callGraph;

  traverse(ast, {
    JSXElement(path: any) {
      const name = path.node.openingElement.name;
      if (!t.isJSXIdentifier(name)) return;

      const callee = componentNames.get(name.name);
      if (!callee) return;

      const callerPath = path.findParent((p: any) => p.isFunction());
      const callerFn = callerPath ? callerPath.node : null;
      if (!callerFn) return;

      const props: { name: string; value: t.Expression }[] = [];
      const spreads: t.Expression[] = [];
      for (const attr of path.node.openingElement.attributes) {
        if (t.isJSXSpreadAttribute(attr)) {
          if (attr.argument) {
            spreads.push(attr.argument as t.Expression);
          }
          continue;
        }
        if (t.isJSXAttribute(attr)) {
          const attrName = (attr.name as t.JSXIdentifier).name;
          if (!attrName) continue;
          if (t.isJSXExpressionContainer(attr.value)) {
            const expr = attr.value.expression;
            if (!expr || t.isJSXEmptyExpression(expr)) continue;
            props.push({ name: attrName, value: expr as t.Expression });
          }
        }
      }

      const childExprs: t.Expression[] = [];
      for (const child of path.node.children) {
        if (t.isJSXExpressionContainer(child)) {
          const expr = child.expression;
          if (!expr || t.isJSXEmptyExpression(expr)) continue;
          childExprs.push(expr as t.Expression);
        }
      }
      if (childExprs.length === 1) {
        props.push({ name: "children", value: childExprs[0]! });
      } else if (childExprs.length > 1) {
        props.push({ name: "children", value: t.arrayExpression(childExprs) });
      }

      const sites = callGraph.get(callerFn) ?? [];
      sites.push({ callee, props, spreads });
      callGraph.set(callerFn, sites);
    },
  });

  return callGraph;
}

export function buildFullScope(
  localScopes: Map<t.Function, ReactiveScope>,
  fn: t.Function,
  reactiveProps: Set<string>,
): ReactiveScope | null {
  const localScope = localScopes.get(fn);
  if (!localScope) return null;
  const fullScope: ReactiveScope = { bindings: new Map(localScope.bindings) };
  trackPropBindings(fullScope, fn.params[0], reactiveProps);
  return fullScope;
}

export function propagateReactiveProps(
  localScopes: Map<t.Function, ReactiveScope>,
  callGraph: Map<t.Function, CallSite[]>,
  componentFunctions: Set<t.Function>,
): Map<t.Function, Set<string>> {
  const reactiveProps = new Map<t.Function, Set<string>>();

  // Initial pass: mark props reactive when passed from a local reactive source.
  for (const [callerFn, sites] of callGraph) {
    const localScope = localScopes.get(callerFn);
    if (!localScope) continue;
    for (const site of sites) {
      const calleeReactive =
        reactiveProps.get(site.callee) ?? new Set<string>();
      for (const prop of site.props) {
        if (containsReactiveValue(prop.value, localScope)) {
          calleeReactive.add(prop.name);
        }
      }
      reactiveProps.set(site.callee, calleeReactive);
    }
  }

  // Fixed-point propagation: if a caller's prop is reactive, it stays reactive
  // in the callee. Worklist terminates because sets only grow.
  const worklist = new Set<t.Function>(componentFunctions);
  while (worklist.size > 0) {
    const callerFn = worklist.values().next().value as t.Function;
    worklist.delete(callerFn);

    const callerReactive = reactiveProps.get(callerFn) ?? new Set<string>();
    const fullScope = buildFullScope(localScopes, callerFn, callerReactive);
    if (!fullScope) continue;

    const sites = callGraph.get(callerFn) ?? [];
    for (const site of sites) {
      const calleeReactive =
        reactiveProps.get(site.callee) ?? new Set<string>();
      const initialSize = calleeReactive.size;
      for (const prop of site.props) {
        if (containsReactiveValue(prop.value, fullScope)) {
          calleeReactive.add(prop.name);
        }
      }
      for (const spread of site.spreads) {
        const resolved = t.isObjectExpression(spread)
          ? spread
          : t.isIdentifier(spread)
            ? resolveLocalObjectLiteral(callerFn, spread.name)
            : null;
        if (resolved) {
          analyzeObjectLiteralSpread(resolved, fullScope, calleeReactive);
        } else {
          // Unknown spread: conservatively mark all known callee props as reactive.
          const allCalleeProps = getAllPropNames(site.callee.params[0]);
          for (const propName of allCalleeProps) {
            calleeReactive.add(propName);
          }
        }
      }
      if (calleeReactive.size > initialSize) {
        reactiveProps.set(site.callee, calleeReactive);
        worklist.add(site.callee);
      }
    }
  }

  return reactiveProps;
}

interface DerivedLocalOptions {
  derivedLocals?: boolean;
  dev?: boolean;
  filename?: string;
  resolveImport?: (source: string, fromFile: string) => string | null;
}

interface DerivedLocal {
  declaration: NodePath<t.VariableDeclarator>;
  binding: AstBinding;
}

function hasSnapshotPragma(node: t.Node): boolean {
  return (
    node.leadingComments?.some((comment) =>
      /\bsinwan-snapshot\b/.test(comment.value),
    ) ?? false
  );
}

function isTypePosition(ref: NodePath): boolean {
  return ref.findParent((parent) => parent.isTSType()) != null;
}

function canRewriteDerivedReference(ref: NodePath): boolean {
  if (!ref.isIdentifier() || !ref.isReferencedIdentifier()) return false;
  if (isTypePosition(ref)) return true;
  let target: NodePath = ref;
  while (
    ((target.parentPath?.isMemberExpression() ||
      target.parentPath?.isOptionalMemberExpression()) &&
      target.key === "object") ||
    ((target.parentPath?.isTSNonNullExpression() ||
      target.parentPath?.isTSAsExpression() ||
      target.parentPath?.isTSTypeAssertion() ||
      target.parentPath?.isTSSatisfiesExpression() ||
      target.parentPath?.isParenthesizedExpression()) &&
      target.key === "expression")
  ) {
    target = target.parentPath;
  }
  const parent = target.parentPath;
  return !(
    (parent?.isAssignmentExpression() && target.key === "left") ||
    parent?.isUpdateExpression() ||
    parent?.isUnaryExpression({ operator: "delete" }) ||
    ((parent?.isForInStatement() || parent?.isForOfStatement()) &&
      target.key === "left") ||
    (target !== ref &&
      (parent?.isCallExpression() || parent?.isOptionalCallExpression()) &&
      target.key === "callee")
  );
}

function isPureDerivedCall(
  path: NodePath,
  names: ImportNames,
  pureImports: PureImports,
): boolean {
  if (!path.isCallExpression() && !path.isOptionalCallExpression())
    return false;
  const call = t.unwrapCall(path.node);
  const callee = t.unwrapParens((call as { callee: t.Node }).callee);
  const args = (call as { arguments?: unknown[] }).arguments ?? [];

  // Member expression calls: Utils.merge(...), ns.cn(...), ns.Utils.merge(...)
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    // Walk the member chain to collect the root identifier and all property names.
    // e.g. ns.Utils.merge → root="ns", props=["Utils", "merge"]
    // e.g. ns.cn → root="ns", props=["cn"]
    // e.g. helpers.merge → root="helpers", props=["merge"]
  const props: string[] = [];
  let node: t.Node = t.unwrapParens(callee);
  while (true) {
    node = t.unwrapParens(node);
    if (t.isChainExpression(node)) {
      node = t.unwrapChain(node);
      continue;
    }
    if (!t.isMemberExpression(node)) break;
    const prop = node.property;
    if (t.isIdentifier(prop)) {
      props.unshift(prop.name);
    } else if (t.isStringLiteral(prop)) {
      props.unshift(prop.value);
    } else {
      return false;
    }
    node = node.object as t.Node;
  }
    if (!t.isIdentifier(node)) return false;
    const root = node.name;

    // Class/object member call: Utils.merge(...) where Utils is a pure import
    if (pureImports.member.has(root)) {
      return true;
    }
    // Namespace call: ns.cn(...) or ns.Utils.merge(...)
    // If ANY property in the chain is in the pure set, the call is pure.
    // - ns.cn() → cn is a pure function → pure call
    // - ns.Utils.merge() → Utils is a pure class → any static method is pure
    const nsMembers = pureImports.namespace.get(root);
    if (nsMembers && props.some((p) => nsMembers.has(p))) {
      return true;
    }
    return false;
  }

  if (!t.isIdentifier(callee)) return false;
  const binding = path.scope.getBinding(callee.name);
  if (!binding) {
    return (
      ["Boolean", "Number", "String"].includes(callee.name) &&
      args.length === 1
    );
  }
  // @sinwan-pure JSDoc-annotated imported functions (named or default) are
  // treated as pure calls. Argument count is not restricted.
  if (
    (binding.path.isImportSpecifier() ||
      binding.path.isImportDefaultSpecifier()) &&
    pureImports.direct.has(callee.name)
  ) {
    return true;
  }
  if (args.length !== 0 || !binding.path.isVariableDeclarator())
    return false;
  const { id, init } = binding.path.node;
  return (
    t.isArrayPattern(id) &&
    id.elements[0] === binding.identifier &&
    t.isCallExpression(init) &&
    t.isIdentifier(init.callee) &&
    names.useState.has(init.callee.name) &&
    binding.path.scope
      .getBinding(init.callee.name)
      ?.path.isImportSpecifier() === true
  );
}

function isDerivedInitializer(
  declaration: NodePath<t.VariableDeclarator>,
  scope: ReactiveScope,
  names: ImportNames,
  derived: Map<AstBinding, DerivedLocal>,
  pureImports: PureImports,
): boolean {
  const init = singlePath(declaration.get("init"));
  init.assertExpression();
  let safe = true;
  let reactive = false;
  const inspect = (path: NodePath): void => {
    if (!safe || path.isTSType()) {
      path.skip();
      return;
    }
    const node = path.node;
    if (path.isReferencedIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (
        binding &&
        (!binding.constant ||
          binding.kind === "let" ||
          binding.kind === "var" ||
          (binding.path.isVariableDeclarator() &&
            (binding.path.node.start ?? -1) >=
              (declaration.node.start ?? Infinity)))
      ) {
        safe = false;
        return;
      }
      if (binding && derived.has(binding)) reactive = true;
      if (isReactiveRead(node, scope)) reactive = true;
    } else if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      if (isReactiveRead(node, scope)) reactive = true;
    } else if (path.isCallExpression() || path.isOptionalCallExpression()) {
      if (!isPureDerivedCall(path, names, pureImports)) safe = false;
      if (isGetterCall(path.node, scope)) reactive = true;
    } else if (path.isSpreadElement()) {
      // Spread elements inside object/array literals are safe only if the
      // spread argument itself is a safe expression; the traverse will
      // visit and validate the argument separately.
    } else if (
      !(
        path.isIdentifier() ||
        path.isLiteral() ||
        path.isTemplateLiteral() ||
        path.isTemplateElement() ||
        path.isBinaryExpression() ||
        path.isLogicalExpression() ||
        path.isConditionalExpression() ||
        path.isObjectExpression() ||
        path.isObjectProperty() ||
        path.isArrayExpression() ||
        path.isParenthesizedExpression() ||
        path.node.type === "ChainExpression" ||
        (path.isUnaryExpression() && path.node.operator !== "delete") ||
        path.isTSAsExpression() ||
        path.isTSSatisfiesExpression() ||
        path.isTSNonNullExpression() ||
        path.isTSTypeAssertion()
      )
    ) {
      safe = false;
    }
  };
  inspect(init);
  if (safe) init.traverse({ enter: inspect });
  return safe && reactive;
}

function promoteReactiveConstInitializers(
  ast: t.Node,
  options: DerivedLocalOptions,
): void {
  if (!options.derivedLocals && !options.dev) return;
  const names = trackReactiveImports(ast);
  const pureImports = collectPureImports(
    ast,
    options.filename,
    options.resolveImport,
  );
  const { functions } = collectComponentFunctions(ast, names.cc);
  // Re-crawl the program scope so bindings injected by autoWrapComponents
  // (e.g. the `cc` import) are visible to the module-kind guard below.
  traverse(ast, {
    Program(p) {
      p.scope.crawl();
    },
  });
  traverse(ast, {
    Function(fnPath) {
      if (!t.isFunction(fnPath.node) || !functions.has(fnPath.node)) return;
      const factory = fnPath.parentPath;
      if (
        !factory ||
        !factory.isCallExpression() ||
        !t.isIdentifier(factory.node.callee) ||
        factory.scope.getBinding(factory.node.callee.name)?.kind !== "module"
      )
        return;
      const body = singlePath(fnPath.get("body"));
      if (!body.isBlockStatement()) return;
      let hasDirectEval = false;
      fnPath.traverse({
        CallExpression(p) {
          if (
            t.isIdentifier(p.node.callee, { name: "eval" }) &&
            !p.scope.getBinding("eval")
          )
            hasDirectEval = true;
        },
      });
      if (hasDirectEval) return;
      const scope: ReactiveScope = { bindings: new Map() };
      trackPropBindings(
        scope,
        fnPath.node.params[0],
        getAllPropNames(fnPath.node.params[0]),
      );
      trackLocalScopeBindings(fnPath, names, scope, true);
      const derived = new Map<AstBinding, DerivedLocal>();
      const statements = body.get("body");
      for (const statement of Array.isArray(statements)
        ? statements
        : [statements]) {
        if (
          !statement.isVariableDeclaration({ kind: "const" }) ||
          hasSnapshotPragma(statement.node)
        )
          continue;
        for (const declaration of (() => {
          const decls = statement.get("declarations");
          return Array.isArray(decls) ? decls : [decls];
        })()) {
          const { id, init } = declaration.node;
          if (
            !t.isIdentifier(id) ||
            !init ||
            hasSnapshotPragma(declaration.node) ||
            hasSnapshotPragma(init)
          )
            continue;
          const binding = declaration.scope.getBinding(id.name)!;
          if (
            !binding.constant ||
            !binding.referenced ||
            !binding.referencePaths.every(canRewriteDerivedReference)
          )
            continue;
          if (
            isDerivedInitializer(
              declaration,
              scope,
              names,
              derived,
              pureImports,
            )
          ) {
            derived.set(binding, { declaration, binding });
          }
        }
      }
      for (const { declaration, binding } of derived.values()) {
        const { id, init } = declaration.node;
        if (!t.isIdentifier(id) || !t.isExpression(init)) continue;
        const location = `${options.filename ?? "<module>"}:${id.loc?.start.line ?? 0}`;
        if (!options.derivedLocals) {
          if (
            binding.referencePaths.some((ref) =>
              ref.findParent((p) => p.isJSXExpressionContainer()),
            )
          ) {
            console.warn(
              `[Sinwan] ${location}: derived local "${id.name}" snapshots a reactive read used in JSX. Enable derivedLocals or use a getter/computed; use /* sinwan-snapshot */ for an intentional snapshot.`,
            );
          }
          continue;
        }
        const getter = t.arrowFunctionExpression([], init);
        if (t.isTSTypeAnnotation(id.typeAnnotation)) {
          getter.returnType = id.typeAnnotation;
          id.typeAnnotation = null;
        }
        declaration.node.init = getter;
        for (const ref of binding.referencePaths) {
          if (isTypePosition(ref)) continue;
          if (
            options.dev &&
            ref.parentPath?.isIfStatement() &&
            ref.key === "test" &&
            ref.getFunctionParent()?.node === fnPath.node
          ) {
            console.warn(
              `[Sinwan] ${location}: derived local "${id.name}" in a setup if is read once, not a reactive branch. The compiler calls its getter to preserve boolean semantics; use Show for reactive control flow.`,
            );
          }
          if (ref.parentPath?.isObjectProperty({ shorthand: true })) {
            ref.parentPath.node.shorthand = false;
          }
          ref.replaceWith(t.callExpression(t.identifier(id.name), []));
        }
      }
      fnPath.scope.crawl();
    },
  });
}

export function wrapReactiveExpressions(
  ast: t.Node,
  options: {
    derivedLocals?: boolean;
    dev?: boolean;
    explicitBindings?: boolean;
    analyze?: string;
    analyzeMetadata?: Map<string, Map<string, Set<string>>>;
    resolveImport?: (source: string, fromFile: string) => string | null;
    filename?: string;
  } = {},
): void {
  promoteReactiveConstInitializers(ast, options);

  // ─── Load metadata (not a traverse) ───────────────────────
  let metadata: Map<string, Map<string, Set<string>>> | null = null;
  if (options.analyzeMetadata) {
    metadata = options.analyzeMetadata;
  } else if (options.analyze && options.filename) {
    try {
      metadata = loadMetadata(options.analyze);
    } catch {
      metadata = null;
    }
  }
  const absoluteFilename = options.filename
    ? path.resolve(options.filename)
    : null;
  const resolveImport = options.resolveImport;

  // ─── Pass 1: Fused collection (single traverse) ──────────
  // Collects: reactive imports, component functions, exports, local scopes,
  // call graph, cross-module prop metadata, and existing `unwrap` import.
  // Previously 5-7 separate traverses; now one.
  const names: ImportNames = {
    createMutable: new Set(),
    createStore: new Set(),
    signal: new Set(),
    computed: new Set(),
    useState: new Set(),
    useFetch: new Set(),
    cc: new Set(),
  };
  const componentFunctions = new Set<t.Function>();
  const componentNames = new Map<string, t.Function>();
  const exported = new Set<t.Function>();
  const localScopes = new Map<t.Function, ReactiveScope>();
  const callGraph = new Map<t.Function, CallSite[]>();
  // Raw call graph stores callee names before resolution (see JSXElement visitor).
  const rawCallGraph = new Map<
    t.Function,
    {
      calleeName: string;
      props: { name: string; value: t.Expression }[];
      spreads: t.Expression[];
    }[]
  >();
  const importedReactiveProps = new Map<string, Set<string>>();
  const exportNameByFn = new Map<t.Function, string>();
  let hasUnwrapImport = false;

  traverse(ast, {
    ImportDeclaration(p) {
      const source = t.moduleSourceValue(p.node.source);
      if (!source) return;
      const reactiveAllowed = REACTIVE_SOURCE_MODULES[source];
      const componentAllowed = COMPONENT_FACTORY_MODULES[source];
      if (reactiveAllowed || componentAllowed) {
        for (const spec of p.node.specifiers ?? []) {
          if (!t.isImportSpecifier(spec)) continue;
          const imported = t.importedBindingName(spec.imported);
          if (imported && reactiveAllowed?.has(imported)) {
            addImportLocal(names, imported, spec.local.name);
          } else if (imported && componentAllowed?.has(imported)) {
            names.cc.add(spec.local.name);
          }
        }
      }

      // Check for existing `_$unwrap` local from `sinwan/reactivity`.
      // `import { unwrap }` is a different binding; generated code always
      // calls `_$unwrap`, so only skip inject when that alias already exists.
      if (source === "sinwan/reactivity") {
        for (const spec of p.node.specifiers ?? []) {
          if (
            t.isImportSpecifier(spec) &&
            t.isIdentifier(spec.imported) &&
            spec.imported.name === "unwrap" &&
            spec.local.name === RESOLVE_HELPER
          ) {
            hasUnwrapImport = true;
          }
        }
      }

      // Cross-module reactive prop metadata for imported components
      if (
        metadata &&
        absoluteFilename &&
        resolveImport &&
        source.startsWith(".")
      ) {
        const resolved = resolveImport(source, absoluteFilename);
        if (resolved) {
          const fileProps = metadata.get(resolved);
          if (fileProps) {
            for (const spec of p.node.specifiers ?? []) {
              if (!t.isImportSpecifier(spec)) continue;
              const imported = t.importedBindingName(spec.imported);
              if (!imported || !/^[A-Z]/.test(imported)) continue;
              const props = fileProps.get(imported);
              if (props && props.size > 0) {
                importedReactiveProps.set(spec.local.name, new Set(props));
              }
            }
          }
        }
      }
    },

    CallExpression(p: any) {
      // Collect cc() component functions
      const callee = p.node.callee;
      if (!t.isIdentifier(callee) || !names.cc.has(callee.name)) return;
      const firstArg = p.node.arguments[0];
      if (!firstArg || !t.isFunction(firstArg)) return;
      const componentFn = firstArg as t.Function;
      componentFunctions.add(componentFn);
      const parent = p.parentPath;
      if (
        parent &&
        parent.isVariableDeclarator &&
        parent.isVariableDeclarator()
      ) {
        const id = parent.node.id;
        if (t.isIdentifier(id)) {
          componentNames.set(id.name, componentFn);
        }
      }
    },

    ExportNamedDeclaration(p: any) {
      // Mark component functions as exported
      const declaration = p.node.declaration;
      if (!t.isVariableDeclaration(declaration)) return;
      for (const decl of declaration.declarations) {
        const init = decl.init;
        if (!init || !t.isCallExpression(init)) continue;
        const callee = init.callee;
        if (!t.isIdentifier(callee) || !names.cc.has(callee.name)) continue;
        const firstArg = init.arguments[0];
        if (!firstArg || !t.isFunction(firstArg)) continue;
        exported.add(firstArg as t.Function);
      }
    },

    ExportDefaultDeclaration(p: any) {
      const decl = p.node.declaration;
      if (t.isIdentifier(decl)) {
        const fn = componentNames.get(decl.name);
        if (fn) {
          exported.add(fn);
          exportNameByFn.set(fn, "default");
        }
      } else if (t.isCallExpression(decl)) {
        const callee = decl.callee;
        if (t.isIdentifier(callee) && names.cc.has(callee.name)) {
          const firstArg = decl.arguments[0];
          if (firstArg && t.isFunction(firstArg)) {
            exported.add(firstArg as t.Function);
            exportNameByFn.set(firstArg as t.Function, "default");
          }
        }
      }
    },

    Function(p: any) {
      // Compute local scope bindings for this function
      const scope: ReactiveScope = { bindings: new Map() };
      if (options.derivedLocals && componentFunctions.has(p.node)) {
        trackPropBindings(
          scope,
          p.node.params[0],
          getAllPropNames(p.node.params[0]),
        );
      }
      trackLocalScopeBindings(
        p,
        names,
        scope,
        options.derivedLocals === true && componentFunctions.has(p.node),
      );
      localScopes.set(p.node, scope);
    },

    JSXElement(p: any) {
      // Build component call graph entry — store raw callee name and resolve
      // after the traverse (component names may not be collected yet during
      // a single fused pass, since `const Child = cc(...)` may appear after
      // `<Child />` in the AST).
      const name = p.node.openingElement.name;
      if (!t.isJSXIdentifier(name)) return;
      const callerPath = p.findParent((pp: any) => pp.isFunction());
      const callerFn = callerPath ? callerPath.node : null;
      if (!callerFn) return;

      const props: { name: string; value: t.Expression }[] = [];
      const spreads: t.Expression[] = [];
      for (const attr of p.node.openingElement.attributes) {
        if (t.isJSXSpreadAttribute(attr)) {
          if (attr.argument) {
            spreads.push(attr.argument as t.Expression);
          }
          continue;
        }
        if (t.isJSXAttribute(attr)) {
          const attrName = (attr.name as t.JSXIdentifier).name;
          if (!attrName) continue;
          if (t.isJSXExpressionContainer(attr.value)) {
            const expr = attr.value.expression;
            if (!expr || t.isJSXEmptyExpression(expr)) continue;
            props.push({ name: attrName, value: expr as t.Expression });
          }
        }
      }

      const childExprs: t.Expression[] = [];
      for (const child of p.node.children) {
        if (t.isJSXExpressionContainer(child)) {
          const expr = child.expression;
          if (!expr || t.isJSXEmptyExpression(expr)) continue;
          childExprs.push(expr as t.Expression);
        }
      }
      if (childExprs.length === 1) {
        props.push({ name: "children", value: childExprs[0]! });
      } else if (childExprs.length > 1) {
        props.push({ name: "children", value: t.arrayExpression(childExprs) });
      }

      // Store with raw name — resolved to callee function after traverse
      const sites = rawCallGraph.get(callerFn) ?? [];
      sites.push({ calleeName: name.name, props, spreads });
      rawCallGraph.set(callerFn, sites);
    },
  });

  // Resolve raw call graph names to component functions (after all
  // CallExpression visitors have populated componentNames).
  for (const [callerFn, sites] of rawCallGraph) {
    const resolved: CallSite[] = [];
    for (const site of sites) {
      const callee = componentNames.get(site.calleeName);
      if (callee) {
        resolved.push({ callee, props: site.props, spreads: site.spreads });
      }
    }
    if (resolved.length > 0) {
      callGraph.set(callerFn, resolved);
    }
  }

  // Build exportNameByFn for named exports (after componentNames is populated)
  for (const [localName, fn] of componentNames) {
    if (exported.has(fn)) {
      if (!exportNameByFn.has(fn)) {
        exportNameByFn.set(fn, localName);
      }
    }
  }

  const hasAnyImport = Object.values(names).some((s) => s.size > 0);
  if (!hasAnyImport) return;

  // ─── Fixed-point: propagate reactive props (not a traverse) ───
  const reactiveProps = propagateReactiveProps(
    localScopes,
    callGraph,
    componentFunctions,
  );

  // ─── Pass 2: Transform (single traverse) ─────────────────
  // Track whether any expression needed the `resolve` runtime helper.
  let needsResolve = false;

  traverse(ast, {
    Function(path: any) {
      // Build a reactive scope for this function
      const scope = localScopes.get(path.node);
      if (!scope) return;
      const isComponent = componentFunctions.has(path.node);
      if (isComponent) {
        const isExported = exported.has(path.node);
        if (isExported) {
          let props: Set<string> | null = null;
          if (metadata && absoluteFilename) {
            const fileProps = metadata.get(absoluteFilename);
            const exportName = exportNameByFn.get(path.node);
            if (fileProps && exportName) {
              props = fileProps.get(exportName) ?? null;
            }
          }
          if (props) {
            trackPropBindings(scope, path.node.params[0], props);
          } else {
            // No metadata or component not listed: fall back to conservative.
            const allProps = getAllPropNames(path.node.params[0]);
            trackPropBindings(scope, path.node.params[0], allProps);
          }
        } else if (reactiveProps.has(path.node)) {
          const props = reactiveProps.get(path.node)!;
          trackPropBindings(scope, path.node.params[0], props);
        } else {
          // No call sites in this module: treat all props as reactive to stay
          // safe for parents in other modules.
          const allProps = getAllPropNames(path.node.params[0]);
          trackPropBindings(scope, path.node.params[0], allProps);
        }
      }

      // Wrap reactive JSX expressions inside this function
      path.traverse({
        JSXExpressionContainer(exprPath: any) {
          const expr = exprPath.node.expression as t.Expression;
          const compInfo = getComponentExpressionInfo(exprPath);
          if (compInfo.attributeName?.startsWith("on")) {
            return;
          }
          if (compInfo.isComponent && compInfo.attributeName !== null) {
            const knownProp =
              !!compInfo.componentName &&
              isReactiveComponentProp(
                compInfo.componentName,
                compInfo.attributeName,
                componentNames,
                reactiveProps,
                importedReactiveProps,
              );
            // Known reactive props (Show.when, inferred call-graph props) wrap
            // below. Unknown imported components still wrap *derived reads*
            // (`title={n.value}`) so styled wrappers like <Label> stay live.
            // Do not wrap a bare signal/store identifier — the child owns it.
            if (
              !knownProp &&
              (!shouldWrap(expr, scope) ||
                isReactiveContainerPassThrough(expr, scope))
            ) {
              return;
            }
          }
          if (shouldWrap(expr, scope)) {
            // Before wrapping, replace prop-rooted member expressions (e.g.
            // `user.name`) with `resolve(user).name` so that getter-valued
            // props are unwrapped before member access at runtime.
            const childrenGetter = isChildrenPropRead(expr, scope);
            if (transformPropMemberAccess(expr, scope)) {
              needsResolve = true;
            }
            exprPath.replaceWith(
              t.jsxExpressionContainer(
                createBindingDescriptor(
                  expr,
                  exprPath,
                  options,
                  scope,
                  childrenGetter,
                ),
              ),
            );
          }
        },
      });
    },
  });

  // If any prop-rooted member expression was transformed, add the runtime
  // `resolve` import so `_$resolve` is in scope at runtime. `hasUnwrapImport`
  // was tracked during Pass 1's ImportDeclaration visit — no extra traverse.
  if (needsResolve && !hasUnwrapImport) {
    (ast as t.File).program.body.unshift(
      t.importDeclaration(
        [
          t.importSpecifier(
            t.identifier(RESOLVE_HELPER),
            t.identifier("unwrap"),
          ),
        ],
        t.stringLiteral("sinwan/reactivity"),
      ),
    );
  }
}
