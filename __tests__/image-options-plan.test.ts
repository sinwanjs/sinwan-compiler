import { describe, expect, test } from "bun:test";
import * as path from "path";

import {
  BUN_ONLY_IMAGE_MESSAGE,
  BunOnlyImageError,
  assertBunImageRuntime,
  boxSize,
  hasBunImage,
  isOptimizableImage,
  parseAspectRatio,
  parseImageQuery,
  pixelSize,
  planImage,
  resolveImageConfig,
  resolveOutputFormat,
  validateBuildOptions,
  withImageQuery,
} from "../src/image";

const config = resolveImageConfig({ root: "/app" });

describe("runtime guard", () => {
  test("accepts Bun with Bun.Image", () => {
    expect(hasBunImage()).toBe(true);
    expect(() => assertBunImageRuntime()).not.toThrow();
  });

  test("refuses a runtime without Bun.Image with the actionable message", () => {
    expect(hasBunImage({})).toBe(false);
    expect(hasBunImage({ Bun: {} })).toBe(false);
    expect(hasBunImage({ Bun: null })).toBe(false);
    expect(() => assertBunImageRuntime({})).toThrow(BunOnlyImageError);
    const error = new BunOnlyImageError();
    expect(error.message).toBe(BUN_ONLY_IMAGE_MESSAGE);
    expect(error.name).toBe("BunOnlyImageError");
    for (const fact of ["requires the Bun runtime", "Bun.Image", "Node", "does not fall back", "bunx --bun vite build", "bun-plugin-sinwan"]) {
      expect(BUN_ONLY_IMAGE_MESSAGE).toContain(fact);
    }
  });
});

describe("resolveImageConfig", () => {
  test("defaults resolve against the root", () => {
    expect(config).toMatchObject({
      root: "/app",
      publicDir: path.resolve("/app/public"),
      cacheDir: path.resolve("/app/.sinwan/images"),
      quality: 75,
      qualities: [50, 75, 85, 100],
      remotePatterns: [],
      cacheTTL: 86400,
    });
    expect(config.deviceSizes[0]).toBe(640);
    expect(config.imageSizes[0]).toBe(16);
  });

  test("sorts, dedupes and adds the default quality to the allowed ones", () => {
    const custom = resolveImageConfig({ root: "/a", quality: 60, qualities: [90, 40, 90], deviceSizes: [800, 400, 800] });
    expect(custom.qualities).toEqual([40, 60, 90]);
    expect(custom.deviceSizes).toEqual([400, 800]);
    expect(resolveImageConfig().root).toBe(process.cwd());
  });

  test("rejects invalid values", () => {
    expect(() => resolveImageConfig({ quality: 0 })).toThrow("images.quality");
    expect(() => resolveImageConfig({ qualities: [101] })).toThrow("images.qualities");
    expect(() => resolveImageConfig({ deviceSizes: [] })).toThrow("at least one width");
    expect(() => resolveImageConfig({ imageSizes: [1.5] })).toThrow("positive integers");
  });
});

describe("validateBuildOptions", () => {
  test("accepts every option", () => {
    expect(
      validateBuildOptions({
        width: 1200,
        height: 800,
        quality: 85,
        format: "webp",
        fit: "contain",
        sizes: " 100vw ",
        densities: [2, 1, 2],
        placeholder: "blur",
        aspectRatio: "3/2",
        ignored: undefined,
      }),
    ).toEqual({
      width: 1200,
      height: 800,
      quality: 85,
      format: "webp",
      fit: "contain",
      sizes: "100vw",
      densities: [1, 2],
      placeholder: "blur",
      aspectRatio: "3/2",
    });
  });

  test("rejects invalid values with the prop name", () => {
    expect(() => validateBuildOptions({ width: 0 })).toThrow('"width" must be a positive integer');
    expect(() => validateBuildOptions({ height: "10" })).toThrow('"height"');
    expect(() => validateBuildOptions({ quality: "high" })).toThrow('"quality" must be a number');
    expect(() => validateBuildOptions({ quality: 120 })).toThrow('"quality" must be an integer from 1 to 100');
    expect(() => validateBuildOptions({ format: "gif" })).toThrow('"format" must be one of');
    expect(() => validateBuildOptions({ fit: "crop" })).toThrow('"fit"');
    expect(() => validateBuildOptions({ placeholder: "color" })).toThrow('"placeholder"');
    expect(() => validateBuildOptions({ sizes: "" })).toThrow('"sizes"');
    expect(() => validateBuildOptions({ densities: [] })).toThrow('"densities"');
    expect(() => validateBuildOptions({ densities: [0] })).toThrow('"densities" must be a positive number');
    expect(() => validateBuildOptions({ aspectRatio: "wide" })).toThrow('"aspectRatio"');
    expect(() => validateBuildOptions({ blur: true })).toThrow('Unknown image option "blur"');
  });

  test("parses aspect ratios", () => {
    expect(parseAspectRatio(1.5)).toBe(1.5);
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseAspectRatio(" 4 / 3 ")).toBeCloseTo(4 / 3);
    expect(() => parseAspectRatio("0/3")).toThrow();
    expect(() => parseAspectRatio(-1)).toThrow();
    expect(validateBuildOptions({ aspectRatio: 2 })).toEqual({ aspectRatio: 2 });
  });

  test("knows which files Bun.Image optimizes", () => {
    for (const file of ["a.jpg", "a.JPEG", "a.png", "a.webp", "a.avif", "a.heic", "./x/a.heif?raw"]) expect(isOptimizableImage(file)).toBe(true);
    for (const file of ["a.svg", "a.gif", "a", "a.jpg.txt"]) expect(isOptimizableImage(file)).toBe(false);
  });
});

