/**
 * SinwanJS Compiler — JSX lint pass
 *
 * Reports JSX that compiles but silently misbehaves at runtime. Runs on the
 * parsed source before any other pass, so it only sees arrows the user wrote
 * (not the `() => expr` getters the compiler adds) and original offsets.
 * The compiler has no type information: rules target shapes TypeScript
 * accepts but Sinwan treats differently.
 */

import * as t from "./ast/types";
import type { Node } from "./ast/node";
import type { Reporter } from "./diagnostics";

/** Built-in control-flow tags, recognised only when imported from Sinwan. */
const CONTROL_FLOW = new Set([
  "Show",
  "For",
  "Index",
  "Key",
  "Match",
  "Switch",
  "Dynamic",
  "Portal",
  "Suspense",
  "ErrorBoundary",
  "Activity",
  "Visible",
  "Virtual",
  "ViewTransition",
]);

const SINWAN_SOURCES = new Set([
  "sinwan",
  "sinwan/control-flow",
  "sinwan/react",
]);

/** `when` on these is compared by identity: a fresh object re-renders. */
const IDENTITY_WHEN = new Set(["Show", "Match", "Key"]);

/** Props sinwan-ui controls treat as controlled when present. */
const CONTROLLED_PROPS = new Set(["value", "checked", "open"]);

/**
 * Mirrors `isCallbackPropKey` in `sinwan/src/component/live-props.ts`: these
 * props are never unwrapped as getters at runtime.
 */
const DOM_EVENT_PROP =
  /^on(?:abort|animation(?:end|iteration|start)|auxclick|before(?:input|toggle)|blur|cancel|canplay(?:through)?|change|click|close|composition(?:end|start|update)|contextmenu|copy|cuechange|cut|dblclick|drag(?:end|enter|leave|over|start)?|drop|durationchange|emptied|ended|error|focus(?:in|out)?|formdata|gotpointercapture|input|invalid|key(?:down|press|up)|load(?:ed(?:data|metadata)?|start)?|lostpointercapture|mouse(?:down|enter|leave|move|out|over|up)|paste|pause|play(?:ing)?|pointer(?:cancel|down|enter|leave|move|out|over|up)|progress|ratechange|reset|resize|scroll|securitypolicyviolation|seeked|seeking|select|slotchange|stalled|submit|suspend|timeupdate|toggle|touch(?:cancel|end|move|start)|transition(?:cancel|end|run|start)|volumechange|waiting|wheel)$/;

export function isCallbackPropName(name: string): boolean {
  if (name.length < 3 || !name.startsWith("on")) return false;
  const third = name.charCodeAt(2);
  if (third >= 65 && third <= 90) return true;
  return DOM_EVENT_PROP.test(name);
}

/** Local names of Sinwan control-flow imports, mapped to their canonical name. */
function collectControlFlowImports(program: Node): Map<string, string> {
  const names = new Map<string, string>();
  const body = Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    if (!t.isImportDeclaration(statement)) continue;
    const source = statement.source.value;
    if (typeof source !== "string" || !SINWAN_SOURCES.has(source)) continue;
    for (const specifier of statement.specifiers) {
      if (!t.isImportSpecifier(specifier)) continue;
      const imported = specifier.imported;
      const importedName = t.isStringLiteral(imported)
        ? imported.value
        : imported.name;
      if (typeof importedName === "string" && CONTROL_FLOW.has(importedName)) {
        names.set(specifier.local.name, importedName);
      }
    }
  }
  return names;
}

function tagName(name: Node): string | null {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name) && t.isJSXIdentifier(name.property)) {
    const object = tagName(name.object);
    return object === null ? null : `${object}.${name.property.name}`;
  }
  return null;
}

function isComponentTag(name: Node, label: string): boolean {
  if (t.isJSXMemberExpression(name)) return true;
  const first = label.charCodeAt(0);
  return first >= 65 && first <= 90;
}

/** Strip parens and TS-only wrappers (`as`, `satisfies`, `!`). */
function unwrapExpression(node: Node): Node {
  let current = t.unwrapParens(node);
  while (
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression") &&
    t.isNode(current.expression)
  ) {
    current = t.unwrapParens(current.expression);
  }
  return current;
}

