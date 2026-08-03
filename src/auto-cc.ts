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

import * as t from "@babel/types";
import _traverse from "@babel/traverse";

const traverse =
  typeof _traverse === "function"
    ? _traverse
    : ((_traverse as any).default ?? _traverse);

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
      for (const item of val) {
        if (
          item &&
          typeof item === "object" &&
          containsJsx(item, enterFunctions)
        ) {
          return true;
        }
      }
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
    (fn as any).generator
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
    ImportDeclaration(path: any) {
      const source = path.node.source.value as string;
      if (!CC_SOURCE_MODULES.has(source)) return;
      for (const spec of path.node.specifiers) {
        if (!t.isImportSpecifier(spec)) continue;
        const imported = t.isIdentifier(spec.imported)
          ? spec.imported.name
          : spec.imported.value;
        if (imported === "cc") {
          aliases.add(spec.local.name as string);
        }
      }
    },
  });
  return { aliases, alreadyImported: aliases.size > 0 };
}

function ccCall(arg: t.Expression, ccName: string): t.CallExpression {
  return t.callExpression(t.identifier(ccName), [arg]);
}

/**
 * Mutates the AST, wrapping exported component-like functions with `cc(...)`.
 * Returns `true` if any wrapping was performed.
 */
export function autoWrapComponents(ast: t.Node, filename?: string): boolean {
  const { aliases, alreadyImported } = collectCcAliases(ast);
  const ccName = aliases.values().next().value as string | undefined;
  let changed = false;

  const wrapIfCandidate = (
    fnPath: any,
    name: string | null,
  ): "wrapped" | "skip" | "not-candidate" => {
    if (name !== null && !isComponentName(name)) return "not-candidate";
    const fn = fnPath.node as t.Function;
    if (!isComponentArity(fn)) return "not-candidate";
    if (!functionReturnsJsx(fnPath)) return "not-candidate";
    return "wrapped";
  };

  traverse(ast, {
    ExportNamedDeclaration(path: any) {
      const decl = path.node.declaration;
      if (!decl) return;

      // export function Foo() {...}  ->  export const Foo = cc(function Foo() {...});
      if (t.isFunctionDeclaration(decl) && decl.id) {
        const name = decl.id.name;
        if (!isComponentName(name)) return;
        const fnPath = path.get("declaration");
        if (!isComponentArity(decl)) return;
        if (!functionReturnsJsx(fnPath)) return;
        const fnExpr = t.functionExpression(
          decl.id,
          decl.params,
          decl.body,
          decl.generator,
          decl.async,
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
        for (const dPath of path.get("declaration.declarations") as any[]) {
          const id = dPath.node.id as t.LVal;
          if (!t.isIdentifier(id) || !isComponentName(id.name)) continue;
          const init = dPath.node.init as t.Expression | undefined | null;
          if (!init) continue;
          // Already wrapped in cc(...) (or an alias) — skip to stay idempotent.
          if (
            t.isCallExpression(init) &&
            t.isIdentifier(init.callee) &&
            aliases.has(init.callee.name)
          ) {
            continue;
          }
          if (!t.isFunction(init)) continue;
          const initPath = dPath.get("init");
          if (!isComponentArity(init)) continue;
          if (!functionReturnsJsx(initPath)) continue;
          dPath.node.init = ccCall(init, ccName ?? "cc");
          changed = true;
        }
        return;
      }
    },

    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;

      // export default function Foo() {...}
      //   -> function Foo() {...}; export default cc(Foo);  (preserves binding)
      if (t.isFunctionDeclaration(decl) && decl.id) {
        const name = decl.id.name;
        if (!isComponentName(name)) return;
        const fnPath = path.get("declaration");
        if (!isComponentArity(decl)) return;
        if (!functionReturnsJsx(fnPath)) return;
        const fnDecl = t.functionDeclaration(
          decl.id,
          decl.params,
          decl.body,
          decl.generator,
          decl.async,
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
        if (!isComponentArity(decl)) return;
        if (!functionReturnsJsx(fnPath)) return;
        const fnExpr = t.functionExpression(
          null,
          decl.params,
          decl.body,
          decl.generator,
          decl.async,
        );
        path.node.declaration = ccCall(fnExpr, ccName ?? "cc");
        changed = true;
        return;
      }

      // export default () => <div/>  /  export default function() {...} (expression form)
      if (t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
        const declPath = path.get("declaration");
        if (!isComponentArity(decl)) return;
        if (!functionReturnsJsx(declPath)) return;
        path.node.declaration = ccCall(decl, ccName ?? "cc");
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
