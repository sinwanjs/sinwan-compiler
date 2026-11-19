import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as path from "path";

import { DEFAULT_IMAGE_PATH, createImageHandler, matchesRemotePattern, negotiateFormat, type ImageHandler } from "../src/image";
import * as pipeline from "../src/image/pipeline";
import { gradientJpeg, gradientPng, metadataOf, tempDir } from "./support/images";

let root: string;
let handler: ImageHandler;
let remote: ReturnType<typeof Bun.serve>;
const PHOTO = await gradientJpeg(1200, 800);

const get = (query: string, headers: Record<string, string> = {}, method = "GET") =>
  handler(new Request(`http://app.test${DEFAULT_IMAGE_PATH}?${query}`, { headers, method }));

beforeAll(async () => {
  root = await tempDir();
  await Bun.write(path.join(root, "public", "photos", "shop.jpg"), PHOTO);
  await Bun.write(path.join(root, "public", "logo.png"), gradientPng(64, 64));
  await Bun.write(path.join(root, "public", "notes.txt"), "not an image");
  await Bun.write(path.join(root, "secret.jpg"), PHOTO);
  remote = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/img/ok.jpg") return new Response(PHOTO);
      if (pathname === "/img/big.jpg") return new Response(new Uint8Array(4096));
      if (pathname === "/img/stream.jpg") {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3000)); c.enqueue(new Uint8Array(3000)); c.close(); } }));
      }
      if (pathname === "/img/redirect.jpg") return Response.redirect("http://elsewhere.test/x.jpg", 302);
      return new Response("missing", { status: 404 });
    },
  });
  handler = createImageHandler({
    root,
    remotePatterns: [{ protocol: "http", hostname: "localhost", port: String(remote.port), pathname: "/img/" }],
    cacheTTL: 600,
  });
});

afterAll(() => remote.stop(true));

