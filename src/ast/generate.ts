/**
 * Print ESTree ASTs with esrap.
 */

import { print } from "esrap";
import tsx from "esrap/languages/tsx";
import type { Comment, Node } from "./node";

export interface GenerateOptions {
  sourceMaps?: boolean | "inline" | "both";
  sourceFileName?: string;
  compact?: boolean;
  comments?: boolean;
}

export interface GenerateResult {
  code: string;
  map: object | null;
}

function programOf(ast: Node): Node {
  if (ast.type === "File" && ast.program) {
    return ast.program;
  }
  return ast;
}

function esrapComments(
  list: Comment[] | null | undefined,
): Array<{ type: "Line" | "Block"; value: string }> | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((comment) => ({
    type:
      comment.type === "CommentLine" || comment.type === "Line"
        ? "Line"
        : "Block",
    value: comment.value,
  }));
}

export function generate(
  ast: Node,
  options: GenerateOptions = {},
  _code?: string,
): GenerateResult {
  const root = programOf(ast);
  const language = tsx({
    quotes: "double",
    getLeadingComments: (node) =>
      esrapComments((node as Node).leadingComments),
    getTrailingComments: (node) =>
      esrapComments((node as { trailingComments?: Comment[] | null }).trailingComments),
  });
  const result = print(root as never, language, {
    sourceMapSource: options.sourceFileName,
    sourceMapContent: _code,
  });
  const map =
    options.sourceMaps && result.map
      ? {
          ...result.map,
          file: options.sourceFileName,
          sources: options.sourceFileName
            ? [options.sourceFileName]
            : result.map.sources,
        }
      : options.sourceMaps
        ? result.map
        : null;
  return { code: result.code, map };
}

export default generate;
