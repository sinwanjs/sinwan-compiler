/**
 * Shared AST node type — oxc/ESTree plain objects.
 */

export type Comment = {
  type: string;
  value: string;
};

export type SourceLocation = {
  start: { line: number; column: number };
  end: { line: number; column: number };
};

/**
 * Mutable ESTree node. Named fields are the properties compiler passes read;
 * the index signature lets Path replace arbitrary child keys.
 */
export type Node = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: SourceLocation | null;
  leadingComments?: Comment[] | null;
  trailingComments?: Comment[] | null;
  name?: string | Node;
  value?:
    | string
    | number
    | boolean
    | null
    | bigint
    | Node
    | { raw?: string; cooked?: string | null };
  raw?: string;
  optional?: boolean;
  computed?: boolean;
  shorthand?: boolean;
  expression?: boolean | Node;
  async?: boolean;
  generator?: boolean;
  kind?: string;
  operator?: string;
  prefix?: boolean;
  method?: boolean;
  id?: Node | null;
  init?: Node | null;
  body?: Node | Node[];
  params?: Node[];
  arguments?: Node[];
  callee?: Node;
  object?: Node;
  property?: Node;
  properties?: Node[];
  elements?: (Node | null)[];
  declarations?: Node[];
  declaration?: Node | null;
  specifiers?: Node[];
  source?: Node | null;
  imported?: Node;
  exported?: Node;
  local?: Node;
  key?: Node;
  left?: Node;
  right?: Node;
  argument?: Node | null;
  test?: Node;
  consequent?: Node;
  alternate?: Node | null;
  openingElement?: Node;
  closingElement?: Node | null;
  children?: Node[];
  attributes?: Node[];
  program?: Program;
  comments?: Comment[] | null;
  sourceType?: "module" | "script";
  exportKind?: string;
  importKind?: string;
  typeAnnotation?: Node | null;
  returnType?: Node | null;
  typeParameters?: Node | null;
  superClass?: Node | null;
  quasis?: Node[];
  expressions?: Node[];
  regex?: { pattern: string; flags: string };
  bigint?: string;
  selfClosing?: boolean;
  namespace?: Node;
  objectType?: Node;
  param?: Node | null;
  label?: Node | null;
  update?: Node | null;
  definite?: boolean;
  override?: boolean;
  readonly?: boolean;
  declare?: boolean;
  static?: boolean;
  accessibility?: string | null;
  implements?: Node[];
  mixins?: Node[];
  decorators?: Node[];
  typeArguments?: Node | null;
  typeName?: Node;
  types?: Node[];
  elementTypes?: Node[];
  members?: Node[];
  openingFragment?: Node;
  closingFragment?: Node;
  [key: string]: unknown;
};

export type Program = Node & {
  type: "Program";
  body: Node[];
  sourceType: "module" | "script";
};

export type File = Node & {
  type: "File";
  program: Program;
  comments: Comment[] | null;
};

export type Expression = Node;
export type Statement = Node;
export type LVal = Node;
export type Function = Node & {
  params: Node[];
  body: Node;
  generator?: boolean;
  async?: boolean;
  id?: Node | null;
};

export type Identifier = Node & { type: "Identifier"; name: string };
export type Literal = Node & {
  type: "Literal";
  value: string | number | boolean | null | bigint;
  raw?: string;
  regex?: { pattern: string; flags: string };
  bigint?: string;
};

export function isAstNode(value: unknown): value is Node {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