describe("createImageHandler", () => {
  test("resizes a public image, negotiates WebP and sends cache headers", async () => {
    const response = await get("url=/photos/shop.jpg&w=640&q=75", { accept: "image/webp,*/*" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await metadataOf(await response.bytes())).toMatchObject({ width: 640, height: 427, format: "webp" });

    const again = await get("url=/photos/shop.jpg&w=640&q=75", { accept: "image/webp", "if-none-match": response.headers.get("etag") ?? "" });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const head = await get("url=/photos/shop.jpg&w=640&q=75", { accept: "image/webp" }, "HEAD");
    expect(head.status).toBe(200);
  });

  test("falls back to the source format, never upscales, honours f", async () => {
    const jpeg = await get("url=/photos/shop.jpg&w=3840&q=50");
    expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
    expect((await metadataOf(await jpeg.bytes())).width).toBe(1200);
    const png = await get("url=/logo.png&w=32");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await metadataOf(await png.bytes())).width).toBe(32);
    const forced = await get("url=/logo.png&w=32&f=webp");
    expect(forced.headers.get("content-type")).toBe("image/webp");
  });

  test("AVIF only when the machine can encode it", async () => {
    const probe = spyOn(pipeline, "canEncodeAvif");
    try {
      probe.mockResolvedValue(false);
      expect((await get("url=/logo.png&w=16&f=avif")).status).toBe(400);
      expect((await get("url=/logo.png&w=16", { accept: "image/avif,image/webp" })).headers.get("content-type")).toBe("image/webp");
    } finally {
      probe.mockRestore();
    }
  });

  test("rejects bad parameters", async () => {
    expect((await get("w=640")).status).toBe(400);
    const width = await get("url=/logo.png&w=500");
    expect(width.status).toBe(400);
    expect(await width.text()).toContain('"w" must be one of 16, 32');
    expect((await get("url=/logo.png&w=16&q=42")).status).toBe(400);
    expect((await get("url=/logo.png&w=16&f=gif")).status).toBe(400);
    expect((await get("url=/logo.png&w=16", {}, "POST")).status).toBe(405);
  });

  test("keeps local reads inside the public directory", async () => {
    expect((await get("url=/../secret.jpg&w=640")).status).toBe(403);
    expect((await get("url=/%2e%2e/secret.jpg&w=640")).status).toBe(403);
    expect((await get("url=/a%00.jpg&w=640")).status).toBe(403);
    expect((await get("url=/%E0%A4%A&w=640")).status).toBe(400);
    expect((await get("url=/nope.jpg&w=640")).status).toBe(404);
    expect((await get("url=/notes.txt&w=640")).status).toBe(415);
  });

  test("remote sources must be allowlisted, small and not redirected", async () => {
    const base = `http://localhost:${remote.port}`;
    expect((await get(`url=${encodeURIComponent(`${base}/img/ok.jpg`)}&w=640`)).status).toBe(200);
    expect((await get(`url=${encodeURIComponent(`${base}/other/ok.jpg`)}&w=640`)).status).toBe(403);
    expect((await get(`url=${encodeURIComponent(`${base}/img/missing.jpg`)}&w=640`)).status).toBe(502);
    expect((await get(`url=${encodeURIComponent(`${base}/img/redirect.jpg`)}&w=640`)).status).toBe(502);
    expect((await get("url=ftp://localhost/x.jpg&w=640")).status).toBe(400);
    expect((await get("url=relative.jpg&w=640")).status).toBe(400);
    const small = createImageHandler({ root, maxInputBytes: 1024, remotePatterns: [{ hostname: "localhost" }] });
    const viaSmall = (url: string) => small(new Request(`http://app.test/?url=${encodeURIComponent(url)}&w=640`));
    expect((await viaSmall(`${base}/img/big.jpg`)).status).toBe(413);
    expect((await viaSmall(`${base}/img/stream.jpg`)).status).toBe(413);
    expect((await small(new Request("http://app.test/?url=/photos/shop.jpg&w=640"))).status).toBe(413);
    const offline = createImageHandler({ root, remotePatterns: [{ hostname: "localhost" }], fetchTimeoutMs: 1 });
    expect((await offline(new Request("http://app.test/?url=http://localhost:1/x.jpg&w=640"))).status).toBe(502);
  });

  test("an encoder failure is a 415, other errors propagate", async () => {
    const encode = spyOn(pipeline, "encodeVariant");
    try {
      encode.mockRejectedValueOnce(new pipeline.ImageBuildError("broken"));
      const broken = await get("url=/logo.png&w=48");
      expect(broken.status).toBe(415);
      expect(await broken.text()).toBe("broken");
      encode.mockRejectedValueOnce(new Error("disk"));
      expect((await get("url=/logo.png&w=64")).status).toBe(415);
      const info = spyOn(pipeline, "readSourceInfo").mockRejectedValueOnce(new Error("x"));
      expect((await get("url=/logo.png&w=96")).status).toBe(415);
      info.mockRestore();
    } finally {
      encode.mockRestore();
    }
    const throwing = spyOn(Headers.prototype, "get").mockImplementationOnce(() => {
      throw new TypeError("unexpected");
    });
    try {
      await expect(get("url=/logo.png&w=16")).rejects.toThrow("unexpected");
    } finally {
      throwing.mockRestore();
    }
  });
});

describe("helpers", () => {
  test("remote patterns", () => {
    const patterns = [{ protocol: "https" as const, hostname: "*.cdn.test", pathname: "/u/" }, { hostname: "exact.test" }];
    expect(matchesRemotePattern(new URL("https://a.cdn.test/u/x.jpg"), patterns)).toBe(true);
    expect(matchesRemotePattern(new URL("https://a.b.cdn.test/u/x.jpg"), patterns)).toBe(true);
    expect(matchesRemotePattern(new URL("https://cdn.test/u/x.jpg"), patterns)).toBe(false);
    expect(matchesRemotePattern(new URL("http://a.cdn.test/u/x.jpg"), patterns)).toBe(false);
    expect(matchesRemotePattern(new URL("https://a.cdn.test/v/x.jpg"), patterns)).toBe(false);
    expect(matchesRemotePattern(new URL("http://EXACT.test/any"), patterns)).toBe(true);
    expect(matchesRemotePattern(new URL("http://exact.test:8080/any"), [{ hostname: "exact.test", port: "80" }])).toBe(false);
  });

  test("format negotiation", () => {
    expect(negotiateFormat("image/avif,image/webp", "jpeg", true)).toBe("avif");
    expect(negotiateFormat("image/avif,image/webp", "jpeg", false)).toBe("webp");
    expect(negotiateFormat(null, "png", true)).toBe("png");
    expect(negotiateFormat("*/*", "heic", false)).toBe("jpeg");
  });
});
