/**
 * `<Img>` optimization options: the props the compiler reads at build time,
 * the app-level configuration, defaults, and strict validation.
 */
import * as path from "path";

export const IMAGE_FORMATS = ["auto", "webp", "avif", "jpeg", "png"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];
/** A format Bun.Image writes (`auto` resolved). */
export type OutputFormat = Exclude<ImageFormat, "auto">;

/**
 * - `cover`: fill the box, keep the ratio; the overflow is cropped visually by
 *   `object-fit: cover` (Bun.Image has no pixel crop).
 * - `contain` / `inside`: fit within the box, keep the ratio.
 * - `fill`: stretch to exactly the box.
 * - `outside`: cover the box, keep the ratio, no cropping.
 */
export const IMAGE_FITS = ["cover", "contain", "fill", "inside", "outside"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

export const IMAGE_PLACEHOLDERS = ["blur", "empty"] as const;
export type ImagePlaceholder = (typeof IMAGE_PLACEHOLDERS)[number];

/** Source types Bun.Image decodes. */
export const OPTIMIZABLE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"] as const;

/** `<Img>` props that drive optimization; static at build time. */
export interface ImageBuildOptions {
  /** Rendered width in CSS pixels (the box). */
  width?: number;
  /** Rendered height in CSS pixels (the box). */
  height?: number;
  /** Encoder quality, 1–100. */
  quality?: number;
  format?: ImageFormat;
  fit?: ImageFit;
  /** `sizes` attribute: switches to width descriptors (`480w, 800w, …`). */
  sizes?: string;
  /** Pixel densities for `x` descriptors when `sizes` is not set. */
  densities?: number[];
  placeholder?: ImagePlaceholder;
  /** Width / height ratio: `1.5`, `"3/2"` or `"3:2"`. */
  aspectRatio?: number | string;
}

export const BUILD_OPTION_NAMES = [
  "width",
  "height",
  "quality",
  "format",
  "fit",
  "sizes",
  "densities",
  "placeholder",
  "aspectRatio",
] as const satisfies readonly (keyof ImageBuildOptions)[];

/** A remote origin the on-demand handler may fetch from. */
export interface RemotePattern {
  protocol?: "http" | "https";
  hostname: string;
  port?: string;
  /** Path prefix, e.g. `/uploads/`. */
  pathname?: string;
}

export interface ImageConfig {
  /** App root; relative paths below resolve against it. */
  root: string;
  /** Public files directory (root-absolute `src="/x.jpg"`). */
  publicDir: string;
  /** Optimized-file cache directory. */
  cacheDir: string;
  /** Widths for responsive (`sizes`) images and the on-demand handler. */
  deviceSizes: number[];
  /** Extra widths the on-demand handler accepts (icons, avatars). */
  imageSizes: number[];
  /** Default quality. */
  quality: number;
  /** Qualities the on-demand handler accepts. */
  qualities: number[];
  /** Refuse sources larger than this many pixels before decoding. */
  maxPixels: number;
  /** Refuse on-demand source files larger than this many bytes. */
  maxInputBytes: number;
  /** Remote origins the on-demand handler may fetch; none by default. */
  remotePatterns: RemotePattern[];
  /** `max-age` (seconds) of on-demand responses. */
  cacheTTL: number;
  /** Remote fetch timeout (ms). */
  fetchTimeoutMs: number;
}

export const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
export const DEFAULT_QUALITY = 75;
export const DEFAULT_DENSITIES = [1, 2];

/** Thrown for an invalid `<Img>` option or configuration. */
export class ImageOptionsError extends Error {
  override name = "ImageOptionsError";
}

function positiveIntegers(name: string, values: readonly number[]): number[] {
  if (values.length === 0) throw new ImageOptionsError(`images.${name} must list at least one width.`);
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ImageOptionsError(`images.${name} must contain positive integers, got ${value}.`);
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function assertQuality(value: number, where: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ImageOptionsError(`${where} must be an integer from 1 to 100, got ${value}.`);
  }
  return value;
}

/** Fills defaults and validates an app's image configuration. */
export function resolveImageConfig(partial: Partial<ImageConfig> = {}): ImageConfig {
  const root = path.resolve(partial.root ?? process.cwd());
  const quality = assertQuality(partial.quality ?? DEFAULT_QUALITY, "images.quality");
  const qualities = [...new Set([...(partial.qualities ?? [50, 75, 85, 100]), quality])]
    .map((q) => assertQuality(q, "images.qualities"))
    .sort((a, b) => a - b);
  return {
    root,
    publicDir: path.resolve(root, partial.publicDir ?? "public"),
    cacheDir: path.resolve(root, partial.cacheDir ?? ".sinwan/images"),
    deviceSizes: positiveIntegers("deviceSizes", partial.deviceSizes ?? DEFAULT_DEVICE_SIZES),
    imageSizes: positiveIntegers("imageSizes", partial.imageSizes ?? DEFAULT_IMAGE_SIZES),
    quality,
    qualities,
    maxPixels: partial.maxPixels ?? 0x3fff * 0x3fff,
    maxInputBytes: partial.maxInputBytes ?? 10 * 1024 * 1024,
    remotePatterns: partial.remotePatterns ?? [],
    cacheTTL: partial.cacheTTL ?? 60 * 60 * 24,
    fetchTimeoutMs: partial.fetchTimeoutMs ?? 10_000,
  };
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ImageOptionsError(`"${name}" must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${JSON.stringify(value)}.`);
  }
  return match;
}

function positiveNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ImageOptionsError(`"${name}" must be a positive number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** `1.5`, `"3/2"` or `"3:2"` → width / height. */
export function parseAspectRatio(value: unknown): number {
  if (typeof value === "number") return positiveNumber("aspectRatio", value);
  if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*[/:]\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (match) {
      const ratio = Number(match[1]) / Number(match[2]);
      if (Number.isFinite(ratio) && ratio > 0) return ratio;
    }
  }
  throw new ImageOptionsError(`"aspectRatio" must be a positive number or "W/H", got ${JSON.stringify(value)}.`);
}

/**
 * Validates raw build props (from JSX literals or a decoded import query)
 * into {@link ImageBuildOptions}; unknown keys are rejected.
 */
export function validateBuildOptions(raw: Record<string, unknown>): ImageBuildOptions {
  const options: ImageBuildOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    switch (key) {
      case "width":
      case "height":
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          throw new ImageOptionsError(`"${key}" must be a positive integer (CSS pixels), got ${JSON.stringify(value)}.`);
        }
        options[key] = value;
        break;
      case "quality":
        if (typeof value !== "number") throw new ImageOptionsError(`"quality" must be a number, got ${JSON.stringify(value)}.`);
        options.quality = assertQuality(value, '"quality"');
        break;
      case "format":
        options.format = oneOf("format", value, IMAGE_FORMATS);
        break;
      case "fit":
        options.fit = oneOf("fit", value, IMAGE_FITS);
        break;
      case "placeholder":
        options.placeholder = oneOf("placeholder", value, IMAGE_PLACEHOLDERS);
        break;
      case "sizes":
        if (typeof value !== "string" || value.trim() === "") {
          throw new ImageOptionsError(`"sizes" must be a non-empty string, got ${JSON.stringify(value)}.`);
        }
        options.sizes = value.trim();
        break;
      case "densities":
        if (!Array.isArray(value) || value.length === 0) {
          throw new ImageOptionsError(`"densities" must be a non-empty array of numbers, got ${JSON.stringify(value)}.`);
        }
        options.densities = [...new Set(value.map((d) => positiveNumber("densities", d)))].sort((a, b) => a - b);
        break;
      case "aspectRatio":
        parseAspectRatio(value);
        if (typeof value === "number" || typeof value === "string") options.aspectRatio = value;
        break;
      default:
        throw new ImageOptionsError(`Unknown image option "${key}".`);
    }
  }
  return options;
}

/** True when a file name has an extension Bun.Image decodes. */
export function isOptimizableImage(file: string): boolean {
  const extension = path.extname(file.split("?")[0] ?? "").slice(1).toLowerCase();
  return OPTIMIZABLE_EXTENSIONS.some((candidate) => candidate === extension);
}
