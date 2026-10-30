/**
 * SinwanJS Compiler — JSX Transform
 *
 * Transforms JSX AST to use template hoisting.
 * Static JSX elements are extracted to module-level template strings
 * and replaced with optimized template creation calls.
 */

import { autoWrapComponents } from "./auto-cc";
import { rewriteLiveCcDestructure } from "./live-cc-destructure";
import { wrapReactiveExpressions } from "./reactive-wrap";
import { parse, generate, traverse, t } from "./ast";


export interface TransformOptions {
  derivedLocals?: boolean;
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
  /**
   * Resolves an import source (e.g. "./Child") to an absolute file path,
   * relative to the file being transformed. Used to look up reactive-prop
   * metadata for components imported from other modules. Derived reads
   * (`title={n.value}`) wrap even without metadata; bare signal/store
   * identifiers stay unwrapped.
   */
  resolveImport?: (source: string, fromFile: string) => string | null;
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
 * This mirrors the runtime's `DEFAULT_TEMPLATE_SLOT_PROTOCOL` in
 * `sinwan/src/renderer/template-protocol.ts`. The compiler cannot import the
 * runtime (separate packages), so the format is duplicated here. A drift test
 * (`sinwan/__tests__/compiler-protocol-drift.test.ts`) asserts the two stay
 * in sync.
 */
export const COMPILER_TEMPLATE_SLOT_PROTOCOL = {
  slotPrefix: "s",
  encodeSlot(index: number): string {
    return `s:${index}`;
  },
  decodeSlot(data: string): number | null {
    if (data.startsWith("s:")) {
      const idx = parseInt(data.slice(2), 10);
      return Number.isNaN(idx) ? null : idx;
    }
    return null;
  },
};

/** Mutable counter threaded through extraction to avoid module-level state. */
interface SlotCounter {
  value: number;
}

function nextSlotId(counter: SlotCounter): string {
  return `<!--${COMPILER_TEMPLATE_SLOT_PROTOCOL.encodeSlot(counter.value++)}-->`;
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

/** Map JSX prop names to HTML attribute names in hoisted template HTML. */
function htmlAttributeName(attrName: string): string {
  if (attrName === "defaultValue") return "value";
  if (attrName === "defaultChecked") return "checked";
  if (attrName === "htmlFor") return "for";
  return attrName;
}

export function jsxAttrName(attr: t.Node): string | undefined {
  if (attr.type !== "JSXAttribute") return undefined;
  const n = attr.name;
  if (!n || typeof n === "string") return undefined;
  if (n.type === "JSXIdentifier") {
    return typeof n.name === "string" ? n.name : undefined;
  }
  if (n.type === "JSXNamespacedName") {
    const namespace = n.namespace as { name: string };
    const name = n.name as { name: string };
    return `${namespace.name}:${name.name}`;
  }
}

function hasAttr(attributes: t.Node[] | undefined, name: string): boolean {
  for (const attr of attributes ?? []) {
    if (jsxAttrName(attr) === name) return true;
  }
  return false;
}

function attrIsExpression(
  attributes: t.Node[] | undefined,
  name: string,
): boolean {
  for (const attr of attributes ?? []) {
    if (attr.type !== "JSXAttribute" || jsxAttrName(attr) !== name) continue;
    return t.isNode(attr.value) && attr.value.type === "JSXExpressionContainer";
  }
  return false;
}

/**
 * Enhanced tags whose special props must go through `jsx()` (refs, head
 * insertion, function actions). Those nodes become child slots so the
 * surrounding native shell can still be hoisted.
 */
function elementNeedsJsxEnhancer(node: t.JSXElement): boolean {
  const opening = node.openingElement;
  if (!t.isJSXOpeningElement(opening)) return false;
  const tagName = jsxNameToString(opening.name);
  const attrs = opening.attributes;
  switch (tagName) {
    case "select":
      return hasAttr(attrs, "defaultValue") || hasAttr(attrs, "value");
    case "textarea":
      return hasAttr(attrs, "value");
    case "option":
      return hasAttr(attrs, "selected");
    case "form":
      return attrIsExpression(attrs, "action");
    case "input":
    case "button":
      return attrIsExpression(attrs, "formAction");
    case "progress":
      return attrIsExpression(attrs, "value");
    case "style":
      return hasAttr(attrs, "href") && hasAttr(attrs, "precedence");
    case "script":
      return hasAttr(attrs, "src") && hasAttr(attrs, "async");
    case "link":
    case "meta":
    case "title":
      return !hasAttr(attrs, "itemProp");
    default:
      return false;
  }
}

function extractTemplate(node: any, filename: string): ExtractedTemplate {
  const counter: SlotCounter = { value: 0 };
  const slots: TemplateSlot[] = [];
  const html = elementToHtml(node, slots, [], filename, counter);
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
  if (t.isTemplateLiteral(expr) && (expr.expressions ?? []).length === 0) {
    return t.templateElementRaw((expr.quasis ?? [])[0]);
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
  counter: SlotCounter,
): string {
  const opening = node.openingElement;
  const tagName = jsxNameToString(opening?.name);
  if (tagName === "") return "";
  // The root element passed to extractTemplate is guaranteed lowercase by
  // transformJSX (it skips capitalized tags). Capitalized children are handled
  // in childrenToHtml as component child slots, so we never recurse into
  // elementToHtml with a component tag. Defensive guard kept for safety.
  const firstChar = tagName.charAt(0);
  if (firstChar && firstChar === firstChar.toUpperCase()) {
    throw new Error("Cannot hoist element containing component calls");
  }
  const isVoid = VOID_ELEMENTS.has(tagName);
  let html = `<${tagName}`;
  let textareaDefault = "";

  for (const attr of opening?.attributes ?? []) {
    if (attr.type === "JSXSpreadAttribute") {
      throw new Error("Cannot hoist element with spread attributes");
    }
    const attrName = jsxAttrName(attr);
    if (!attrName) continue;
    if (attrName === "children") continue;
    if (attrName === "ref") {
      if (attr.value?.type === "JSXExpressionContainer") {
        const expr = attr.value.expression;
        if (expr.type !== "JSXEmptyExpression") {
          slots.push({
            path: [...path],
            type: "ref",
            name: "ref",
            expr,
          });
        }
      }
      continue;
    }
    const htmlName = htmlAttributeName(attrName);
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
        html += ` ${htmlName}="${escapeHtml(serialized)}"`;
        continue;
      }
      slots.push({
        path: [...path],
        type: attrName.startsWith("on") ? "event" : "attr",
        name: attrName,
        expr,
      });
      // class / on* bind at runtime. Empty placeholders would be cloned on
      // every row. SSR inserts the attribute when this placeholder is absent.
      if (attrName !== "class" && !attrName.startsWith("on")) {
        html += ` ${htmlName}=""`;
      }
      continue;
    }
    if (
      attr.value?.type === "JSXText" ||
      t.isStringLiteral(attr.value)
    ) {
      const rawValue = attr.value.value;
      if (attrName === "style") {
        warnSuspectedStyleInterpolation(
          rawValue,
          filename,
          attr.value.loc?.start?.line,
        );
      }
      if (tagName === "textarea" && attrName === "defaultValue") {
        textareaDefault = escapeHtml(rawValue);
        continue;
      }
      html += ` ${htmlName}="${escapeHtml(rawValue)}"`;
    } else if (!attr.value) {
      html += ` ${htmlName}`;
    }
  }

  html += isVoid ? " />" : ">";
  if (isVoid) return html;

  const childResult = childrenToHtml(
    node.children,
    slots,
    path,
    filename,
    0,
    counter,
  );
  html += childResult.html;
  html += textareaDefault;

  html += `</${tagName}>`;
  return html;
}

/**
 * When an element’s only meaningful child is one dynamic expression or one
 * component/enhancer island, bind via the parent element path and omit the
 * `<!--s:N-->` comment. That saves two Comment nodes per bench row (id + label).
 * Mixed static+dynamic children still use markers so sibling indices stay stable.
 */
function getSoleDynamicChild(children: any[]): any | null {
  const meaningful: any[] = [];
  for (const child of children) {
    if (child.type === "JSXText") {
      if (cleanJSXText(child.value ?? "")) meaningful.push(child);
      continue;
    }
    if (child.type === "JSXExpressionContainer") {
      if (child.expression.type === "JSXEmptyExpression") continue;
      meaningful.push(child);
      continue;
    }
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      meaningful.push(child);
    }
  }
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  if (only.type === "JSXFragment") return getSoleDynamicChild(only.children);
  if (only.type === "JSXExpressionContainer") return only;
  if (only.type === "JSXElement") {
    const childTag = jsxIdentifierTagName(only.openingElement?.name);
    const isComponent =
      !!childTag && childTag.charAt(0) === childTag.charAt(0).toUpperCase();
    if (isComponent || elementNeedsJsxEnhancer(only)) return only;
    return null;
  }
  return null;
}

