/**
 * SinwanJS Compiler — JSX Transform
 *
 * Transforms JSX AST to use template hoisting.
 * Static JSX elements are extracted to module-level template strings
 * and replaced with optimized template creation calls.
 */

import { parse } from "@babel/parser";
import { wrapReactiveExpressions } from "./reactive-wrap";
import _generate from "@babel/generator";
const generate =
  typeof _generate === "function"
    ? _generate
    : ((_generate as any).default ?? _generate);
import * as t from "@babel/types";
import _traverse from "@babel/traverse";
// Handle CJS/ESM interop — @babel/traverse default may be nested
const traverse =
  typeof _traverse === "function"
    ? _traverse
    : ((_traverse as any).default ?? _traverse);

export interface TransformOptions {
  /** Enable template hoisting (default: true) */
  hoist?: boolean;
  /** Enable dev mode (source maps, etc.) */
  dev?: boolean;
  /** Emit explicit compiler-driven binding descriptors (Phase 2). */
  explicitBindings?: boolean;
  /** Path to the reactive-props metadata file produced by `sinwan analyze`. */
  analyze?: string;
  /** In-memory reactive-props metadata (used by plugin-level caches). */
  analyzeMetadata?: Map<string, Map<string, Set<string>>>;
}

interface TemplateSlot {
  path: number[];
  type: string;
  name?: string;
  expr?: t.Expression;
}

interface ExtractedTemplate {
  html: string;
  slots: TemplateSlot[];
}

/**
 * Template slot marker encoding.
 *
 * Must stay in sync with the runtime's `DEFAULT_TEMPLATE_SLOT_PROTOCOL`
 * in `sinwan/src/renderer/template-protocol.ts`.
 */
const SLOT_PREFIX = "s";
let slotId = 0;
function nextSlotId(): string {
  return `<!--${SLOT_PREFIX}:${slotId++}-->`;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Clean JSX text the same way Babel/React does:
 * - trim indentation on continuation lines
 * - collapse newlines to a single space
 * - preserve trailing whitespace on the last non-empty line so that
 *   `text {expr}` keeps the separating space in the HTML template.
 */
function cleanJSXText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/[^ \t]/.exec(line)) {
      lastNonEmptyLine = i;
    }
  }

  let str = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isFirstLine = i === 0;
    const isLastLine = i === lines.length - 1;
    const isLastNonEmptyLine = i === lastNonEmptyLine;
    let trimmedLine = line.replace(/\t/g, " ");
    if (!isFirstLine) {
      trimmedLine = trimmedLine.replace(/^ +/, "");
    }
    if (!isLastLine) {
      trimmedLine = trimmedLine.replace(/ +$/, "");
    }
    if (trimmedLine) {
      if (!isLastNonEmptyLine) {
        trimmedLine += " ";
      }
      str += trimmedLine;
    }
  }
  return str;
}

function extractTemplate(node: any, filename: string): ExtractedTemplate {
  slotId = 0;
  const slots: TemplateSlot[] = [];
  const html = elementToHtml(node, slots, [], filename);
  return { html, slots };
}

function warnSuspectedStyleInterpolation(
  attrValue: string,
  filename: string,
  line?: number | null,
): void {
  if (!attrValue.includes("${")) return;
  const location = line ? `:${line}` : "";
  console.warn(
    '[Sinwan] JSX string literal style attribute contains "${...}" which will not be interpolated. ' +
      "Use style={`...${...}`} instead. (" +
      filename +
      location +
      ")",
  );
}

function isLiteralStyleValue(expr: t.Expression): boolean {
  return (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isNullLiteral(expr)
  );
}

function isStaticStyleValue(expr: t.Expression): boolean {
  if (t.isStringLiteral(expr)) return true;
  if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) return true;
  if (!t.isObjectExpression(expr)) return false;
  for (const prop of expr.properties) {
    if (!t.isObjectProperty(prop)) return false;
    if (prop.computed) return false;
    if (!isLiteralStyleValue(prop.value as t.Expression)) return false;
  }
  return true;
}

