/**
 * Oxc/ESTree AST facade for sinwan-compiler.
 */

export { parse, type ParseOptions } from "./parse";
export {
  generate,
  type GenerateOptions,
  type GenerateResult,
} from "./generate";
export {
  traverse,
  Path,
  Scope,
  Binding,
  singlePath,
  type NodePath,
  type TraverseOptions,
} from "./traverse";
export * as t from "./types";
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
