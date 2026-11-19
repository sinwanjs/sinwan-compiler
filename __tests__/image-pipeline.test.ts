import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdir, stat, utimes } from "fs/promises";
import * as path from "path";

import {
  AVIF_UNSUPPORTED_MESSAGE,
  ImageBuildError,
  ImageCache,
  canEncodeAvif,
  createPlaceholder,
  encodeVariant,
  generateAssetModule,
  imageCacheFor,
  loadImageModule,
  optimizeImage,
  readSourceInfo,
  resolveImageConfig,
  sha256,
  withImageQuery,
} from "../src/image";
import { resetAvifProbe } from "../src/image/pipeline";
import { gradientJpeg, gradientPng, metadataOf, tempDir } from "./support/images";

const MAX = 0x3fff * 0x3fff;

afterEach(() => resetAvifProbe());

describe("Bun.Image pipeline", () => {
  test("reads the header", async () => {
    expect(await readSourceInfo(gradientPng(30, 20), MAX)).toEqual({ width: 30, height: 20, format: "png" });
    await expect(readSourceInfo(new Uint8Array([1, 2, 3]), MAX)).rejects.toThrow(ImageBuildError);
  });

  test("resizes and converts to every format", async () => {
    const png = gradientPng(400, 200);
    for (const format of ["webp", "jpeg", "png"] as const) {
      const bytes = await encodeVariant(png, { width: 100, height: 50, format, quality: 80 }, MAX);
      expect(await metadataOf(bytes)).toMatchObject({ width: 100, height: 50, format });
    }
  });

  test("quality changes the output size", async () => {
    const jpeg = await gradientJpeg(600, 400);
    const low = await encodeVariant(jpeg, { width: 600, height: 400, format: "webp", quality: 20 }, MAX);
    const high = await encodeVariant(jpeg, { width: 600, height: 400, format: "webp", quality: 95 }, MAX);
    expect(low.byteLength).toBeLessThan(high.byteLength);
  });

  test("AVIF is encoded when the machine can, and is a hard error when it cannot", async () => {
    const png = gradientPng(40, 20);
    if (await canEncodeAvif()) {
      const avif = await encodeVariant(png, { width: 20, height: 10, format: "avif", quality: 50 }, MAX);
      expect((await metadataOf(avif)).format).toBe("avif");
    } else {
      await expect(encodeVariant(png, { width: 20, height: 10, format: "avif", quality: 50 }, MAX)).rejects.toThrow(AVIF_UNSUPPORTED_MESSAGE);
    }
    // Forced failure path: a fake encoder rejecting with the unsupported code.
    const unsupported = Object.assign(new Error("no encoder"), { code: "ERR_IMAGE_FORMAT_UNSUPPORTED" });
    const spy = spyOn(Bun.Image.prototype, "bytes").mockRejectedValue(unsupported);
    try {
      await expect(encodeVariant(png, { width: 20, height: 10, format: "avif", quality: 50 }, MAX)).rejects.toThrow(AVIF_UNSUPPORTED_MESSAGE);
      await expect(encodeVariant(png, { width: 20, height: 10, format: "webp", quality: 50 }, MAX)).rejects.toThrow("cannot encode webp");
      resetAvifProbe();
      expect(await canEncodeAvif()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("an undecodable source is an ImageBuildError", async () => {
    await expect(encodeVariant(new Uint8Array([9, 9, 9]), { width: 1, height: 1, format: "webp", quality: 50 }, MAX)).rejects.toThrow(
      "could not optimize",
    );
    await expect(createPlaceholder(new Uint8Array([9, 9, 9]), MAX)).rejects.toThrow("could not build a placeholder");
    const spy = spyOn(Bun.Image.prototype, "bytes").mockRejectedValue("plain failure");
    try {
      await expect(encodeVariant(gradientPng(4, 4), { width: 1, height: 1, format: "png", quality: 50 }, MAX)).rejects.toThrow("plain failure");
    } finally {
      spy.mockRestore();
    }
  });

  test("placeholder is a small PNG data URL", async () => {
    const placeholder = await createPlaceholder(await gradientJpeg(800, 600), MAX);
    expect(placeholder).toStartWith("data:image/png;base64,");
    expect(placeholder.length).toBeLessThan(3000);
  });
});

describe("ImageCache", () => {
  test("produces once, then serves the file without calling produce", async () => {
    const cache = new ImageCache(await tempDir());
    let calls = 0;
    const produce = async () => {
      calls++;
      return new Uint8Array([1, 2, 3]);
    };
    const key = cache.key(sha256("source"), { width: 1 });
    const [a, b] = await Promise.all([cache.ensure(key, "bin", produce), cache.ensure(key, "bin", produce)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(await cache.ensure(key, "bin", produce)).toBe(a);
    expect(calls).toBe(1);
    expect(await new ImageCache(cache.dir).ensure(key, "bin", produce)).toBe(a);
    expect(calls).toBe(1);
    expect(await cache.ensureText(cache.key("s", "t"), async () => "hello")).toBe("hello");
  });

  test("keys change with the source or the target", () => {
    const cache = new ImageCache("/x");
    expect(cache.key("a", { w: 1 })).toHaveLength(32);
    expect(cache.key("a", { w: 1 })).toBe(cache.key("a", { w: 1 }));
    expect(cache.key("a", { w: 1 })).not.toBe(cache.key("b", { w: 1 }));
    expect(cache.key("a", { w: 1 })).not.toBe(cache.key("a", { w: 2 }));
    expect(cache.pathFor("k", "webp")).toBe(path.join("/x", "k.webp"));
  });

  test("a failed produce is not cached", async () => {
    const cache = new ImageCache(await tempDir());
    await expect(cache.ensure("k", "bin", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await cache.ensure("k", "bin", async () => "ok")).toEndWith("k.bin");
  });

  test("prune removes least recently used files first", async () => {
    const cache = new ImageCache(await tempDir());
    const old = await cache.ensure("old", "bin", async () => new Uint8Array(100));
    await cache.ensure("new", "bin", async () => new Uint8Array(100));
    await utimes(old, new Date(1000), new Date(1000));
    expect(await cache.prune(150)).toBe(1);
    expect(await readdir(cache.dir)).toEqual(["new.bin"]);
    expect(await cache.prune(1000)).toBe(0);
    expect(await new ImageCache(path.join(cache.dir, "missing")).prune(0)).toBe(0);
  });

  test("imageCacheFor shares one cache per directory", () => {
    expect(imageCacheFor("/a")).toBe(imageCacheFor("/a"));
    expect(imageCacheFor("/a")).not.toBe(imageCacheFor("/b"));
  });
});

describe("asset modules", () => {
  test("optimizes every variant once and generates the module", async () => {
    const root = await tempDir();
    const config = resolveImageConfig({ root });
    const cache = new ImageCache(config.cacheDir);
    const jpeg = await gradientJpeg(1600, 800);
    const encode = spyOn(Bun.Image.prototype, "webp");
    try {
      const first = await optimizeImage(jpeg, { width: 400, placeholder: "blur" }, config, cache);
      expect(first.plan.variants.map((v) => [v.width, v.height])).toEqual([
        [400, 200],
        [800, 400],
      ]);
      expect(first.placeholder).toStartWith("data:image/png;base64,");
      for (const file of first.files) expect((await stat(file)).size).toBeGreaterThan(0);
      expect(await metadataOf(await Bun.file(first.files[1] ?? "").bytes())).toMatchObject({ width: 800, height: 400, format: "webp" });
      const encodes = encode.mock.calls.length;
      const again = await optimizeImage(jpeg, { width: 400, placeholder: "blur" }, config, cache);
      expect(again.files).toEqual(first.files);
      expect(encode.mock.calls.length).toBe(encodes);
    } finally {
      encode.mockRestore();
    }
  });

  test("module shape for density and width descriptors", () => {
    const base = { width: 400, height: 200, fit: "cover" as const, format: "webp" as const };
    const dense = generateAssetModule({
      plan: { ...base, variants: [{ width: 400, height: 200, format: "webp", quality: 75, descriptor: "1x" }, { width: 800, height: 400, format: "webp", quality: 75, descriptor: "2x" }] },
      files: ["/c/a.webp", "/c/b.webp"],
    });
    expect(dense).toContain('import _$v0 from "sinwan-img-file:/c/a.webp";');
    expect(dense).toContain("src: _$v0");
    expect(dense).toContain('srcSet: [_$v0 + " 1x", _$v1 + " 2x"].join(", ")');
    expect(dense).not.toContain("sizes:");
    expect(dense).not.toContain("placeholder:");
    const wide = generateAssetModule({
      plan: { ...base, sizes: "50vw", variants: [{ width: 640, height: 320, format: "webp", quality: 75, descriptor: "640w" }, { width: 750, height: 375, format: "webp", quality: 75, descriptor: "750w" }] },
      files: ["/c/a.webp", "/c/b.webp"],
      placeholder: "data:x",
    });
    expect(wide).toContain("src: _$v1");
    expect(wide).toContain('sizes: "50vw"');
    expect(wide).toContain('placeholder: "data:x"');
  });

  test("loadImageModule reads the file named by the import", async () => {
    const root = await tempDir();
    const file = path.join(root, "hero.png");
    await Bun.write(file, gradientPng(300, 150));
    const config = resolveImageConfig({ root });
    const code = await loadImageModule(withImageQuery(file, { width: 100 }), config);
    expect(code).toContain("export default Object.freeze({");
    expect(code).toContain("width: 100, height: 50");
    await expect(loadImageModule(file, config)).rejects.toThrow("Not an <Img> asset import");
    await expect(loadImageModule(withImageQuery(path.join(root, "missing.png"), {}), config)).rejects.toThrow("source not found");
  });
});
