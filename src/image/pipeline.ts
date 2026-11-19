/**
 * The only encoder: Bun's native `Bun.Image`. Every function asserts the Bun
 * runtime first; nothing falls back to another library.
 */
import { assertBunImageRuntime } from "./runtime-guard";
import type { OutputFormat } from "./options";
import type { Size } from "./plan";

export interface SourceInfo extends Size {
  /** `jpeg`, `png`, `webp`, `heic`, `avif`, … as Bun reports it. */
  format: string;
}

export interface EncodeTarget extends Size {
  format: OutputFormat;
  quality: number;
}

/** A source Bun cannot read or a target it cannot write. */
export class ImageBuildError extends Error {
  override name = "ImageBuildError";
}

export const AVIF_UNSUPPORTED_MESSAGE =
  'AVIF encoding is not available on this machine: Bun.Image needs an OS AV1 encoder (macOS on Apple Silicon M3 or later, or Windows with the AV1 Video Extension). Use format="webp" or format="auto".';

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Width, height and format from the header (no pixel decode). */
export async function readSourceInfo(bytes: Uint8Array, maxPixels: number): Promise<SourceInfo> {
  assertBunImageRuntime();
  try {
    const { width, height, format } = await new Bun.Image(bytes, { maxPixels }).metadata();
    return { width, height, format };
  } catch (error) {
    throw new ImageBuildError(`Bun.Image could not read this image: ${describe(error)}`);
  }
}

/** Resizes `bytes` to exactly `target` pixels and encodes it. */
export async function encodeVariant(bytes: Uint8Array, target: EncodeTarget, maxPixels: number): Promise<Uint8Array> {
  assertBunImageRuntime();
  const image = new Bun.Image(bytes, { maxPixels }).resize(target.width, target.height, { fit: "fill" });
  switch (target.format) {
    case "webp":
      image.webp({ quality: target.quality });
      break;
    case "avif":
      image.avif({ quality: target.quality });
      break;
    case "jpeg":
      image.jpeg({ quality: target.quality, progressive: true });
      break;
    case "png":
      image.png({ compressionLevel: 9 });
      break;
  }
  try {
    return await image.bytes();
  } catch (error) {
    if (errorCode(error) === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
      throw new ImageBuildError(target.format === "avif" ? AVIF_UNSUPPORTED_MESSAGE : `Bun.Image cannot encode ${target.format} here.`);
    }
    throw new ImageBuildError(`Bun.Image could not optimize this image: ${describe(error)}`);
  }
}

/** ThumbHash blur as a `data:image/png;base64,…` URL (about 1–2 KB). */
export async function createPlaceholder(bytes: Uint8Array, maxPixels: number): Promise<string> {
  assertBunImageRuntime();
  try {
    return await new Bun.Image(bytes, { maxPixels }).placeholder();
  } catch (error) {
    throw new ImageBuildError(`Bun.Image could not build a placeholder: ${describe(error)}`);
  }
}

/** 1×1 opaque PNG, used to probe the AVIF encoder once. */
const PROBE_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"),
  (char) => char.charCodeAt(0),
);

let avifSupport: Promise<boolean> | undefined;

/** Whether this machine can encode AVIF (probed once per process). */
export function canEncodeAvif(): Promise<boolean> {
  avifSupport ??= encodeVariant(PROBE_PNG, { width: 1, height: 1, format: "avif", quality: 50 }, 1).then(
    () => true,
    () => false,
  );
  return avifSupport;
}

/** Test hook: forget the probed AVIF support. */
export function resetAvifProbe(): void {
  avifSupport = undefined;
}

export const FORMAT_EXTENSION: Record<OutputFormat, string> = {
  webp: "webp",
  avif: "avif",
  jpeg: "jpg",
  png: "png",
};

export const FORMAT_MIME: Record<OutputFormat, string> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};
