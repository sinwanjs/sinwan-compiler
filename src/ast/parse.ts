/**
 * Parse TS/TSX with oxc-parser (ESTree) and attach comments onto nodes.
 */

import { parseSync } from "oxc-parser";
import {
  isAstNode,
  type Comment,
  type File,
  type Node,
  type Program,
} from "./node";

export interface ParseOptions {
  sourceType?: "module" | "script" | "unambiguous";
  plugins?: unknown[];
  sourceFilename?: string;
  allowReturnOutsideFunction?: boolean;
  errorRecovery?: boolean;
}

function containsSpan(node: Node, start: number, end: number): boolean {
  const nodeStart = node.start ?? -1;
  const nodeEnd = node.end ?? -1;
  return nodeStart <= start && nodeEnd >= end;
}

interface OxcComment {
  type: string;
  value: string;
  start: number;
  end: number;
}

/**
 * Attach oxc comments as leadingComments / trailingComments on the nearest nodes.
 */
function attachComments(program: Program, comments: OxcComment[]): void {
  if (comments.length === 0) return;

  const nodes: Node[] = [];
  const visit = (node: Node): void => {
    if (typeof node.start === "number" && typeof node.end === "number") {
      nodes.push(node);
    }
    for (const key of Object.keys(node)) {
      if (
        key === "leadingComments" ||
        key === "trailingComments" ||
        key === "innerComments"
      )
        continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === "object" && "type" in item) {
            visit(item as Node);
          }
        }
      } else if (val && typeof val === "object" && "type" in val) {
        visit(val as Node);
      }
    }
  };
  visit(program);
  // Same start → prefer the outermost node (largest end) so comments bind to
  // MemberExpression / ExportNamedDeclaration rather than an inner Identifier.
  nodes.sort((a, b) => {
    const ds = (a.start ?? 0) - (b.start ?? 0);
    if (ds !== 0) return ds;
    return (b.end ?? 0) - (a.end ?? 0);
  });

  for (const comment of comments) {
    const mapped: Comment = {
      type: comment.type === "Line" ? "CommentLine" : "CommentBlock",
      value: comment.value,
    };
    let container: Node | null = null;
    let containerSpan = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      if (node.type === "Program") continue;
      if (!containsSpan(node, comment.start, comment.end)) continue;
      const span = (node.end ?? 0) - (node.start ?? 0);
      if (span < containerSpan) {
        container = node;
        containerSpan = span;
      }
    }

    const commentIsNode =
      container != null &&
      (container.type === "JSXEmptyExpression" ||
        ((container.start ?? -1) === comment.start &&
          (container.end ?? -1) === comment.end));
    if (commentIsNode && container) {
      const list = (container.leadingComments ??= []) as Comment[];
      list.push(mapped);
      continue;
    }

    let leading: Node | null = null;
    for (const node of nodes) {
      if (node.type === "Program" || node === container) continue;
      const start = node.start ?? 0;
      if (start < comment.end) continue;
      if (
        container &&
        !containsSpan(container, node.start ?? 0, node.end ?? 0)
      ) {
        continue;
      }
      leading = node;
      break;
    }
    if (leading) {
      const list = (leading.leadingComments ??= []) as Comment[];
      list.push(mapped);
      continue;
    }
    if (container) {
      const list = (container.innerComments ??= []) as Comment[];
      list.push(mapped);
      continue;
    }
    const list = (program.trailingComments ??= []) as Comment[];
    list.push(mapped);
  }
}

/**
 * Normalize oxc's program object into our mutable Program node.
 */
export function asProgram(parsed: unknown): Program {
  if (
    !isAstNode(parsed) ||
    parsed.type !== "Program" ||
    !Array.isArray(parsed.body)
  ) {
    throw new Error("oxc-parser did not return a Program");
  }
  return {
    ...parsed,
    type: "Program",
    body: parsed.body,
    sourceType: parsed.sourceType === "script" ? "script" : "module",
  };
}

/**
 * Parse source into a File wrapper `{ type: "File", program }`.
 */
export function parse(code: string, options: ParseOptions = {}): File {
  const filename = options.sourceFilename ?? "unknown.tsx";
  const sourceType =
    options.sourceType === "script"
      ? "script"
      : options.sourceType === "unambiguous"
        ? "unambiguous"
        : "module";

  // 0.4.0 always enabled the JSX and TypeScript plugins. oxc's per-extension
  // lang would reject JSX in `.ts` / `.js` and types in `.jsx`.
  const result = parseSync(filename, code, {
    lang: "tsx",
    sourceType,
  });

  if (result.errors.length > 0 && !options.errorRecovery) {
    throw new Error(result.errors[0]!.message);
  }

  const program = asProgram(result.program);
  const comments = ((result as { comments?: OxcComment[] }).comments ??
    []) as OxcComment[];
  attachComments(program, comments);

  return {
    type: "File",
    program,
    comments: comments.map((c) => ({
      type: c.type === "Line" ? "CommentLine" : "CommentBlock",
      value: c.value,
    })),
  };
}
