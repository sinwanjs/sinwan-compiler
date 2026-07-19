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
 *   - `useState` from `sinwan/react-client`
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
  cc: Set<string>;
}

const REACTIVE_SOURCE_MODULES: Record<string, Set<string>> = {
  "sinwan/store": new Set(["createMutable", "createStore"]),
  "sinwan/reactivity": new Set(["signal", "computed"]),
  "sinwan/react": new Set(["useState"]),
  "sinwan/react-client": new Set(["useState"]),
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

export function trackReactiveImports(ast: t.Node): ImportNames {
  const names: ImportNames = {
    createMutable: new Set(),
    createStore: new Set(),
    signal: new Set(),
    computed: new Set(),
    useState: new Set(),
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

type BindingKind = "mutable" | "signal" | "computed" | "getter";

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

export interface PropBinding {
  kind: "prop";
}

export type Binding =
  | MutableBinding
  | SignalBinding
  | ComputedBinding
  | GetterBinding
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

      const source = isReactiveSourceCall(init, names);
      if (!source) return;

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

function resolveLocalObjectLiteral(
  fn: t.Function,
  name: string,
): t.ObjectExpression | null {
  const body = fn.body;
  if (!t.isBlockStatement(body)) return null;
  for (const stmt of body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || decl.id.name !== name) continue;
      if (decl.init && t.isObjectExpression(decl.init)) {
        return decl.init;
      }
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

function getMemberExpressionRootAndPath(
  node: t.MemberExpression,
): { root: string; path: string[] } | null {
  const path: string[] = [];
  let current: t.Expression = node;
  while (t.isMemberExpression(current)) {
    if (current.computed) return null;
    if (!t.isIdentifier(current.property)) return null;
    path.push(current.property.name);
    current = current.object;
  }
  if (t.isIdentifier(current)) {
    return { root: current.name, path: path.reverse() };
  }
  return null;
}

function isReactiveRead(
  node: t.Identifier | t.MemberExpression,
  scope: ReactiveScope,
): boolean {
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

  const rootPath = getMemberExpressionRootAndPath(node);
  if (!rootPath) return false;
  const binding = scope.bindings.get(rootPath.root);
  if (!binding) return false;

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
  return false;
}

function isGetterCall(node: t.CallExpression, scope: ReactiveScope): boolean {
  const callee = node.callee;
  if (!t.isIdentifier(callee)) return false;
  const binding = scope.bindings.get(callee.name);
  return binding?.kind === "getter";
}

export function isReactiveValue(
  node: t.Identifier | t.MemberExpression,
  scope: ReactiveScope,
): boolean {
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

  const rootPath = getMemberExpressionRootAndPath(node);
  if (!rootPath) return false;
  const binding = scope.bindings.get(rootPath.root);
  if (!binding) return false;

  if (binding.kind === "prop" || binding.kind === "mutable") {
    return true;
  }
  if (binding.kind === "signal" || binding.kind === "computed") {
    return rootPath.path[0] === "value";
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

    if (t.isMemberExpression(node) || t.isIdentifier(node)) {
      if (isReactiveValue(node, scope)) {
        found = true;
        return;
      }
    }

    if (t.isCallExpression(node) && isGetterCall(node, scope)) {
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

  function visit(node: any): void {
    if (found) return;
    if (!node || typeof node !== "object") return;

    if (t.isMemberExpression(node) || t.isIdentifier(node)) {
      if (isReactiveRead(node, scope)) {
        found = true;
        return;
      }
    }

    if (t.isCallExpression(node) && isGetterCall(node, scope)) {
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

// ─── Wrap JSX expressions ──────────────────────────────────

export interface ComponentExpressionInfo {
  isComponent: boolean;
  componentName: string | null;
  attributeName: string | null;
}

function getComponentExpressionInfo(exprPath: any): ComponentExpressionInfo {
  const parent = exprPath.parentPath;
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
    return { isComponent: false, componentName: null, attributeName: null };
  }

  return { isComponent: true, componentName, attributeName };
}

function isReactiveComponentProp(
  info: ComponentExpressionInfo,
  componentNames: Map<string, t.Function>,
  reactiveProps: Map<t.Function, Set<string>>,
): boolean {
  if (!info.isComponent || !info.componentName || !info.attributeName) {
    return false;
  }

  if (isBuiltinReactiveProp(info.componentName, info.attributeName)) {
    return true;
  }

  const componentFn = componentNames.get(info.componentName);
  if (!componentFn) return false;
  const props = reactiveProps.get(componentFn);
  if (!props) return false;
  return props.has(info.attributeName);
}

function shouldWrap(expr: t.Expression, scope: ReactiveScope): boolean {
  // Already a function — leave event handlers and manual getters alone
  if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr))
    return false;
  // Empty JSX expression
  if (t.isJSXEmptyExpression(expr)) return false;
  return containsReactiveRead(expr, scope);
}

function wrapExpression(expr: t.Expression): t.Expression {
  return t.arrowFunctionExpression([], expr);
}

/**
 * Build either a legacy zero-arity arrow function or a Phase 2 explicit
 * binding descriptor for a reactive JSX expression.
 */
function createBindingDescriptor(
  expr: t.Expression,
  exprPath: any,
  options: { explicitBindings?: boolean },
): t.Expression {
  if (!options.explicitBindings) {
    return wrapExpression(expr);
  }

  const parent = exprPath.parentPath;
  if (parent && parent.isJSXAttribute && parent.isJSXAttribute()) {
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

  // JSX children and any other context default to a reactive text binding.
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
      } else if (
        parent &&
        parent.isExportNamedDeclaration &&
        parent.isExportNamedDeclaration()
      ) {
        const declaration = parent.node.declaration;
        if (t.isVariableDeclaration(declaration)) {
          for (const decl of declaration.declarations) {
            if (t.isIdentifier(decl.id)) {
              names.set(decl.id.name, componentFn);
            }
          }
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
    filename?: string;
  } = {},
): void {
  const names = trackReactiveImports(ast);
  const hasAnyImport = Object.values(names).some((s) => s.size > 0);
  if (!hasAnyImport) return;

  const {
    functions: componentFunctions,
    names: componentNames,
    exported,
  } = collectComponentFunctions(ast, names.cc);
  const localScopes = computeLocalScopes(ast, names);
  const callGraph = collectComponentCallGraph(ast, componentNames);
  const reactiveProps = propagateReactiveProps(
    localScopes,
    callGraph,
    componentFunctions,
  );

  // Build a map from exported component function to its export name.
  const exportNameByFn = new Map<t.Function, string>();
  for (const [localName, fn] of componentNames) {
    if (exported.has(fn)) {
      exportNameByFn.set(fn, localName);
    }
  }
  traverse(ast, {
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isIdentifier(decl)) {
        const fn = componentNames.get(decl.name);
        if (fn) exportNameByFn.set(fn, "default");
      } else if (t.isCallExpression(decl)) {
        const callee = decl.callee;
        if (t.isIdentifier(callee) && names.cc.has(callee.name)) {
          const firstArg = decl.arguments[0];
          if (firstArg && t.isFunction(firstArg)) {
            exportNameByFn.set(firstArg, "default");
          }
        }
      }
    },
  });

  // Load project-wide metadata if available.
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
      if (scope.bindings.size === 0) return;

      // Wrap reactive JSX expressions inside this function
      path.traverse({
        JSXExpressionContainer(exprPath: any) {
          const expr = exprPath.node.expression as t.Expression;
          const compInfo = getComponentExpressionInfo(exprPath);
          if (compInfo.isComponent) {
            if (
              !isReactiveComponentProp(compInfo, componentNames, reactiveProps)
            ) {
              return;
            }
          }
          if (shouldWrap(expr, scope)) {
            exprPath.replaceWith(
              t.jsxExpressionContainer(
                createBindingDescriptor(expr, exprPath, options),
              ),
            );
          }
        },
      });
    },
  });
}
