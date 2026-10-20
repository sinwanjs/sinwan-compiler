/**
 * Rewrite flat `cc` / auto-`cc` object destructure so prop reads stay live.
 *
 * `cc(({ value }) => <span>{value}</span>)` becomes
 * `cc((props) => <span>{props.value}</span>)` before reactive wrap, so JSX
 * emits `() => props.value` instead of snapshotting a destructured local.
 *
 * Nested patterns are left as snapshots. JSX spreads of the props (or rest)
 * identifier use `getSpreadProps` so native attributes keep getter functions.
 */

import * as t from "./ast/types";
import { traverse, singlePath, type NodePath } from "./ast/traverse";

const CC_SOURCE_MODULES = new Set(["sinwan", "sinwan/component"]);
const LIVE_REST_LOCAL = "_$createLiveRest";
const SPREAD_LOCAL = "_$getSpreadProps";
const LIVE_REST_IMPORTED = "createLiveRest";
const SPREAD_IMPORTED = "getSpreadProps";

interface FlatProp {
  key: t.Identifier | t.StringLiteral;
  keyName: string;
  local: string;
  defaultValue: t.Expression | null;
}

interface FlatPattern {
  props: FlatProp[];
  rest: string | null;
}

function collectCcAliases(ast: t.Node): Set<string> {
  const aliases = new Set<string>();
  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source?.value;
      if (typeof source !== "string") return;
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
  return aliases;
}

function parseFlatObjectPattern(pattern: t.ObjectPattern): FlatPattern | null {
  const props: FlatProp[] = [];
  let rest: string | null = null;
  for (const prop of pattern.properties ?? []) {
    if (t.isRestElement(prop)) {
      if (!t.isIdentifier(prop.argument)) return null;
      rest = prop.argument.name;
      continue;
    }
    if (!t.isObjectProperty(prop) || prop.computed) return null;
    if (!t.isIdentifier(prop.key) && !t.isStringLiteral(prop.key)) return null;
    if (!prop.value) return null;
    let value: t.Node = prop.value;
    let defaultValue: t.Expression | null = null;
    if (t.isAssignmentPattern(value)) {
      defaultValue = value.right;
      value = value.left;
    }
    if (!t.isIdentifier(value)) return null;
    const keyName = t.isIdentifier(prop.key) ? prop.key.name : prop.key.value;
    props.push({
      key: prop.key,
      keyName,
      local: value.name,
      defaultValue,
    });
  }
  return { props, rest };
}

function pickPropsName(used: Set<string>): string {
  if (!used.has("props")) return "props";
  let index = 0;
  let name = "_props";
  while (used.has(name)) {
    index += 1;
    name = `_props${index}`;
  }
  return name;
}

function collectUsedNames(fnPath: NodePath): Set<string> {
  const used = new Set<string>();
  fnPath.traverse({
    Identifier(p) {
      if (typeof p.node.name === "string") used.add(p.node.name);
    },
  });
  return used;
}

function memberAccess(
  propsName: string,
  key: t.Identifier | t.StringLiteral,
): t.MemberExpression {
  if (t.isIdentifier(key)) {
    return t.memberExpression(t.identifier(propsName), t.identifier(key.name));
  }
  const computedKey = t.isStringLiteral(key) ? key.value : String(key.value ?? "");
  return t.memberExpression(
    t.identifier(propsName),
    t.stringLiteral(computedKey),
    true,
  );
}

function liveRead(propsName: string, binding: FlatProp): t.Expression {
  const read = memberAccess(propsName, binding.key);
  if (!binding.defaultValue) return read;
  return t.conditionalExpression(
    t.binaryExpression(
      "===",
      memberAccess(propsName, binding.key),
      t.unaryExpression("void", t.numericLiteral(0)),
    ),
    binding.defaultValue,
    read,
  );
}

function ensureBlockBody(
  fn: t.Function,
): t.Node & { type: "BlockStatement"; body: t.Node[] } {
  if (t.isBlockStatement(fn.body)) return fn.body;
  const body = t.blockStatement([t.returnStatement(fn.body as t.Expression)]);
  fn.body = body;
  if (t.isArrowFunctionExpression(fn)) {
    fn.expression = false;
  }
  return body;
}

function replaceWithExpression(path: any, expr: t.Expression): void {
  const parent = path.parent as t.Node;
  if (
    t.isObjectProperty(parent) &&
    parent.shorthand &&
    parent.value === path.node
  ) {
    parent.shorthand = false;
    parent.value = expr;
    return;
  }
  path.replaceWith(expr);
}

function isCcParamBinding(
  path: any,
  locals: Set<string>,
  fnNode: t.Function,
): boolean {
  if (!path.isReferencedIdentifier()) return false;
  if (!locals.has(path.node.name)) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  const fnParent = binding.path.getFunctionParent();
  return fnParent?.node === fnNode;
}

