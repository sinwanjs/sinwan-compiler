/**
 * SinwanJS Compiler — Exported component detection.
 *
 * Shared utility for detecting top-level exported component bindings in a
 * module. Used by the Vite and Bun plugins for HMR boundary injection.
 *
 * Detection is intentionally conservative: only top-level exports whose name
 * starts with an uppercase letter (the component naming convention) are
 * returned. The runtime safely ignores anything that is not used as a
 * component, so over-matching is harmless.
 */

import { parse } from "@babel/parser";

export interface ExportedComponent {
  /** Local binding name in the module (referenced in the accept callback). */
  local: string;
  /** Export key on the module namespace ("default" for the default export). */
  key: string;
}

function isComponentName(name: string | undefined): name is string {
  return !!name && name[0] === name[0]!.toUpperCase() && /^[A-Z]/.test(name);
}

/**
 * Collect top-level exported component bindings from a module source string.
 *
 * Parses the source with Babel, then walks top-level export declarations to
 * find functions and variables whose name starts with an uppercase letter.
 *
 * Returns an array of `{ local, key }` pairs. Returns an empty array if the
 * source cannot be parsed.
 */
export function collectExportedComponents(
  code: string,
  filename: string,
): ExportedComponent[] {
  let ast: any;
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

  for (const node of ast.program.body as any[]) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const decl = node.declaration;
        if (
          decl.type === "FunctionDeclaration" &&
          decl.id &&
          isComponentName(decl.id.name)
        ) {
          add(decl.id.name, decl.id.name);
        } else if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) {
            if (d.id?.type === "Identifier" && isComponentName(d.id.name)) {
              add(d.id.name, d.id.name);
            }
          }
        }
      } else if (node.specifiers && !node.source) {
        // export { A, B as C }
        for (const spec of node.specifiers) {
          if (
            spec.type === "ExportSpecifier" &&
            spec.local?.type === "Identifier" &&
            spec.exported?.type === "Identifier" &&
            isComponentName(spec.exported.name)
          ) {
            add(spec.local.name, spec.exported.name);
          }
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl.type === "Identifier") {
        add(decl.name, "default");
      } else if (decl.type === "FunctionDeclaration" && decl.id) {
        add(decl.id.name, "default");
      }
    }
  }

  return found;
}
