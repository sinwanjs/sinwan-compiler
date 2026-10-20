/**
 * ESTree node builders and type guards for oxc ASTs.
 */

import type { Expression, Function, Identifier, Literal, Node } from "./node";

function lit(
  value: string | number | boolean | null,
  raw?: string,
): Literal {
  return {
    type: "Literal",
    value,
    raw:
      raw ??
      (typeof value === "string"
        ? JSON.stringify(value)
        : value === null
          ? "null"
          : String(value)),
  };
}

export function identifier(name: string): Identifier {
  return { type: "Identifier", name };
}

export function stringLiteral(value: string): Literal {
  return lit(value);
}

export function numericLiteral(value: number): Literal {
  return lit(value);
}

export function booleanLiteral(value: boolean): Literal {
  return lit(value);
}

export function nullLiteral(): Literal {
  return lit(null);
}

export function callExpression(
  callee: Expression,
  args: Expression[],
): CallExpression {
  return {
    type: "CallExpression",
    callee,
    arguments: args,
    optional: false,
  };
}

export function memberExpression(
  object: Expression,
  property: Expression,
  computed = false,
): Node {
  return {
    type: "MemberExpression",
    object,
    property,
    computed,
    optional: false,
  };
}

export function arrowFunctionExpression(
  params: Node[],
  body: Node,
  expression = !isBlockStatement(body),
): Function & { type: "ArrowFunctionExpression" } {
  return {
    type: "ArrowFunctionExpression",
    params,
    body,
    expression,
    async: false,
    generator: false,
    id: null,
  };
}

export function functionExpression(
  id: Identifier | Node | null,
  params: Node[],
  body: Node,
  generator = false,
  async = false,
): Function {
  return {
    type: "FunctionExpression",
    id,
    params,
    body,
    generator,
    async,
  };
}

export function functionDeclaration(
  id: Identifier | Node | null,
  params: Node[],
  body: Node,
  generator = false,
  async = false,
): Function {
  return {
    type: "FunctionDeclaration",
    id,
    params,
    body,
    generator,
    async,
  };
}

export function variableDeclarator(id: Node, init: Expression | null = null): Node {
  return { type: "VariableDeclarator", id, init };
}

export function variableDeclaration(
  kind: "const" | "let" | "var",
  declarations: Node[],
): VariableDeclaration {
  return { type: "VariableDeclaration", kind, declarations };
}

export function arrayExpression(elements: (Expression | null)[]): Node {
  return { type: "ArrayExpression", elements };
}

export function objectExpression(properties: Node[]): Node {
  return { type: "ObjectExpression", properties };
}

export function objectProperty(
  key: Node,
  value: Node,
  computed = false,
  shorthand = false,
): Node {
  return {
    type: "Property",
    key,
    value,
    kind: "init",
    method: false,
    shorthand,
    computed,
  };
}

export function objectPattern(properties: Node[]): ObjectPattern {
  return { type: "ObjectPattern", properties };
}

export function restElement(argument: Node): Node {
  return { type: "RestElement", argument };
}

export function arrayPattern(elements: (Node | null)[]): Node {
  return { type: "ArrayPattern", elements };
}

export function assignmentPattern(left: Node, right: Expression): Node {
  return { type: "AssignmentPattern", left, right };
}

export function importSpecifier(local: Identifier, imported: Identifier): Node {
  return { type: "ImportSpecifier", local, imported, importKind: "value" };
}

export function importDeclaration(
  specifiers: Node[],
  source: Literal,
): ImportDeclaration {
  return {
    type: "ImportDeclaration",
    specifiers,
    source,
    importKind: "value",
    attributes: [],
  };
}

export function exportNamedDeclaration(
  declaration: Node | null,
  specifiers: Node[] = [],
): Node {
  return {
    type: "ExportNamedDeclaration",
    declaration,
    specifiers,
    source: null,
    exportKind: "value",
    attributes: [],
  };
}

export function exportDefaultDeclaration(declaration: Node): Node {
  return { type: "ExportDefaultDeclaration", declaration };
}

export function jsxExpressionContainer(expression: Expression): Node {
  return { type: "JSXExpressionContainer", expression };
}

export function blockStatement(
  body: Node[],
): Node & { type: "BlockStatement"; body: Node[] } {
  return { type: "BlockStatement", body };
}

export function returnStatement(argument: Expression | null = null): Node {
  return { type: "ReturnStatement", argument };
}

export function binaryExpression(
  operator: string,
  left: Expression,
  right: Expression,
): Node {
  return { type: "BinaryExpression", operator, left, right };
}

export function conditionalExpression(
  test: Expression,
  consequent: Expression,
  alternate: Expression,
): Node {
  return { type: "ConditionalExpression", test, consequent, alternate };
}

