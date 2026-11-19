/**
 * `sinwan-compiler/image` — the Bun-native `<Img>` optimization pipeline:
 * configuration, variant planning, `Bun.Image` encoding, the disk cache, the
 * asset modules behind `?sinwan-img=` imports and the on-demand handler.
 *
 * Bun only: every entry that encodes asserts `Bun.Image` and throws
 * {@link BunOnlyImageError} elsewhere. The JSX pass lives in the main entry
 * (`transformJSX({ images: { host: "bun" } })`).
 */

export {
  BUN_ONLY_IMAGE_MESSAGE,
  BunOnlyImageError,
  assertBunImageRuntime,
  hasBunImage,
} from "./runtime-guard";
export {
  BUILD_OPTION_NAMES,
  DEFAULT_DENSITIES,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  DEFAULT_QUALITY,
  IMAGE_FITS,
  IMAGE_FORMATS,
  IMAGE_PLACEHOLDERS,
  ImageOptionsError,
  isOptimizableImage,
  parseAspectRatio,
  resolveImageConfig,
  validateBuildOptions,
  type ImageBuildOptions,
  type ImageConfig,
  type ImageFit,
  type ImageFormat,
  type ImagePlaceholder,
  type OutputFormat,
  type RemotePattern,
} from "./options";
export { DEFAULT_FIT, boxSize, pixelSize, planImage, resolveOutputFormat, type ImagePlan, type PlannedVariant, type Size } from "./plan";
export {
  AVIF_UNSUPPORTED_MESSAGE,
  FORMAT_EXTENSION,
  FORMAT_MIME,
  ImageBuildError,
  canEncodeAvif,
  createPlaceholder,
  encodeVariant,
  readSourceInfo,
  type EncodeTarget,
  type SourceInfo,
} from "./pipeline";
export { ImageCache, PIPELINE_VERSION, imageCacheFor, sha256 } from "./cache";
export { IMAGE_FILE_PATTERN, IMAGE_FILE_PREFIX, IMAGE_QUERY_PARAM, IMAGE_QUERY_PATTERN, parseImageQuery, withImageQuery } from "./query";
export { generateAssetModule, loadImageModule, optimizeImage, type OptimizedImage } from "./load-module";
export {
  DEFAULT_IMAGE_PATH,
  createImageHandler,
  matchesRemotePattern,
  negotiateFormat,
  type ImageHandler,
} from "./handler";
