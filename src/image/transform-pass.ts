/**
 * `<Img>` compile pass. Finds `<Img>` elements imported from `sinwan/image`
 * (aliases included) and, when `src` is static — a string literal or a
 * default import of an image file — rewrites it to an optimized asset import:
 *
 *   <Img src="./hero.jpg" width={1200} quality={85} />
 *   → import _$sinwanImg0 from "./hero.jpg?sinwan-img=<options>";
 *     <Img src={_$sinwanImg0} width={1200} quality={85} />
 *
 * The optimization props must be static so the build knows what to produce.
 * Dynamic `src` is left to the runtime loader (on-demand handler). Any `<Img>`
 * usage on a host other than Bun's bundler is refused.
 */
import type { File, Node } from "../ast/node";
import { traverse } from "../ast/traverse";
import * as t from "../ast/types";
import { BUILD_OPTION_NAMES, ImageOptionsError, isOptimizableImage, validateBuildOptions } from "./options";
import { withImageQuery } from "./query";
import { BunOnlyImageError } from "./runtime-guard";

/**
 * Who runs the image pipeline: `"bun"` for bun-plugin-sinwan and for Vite
 * started on Bun; `"vite"` for Vite on Node (refused with a `bunx --bun vite`
 * hint); `"other"` for anything else.
 */
export type ImageHost = "bun" | "vite" | "other";

export interface ImageTransformOptions {
  host: ImageHost;
}

export const IMAGE_MODULE = "sinwan/image";
const IMAGE_LOCAL_PREFIX = "_$sinwanImg";

/** A static `<Img>` problem, reported with its file and position. */
export class ImageTransformError extends Error {
  override name = "ImageTransformError";
}

type Static = { ok: true; value: unknown } | { ok: false };

function location(code: string, node: Node): string {
  const offset = typeof node.start === "number" ? node.start : 0;
  const before = code.slice(0, offset).split("\n");
  return `${before.length}:${(before[before.length - 1]?.length ?? 0) + 1}`;
}

function unwrap(node: Node): Node {
  let current = node;
  while (
    (t.isParenthesizedExpression(current) || t.isTSAsExpression(current) || t.isTSSatisfiesExpression(current)) &&
    t.isNode(current.expression)
  ) {
    current = current.expression;
  }
  return current;
}

/** Literal value of an expression the build can read, or `{ ok: false }`. */
function staticExpression(raw: Node): Static {
  const node = unwrap(raw);
  if (t.isLiteral(node)) return { ok: true, value: node.value };
  if (t.isTemplateLiteral(node)) {
    const quasis = node.quasis ?? [];
    if ((node.expressions ?? []).length === 0 && quasis.length === 1) return { ok: true, value: t.templateElementRaw(quasis[0]) };
    return { ok: false };
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && t.isNode(node.argument)) {
    const inner = staticExpression(node.argument);
    return inner.ok && typeof inner.value === "number" ? { ok: true, value: -inner.value } : { ok: false };
  }
  if (node.type === "BinaryExpression" && node.operator === "/" && t.isNode(node.left) && t.isNode(node.right)) {
    const left = staticExpression(node.left);
    const right = staticExpression(node.right);
    return left.ok && right.ok && typeof left.value === "number" && typeof right.value === "number"
      ? { ok: true, value: left.value / right.value }
      : { ok: false };
  }
  if (node.type === "ArrayExpression") {
    const values: unknown[] = [];
    for (const element of node.elements ?? []) {
      if (!element) return { ok: false };
      const item = staticExpression(element);
      if (!item.ok) return { ok: false };
      values.push(item.value);
    }
    return { ok: true, value: values };
  }
  return { ok: false };
}

/** Static value of a JSX attribute (`<Img priority />` is `true`). */
function staticAttribute(attribute: Node): Static {
  const value = attribute.value;
  if (value === undefined || value === null) return { ok: true, value: true };
  if (!t.isNode(value)) return { ok: false };
  if (t.isJSXExpressionContainer(value)) return staticExpression(value.expression);
  return staticExpression(value);
}

function attributeName(attribute: Node): string | null {
  return t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name) ? attribute.name.name : null;
}

function isRemoteOrInline(spec: string): boolean {
  return spec.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(spec);
}

/**
 * Rewrites static `<Img>` sources in `ast`. Returns how many `<Img>` elements
 * were found. Throws {@link BunOnlyImageError} when any is found and
 * `options.host` is not `"bun"` (the default when `options` is omitted is
 * `"other"`).
 */
