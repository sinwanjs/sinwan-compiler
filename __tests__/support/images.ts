// Real, decodable images for the image pipeline tests. A smooth gradient
// compresses like a photo (noise would not), so quality and size comparisons
// behave as they do for real assets.
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { deflateSync } from "zlib";

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, Bun.hash.crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

/** An RGB PNG gradient of `width × height`. */
export function gradientPng(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.round((x / width) * 255);
      raw[row + 2 + x * 3] = Math.round((y / height) * 255);
      raw[row + 3 + x * 3] = (x * y) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

/** The same gradient as a JPEG. */
export function gradientJpeg(width: number, height: number): Promise<Uint8Array> {
  return new Bun.Image(gradientPng(width, height)).jpeg({ quality: 92 }).bytes();
}

/** A fresh temporary directory. */
export function tempDir(prefix = "sinwan-img-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Width, height and format of encoded bytes. */
export function metadataOf(bytes: Uint8Array) {
  return new Bun.Image(bytes).metadata();
}
