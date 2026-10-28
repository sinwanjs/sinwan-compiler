/**
 * SinwanJS Compiler — Auto `cc` wrapping
 *
 * Detects top-level exported functions that look like components (uppercase
 * name, 0–1 params, return JSX) and wraps them with `cc(...)` so the reactive
 * analyzer treats them as components and the runtime gives them a component
 * instance + displayName.
 *
 * This lets plain `export function App()` / `export const App = () => <div/>`
 * work as Sinwan components without an explicit `cc(...)` call, matching the
 * ergonomics of React function components while preserving Sinwan's explicit
 * reactivity model (the compiler still only auto-wraps JSX expressions that
 * read tracked reactive sources).
 *
 * Detection is conservative on purpose:
 *   - Only exported bindings are considered (named or default export).
 *   - The binding name must start with an uppercase letter (component naming
 *     convention). Anonymous default-exported function declarations are also
 *     accepted since they are conventionally components.
 *   - The function must have 0 or 1 parameters and must lexically return JSX
 *     (a JSXElement/JSXFragment in a return statement or arrow body).
 *   - Functions already wrapped in `cc(...)` (or an alias) are skipped to keep
 *     the transform idempotent.
 *
 * If any wrapping is performed and `cc` is not already imported from
 * `sinwan` / `sinwan/component`, an `import { cc } from "sinwan/component"` is
 * prepended so the subsequent reactive-wrap pass detects the components.
 */

import * as t from "./ast/types";
import { traverse, singlePath } from "./ast/traverse";


const CC_SOURCE_MODULES = new Set(["sinwan", "sinwan/component"]);

const EXCLUDE_KEYS = new Set([
  "loc",
  "start",
  "end",
  "type",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "extra",
]);

function isComponentName(name: string | undefined | null): name is string {
  return !!name && /^[A-Z]/.test(name);
}

/**
 * True if the expression tree contains a JSXElement/JSXFragment. When
 * `enterFunctions` is false, nested function bodies are not traversed, so a
 * bare `helper()` call (whose JSX lives in another function) is not reported.
 */