export function rewriteImageElements(ast: File, code: string, filename: string, options?: ImageTransformOptions): number {
  const program = ast.program;
  const imgLocals = new Set<string>();
  const imageImports = new Map<string, string>();
  for (const statement of program.body) {
    if (!t.isImportDeclaration(statement) || statement.importKind === "type") continue;
    const source = t.moduleSourceValue(statement.source);
    if (source === null) continue;
    for (const specifier of statement.specifiers ?? []) {
      if (source === IMAGE_MODULE && t.isImportSpecifier(specifier) && specifier.importKind !== "type") {
        if (t.importedBindingName(specifier.imported) === "Img" && t.isIdentifier(specifier.local)) imgLocals.add(specifier.local.name);
      } else if (t.isImportDefaultSpecifier(specifier) && t.isIdentifier(specifier.local) && isOptimizableImage(source) && !source.includes("?")) {
        imageImports.set(specifier.local.name, source);
      }
    }
  }
  if (imgLocals.size === 0) return 0;

  const host = options?.host ?? "other";
  const added = new Map<string, string>();
  let found = 0;

  traverse(ast, {
    JSXOpeningElement(path) {
      const element = path.node;
      if (!t.isJSXOpeningElement(element) || !t.isJSXIdentifier(element.name) || !imgLocals.has(element.name.name)) return;
      found++;
      const where = `${filename}:${location(code, element)}`;
      if (host !== "bun") {
        throw new BunOnlyImageError(
          host === "vite"
            ? `<Img> found at ${where} while compiling with Vite on Node. Start Vite on Bun: \`bunx --bun vite\` (dev) and \`bunx --bun vite build\`.`
            : `<Img> found at ${where} while compiling for a non-Bun host.`,
        );
      }

      const attributes = new Map<string, Node>();
      for (const attribute of element.attributes) {
        const name = attributeName(attribute);
        if (name !== null) attributes.set(name, attribute);
      }
      const srcAttribute = attributes.get("src");
      if (!srcAttribute) return;
      const unoptimized = attributes.get("unoptimized");
      if (unoptimized) {
        const value = staticAttribute(unoptimized);
        if (!value.ok || value.value !== false) return;
      }

      let spec: string | null = null;
      const srcValue = srcAttribute.value;
      const srcExpression = t.isJSXExpressionContainer(srcValue) ? unwrap(srcValue.expression) : null;
      if (srcExpression && t.isIdentifier(srcExpression)) {
        spec = imageImports.get(srcExpression.name) ?? null;
      } else {
        const literal = staticAttribute(srcAttribute);
        if (literal.ok && typeof literal.value === "string") spec = literal.value;
      }
      if (spec === null || isRemoteOrInline(spec)) return;
      if (!isOptimizableImage(spec)) {
        throw new ImageTransformError(
          `${where}: <Img> optimizes JPEG, PNG, WebP, AVIF and HEIC sources; "${spec}" is not one. Add \`unoptimized\` to render it as is.`,
        );
      }

      const raw: Record<string, unknown> = {};
      for (const name of BUILD_OPTION_NAMES) {
        const attribute = attributes.get(name);
        if (!attribute) continue;
        const value = staticAttribute(attribute);
        if (!value.ok) {
          throw new ImageTransformError(
            `${where}: <Img> prop "${name}" must be a static value (a literal) so the image can be optimized at build time. Pass a dynamic src instead to optimize on demand.`,
          );
        }
        raw[name] = value.value;
      }
      let buildOptions;
      try {
        buildOptions = validateBuildOptions(raw);
      } catch (error) {
        throw new ImageTransformError(`${where}: <Img> ${error instanceof ImageOptionsError ? error.message : String(error)}`);
      }

      const specifier = withImageQuery(spec, buildOptions);
      let local = added.get(specifier);
      if (local === undefined) {
        local = `${IMAGE_LOCAL_PREFIX}${added.size}`;
        added.set(specifier, local);
      }
      srcAttribute.value = t.jsxExpressionContainer(t.identifier(local));
    },
  });

  const imports = [...added].map(([specifier, local]) =>
    t.importDeclaration([{ type: "ImportDefaultSpecifier", local: t.identifier(local) }], t.stringLiteral(specifier)),
  );
  program.body.unshift(...imports);
  return found;
}