export function unaryExpression(
  operator: string,
  argument: Expression,
  prefix = true,
): Node {
  return { type: "UnaryExpression", operator, argument, prefix };
}

export function tsNonNullExpression(expression: Expression): Node {
  return { type: "TSNonNullExpression", expression };
}

export function tsAsExpression(expression: Expression, typeAnnotation: Node): Node {
  return { type: "TSAsExpression", expression, typeAnnotation };
}

export function tsTypeAssertion(expression: Expression, typeAnnotation: Node): Node {
  return { type: "TSTypeAssertion", expression, typeAnnotation };
}

export function isNode(n: unknown): n is Node {
  return !!n && typeof n === "object" && typeof (n as Node).type === "string";
}

export function isIdentifier(
  n: unknown,
  opts?: { name?: string },
): n is Identifier {
  if (!isNode(n) || n.type !== "Identifier" || typeof n.name !== "string")
    return false;
  if (opts?.name !== undefined) return n.name === opts.name;
  return true;
}

export function isLiteral(n: unknown): n is Literal {
  return isNode(n) && n.type === "Literal";
}

export function isStringLiteral(
  n: unknown,
  opts?: { value?: string },
): n is Literal & { value: string } {
  if (!isLiteral(n) || typeof n.value !== "string") return false;
  if (opts?.value !== undefined) return n.value === opts.value;
  return true;
}

export function isNumericLiteral(n: unknown): n is Literal {
  return isLiteral(n) && typeof n.value === "number";
}

export function isBooleanLiteral(n: unknown): n is Literal {
  return isLiteral(n) && typeof n.value === "boolean";
}

export function isNullLiteral(n: unknown): n is Literal {
  return isLiteral(n) && n.value === null && !n.regex;
}

export function isTemplateLiteral(
  n: unknown,
): n is Node & {
  type: "TemplateLiteral";
  expressions: Node[];
  quasis: Node[];
} {
  return isNode(n) && n.type === "TemplateLiteral";
}

export function templateElementRaw(n: Node | undefined | null): string {
  const raw = n?.value;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "raw" in raw) {
    return String(raw.raw ?? "");
  }
  return "";
}

export function isCallExpression(
  n: unknown,
): n is Node & { type: "CallExpression"; callee: Node; arguments: Node[] } {
  return isNode(n) && n.type === "CallExpression";
}

export function isOptionalCallExpression(n: unknown): boolean {
  return (
    isNode(n) &&
    ((n.type === "CallExpression" && n.optional === true) ||
      (n.type === "ChainExpression" &&
        isNode(n.expression) &&
        n.expression.type === "CallExpression" &&
        n.expression.optional === true))
  );
}

export function isMemberExpression(
  n: unknown,
): n is Node & {
  type: "MemberExpression";
  object: Node;
  property: Node;
  computed?: boolean;
  optional?: boolean;
} {
  return isNode(n) && n.type === "MemberExpression";
}

export function isOptionalMemberExpression(
  n: unknown,
): n is Node & {
  type: string;
  object: Node;
  property: Node;
  computed?: boolean;
  optional?: boolean;
} {
  return (
    isNode(n) &&
    ((n.type === "MemberExpression" && n.optional === true) ||
      (n.type === "ChainExpression" &&
        isNode(n.expression) &&
        n.expression.type === "MemberExpression"))
  );
}

export function isChainExpression(n: unknown): boolean {
  return isNode(n) && n.type === "ChainExpression";
}

/** Unwrap ChainExpression to the inner member/call expression. */
export function unwrapChain(n: Node): Node {
  return isChainExpression(n) && isNode(n.expression)
    ? (n.expression as Node)
    : n;
}

export function isParenthesizedExpression(n: unknown): boolean {
  return isNode(n) && n.type === "ParenthesizedExpression";
}

/**
 * Strip ParenthesizedExpression wrappers. Oxc preserves them by default;
 * Babel typically does not.
 */
export function unwrapParens(n: Node): Node {
  let current: Node | undefined = n;
  while (
    current &&
    isParenthesizedExpression(current) &&
    isNode(current.expression)
  ) {
    current = current.expression as Node;
  }
  return current ?? n;
}

/** Unwrap parens and ChainExpression so CallExpression fields are accessible. */
export function unwrapCall(n: Node): Node {
  return unwrapParens(unwrapChain(unwrapParens(n)));
}

export function isObjectExpression(
  n: unknown,
): n is Node & { type: "ObjectExpression"; properties: Node[] } {
  return isNode(n) && n.type === "ObjectExpression";
}

