/**
 * SinwanJS Compiler — Reactive JSX Expression Wrapping
 *
 * Wraps JSX expressions that read reactive values in zero-arity arrow
 * functions so the runtime renderer can create an effect and update the DOM
 * when the value changes.
 *
 * Supported reactive sources:
 *   - `createMutable` / `createStore` from `sinwan/store`
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

import * as t from "@babel/types";
import _traverse from "@babel/traverse";
import * as path from "path";

const traverse =
  typeof _traverse === "function"
    ? _traverse
    : ((_traverse as any).default ?? _traverse);

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
  "sinwan/store": new Set(["createMutable", "createStore"]),
  "sinwan/reactivity": new Set(["signal", "computed"]),
  "sinwan/react": new Set(["useState"]),
  "sinwan/hook": new Set(["useFetch"]),
};

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
  let node: t.Node = expr;
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
      const source = path.node.source.value as string;
      const reactiveAllowed = REACTIVE_SOURCE_MODULES[source];
      const componentAllowed = COMPONENT_FACTORY_MODULES[source];
      if (!reactiveAllowed && !componentAllowed) return;

      for (const spec of path.node.specifiers) {
        if (!t.isImportSpecifier(spec)) continue;
        const imported = t.isIdentifier(spec.imported)
          ? spec.imported.name
          : spec.imported.value;
        if (reactiveAllowed?.has(imported)) {
          const local = spec.local.name as string;
          (names as any)[imported].add(local);
        } else if (componentAllowed?.has(imported)) {
          names.cc.add(spec.local.name as string);
        }
      }
    },
  });

  return names;
}

// ─── Reactive binding kinds per scope ──────────────────────

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
  path: any,
  names: ImportNames,
  scope: ReactiveScope,
): void {
  // First pass: collect reactive source bindings (signals, mutables, getters).
  path.traverse({
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
  path.traverse({
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
  path.traverse({
    "FunctionDeclaration|VariableDeclarator"(p: any) {
      const node = p.node as t.FunctionDeclaration | t.VariableDeclarator;
      let fn: t.Function | null = null;
      let name: string | null = null;

      if (t.isFunctionDeclaration(node)) {
        fn = node;
        name = node.id?.name ?? null;
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

/** True for `a.b` and optional `a?.b` member expressions. */
function isMemberLike(
  node: any,
): node is t.MemberExpression | t.OptionalMemberExpression {
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

function isFunctionLike(
  node: t.Node,
): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return t.isArrowFunctionExpression(node) || t.isFunctionExpression(node);
}

function isCallLike(
  node: t.Node,
): node is t.CallExpression | t.OptionalCallExpression {
  return t.isCallExpression(node) || t.isOptionalCallExpression(node);
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
  node: t.CallExpression | t.OptionalCallExpression,
): boolean {
  const callee = node.callee;
  return t.isIdentifier(callee) && COMPILER_BINDING_CALLEES.has(callee.name);
}

/**
 * Call arguments and IIFE callees run while the outer JSX expression is
 * evaluated (`.map` / `.filter` callbacks, `fn(...spread)`). Render props and
 * returned handlers do not.
 */
function visitCallCalleeAndArgs(
  node: t.CallExpression | t.OptionalCallExpression,
  visitExpr: (expr: t.Node, enterFunction: boolean) => void,
): void {
  if (isCompilerBindingCall(node)) return;
  visitExpr(node.callee, true);
  for (const arg of node.arguments) {
    if (t.isSpreadElement(arg)) {
      visitExpr(arg.argument, true);
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (t.isTSNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (isMemberLike(current)) {
      if (current.computed) return null;
      if (!t.isIdentifier(current.property)) return null;
      path.push(current.property.name);
      current = current.object;
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
    return isReactiveRead(node.expression, scope);
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
  node: t.CallExpression | t.OptionalCallExpression,
  scope: ReactiveScope,
): boolean {
  const callee = node.callee;
  if (t.isIdentifier(callee)) {
    const binding = scope.bindings.get(callee.name);
    if (binding?.kind === "getter") return true;
    if (binding) return false;
    return node.arguments.length === 0;
  }
  if (
    isMemberLike(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property)
  ) {
    if (node.arguments.length !== 0) return false;
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
  if (t.isTSNonNullExpression(node)) {
    return isReactiveValue(node.expression, scope);
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
    let current: t.JSXMemberExpression | t.JSXIdentifier = name;
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
  // Already a function — leave event handlers and manual getters alone
  if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr))
    return false;
  // Empty JSX expression
  if (t.isJSXEmptyExpression(expr)) return false;
  return containsReactiveRead(expr, scope);
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
      if (t.isTSNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      if (!isMemberLike(current)) break;
      parent = current;
      current = current.object;
    }
    if (parent && t.isIdentifier(current) && current.name === rootName) {
      parent.object = resolveRoot(rootName);
    }
  }

  function visit(node: any, enterFunction: boolean): void {
    if (!node || typeof node !== "object") return;

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
function isPropRoot(
  expr: t.Expression,
  scope: ReactiveScope,
): boolean {
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

function isChildrenPropRead(
  expr: t.Expression,
  scope: ReactiveScope,
): boolean {
  if (t.isIdentifier(expr, { name: "children" })) return true;
  if (!isMemberLike(expr) || expr.computed) return false;
  if (!t.isIdentifier(expr.property, { name: "children" })) return false;
  return isPropRoot(expr.object as t.Expression, scope);
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

export function wrapReactiveExpressions(
  ast: t.Node,
  options: {
    explicitBindings?: boolean;
    analyze?: string;
    analyzeMetadata?: Map<string, Map<string, Set<string>>>;
    resolveImport?: (source: string, fromFile: string) => string | null;
    filename?: string;
  } = {},
): void {
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
    ImportDeclaration(p: any) {
      const source = p.node.source.value as string;

      // Reactive source imports + component factory imports
      const reactiveAllowed = REACTIVE_SOURCE_MODULES[source];
      const componentAllowed = COMPONENT_FACTORY_MODULES[source];
      if (reactiveAllowed || componentAllowed) {
        for (const spec of p.node.specifiers) {
          if (!t.isImportSpecifier(spec)) continue;
          const imported = t.isIdentifier(spec.imported)
            ? spec.imported.name
            : spec.imported.value;
          if (reactiveAllowed?.has(imported)) {
            (names as any)[imported].add(spec.local.name as string);
          } else if (componentAllowed?.has(imported)) {
            names.cc.add(spec.local.name as string);
          }
        }
      }

      // Check for existing `unwrap` import from sinwan/reactivity
      if (source === "sinwan/reactivity") {
        for (const spec of p.node.specifiers) {
          if (
            t.isImportSpecifier(spec) &&
            t.isIdentifier(spec.imported) &&
            spec.imported.name === "unwrap"
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
            for (const spec of p.node.specifiers) {
              if (!t.isImportSpecifier(spec)) continue;
              const imported = t.isIdentifier(spec.imported)
                ? spec.imported.name
                : spec.imported.value;
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
      trackLocalScopeBindings(p, names, scope);
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