/** True when evaluating the expression can produce a new object or array. */
function createsFreshObject(node: Node): boolean {
  const expression = unwrapExpression(node);
  switch (expression.type) {
    case "ObjectExpression":
    case "ArrayExpression":
    case "NewExpression":
      return true;
    case "ConditionalExpression":
      return (
        (t.isNode(expression.consequent) &&
          createsFreshObject(expression.consequent)) ||
        (t.isNode(expression.alternate) &&
          createsFreshObject(expression.alternate))
      );
    case "LogicalExpression":
      return t.isNode(expression.right) && createsFreshObject(expression.right);
    default:
      return false;
  }
}

function isZeroArgumentFunction(node: Node): boolean {
  const expression = unwrapExpression(node);
  return (
    (t.isArrowFunctionExpression(expression) ||
      t.isFunctionExpression(expression)) &&
    (expression.params?.length ?? 0) === 0
  );
}

function isUndefinedLiteral(node: Node): boolean {
  const expression = unwrapExpression(node);
  if (t.isIdentifier(expression)) return expression.name === "undefined";
  return (
    expression.type === "UnaryExpression" &&
    expression.operator === "void" &&
    t.isNode(expression.argument) &&
    expression.argument.type === "Literal"
  );
}

function lintOpeningElement(
  opening: Node,
  controlFlow: Map<string, string>,
  report: Reporter,
): void {
  if (!t.isNode(opening.name)) return;
  const label = tagName(opening.name);
  if (label === null || !isComponentTag(opening.name, label)) return;
  const builtin = controlFlow.get(label);

  for (const attribute of opening.attributes ?? []) {
    if (!t.isJSXAttribute(attribute) || !t.isJSXIdentifier(attribute.name)) {
      continue;
    }
    const name = attribute.name.name;
    const value = attribute.value;
    if (!t.isJSXExpressionContainer(value)) continue;
    const expression = value.expression;

    if (builtin === undefined) {
      if (
        name !== "children" &&
        name !== "ref" &&
        !isCallbackPropName(name) &&
        isZeroArgumentFunction(expression)
      ) {
        report(
          "SW101",
          expression.start,
          `<${label} ${name}={() => …}>: a zero-argument function on a component prop is read as a getter, so the component receives its return value, not the function.`,
          "For a callback, give it a parameter ((_) => …) or an on… name. For a value, pass it directly: the compiler already tracks reactive reads.",
        );
      }
      if (CONTROLLED_PROPS.has(name) && isUndefinedLiteral(expression)) {
        report(
          "SW103",
          expression.start,
          `<${label} ${name}={undefined}>: the prop is present, so a controlled component treats it as controlled with no value and ignores input.`,
          `Omit ${name} for an uncontrolled component, or pass null or "" for an empty controlled one.`,
        );
      }
    } else if (
      builtin === "Dynamic" &&
      name === "component" &&
      isZeroArgumentFunction(expression)
    ) {
      report(
        "SW106",
        expression.start,
        `<${label} component={() => …}>: a zero-argument function is read as a getter and called, so Dynamic receives its result instead of a component and renders nothing.`,
        "Pass a component defined once (component={Row}, where Row = cc(...)), or give the function a props parameter.",
      );
    } else if (
      name === "when" &&
      IDENTITY_WHEN.has(builtin) &&
      createsFreshObject(expression)
    ) {
      report(
        "SW102",
        expression.start,
        `<${label} when={…}> creates a new object on every evaluation, so its content is rebuilt whenever anything the expression reads changes.`,
        "Pass a boolean (when={!!x}) and read the value in the children, or keep the object stable with computed().",
      );
    }
  }
}

/** Built-ins that call their children once per item. */
const LIST_BUILTINS = new Set(["For", "Index", "Virtual"]);

function isFunctionNode(node: Node): boolean {
  return t.isArrowFunctionExpression(node) || t.isFunctionExpression(node);
}

/** A child that can never be a render function (JSX, text, string literals). */
function isStaticChild(child: Node): boolean {
  if (child.type === "JSXText") {
    return typeof child.value === "string" && child.value.trim() !== "";
  }
  if (child.type === "JSXElement" || child.type === "JSXFragment") return true;
  if (!t.isJSXExpressionContainer(child)) return false;
  const expression = unwrapExpression(child.expression);
  return (
    expression.type === "JSXElement" ||
    expression.type === "JSXFragment" ||
    expression.type === "TemplateLiteral" ||
    (expression.type === "Literal" && typeof expression.value === "string")
  );
}