function toKebabCase(value: string): string {
  return value.includes("-")
    ? value
    : value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function serializeStyleValue(expr: t.Expression): string {
  if (t.isStringLiteral(expr)) return expr.value;
  if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) {
    return expr.quasis[0]?.value?.raw ?? "";
  }
  if (!t.isObjectExpression(expr)) return "";

  const parts: string[] = [];
  for (const prop of expr.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const key = prop.key;
    let name: string | null = null;
    if (t.isIdentifier(key)) name = key.name;
    else if (t.isStringLiteral(key)) name = key.value;
    if (!name) continue;

    const val = prop.value as t.Expression;
    if (t.isNullLiteral(val)) continue;
    if (t.isBooleanLiteral(val) && !val.value) continue;

    let valueStr = "";
    if (t.isStringLiteral(val)) valueStr = val.value;
    else if (t.isNumericLiteral(val)) valueStr = String(val.value);
    else if (t.isBooleanLiteral(val)) valueStr = String(val.value);
    if (valueStr === "") continue;

    parts.push(`${toKebabCase(name)}:${valueStr}`);
  }
  return parts.join(";");
}

function elementToHtml(
  node: any,
  slots: TemplateSlot[],
  path: number[],
  filename: string,
): string {
  const tagName = jsxNameToString(node.openingElement.name);
  if (tagName === "") return "";
  // Component calls (capitalized tags) cannot be hoisted into HTML strings
  const firstChar = tagName.charAt(0);
  if (firstChar && firstChar === firstChar.toUpperCase()) {
    throw new Error("Cannot hoist element containing component calls");
  }
  const isVoid = VOID_ELEMENTS.has(tagName);
  let html = `<${tagName}`;

  for (const attr of node.openingElement.attributes) {
    if (attr.type === "JSXSpreadAttribute") {
      throw new Error("Cannot hoist element with spread attributes");
    }
    const attrName = attr.name.name;
    if (attrName === "children") continue;
    if (attrName === "ref") {
      throw new Error("Cannot hoist element with ref");
    }
    if (attr.value?.type === "JSXExpressionContainer") {
      const expr = attr.value.expression;
      if (expr.type === "JSXEmptyExpression") continue;
      // Static style values can be serialized directly into the HTML, avoiding
      // a runtime slot and any runtime CSS string parsing.
      if (
        attrName === "style" &&
        t.isExpression(expr) &&
        isStaticStyleValue(expr)
      ) {
        const serialized = serializeStyleValue(expr);
        html += ` ${attrName}="${escapeHtml(serialized)}"`;
        continue;
      }
      slots.push({
        path: [...path],
        type: attrName.startsWith("on") ? "event" : "attr",
        name: attrName,
        expr,
      });
      html += ` ${attrName}=""`;
      continue;
    }
    if (
      attr.value?.type === "JSXText" ||
      attr.value?.type === "StringLiteral"
    ) {
      const rawValue = attr.value.value;
      if (attrName === "style") {
        warnSuspectedStyleInterpolation(
          rawValue,
          filename,
          attr.value.loc?.start?.line,
        );
      }
      html += ` ${attrName}="${escapeHtml(rawValue)}"`;
    } else if (!attr.value) {
      html += ` ${attrName}`;
    }
  }

  html += isVoid ? " />" : ">";
  if (isVoid) return html;

  const childResult = childrenToHtml(node.children, slots, path, filename, 0);
  html += childResult.html;

  html += `</${tagName}>`;
  return html;
}

function childrenToHtml(
  children: any[],
  slots: TemplateSlot[],
  path: number[],
  filename: string,
  startIndex: number,
): { html: string; childIndex: number } {
  let html = "";
  let childIndex = startIndex;
  for (const child of children) {
    if (child.type === "JSXText") {
      const text = cleanJSXText(child.value ?? "");
      if (text) {
        html += escapeHtml(text);
        childIndex++;
      }
    } else if (child.type === "JSXExpressionContainer") {
      if (child.expression.type === "JSXEmptyExpression") continue;
      const slot = nextSlotId();
      slots.push({
        path: [...path, childIndex],
        type: "child",
        expr: child.expression,
      });
      html += slot;
      childIndex++;
    } else if (child.type === "JSXElement") {
      html += elementToHtml(child, slots, [...path, childIndex], filename);
      childIndex++;
    } else if (child.type === "JSXFragment") {
      const fragResult = childrenToHtml(
        child.children,
        slots,
        path,
        filename,
        childIndex,
      );
      html += fragResult.html;
      childIndex = fragResult.childIndex;
    }
  }
  return { html, childIndex };
}

