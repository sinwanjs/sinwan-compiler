/**
 * Pure variant planning: which files an `<Img>` needs (pixel sizes, format,
 * quality) and the `srcset` descriptor of each. Never upscales.
 *
 * Bun.Image resizes with `fill` or `inside` and has no crop, so every fit is
 * computed here as exact target pixels: `cover` / `outside` keep the source
 * ratio and cover the box (the component crops with `object-fit: cover`),
 * `contain` / `inside` fit within it, `fill` stretches to it.
 */
import {
  DEFAULT_DENSITIES,
  type ImageBuildOptions,
  type ImageConfig,
  type ImageFit,
  type ImageFormat,
  type OutputFormat,
  parseAspectRatio,
} from "./options";

export interface Size {
  width: number;
  height: number;
}

export interface PlannedVariant extends Size {
  format: OutputFormat;
  quality: number;
  /** `1x` / `2x` or `640w`. */
  descriptor: string;
}

export interface ImagePlan extends Size {
  fit: ImageFit;
  format: OutputFormat;
  sizes?: string;
  variants: PlannedVariant[];
}

export const DEFAULT_FIT: ImageFit = "cover";

/** `auto` is WebP: every Bun build can encode it, so builds stay identical across machines. */
export function resolveOutputFormat(format: ImageFormat | undefined): OutputFormat {
  return format === undefined || format === "auto" ? "webp" : format;
}

/** The rendered box in CSS pixels, from `width` / `height` / `aspectRatio` and the source ratio. */
export function boxSize(source: Size, options: Pick<ImageBuildOptions, "width" | "height" | "aspectRatio">): Size {
  const ratio = options.aspectRatio === undefined ? source.width / source.height : parseAspectRatio(options.aspectRatio);
  const { width, height } = options;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) return { width, height: Math.max(1, Math.round(width / ratio)) };
  if (height !== undefined) return { width: Math.max(1, Math.round(height * ratio)), height };
  return options.aspectRatio === undefined
    ? { width: source.width, height: source.height }
    : { width: source.width, height: Math.max(1, Math.round(source.width / ratio)) };
}

/** Pixel size of the file for `box` under `fit`, never larger than the source. */
export function pixelSize(source: Size, box: Size, fit: ImageFit): Size {
  if (fit === "fill") {
    const shrink = Math.min(1, source.width / box.width, source.height / box.height);
    return { width: Math.max(1, Math.round(box.width * shrink)), height: Math.max(1, Math.round(box.height * shrink)) };
  }
  const scaleX = box.width / source.width;
  const scaleY = box.height / source.height;
  const scale = Math.min(1, fit === "contain" || fit === "inside" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY));
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

/** Plans every file an `<Img>` with `options` needs for a `source` image. */
export function planImage(source: Size, options: ImageBuildOptions, config: Pick<ImageConfig, "deviceSizes" | "quality">): ImagePlan {
  const fit = options.fit ?? DEFAULT_FIT;
  const format = resolveOutputFormat(options.format);
  const quality = options.quality ?? config.quality;
  const box = boxSize(source, options);
  const variants: PlannedVariant[] = [];

  const add = (target: Size, descriptor: string): boolean => {
    const pixels = pixelSize(source, target, fit);
    if (variants.some((variant) => same(variant, pixels))) return false;
    variants.push({ ...pixels, format, quality, descriptor: descriptor === "w" ? `${pixels.width}w` : descriptor });
    return true;
  };

  if (options.sizes !== undefined) {
    // Width descriptors: one file per device width; widths past the source
    // collapse into the same (unscaled) file and are skipped by `add`.
    for (const deviceWidth of config.deviceSizes) {
      add({ width: deviceWidth, height: Math.max(1, Math.round((deviceWidth * box.height) / box.width)) }, "w");
    }
  } else {
    for (const density of options.densities ?? DEFAULT_DENSITIES) {
      add({ width: Math.round(box.width * density), height: Math.round(box.height * density) }, `${density}x`);
    }
  }

  return { ...box, fit, format, ...(options.sizes === undefined ? {} : { sizes: options.sizes }), variants };
}