describe("image query", () => {
  test("round-trips options with a stable key order", () => {
    const spec = withImageQuery("./hero.jpg", { width: 10, quality: 80 });
    expect(spec).toBe(withImageQuery("./hero.jpg", { quality: 80, width: 10 }));
    expect(parseImageQuery(spec)).toEqual({ file: "./hero.jpg", options: { width: 10, quality: 80 } });
    expect(withImageQuery("./a.png?x=1", {})).toStartWith("./a.png?x=1&sinwan-img=");
    expect(parseImageQuery("./a.png")).toBeNull();
  });

  test("rejects a tampered query", () => {
    expect(() => parseImageQuery("./a.png?sinwan-img=%%%")).toThrow("Invalid sinwan-img query");
    expect(() => parseImageQuery(`./a.png?sinwan-img=${Buffer.from("[1]").toString("base64url")}`)).toThrow("Invalid sinwan-img query");
    expect(() => parseImageQuery(`./a.png?sinwan-img=${Buffer.from('{"width":-1}').toString("base64url")}`)).toThrow('"width"');
  });
});

describe("planning", () => {
  const source = { width: 2000, height: 1000 };

  test("auto is WebP", () => {
    expect(resolveOutputFormat(undefined)).toBe("webp");
    expect(resolveOutputFormat("auto")).toBe("webp");
    expect(resolveOutputFormat("jpeg")).toBe("jpeg");
  });

  test("box from width, height, aspect ratio or the source", () => {
    expect(boxSize(source, {})).toEqual({ width: 2000, height: 1000 });
    expect(boxSize(source, { width: 400 })).toEqual({ width: 400, height: 200 });
    expect(boxSize(source, { height: 300 })).toEqual({ width: 600, height: 300 });
    expect(boxSize(source, { width: 400, height: 400 })).toEqual({ width: 400, height: 400 });
    expect(boxSize(source, { width: 400, aspectRatio: 1 })).toEqual({ width: 400, height: 400 });
    expect(boxSize(source, { height: 100, aspectRatio: "4/1" })).toEqual({ width: 400, height: 100 });
    expect(boxSize(source, { aspectRatio: 1 })).toEqual({ width: 2000, height: 2000 });
  });

  test("pixel size per fit, never upscaled", () => {
    const box = { width: 400, height: 400 };
    expect(pixelSize(source, box, "fill")).toEqual({ width: 400, height: 400 });
    expect(pixelSize(source, box, "inside")).toEqual({ width: 400, height: 200 });
    expect(pixelSize(source, box, "contain")).toEqual({ width: 400, height: 200 });
    expect(pixelSize(source, box, "cover")).toEqual({ width: 800, height: 400 });
    expect(pixelSize(source, box, "outside")).toEqual({ width: 800, height: 400 });
    expect(pixelSize(source, { width: 4000, height: 4000 }, "fill")).toEqual({ width: 1000, height: 1000 });
    expect(pixelSize(source, { width: 4000, height: 2000 }, "cover")).toEqual(source);
  });

  test("density descriptors: 1x and 2x, dropping duplicates past the source", () => {
    const plan = planImage(source, { width: 800, quality: 60 }, config);
    expect(plan).toMatchObject({ width: 800, height: 400, fit: "cover", format: "webp" });
    expect(plan.sizes).toBeUndefined();
    expect(plan.variants).toEqual([
      { width: 800, height: 400, format: "webp", quality: 60, descriptor: "1x" },
      { width: 1600, height: 800, format: "webp", quality: 60, descriptor: "2x" },
    ]);
    const capped = planImage(source, { width: 1500, densities: [1, 2, 3] }, config);
    expect(capped.variants.map((v) => v.descriptor)).toEqual(["1x", "2x"]);
    expect(capped.variants[1]).toMatchObject({ width: 2000, quality: 75 });
  });

  test("width descriptors follow deviceSizes up to the source", () => {
    const plan = planImage(source, { width: 1000, sizes: "100vw", format: "jpeg" }, config);
    expect(plan.sizes).toBe("100vw");
    expect(plan.variants.map((v) => v.descriptor)).toEqual(["640w", "750w", "828w", "1080w", "1200w", "1920w", "2000w"]);
    expect(plan.variants.every((v) => v.format === "jpeg")).toBe(true);
  });
});