function jsxNameToString(name: any): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    return jsxNameToString(name.object) + "." + jsxNameToString(name.property);
  }
  return "";
}

export function transformJSX(
  code: string,
  filename: string,
  options: TransformOptions = {},
): { code: string; map?: any } {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
    sourceFilename: filename,
  });

  // Wrap reactive JSX expressions so the runtime can track them.
  wrapReactiveExpressions(ast, {
    explicitBindings: options.explicitBindings,
    analyze: options.analyze,
    analyzeMetadata: options.analyzeMetadata,
    filename,
  });

  const hoist = options.hoist !== false;
  const templates: { id: string; template: ExtractedTemplate }[] = [];
  let templateCounter = 0;

  traverse(ast, {
    JSXElement(path: any) {
      if (!hoist) return;
      if (path.findParent((p: any) => p.isJSXElement())) return;

      const opening = path.node.openingElement;
      const tagName = opening.name;
      if (tagName.type !== "JSXIdentifier") return;
      const name = tagName.name;
      if (!name || name[0] !== name[0].toLowerCase()) return;

      try {
        const extracted = extractTemplate(path.node, filename);
        const tmplId = `_$tmpl_${templateCounter++}`;
        templates.push({ id: tmplId, template: extracted });

        const dynamicExprs = extracted.slots
          .filter((s) => s.expr)
          .map((s) => s.expr!);

        const templateExpr = t.callExpression(
          t.identifier("_$createTemplate"),
          [t.identifier(tmplId), t.arrayExpression(dynamicExprs)],
        );

        // If parent is JSX (element or fragment), wrap in {…} so the
        // output stays valid JSX for the next transform pass (esbuild).
        const parentIsJSX =
          path.parentPath?.isJSXElement() || path.parentPath?.isJSXFragment();

        path.replaceWith(
          parentIsJSX ? t.jsxExpressionContainer(templateExpr) : templateExpr,
        );
      } catch {
        /* leave as-is */
      }
    },
  });

  if (templates.length === 0) {
    const result = generate(ast, {
      sourceMaps: true,
      sourceFileName: filename,
    });
    return { code: result.code, map: result.map };
  }

  const templateDecls = templates.map(({ id, template }) =>
    t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier(id),
        t.objectExpression([
          t.objectProperty(
            t.identifier("html"),
            t.stringLiteral(template.html),
          ),
          t.objectProperty(
            t.identifier("slots"),
            t.arrayExpression(
              template.slots.map((slot) =>
                t.objectExpression([
                  t.objectProperty(
                    t.identifier("path"),
                    t.arrayExpression(
                      slot.path.map((i) => t.numericLiteral(i)),
                    ),
                  ),
                  t.objectProperty(
                    t.identifier("type"),
                    t.stringLiteral(slot.type),
                  ),
                  ...(slot.name
                    ? [
                        t.objectProperty(
                          t.identifier("name"),
                          t.stringLiteral(slot.name),
                        ),
                      ]
                    : []),
                ]),
              ),
            ),
          ),
        ]),
      ),
    ]),
  );

  const importSpecifiers = [
    t.importSpecifier(
      t.identifier("_$createTemplate"),
      t.identifier("_$createTemplate"),
    ),
  ];
  if (options.explicitBindings) {
    importSpecifiers.push(
      t.importSpecifier(t.identifier("_$bindText"), t.identifier("_$bindText")),
      t.importSpecifier(t.identifier("_$bindAttr"), t.identifier("_$bindAttr")),
      t.importSpecifier(
        t.identifier("_$bindStyle"),
        t.identifier("_$bindStyle"),
      ),
      t.importSpecifier(
        t.identifier("_$bindClass"),
        t.identifier("_$bindClass"),
      ),
    );
  }

  const importDecl = t.importDeclaration(
    importSpecifiers,
    t.stringLiteral("sinwan/renderer"),
  );

  ast.program.body.unshift(importDecl, ...templateDecls);

  const result = generate(ast, { sourceMaps: true, sourceFileName: filename });
  return { code: result.code, map: result.map };
}
