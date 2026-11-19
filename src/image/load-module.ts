/**
 * Builds the module behind a `?sinwan-img=` import: optimizes every planned
 * variant into the disk cache, then emits JS that imports those cached files
 * (`sinwan-img-file:<path>`, resolved by the plugin; the bundler then
 * content-hashes and emits them like any asset) and exports the
 * `ImageAsset` that `<Img>` renders from `sinwan/image`.
 */
import { imageCacheFor, sha256, type ImageCache } from "./cache";
import type { ImageBuildOptions, ImageConfig } from "./options";
import { createPlaceholder, encodeVariant, FORMAT_EXTENSION, ImageBuildError, readSourceInfo } from "./pipeline";
import { planImage, type ImagePlan } from "./plan";
import { IMAGE_FILE_PREFIX, parseImageQuery } from "./query";
import { assertBunImageRuntime } from "./runtime-guard";

export interface OptimizedImage {
  plan: ImagePlan;
  /** Absolute cached file per variant, same order as `plan.variants`. */
  files: string[];
  placeholder?: string;
}

/** Optimizes `bytes` for `options` into the cache (hits skip all decoding). */
export async function optimizeImage(
  bytes: Uint8Array,
  options: ImageBuildOptions,
  config: ImageConfig,
  cache: ImageCache = imageCacheFor(config.cacheDir),
): Promise<OptimizedImage> {
  assertBunImageRuntime();
  const sourceHash = sha256(bytes);
  const info = await readSourceInfo(bytes, config.maxPixels);
  const plan = planImage(info, options, config);
  const files = await Promise.all(
    plan.variants.map(({ descriptor: _descriptor, ...target }) =>
      cache.ensure(cache.key(sourceHash, target), FORMAT_EXTENSION[target.format], () =>
        encodeVariant(bytes, target, config.maxPixels),
      ),
    ),
  );
  const placeholder =
    options.placeholder === "blur"
      ? await cache.ensureText(cache.key(sourceHash, "placeholder"), () => createPlaceholder(bytes, config.maxPixels))
      : undefined;
  return { plan, files, ...(placeholder === undefined ? {} : { placeholder }) };
}

/** JS source of an image asset module for an optimized image. */
export function generateAssetModule(image: OptimizedImage): string {
  const { plan, files, placeholder } = image;
  const imports = files.map((file, index) => `import _$v${index} from ${JSON.stringify(IMAGE_FILE_PREFIX + file)};`);
  const srcSet = plan.variants.map((variant, index) => `_$v${index} + ${JSON.stringify(` ${variant.descriptor}`)}`);
  // `x` descriptors: the 1x file is the fallback; `w` descriptors: the largest.
  const fallback = plan.sizes === undefined ? 0 : files.length - 1;
  const fields = [
    `src: _$v${fallback}`,
    `srcSet: [${srcSet.join(", ")}].join(", ")`,
    `width: ${plan.width}`,
    `height: ${plan.height}`,
    `fit: ${JSON.stringify(plan.fit)}`,
    `format: ${JSON.stringify(plan.format)}`,
  ];
  if (plan.sizes !== undefined) fields.push(`sizes: ${JSON.stringify(plan.sizes)}`);
  if (placeholder !== undefined) fields.push(`placeholder: ${JSON.stringify(placeholder)}`);
  return `${imports.join("\n")}\nexport default Object.freeze({ ${fields.join(", ")} });\n`;
}

/**
 * Loads `id` — an absolute file path carrying `?sinwan-img=` — into an image
 * asset module.
 */
export async function loadImageModule(id: string, config: ImageConfig, cache?: ImageCache): Promise<string> {
  assertBunImageRuntime();
  const parsed = parseImageQuery(id);
  if (!parsed) throw new ImageBuildError(`Not an <Img> asset import: "${id}".`);
  const source = Bun.file(parsed.file);
  if (!(await source.exists())) throw new ImageBuildError(`<Img> source not found: ${parsed.file}`);
  return generateAssetModule(await optimizeImage(await source.bytes(), parsed.options, config, cache));
}
