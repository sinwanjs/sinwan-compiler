/**
 * The import the compiler writes for a static `<Img>`:
 * `"./hero.jpg?sinwan-img=<base64url(JSON options)>"`. The Bun plugin turns
 * it into an image asset module; any other host fails on it.
 */
import { type ImageBuildOptions, validateBuildOptions } from "./options";

export const IMAGE_QUERY_PARAM = "sinwan-img";

/** Matches a specifier or path carrying the image query. */
export const IMAGE_QUERY_PATTERN = /[?&]sinwan-img=/;

/**
 * Prefix of the imports an asset module makes for its optimized files. The
 * Bun plugin resolves `sinwan-img-file:<absolute path>` to that path directly:
 * Bun's resolver caches directory listings, so a file written to the cache
 * after the directory was first listed would otherwise not resolve.
 */
export const IMAGE_FILE_PREFIX = "sinwan-img-file:";

/** Matches an optimized-file import made by an asset module. */
export const IMAGE_FILE_PATTERN = /^sinwan-img-file:/;

function stableJson(options: ImageBuildOptions): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(options).sort()) ordered[key] = Reflect.get(options, key);
  return JSON.stringify(ordered);
}

/** `spec` plus the encoded options (same options → same specifier). */
export function withImageQuery(spec: string, options: ImageBuildOptions): string {
  const encoded = Buffer.from(stableJson(options)).toString("base64url");
  return `${spec}${spec.includes("?") ? "&" : "?"}${IMAGE_QUERY_PARAM}=${encoded}`;
}

/** The file and validated options of an image-query specifier or path; `null` without the query. */
export function parseImageQuery(id: string): { file: string; options: ImageBuildOptions } | null {
  const index = id.search(IMAGE_QUERY_PATTERN);
  if (index < 0) return null;
  const file = id.slice(0, index);
  const params = new URLSearchParams(id.slice(index + 1));
  const encoded = params.get(IMAGE_QUERY_PARAM) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new SyntaxError(`Invalid ${IMAGE_QUERY_PARAM} query in "${id}".`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SyntaxError(`Invalid ${IMAGE_QUERY_PARAM} query in "${id}".`);
  }
  return { file, options: validateBuildOptions(Object.fromEntries(Object.entries(raw))) };
}