function rewriteSpreads(
  fnPath: any,
  liveNames: Set<string>,
  fnNode: t.Function,
): boolean {
  let changed = false;
  fnPath.traverse({
    JSXSpreadAttribute(p: any) {
      const arg = p.node.argument;
      if (!t.isIdentifier(arg) || !liveNames.has(arg.name)) return;
      const binding = p.scope.getBinding(arg.name);
      const fnParent = binding?.path.getFunctionParent();
      if (fnParent && fnParent.node !== fnNode) return;
      p.node.argument = t.callExpression(t.identifier(SPREAD_LOCAL), [
        t.identifier(arg.name),
      ]);
      changed = true;
    },
  });
  return changed;
}

function hasLocalSpecifier(
  stmt: t.ImportDeclaration,
  local: string,
): boolean {
  return stmt.specifiers.some(
    (spec) => t.isImportSpecifier(spec) && spec.local.name === local,
  );
}

function ensureComponentImport(
  ast: t.File,
  imported: string,
  local: string,
): void {
  let target: t.ImportDeclaration | null = null;
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    if (hasLocalSpecifier(stmt, local)) return;
    if (t.moduleSourceValue(stmt.source) === "sinwan/component") {
      target = stmt;
    } else if (t.moduleSourceValue(stmt.source) === "sinwan" && target === null) {
      target = stmt;
    }
  }
  const spec = t.importSpecifier(t.identifier(local), t.identifier(imported));
  if (target) {
    target.specifiers.push(spec);
  }
}

function copyPatternType(pattern: t.ObjectPattern, id: t.Identifier): void {
  if (pattern.typeAnnotation) {
    id.typeAnnotation = pattern.typeAnnotation;
  }
  if (pattern.optional) {
    id.optional = true;
  }
}

function rewriteFunctionDestructure(
  fnPath: NodePath,
): { rest: boolean; spread: boolean } {
  if (!t.isFunction(fnPath.node)) {
    return { rest: false, spread: false };
  }
  const fn = fnPath.node;
  const param = fn.params[0];
  if (!param) {
    return { rest: false, spread: false };
  }

  if (t.isIdentifier(param)) {
    const spread = rewriteSpreads(fnPath, new Set([param.name]), fn);
    return { rest: false, spread };
  }

  if (!t.isObjectPattern(param)) {
    return { rest: false, spread: false };
  }

  const flat = parseFlatObjectPattern(param);
  if (!flat) {
    return { rest: false, spread: false };
  }

  const used = collectUsedNames(fnPath);
  for (const binding of flat.props) used.add(binding.local);
  if (flat.rest) used.add(flat.rest);
  const propsName = pickPropsName(used);
  const locals = new Set(flat.props.map((binding) => binding.local));
  const reads = new Map<string, FlatProp>();
  for (const binding of flat.props) {
    reads.set(binding.local, binding);
  }

  fnPath.traverse({
    Identifier(p: any) {
      if (p.findParent((parent: { node: t.Node }) => parent.node === param)) {
        return;
      }
      if (!isCcParamBinding(p, locals, fn)) return;
      const binding = reads.get(p.node.name);
      if (!binding) return;
      replaceWithExpression(p, liveRead(propsName, binding));
    },
  });

  const propsId = t.identifier(propsName);
  copyPatternType(param, propsId);
  fn.params[0] = propsId;

  const liveNames = new Set<string>([propsName]);
  if (flat.rest) {
    const body = ensureBlockBody(fn);
    body.body.unshift(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.identifier(flat.rest),
          t.callExpression(t.identifier(LIVE_REST_LOCAL), [
            t.identifier(propsName),
            t.arrayExpression(
              flat.props.map((binding) => t.stringLiteral(binding.keyName)),
            ),
          ]),
        ),
      ]),
    );
    liveNames.add(flat.rest);
  }

  const spread = rewriteSpreads(fnPath, liveNames, fn);
  return { rest: flat.rest != null, spread };
}

/**
 * Rewrite flat `cc` destructure and raw JSX spreads. Returns whether any
 * helper imports are required.
 */
export function rewriteLiveCcDestructure(ast: t.Node): {
  rest: boolean;
  spread: boolean;
} {
  const aliases = collectCcAliases(ast);
  if (aliases.size === 0) return { rest: false, spread: false };

  let needsRest = false;
  let needsSpread = false;

  traverse(ast, {
    CallExpression(path: any) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !aliases.has(callee.name)) return;
      const argPaths = path.get("arguments");
      let fnPath = Array.isArray(argPaths) ? argPaths[0] : argPaths;
      if (!fnPath) return;
      while (t.isParenthesizedExpression(fnPath.node)) {
        fnPath = singlePath(fnPath.get("expression"));
      }
      const result = rewriteFunctionDestructure(fnPath);
      needsRest = needsRest || result.rest;
      needsSpread = needsSpread || result.spread;
    },
  });

  if (needsRest) {
    ensureComponentImport(ast as t.File, LIVE_REST_IMPORTED, LIVE_REST_LOCAL);
  }
  if (needsSpread) {
    ensureComponentImport(ast as t.File, SPREAD_IMPORTED, SPREAD_LOCAL);
  }
  return { rest: needsRest, spread: needsSpread };
}