export function isObjectProperty(
  n: unknown,
): n is Node & {
  type: "Property" | "ObjectProperty";
  key: Node;
  value: Node;
  computed?: boolean;
  shorthand?: boolean;
} {
  return isNode(n) && (n.type === "Property" || n.type === "ObjectProperty");
}

export function isObjectPattern(
  n: unknown,
): n is Node & { type: "ObjectPattern"; properties: Node[] } {
  return isNode(n) && n.type === "ObjectPattern";
}

export function isArrayPattern(
  n: unknown,
): n is Node & { type: "ArrayPattern"; elements: (Node | null)[] } {
  return isNode(n) && n.type === "ArrayPattern";
}

export function isRestElement(
  n: unknown,
): n is Node & { type: "RestElement"; argument: Node } {
  return isNode(n) && n.type === "RestElement";
}

export function isSpreadElement(
  n: unknown,
): n is Node & { type: "SpreadElement"; argument: Node } {
  return isNode(n) && n.type === "SpreadElement";
}

export function isAssignmentPattern(
  n: unknown,
): n is Node & { type: "AssignmentPattern"; left: Node; right: Node } {
  return isNode(n) && n.type === "AssignmentPattern";
}

export function isBlockStatement(
  n: unknown,
): n is Node & { type: "BlockStatement"; body: Node[] } {
  return isNode(n) && n.type === "BlockStatement";
}

export function isVariableDeclaration(
  n: unknown,
  opts?: { kind?: string },
): n is Node & {
  type: "VariableDeclaration";
  kind: string;
  declarations: Node[];
} {
  if (!isNode(n) || n.type !== "VariableDeclaration") return false;
  if (opts?.kind !== undefined) return n.kind === opts.kind;
  return true;
}

export function isVariableDeclarator(
  n: unknown,
): n is Node & { type: "VariableDeclarator"; id: Node; init?: Node | null } {
  return isNode(n) && n.type === "VariableDeclarator";
}

export function isFunctionDeclaration(n: unknown): n is Function {
  return isNode(n) && n.type === "FunctionDeclaration";
}

export function isFunctionExpression(n: unknown): n is Function {
  return isNode(n) && n.type === "FunctionExpression";
}

export function isArrowFunctionExpression(n: unknown): n is Function {
  return isNode(n) && n.type === "ArrowFunctionExpression";
}

export function isFunction(n: unknown): n is Function {
  return (
    isFunctionDeclaration(n) ||
    isFunctionExpression(n) ||
    isArrowFunctionExpression(n)
  );
}

export function isImportDeclaration(
  n: unknown,
): n is Node & {
  type: "ImportDeclaration";
  specifiers: Node[];
  source: Literal;
} {
  return isNode(n) && n.type === "ImportDeclaration";
}

export function isImportSpecifier(
  n: unknown,
): n is Node & {
  type: "ImportSpecifier";
  local: Identifier;
  imported: Node;
} {
  return isNode(n) && n.type === "ImportSpecifier";
}

export function isImportDefaultSpecifier(
  n: unknown,
): n is Node & { type: "ImportDefaultSpecifier"; local: Identifier } {
  return isNode(n) && n.type === "ImportDefaultSpecifier";
}

export function isImportNamespaceSpecifier(
  n: unknown,
): n is Node & { type: "ImportNamespaceSpecifier"; local: Identifier } {
  return isNode(n) && n.type === "ImportNamespaceSpecifier";
}

export function isExportSpecifier(n: unknown): boolean {
  return isNode(n) && n.type === "ExportSpecifier";
}

export function isClassDeclaration(n: unknown): boolean {
  return isNode(n) && n.type === "ClassDeclaration";
}

export function isJSXElement(
  n: unknown,
): n is Node & {
  type: "JSXElement";
  openingElement: Node;
  children: Node[];
} {
  return isNode(n) && n.type === "JSXElement";
}

export function isJSXFragment(n: unknown): boolean {
  return isNode(n) && n.type === "JSXFragment";
}

export function isJSXIdentifier(
  n: unknown,
): n is Node & { type: "JSXIdentifier"; name: string } {
  return isNode(n) && n.type === "JSXIdentifier" && typeof n.name === "string";
}

export function isJSXOpeningElement(
  n: unknown,
): n is Node & {
  type: "JSXOpeningElement";
  name: Node;
  attributes: Node[];
} {
  return isNode(n) && n.type === "JSXOpeningElement";
}

export function isJSXMemberExpression(
  n: unknown,
): n is Node & {
  type: "JSXMemberExpression";
  object: Node;
  property: Node;
} {
  return isNode(n) && n.type === "JSXMemberExpression";
}