function renderFunction(children: Node[]): Node | null {
  for (const child of children) {
    if (!t.isJSXExpressionContainer(child)) continue;
    const expression = unwrapExpression(child.expression);
    if (isFunctionNode(expression)) return expression;
  }
  return null;
}

function bindsName(fn: Node, name: string): boolean {
  return (fn.params ?? []).some(
    (param) => t.isIdentifier(param) && param.name === name,
  );
}

function isName(node: Node | null | undefined, name: string): boolean {
  return t.isIdentifier(node) && node.name === name;
}

/**
 * First use of an `Index` item getter as if it were the item: a property
 * read, an operand, a template part or a truthiness test. Nested functions
 * that rebind the name are skipped.
 */
function findGetterMisuse(node: Node, name: string): Node | null {
  if (
    (node.type === "MemberExpression" && isName(node.object, name)) ||
    ((node.type === "BinaryExpression" || node.type === "LogicalExpression") &&
      (isName(node.left, name) || isName(node.right, name))) ||
    (node.type === "UnaryExpression" &&
      node.operator !== "typeof" &&
      isName(node.argument, name))
  ) {
    return node;
  }
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.some((expression) => isName(expression, name))
  ) {
    return node;
  }
  for (const key in node) {
    if (key === "leadingComments" || key === "trailingComments") continue;
    const value = (node as Record<string, unknown>)[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!t.isNode(child)) continue;
      if (
        (isFunctionNode(child) || child.type === "FunctionDeclaration") &&
        bindsName(child, name)
      ) {
        continue;
      }
      const found = findGetterMisuse(child, name);
      if (found) return found;
    }
  }
  return null;
}

function lintIndexChild(fn: Node, report: Reporter): void {
  const item = fn.params?.[0];
  if (!item) return;
  if (item.type === "ObjectPattern" || item.type === "ArrayPattern") {
    report(
      "SW104",
      item.start,
      "<Index> passes each item as a getter, so destructuring it reads properties of the function, not of the item.",
      "Take the getter and call it: (item) => item().name. Use <For> to receive the item value directly.",
    );
    return;
  }
  if (!t.isIdentifier(item) || !t.isNode(fn.body)) return;
  const misuse = findGetterMisuse(fn.body, item.name);
  if (misuse) {
    report(
      "SW104",
      misuse.start,
      `<Index> passes each item as a getter: this uses ${item.name} itself, not the item it returns.`,
      `Call it: ${item.name}(). Use <For> to receive the item value directly.`,
    );
  }
}

function lintElement(
  element: Node,
  controlFlow: Map<string, string>,
  report: Reporter,
): void {
  const opening = element.openingElement;
  if (!t.isJSXOpeningElement(opening) || !t.isJSXIdentifier(opening.name)) {
    return;
  }
  const builtin = controlFlow.get(opening.name.name);
  if (builtin === undefined || !LIST_BUILTINS.has(builtin)) return;
  const children = Array.isArray(element.children) ? element.children : [];
  const staticChild = children.find(isStaticChild);
  if (staticChild) {
    report(
      "SW105",
      staticChild.start,
      `<${builtin}> children must be a render function called for each item; this child is not one.`,
      `Wrap it: {(item) => <Row item={item} />}.`,
    );
    return;
  }
  if (builtin === "Index") {
    const fn = renderFunction(children);
    if (fn) lintIndexChild(fn, report);
  }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const key in node) {
    if (key === "leadingComments" || key === "trailingComments") continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (t.isNode(child)) walk(child, visit);
      }
    } else if (t.isNode(value)) {
      walk(value, visit);
    }
  }
}

/** Report SW101–SW106 for one parsed file. */
export function lintJsx(program: Node, report: Reporter): void {
  const controlFlow = collectControlFlowImports(program);
  walk(program, (node) => {
    if (t.isJSXOpeningElement(node)) {
      lintOpeningElement(node, controlFlow, report);
    } else if (node.type === "JSXElement") {
      lintElement(node, controlFlow, report);
    }
  });
}
