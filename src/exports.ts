/**
 * SinwanJS Compiler — Exported component detection.
 *
 * Shared utility for detecting top-level exported component bindings in a
 * module. Used by the Vite and Bun plugins for HMR boundary injection.
 *
 * Detection is intentionally conservative: only top-level *value* exports
 * whose name starts with an uppercase letter (the component naming
 * convention) are returned. Type-only exports (`export type { Foo }`,
 * `export { type Foo }`) must be skipped: HMR footers reference the local
 * binding, and a type has no runtime binding (`ReferenceError`).
 */

import { parse } from "./ast/parse";
import type { File } from "./ast/node";
import * as t from "./ast/types";

export interface ExportedComponent {
  /** Local binding name in the module (referenced in the accept callback). */
  local: string;
  /** Export key on the module namespace ("default" for the default export). */
  key: string;
}

function isComponentName(name: string | undefined): name is string {
  return !!name && name[0] === name[0]!.toUpperCase() && /^[A-Z]/.test(name);
}

function isTypeOnlyExport(node: { exportKind?: string }): boolean {
  return node.exportKind === "type";
}

function isIdent(n: unknown): n is { type: "Identifier"; name: string } {
  return (
    !!n &&
    typeof n === "object" &&
    (n as { type?: string }).type === "Identifier" &&
    typeof (n as { name?: unknown }).name === "string"
  );
}

/**
 * Collect top-level exported component bindings from a module source string.
 *
 * Parses the source with oxc-parser, then walks top-level export declarations
 * to find functions and variables whose name starts with an uppercase letter.
 *
 * Returns an array of `{ local, key }` pairs. Returns an empty array if the
 * source cannot be parsed.
 */
export function collectExportedComponents(
  code: string,
  filename: string,
): ExportedComponent[] {
  let ast: File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      sourceFilename: filename,
    });
  } catch {
    return [];
  }

  const found: ExportedComponent[] = [];
  const seen = new Set<string>();
  const add = (local: string, key: string) => {
    const sig = `${local}::${key}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    found.push({ local, key });
  };

  for (const node of ast.program.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (isTypeOnlyExport(node)) continue;
      const declaration = node.declaration as
        | { type: string; id?: unknown; declarations?: Array<{ id?: unknown }> }
        | null
        | undefined;
      if (declaration) {
        if (
          declaration.type === "FunctionDeclaration" &&
          isIdent(declaration.id) &&
          isComponentName(declaration.id.name)
        ) {
          add(declaration.id.name, declaration.id.name);
        } else if (declaration.type === "VariableDeclaration") {
          for (const d of declaration.declarations ?? []) {
            if (isIdent(d.id) && isComponentName(d.id.name)) {
              add(d.id.name, d.id.name);
            }
          }
        }
      } else if (node.specifiers && !node.source) {
        // export { A, B as C } / export { Button, type ButtonProps }
        for (const spec of node.specifiers as Array<{
          type: string;
          exportKind?: string;
          local?: unknown;
          exported?: unknown;
        }>) {
          if (isTypeOnlyExport(spec)) continue;
          if (
            spec.type === "ExportSpecifier" &&
            isIdent(spec.local) &&
            isIdent(spec.exported) &&
            isComponentName(spec.exported.name)
          ) {
            add(spec.local.name, spec.exported.name);
          }
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const raw = node.declaration;
      const declaration = (
        raw && typeof raw === "object" && "type" in raw
          ? t.unwrapParens(raw as t.Node)
          : raw
      ) as {
        type: string;
        name?: string;
        id?: unknown;
      };
      if (isIdent(declaration)) {
        add(declaration.name, "default");
      } else if (
        declaration.type === "FunctionDeclaration" &&
        isIdent(declaration.id)
      ) {
        add(declaration.id.name, "default");
      }
    }
  }

  return found;
}