export function isJSXAttribute(
  n: unknown,
): n is Node & { type: "JSXAttribute"; name: Node; value?: Node | null } {
  return isNode(n) && n.type === "JSXAttribute";
}

export function isJSXSpreadAttribute(n: unknown): boolean {
  return isNode(n) && n.type === "JSXSpreadAttribute";
}

export function isJSXExpressionContainer(
  n: unknown,
): n is Node & { type: "JSXExpressionContainer"; expression: Node } {
  return isNode(n) && n.type === "JSXExpressionContainer";
}

export function isJSXEmptyExpression(n: unknown): boolean {
  return isNode(n) && n.type === "JSXEmptyExpression";
}

export function isTSNonNullExpression(
  n: unknown,
): n is Node & { type: "TSNonNullExpression"; expression: Node } {
  return isNode(n) && n.type === "TSNonNullExpression";
}

export function isTSAsExpression(n: unknown): boolean {
  return isNode(n) && n.type === "TSAsExpression";
}

export function isTSTypeAssertion(n: unknown): boolean {
  return isNode(n) && n.type === "TSTypeAssertion";
}

export function isTSSatisfiesExpression(n: unknown): boolean {
  return isNode(n) && n.type === "TSSatisfiesExpression";
}

export function isTSTypeAnnotation(n: unknown): boolean {
  return isNode(n) && n.type === "TSTypeAnnotation";
}

export function isExpression(n: unknown): n is Expression {
  if (!isNode(n)) return false;
  switch (n.type) {
    case "Identifier":
    case "Literal":
    case "ThisExpression":
    case "ArrayExpression":
    case "ObjectExpression":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassExpression":
    case "UnaryExpression":
    case "UpdateExpression":
    case "BinaryExpression":
    case "LogicalExpression":
    case "AssignmentExpression":
    case "MemberExpression":
    case "ConditionalExpression":
    case "CallExpression":
    case "NewExpression":
    case "SequenceExpression":
    case "TemplateLiteral":
    case "TaggedTemplateExpression":
    case "YieldExpression":
    case "AwaitExpression":
    case "ImportExpression":
    case "MetaProperty":
    case "ChainExpression":
    case "ParenthesizedExpression":
    case "JSXElement":
    case "JSXFragment":
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSInstantiationExpression":
      return true;
    default:
      return false;
  }
}

export function importedBindingName(n: Node | undefined | null): string | null {
  if (!n) return null;
  if (isIdentifier(n)) return n.name;
  if (typeof n.value === "string") return n.value;
  return null;
}

export function moduleSourceValue(n: Node | undefined | null): string | null {
  if (!n) return null;
  return typeof n.value === "string" ? n.value : null;
}

export function assertExpression(n: unknown): asserts n is Expression {
  if (!isExpression(n)) {
    throw new TypeError(
      `Expected Expression, got ${isNode(n) ? n.type : typeof n}`,
    );
  }
}

/** Type-only aliases used as `t.Function` etc. in annotations. */
export type {
  Node,
  Expression,
  Function,
  Identifier,
  Literal,
  Program,
  File,
  LVal,
} from "./node";

// Historical annotation names mapped to ESTree shapes used by compiler passes.
export type MemberExpression = Node;
export type OptionalMemberExpression = Node;
export type CallExpression = Node & {
  type: "CallExpression";
  callee: Node;
  arguments: Node[];
};
export type OptionalCallExpression = Node;
export type ArrowFunctionExpression = Function & {
  type: "ArrowFunctionExpression";
};
export type FunctionExpression = Function;
export type FunctionDeclaration = Function;
export type ObjectPattern = Node & {
  type: "ObjectPattern";
  properties: Node[];
};
export type ObjectExpression = Node & {
  type: "ObjectExpression";
  properties: Node[];
};
export type VariableDeclarator = Node;
export type VariableDeclaration = Node & {
  type: "VariableDeclaration";
  kind: string;
  declarations: Node[];
};
export type ExportNamedDeclaration = Node & {
  type: "ExportNamedDeclaration";
  declaration?: Node | null;
  specifiers: Node[];
};
export type ImportDeclaration = Node & {
  type: "ImportDeclaration";
  specifiers: Node[];
  source: Literal;
};
export type JSXElement = Node & {
  type: "JSXElement";
  openingElement: Node;
  children: Node[];
};
export type JSXAttribute = Node;
export type JSXOpeningElement = Node & {
  type: "JSXOpeningElement";
  name: Node;
  attributes: Node[];
};
export type JSXIdentifier = Node & { type: "JSXIdentifier"; name: string };
export type JSXMemberExpression = Node;
export type JSXSpreadAttribute = Node;
export type BlockStatement = Node & { type: "BlockStatement"; body: Node[] };
export type StringLiteral = Literal;