function childrenToHtml(
  children: any[],
  slots: TemplateSlot[],
  path: number[],
  filename: string,
  startIndex: number,
  counter: SlotCounter,
  allowParentFill = true,
): { html: string; childIndex: number } {
  // Parent-fill only for an element's own child list. A fragment shares the
  // parent path, so filling it would steal later siblings.
  if (allowParentFill && startIndex === 0) {
    const sole = getSoleDynamicChild(children);
    if (sole != null) {
      // Keep marker id ordinals aligned with child-slot order for SSR.
      counter.value++;
      if (sole.type === "JSXExpressionContainer") {
        slots.push({
          path: [...path],
          type: "child",
          expr: sole.expression,
        });
      } else {
        slots.push({
          path: [...path],
          type: "child",
          expr: sole,
        });
      }
      return { html: "", childIndex: 0 };
    }
  }

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
      if (child.expression.type === "JSXEmptyExpression") {
        const comments = [
          ...(child.expression.leadingComments ?? []),
          ...(child.leadingComments ?? []),
        ];
        for (const comment of comments) {
          if (
            comment?.type === "CommentBlock" &&
            typeof comment.value === "string"
          ) {
            html += `<!--${comment.value.replace(/--/g, "")}-->`;
          }
        }
        continue;
      }
      const slot = nextSlotId(counter);
      slots.push({
        path: [...path, childIndex],
        type: "child",
        expr: child.expression,
      });
      html += slot;
      childIndex++;
    } else if (child.type === "JSXElement") {
      const childTag = jsxIdentifierTagName(child.openingElement?.name);
      const isFirstCharUpper =
        childTag && childTag.charAt(0) === childTag.charAt(0).toUpperCase();
      if (isFirstCharUpper || elementNeedsJsxEnhancer(child)) {
        const slot = nextSlotId(counter);
        slots.push({
          path: [...path, childIndex],
          type: "child",
          expr: child,
        });
        html += slot;
        childIndex++;
      } else {
        html += elementToHtml(
          child,
          slots,
          [...path, childIndex],
          filename,
          counter,
        );
        childIndex++;
      }
    } else if (child.type === "JSXFragment") {
      const fragResult = childrenToHtml(
        child.children,
        slots,
        path,
        filename,
        childIndex,
        counter,
        false,
      );
      html += fragResult.html;
      childIndex = fragResult.childIndex;
    }
  }
  return { html, childIndex };
}

