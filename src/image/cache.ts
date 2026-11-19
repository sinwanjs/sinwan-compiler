/**
 * Content-addressed disk cache for optimized images. A key is the hash of the
 * source bytes, the exact target, the pipeline version and the Bun version, so
 * an unchanged image is never decoded again — across builds, dev reloads and
 * on-demand requests — and any change produces a new file. Concurrent requests
 * for the same key share one encode.
 */
import { mkdir, readdir, rename, rm, stat, utimes } from "fs/promises";
import * as path from "path";

/** Bump when the planning or encoding output changes for the same inputs. */
export const PIPELINE_VERSION = 1;

/** Hex SHA-256 of bytes or text. */
export function sha256(input: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

export class ImageCache {
  readonly dir: string;
  private readonly pending = new Map<string, Promise<string>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Cache key for one output of a source (`sourceHash`) with `target` options. */
  key(sourceHash: string, target: unknown): string {
    return sha256(JSON.stringify([PIPELINE_VERSION, Bun.version, sourceHash, target])).slice(0, 32);
  }

  /** Absolute path of a cached file. */
  pathFor(key: string, extension: string): string {
    return path.join(this.dir, `${key}.${extension}`);
  }

  /**
   * The cached file for `key`, producing and writing it with `produce` on a
   * miss. A hit refreshes the file's time (for {@link prune}) and never calls
   * `produce`.
   */
  ensure(key: string, extension: string, produce: () => Promise<Uint8Array | string>): Promise<string> {
    const file = this.pathFor(key, extension);
    const inFlight = this.pending.get(file);
    if (inFlight) return inFlight;
    const work = this.load(file, produce).finally(() => this.pending.delete(file));
    this.pending.set(file, work);
    return work;
  }

  /** Like {@link ensure}, returning the cached text (placeholders). */
  async ensureText(key: string, produce: () => Promise<string>): Promise<string> {
    return Bun.file(await this.ensure(key, "txt", produce)).text();
  }

  private async load(file: string, produce: () => Promise<Uint8Array | string>): Promise<string> {
    if (await Bun.file(file).exists()) {
      const now = new Date();
      await utimes(file, now, now);
      return file;
    }
    const contents = await produce();
    await mkdir(this.dir, { recursive: true });
    // Write then rename: a reader never sees a half-written file.
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await Bun.write(temporary, contents);
    await rename(temporary, file);
    return file;
  }

  /** Removes least recently used files until the cache holds at most `maxBytes`. Returns how many were removed. */
  async prune(maxBytes: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.dir, name);
        const info = await stat(file);
        return { file, size: info.size, time: info.mtimeMs };
      }),
    );
    entries.sort((a, b) => a.time - b.time);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let removed = 0;
    for (const entry of entries) {
      if (total <= maxBytes) break;
      await rm(entry.file, { force: true });
      total -= entry.size;
      removed++;
    }
    return removed;
  }
}

const caches = new Map<string, ImageCache>();

/** The shared cache for `dir` (one per directory per process, so in-flight work is shared). */
export function imageCacheFor(dir: string): ImageCache {
  let cache = caches.get(dir);
  if (!cache) {
    cache = new ImageCache(dir);
    caches.set(dir, cache);
  }
  return cache;
}