function containsJsx(node: any, enterFunctions: boolean): boolean {
  if (!node || typeof node !== "object") return false;
  if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
  if (
    !enterFunctions &&
    (t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node) ||
      t.isFunctionDeclaration(node))
  ) {
    return false;
  }
  for (const key of Object.keys(node)) {
    if (EXCLUDE_KEYS.has(key)) continue;
    const val = (node as any)[key];
    if (Array.isArray(val)) {
      const foundInArray = val.some(
        (item) =>
          Boolean(item) &&
          typeof item === "object" &&
          containsJsx(item, enterFunctions),
      );
      if (foundInArray) return true;
    } else if (
      val &&
      typeof val === "object" &&
      containsJsx(val, enterFunctions)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True if the given function lexically returns JSX. Arrow functions with an
 * expression body check the body directly; block-bodied functions scan their
 * top-level return statements without entering nested functions.
 */
function functionReturnsJsx(fnPath: any): boolean {
  const fn = fnPath.node as t.Function;
  if (t.isArrowFunctionExpression(fn) && !t.isBlockStatement(fn.body)) {
    return containsJsx(fn.body, false);
  }
  let found = false;
  fnPath.traverse({
    ReturnStatement(p: any) {
      if (p.node.argument && containsJsx(p.node.argument, false)) {
        found = true;
        p.stop();
      }
    },
    // Do not enter nested function bodies — their returns belong to the inner
    // function, not this one. `path.traverse` does not visit the root node, so
    // the function's own top-level returns are still scanned.
    Function(p: any) {
      p.skip();
    },
  });
  return found;
}

function isComponentArity(fn: t.Function): boolean {
  if (t.isFunctionDeclaration(fn) && fn.generator) return false;
  if (
    (t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) &&
    fn.generator
  ) {
    return false;
  }
  return fn.params.length <= 1;
}

/**
 * Collect local import names bound to `cc` from `sinwan` / `sinwan/component`.
 * Used to detect functions that are already wrapped (so we don't double-wrap)
 * and to know whether a `cc` import needs to be injected.
 */
function collectCcAliases(ast: t.Node): {
  aliases: Set<string>;
  alreadyImported: boolean;
} {
  const aliases = new Set<string>();
  traverse(ast, {
    ImportDeclaration(path) {
      const source = t.moduleSourceValue(path.node.source);
      if (!source) return;
      if (!CC_SOURCE_MODULES.has(source)) return;
      for (const spec of path.node.specifiers ?? []) {
        if (!t.isImportSpecifier(spec)) continue;
        const imported = t.importedBindingName(spec.imported);
        if (imported === "cc") {
          aliases.add(spec.local.name);
        }
      }
    },
  });
  return { aliases, alreadyImported: aliases.size > 0 };
}

function unwrapFunctionPath(fnPath: any): any {
  let current = fnPath;
  while (current && t.isParenthesizedExpression(current.node)) {
    current = singlePath(current.get("expression"));
  }
  return current;
}

function ccCall(arg: t.Expression, ccName: string): t.CallExpression {
  return t.callExpression(t.identifier(ccName), [arg]);
}

/** Keeps `<T>` and the return type when a declaration is rebuilt. */
function withTypes(fn: t.Function, from: t.Function): t.Function {
  fn.typeParameters = from.typeParameters;
  fn.returnType = from.returnType;
  return fn;
}

/**
 * `function X` is hoisted, so module code above it may already read `X`
 * (`Object.assign(X, { Item })`). As `const X = cc(...)` that read would throw.
 * Reads inside functions, export specifiers and types run later or not at all.
 */
function isReadBeforeDeclaration(path: any, name: string): boolean {
  const start = path.node.start ?? 0;
  return (path.parentPath.scope.getBinding(name)?.referencePaths ?? []).some(
    (ref: any) =>
      (ref.node.start ?? 0) < start &&
      !ref.getFunctionParent() &&
      ref.parent?.type !== "ExportSpecifier" &&
      !ref.findParent((parent: any) => parent.isTSType()),
  );
}

/**
 * Local bindings exported through `export { Local }` / `export { Local as Name }`
 * (no `from`), mapped to their exported component name. Type-only exports and
 * non-component export names are skipped.
 */
function collectSpecifierExports(ast: t.Node): Map<string, string> {
  const exports = new Map<string, string>();
  traverse(ast, {
    ExportNamedDeclaration(path: any) {
      const node = path.node;
      if (node.declaration || node.source || node.exportKind === "type") return;
      for (const spec of node.specifiers ?? []) {
        if (!t.isExportSpecifier(spec) || spec.exportKind === "type") continue;
        if (!t.isIdentifier(spec.local) || !t.isIdentifier(spec.exported)) continue;
        if (isComponentName(spec.exported.name)) {
          exports.set(spec.local.name, spec.exported.name);
        }
      }
    },
  });
  return exports;
}

function isTopLevel(path: any): boolean {
  return path.parent?.type === "Program";
}

/**
 * Mutates the AST, wrapping exported component-like functions with `cc(...)`.
 * Returns `true` if any wrapping was performed.
 */
export function autoWrapComponents(ast: t.Node, filename?: string): boolean {
  const { aliases, alreadyImported } = collectCcAliases(ast);
  const ccName = aliases.values().next().value as string | undefined;
  let changed = false;

  const wrapIfCandidate = (fnPath: unknown, name: string | null): boolean => {
    if (name !== null && !isComponentName(name)) return false;
    const fn = (fnPath as { node: t.Function }).node;
    if (!isComponentArity(fn)) return false;
    if (!functionReturnsJsx(fnPath)) return false;
    return true;
  };

  /** Wraps each `const Name = <fn>` whose `componentName(Name)` is defined. */
  const wrapDeclarators = (
    declarators: any[],
    componentName: (name: string) => string | undefined,
  ): void => {
    for (const dPath of declarators) {
      const id = dPath.node.id as t.LVal;
      if (!t.isIdentifier(id)) continue;
      const name = componentName(id.name);
      if (name === undefined || !dPath.node.init) continue;
      const initPath = unwrapFunctionPath(dPath.get("init"));
      if (!t.isFunction(initPath.node)) continue;
      if (!wrapIfCandidate(initPath, name)) continue;
      dPath.node.init = ccCall(initPath.node, ccName ?? "cc");
      changed = true;
    }
  };

  const specifierExports = collectSpecifierExports(ast);

  traverse(ast, {
    ExportNamedDeclaration(path: any) {
      const decl = path.node.declaration;
      if (!decl) return;

      // export function Foo() {...}  ->  export const Foo = cc(function Foo() {...});
      if (t.isFunctionDeclaration(decl) && t.isIdentifier(decl.id)) {
        const name = decl.id.name;
        const fnPath = path.get("declaration");
        if (!wrapIfCandidate(fnPath, name)) return;
        const fnExpr = withTypes(
          t.functionExpression(
            decl.id,
            decl.params,
            decl.body,
            decl.generator,
            decl.async,
          ),
          decl,
        );
        const varDecl = t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier(name),
            ccCall(fnExpr, ccName ?? "cc"),
          ),
        ]);
        path.replaceWith(t.exportNamedDeclaration(varDecl, []));
        changed = true;
        return;
      }

      // export const Foo = <fn>  ->  export const Foo = cc(<fn>)
      if (t.isVariableDeclaration(decl)) {
        wrapDeclarators(path.get("declaration.declarations") as any[], (name) =>
          isComponentName(name) ? name : undefined,
        );
        return;
      }
    },

    // function Foo() {...}; export { Foo }  ->  const Foo = cc(function Foo() {...});
    FunctionDeclaration(path: any) {
      const decl = path.node;
      if (!isTopLevel(path) || !t.isIdentifier(decl.id)) return;
      const exported = specifierExports.get(decl.id.name);
      if (exported === undefined || !wrapIfCandidate(path, exported)) return;
      if (isReadBeforeDeclaration(path, decl.id.name)) return;
      const fnExpr = withTypes(
        t.functionExpression(
          decl.id,
          decl.params,
          decl.body,
          decl.generator,
          decl.async,
        ),
        decl,
      );
      path.replaceWith(
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier(decl.id.name),
            ccCall(fnExpr, ccName ?? "cc"),
          ),
        ]),
      );
      changed = true;
    },

    // const Foo = <fn>; export { Foo }  ->  const Foo = cc(<fn>);
    VariableDeclaration(path: any) {
      if (!isTopLevel(path)) return;
      wrapDeclarators(path.get("declarations") as any[], (name) =>
        specifierExports.get(name),
      );
    },

    ExportDefaultDeclaration(path: any) {
      const decl = t.isNode(path.node.declaration)
        ? t.unwrapParens(path.node.declaration)
        : path.node.declaration;

      // export default function Foo() {...}
      //   -> function Foo() {...}; export default cc(Foo);  (preserves binding)
      if (t.isFunctionDeclaration(decl) && t.isIdentifier(decl.id)) {
        const name = decl.id.name;
        const fnPath = path.get("declaration");
        if (!wrapIfCandidate(fnPath, name)) return;
        const fnDecl = withTypes(
          t.functionDeclaration(
            decl.id,
            decl.params,
            decl.body,
            decl.generator,
            decl.async,
          ),
          decl,
        );
        const exportDefault = t.exportDefaultDeclaration(
          ccCall(t.identifier(name), ccName ?? "cc"),
        );
        path.replaceWithMultiple([fnDecl, exportDefault]);
        changed = true;
        return;
      }

      // export default function() {...}  ->  export default cc(function() {...})
      if (t.isFunctionDeclaration(decl) && !decl.id) {
        const fnPath = path.get("declaration");
        if (!wrapIfCandidate(fnPath, null)) return;
        const fnExpr = withTypes(
          t.functionExpression(
            null,
            decl.params,
            decl.body,
            decl.generator,
            decl.async,
          ),
          decl,
        );
        path.node.declaration = ccCall(fnExpr, ccName ?? "cc");
        changed = true;
        return;
      }

      // export default () => <div/>  /  export default function() {...} (expression form)
      if (t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
        const declPath = unwrapFunctionPath(path.get("declaration"));
        if (!t.isFunction(declPath.node)) return;
        if (!wrapIfCandidate(declPath, null)) return;
        path.node.declaration = ccCall(declPath.node, ccName ?? "cc");
        changed = true;
        return;
      }
    },
  });

  if (changed && !alreadyImported) {
    (ast as t.File).program.body.unshift(
      t.importDeclaration(
        [t.importSpecifier(t.identifier("cc"), t.identifier("cc"))],
        t.stringLiteral("sinwan/component"),
      ),
    );
  }

  // Touch filename so it stays referenced for future debug hooks.
  void filename;
  return changed;
}