function jsxNameToString(name: unknown): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    return jsxNameToString(name.object) + "." + jsxNameToString(name.property);
  }
  return "";
}

function jsxIdentifierTagName(name: unknown): string {
  return t.isJSXIdentifier(name) ? name.name : "";
}

function rendererHelperImported(body: t.Node[], local: string): boolean {
  for (const statement of body) {
    if (!t.isImportDeclaration(statement)) continue;
    const source = t.moduleSourceValue(statement.source);
    if (source !== "sinwan/renderer" && source !== "sinwan/renderer/web") {
      continue;
    }
    for (const specifier of statement.specifiers ?? []) {
      if (
        t.isImportSpecifier(specifier) &&
        t.isIdentifier(specifier.local) &&
        specifier.local.name === local
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when this element is a structural child of a parent JSXElement /
 * JSXFragment (the parent template would serialize it into HTML).
 *
 * False when a JSXExpressionContainer appears first — the element is a
 * dynamic island root (For/Show children, `&&`, `.map` callbacks) and may
 * be hoisted independently. Fragments are transparent, so a root fragment
 * or a fragment inside an expression does not block that hoist.
 */
function isStructuralJsxChild(path: any): boolean {
  let cur = path.parentPath;
  while (cur) {
    if (cur.isJSXExpressionContainer()) return false;
    if (cur.isJSXElement()) return true;
    cur = cur.parentPath;
  }
  return false;
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

  // Auto-wrap exported component-like functions with `cc(...)` so plain
  // `export function App()` / `export const App = () => <div/>` are treated as
  // components by the reactive analyzer. Must run before `wrapReactiveExpressions`
  // so the latter sees the `cc(...)` wrappers and processes their JSX.
  autoWrapComponents(ast, filename);

  // Flatten `cc(({ value }) => …)` so wrap sees live `props.value` reads.
  rewriteLiveCcDestructure(ast);

  // Wrap reactive JSX expressions so the runtime can track them.
  wrapReactiveExpressions(ast, {
    derivedLocals: options.derivedLocals,
    dev: options.dev,
    explicitBindings: options.explicitBindings,
    analyze: options.analyze,
    analyzeMetadata: options.analyzeMetadata,
    resolveImport: options.resolveImport,
    filename,
  });

  const hoist = options.hoist !== false;
  const templates: { id: string; template: ExtractedTemplate }[] = [];
  let templateCounter = 0;

  traverse(ast, {
    JSXElement(path: any) {
      if (!hoist) return;
      // Skip structural children of a parent JSX tree (parent HTML absorbs them).
      // Allow hoist when a JSXExpressionContainer sits between this element and
      // any JSX ancestor — e.g. <For>{(row) => <tr/>}</For>, {cond && <span/>}.
      if (isStructuralJsxChild(path)) return;

      const opening = path.node.openingElement;
      if (!t.isJSXOpeningElement(opening)) return;
      if (!t.isJSXIdentifier(opening.name)) return;
      const name = opening.name.name;
      const first = name[0];
      if (!first || first !== first.toLowerCase()) return;
      if (elementNeedsJsxEnhancer(path.node)) return;

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
      } catch (err) {
        // Hoisting is intentionally skipped for unsupported constructs (spread
        // attributes, refs, member-expression tag names). But genuine compiler
        // bugs also land here and would be silently indistinguishable. In dev
        // mode, surface the reason so regressions are debuggable.
        if (options.dev) {
          console.warn(
            `[Sinwan] template hoisting skipped in ${filename}: ${(err as Error).message}`,
          );
        }
      }
    },
  });

  if (templates.length === 0) {
    // Even with no hoisted templates, explicit bindings may have emitted
    // _$bindText/_$bindAttr calls in non-hoisted JSX. Add the import so
    // those calls resolve at runtime. The non-template renderers unwrap
    // binding descriptors to their getter functions.
    if (options.explicitBindings) {
      const bindingImport = t.importDeclaration(
        [
          t.importSpecifier(
            t.identifier("_$bindText"),
            t.identifier("_$bindText"),
          ),
          t.importSpecifier(
            t.identifier("_$bindAttr"),
            t.identifier("_$bindAttr"),
          ),
          t.importSpecifier(
            t.identifier("_$bindStyle"),
            t.identifier("_$bindStyle"),
          ),
          t.importSpecifier(
            t.identifier("_$bindClass"),
            t.identifier("_$bindClass"),
          ),
        ],
        t.stringLiteral("sinwan/renderer/web"),
      );
      bindingImport.specifiers = (bindingImport.specifiers ?? []).filter(
        (candidate) =>
          t.isImportSpecifier(candidate) &&
          t.isIdentifier(candidate.local) &&
          !rendererHelperImported(ast.program.body, candidate.local.name),
      );
      if (bindingImport.specifiers.length > 0)
        ast.program.body.unshift(bindingImport);
    }
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
  const freshSpecifiers = importSpecifiers.filter((specifier) => {
    const local = specifier.local;
    return t.isIdentifier(local) && !rendererHelperImported(ast.program.body, local.name);
  });
  ast.program.body.unshift(...templateDecls);
  if (freshSpecifiers.length > 0) {
    ast.program.body.unshift(
      t.importDeclaration(
        freshSpecifiers,
        t.stringLiteral("sinwan/renderer/web"),
      ),
    );
  }

  const result = generate(ast, { sourceMaps: true, sourceFileName: filename });
  return { code: result.code, map: result.map };
}
