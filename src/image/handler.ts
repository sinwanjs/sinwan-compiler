/**
 * On-demand optimization for `<Img>` sources only known at runtime: a fetch
 * handler for `Bun.serve` routes (`"/_sinwan/image": createImageHandler()`).
 *
 * `GET ?url=<src>&w=<width>&q=<quality>[&f=<format>]`
 *
 * - `w` and `q` must be configured values, so a client cannot fill the cache
 *   with arbitrary sizes.
 * - Local sources must live under `publicDir`; remote ones must match a
 *   `remotePatterns` entry, are fetched without following redirects, with a
 *   timeout and a byte limit.
 * - The format follows `Accept` (AVIF when this machine can encode it, then
 *   WebP, then the source's JPEG/PNG) unless `f` names one; responses carry
 *   `Vary: Accept`, an ETag and `Cache-Control: public, max-age=<cacheTTL>`.
 * - Results share the build's content-addressed disk cache.
 */
import * as path from "path";

import { imageCacheFor, sha256 } from "./cache";
import { type ImageConfig, type OutputFormat, type RemotePattern, resolveImageConfig } from "./options";
import { canEncodeAvif, encodeVariant, FORMAT_EXTENSION, FORMAT_MIME, ImageBuildError, readSourceInfo, type SourceInfo } from "./pipeline";
import { assertBunImageRuntime } from "./runtime-guard";

export type ImageHandler = (request: Request) => Promise<Response>;

/** Default route the `sinwan/image` loader points at. */
export const DEFAULT_IMAGE_PATH = "/_sinwan/image";

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const OUTPUT_FORMATS: readonly OutputFormat[] = ["webp", "avif", "jpeg", "png"];

function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Whether a remote URL is allowed by one of `patterns`. `*.example.com` matches any subdomain depth. */
export function matchesRemotePattern(url: URL, patterns: readonly RemotePattern[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.protocol && `${pattern.protocol}:` !== url.protocol) return false;
    if (pattern.port !== undefined && pattern.port !== url.port) return false;
    const host = url.hostname.toLowerCase();
    const wanted = pattern.hostname.toLowerCase();
    const hostOk = wanted.startsWith("*.") ? host.endsWith(wanted.slice(1)) && host.length > wanted.length - 1 : host === wanted;
    if (!hostOk) return false;
    return pattern.pathname === undefined || url.pathname.startsWith(pattern.pathname);
  });
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, `Source image is larger than ${maxBytes} bytes.`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new HttpError(413, `Source image is larger than ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readSource(src: string, config: ImageConfig): Promise<Uint8Array> {
  if (src.startsWith("/") && !src.startsWith("//")) {
    let pathname: string;
    try {
      pathname = decodeURIComponent(src.split(/[?#]/)[0] ?? "");
    } catch {
      throw new HttpError(400, '"url" is not a valid path.');
    }
    const file = path.resolve(config.publicDir, `.${pathname}`);
    if (pathname.includes("\0") || !file.startsWith(config.publicDir + path.sep)) {
      throw new HttpError(403, "Local images must be inside the public directory.");
    }
    const source = Bun.file(file);
    if (!(await source.exists())) throw new HttpError(404, "Source image not found.");
    if (source.size > config.maxInputBytes) throw new HttpError(413, `Source image is larger than ${config.maxInputBytes} bytes.`);
    return source.bytes();
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new HttpError(400, '"url" must be a root-relative path or an absolute http(s) URL.');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, '"url" must be a root-relative path or an absolute http(s) URL.');
  }
  if (!matchesRemotePattern(url, config.remotePatterns)) {
    throw new HttpError(403, `Remote images from ${url.host} are not allowed (add it to images.remotePatterns).`);
  }
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(config.fetchTimeoutMs) });
  } catch {
    throw new HttpError(502, "Could not fetch the source image.");
  }
  if (!response.ok) throw new HttpError(502, `The source image answered ${response.status}.`);
  return readLimited(response, config.maxInputBytes);
}

/** The output format for an `Accept` header and source format. */
export function negotiateFormat(accept: string | null, sourceFormat: string, avif: boolean): OutputFormat {
  const header = accept ?? "";
  if (avif && header.includes("image/avif")) return "avif";
  if (header.includes("image/webp")) return "webp";
  return sourceFormat === "png" ? "png" : "jpeg";
}

/** Creates the on-demand image route handler (Bun only). */
export function createImageHandler(options: Partial<ImageConfig> = {}): ImageHandler {
  assertBunImageRuntime();
  const config = resolveImageConfig(options);
  const cache = imageCacheFor(config.cacheDir);
  const widths = new Set([...config.deviceSizes, ...config.imageSizes]);

  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Use GET.");
      const params = new URL(request.url).searchParams;
      const src = params.get("url");
      if (!src) throw new HttpError(400, '"url" is required.');
      const width = Number(params.get("w"));
      if (!widths.has(width)) throw new HttpError(400, `"w" must be one of ${[...widths].sort((a, b) => a - b).join(", ")}.`);
      const quality = Number(params.get("q") ?? config.quality);
      if (!config.qualities.includes(quality)) throw new HttpError(400, `"q" must be one of ${config.qualities.join(", ")}.`);
      const requested = params.get("f");
      const forced = requested === null ? undefined : OUTPUT_FORMATS.find((format) => format === requested);
      if (requested !== null && forced === undefined) throw new HttpError(400, `"f" must be one of ${OUTPUT_FORMATS.join(", ")}.`);

      const bytes = await readSource(src, config);
      let info: SourceInfo;
      try {
        info = await readSourceInfo(bytes, config.maxPixels);
      } catch {
        throw new HttpError(415, "The source is not an image Bun.Image can decode.");
      }
      const avif = await canEncodeAvif();
      if (forced === "avif" && !avif) throw new HttpError(400, "AVIF encoding is not available on this server.");
      const format = forced ?? negotiateFormat(request.headers.get("accept"), info.format, avif);
      const outWidth = Math.min(width, info.width);
      const target = { width: outWidth, height: Math.max(1, Math.round((info.height * outWidth) / info.width)), format, quality };
      const key = cache.key(sha256(bytes), target);
      const headers = {
        "Content-Type": FORMAT_MIME[format],
        "Cache-Control": `public, max-age=${config.cacheTTL}`,
        ETag: `"${key}"`,
        Vary: "Accept",
        "X-Content-Type-Options": "nosniff",
      };
      if (request.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });
      let file: string;
      try {
        file = await cache.ensure(key, FORMAT_EXTENSION[format], () => encodeVariant(bytes, target, config.maxPixels));
      } catch (error) {
        throw new HttpError(415, error instanceof ImageBuildError ? error.message : "The image could not be optimized.");
      }
      return new Response(request.method === "HEAD" ? null : Bun.file(file), { headers });
    } catch (error) {
      if (error instanceof HttpError) return textResponse(error.status, error.message);
      throw error;
    }
  };
}
