/**
 * `<Img>` is optimized only by Bun's native `Bun.Image`. Runtimes without it
 * (Node — including Vite started on Node —, Deno, …) are refused with one
 * actionable message; there is no fallback encoder.
 */

export const BUN_ONLY_IMAGE_MESSAGE = [
  "[sinwan/image] <Img> requires the Bun runtime (Bun >= 1.4).",
  "Images are optimized at build time and on demand by Bun's native `Bun.Image` pipeline, which only exists in Bun.",
  "Node and other runtimes cannot use <Img>, and Sinwan does not fall back to another image library.",
  "Run and build the app with Bun: bun-plugin-sinwan (`Bun.build`, `Bun.serve`), or Vite started on Bun with vite-plugin-sinwan (`bunx --bun vite` and `bunx --bun vite build`).",
].join("\n");

/** Thrown when `<Img>` is compiled or optimized outside Bun. */
export class BunOnlyImageError extends Error {
  override name = "BunOnlyImageError";

  constructor(detail?: string) {
    super(detail ? `${BUN_ONLY_IMAGE_MESSAGE}\n${detail}` : BUN_ONLY_IMAGE_MESSAGE);
  }
}

/** Whether `scope` is a Bun runtime with the native image pipeline. */
export function hasBunImage(scope: object = globalThis): boolean {
  const bun: unknown = Reflect.get(scope, "Bun");
  return typeof bun === "object" && bun !== null && typeof Reflect.get(bun, "Image") === "function";
}

/** Throws {@link BunOnlyImageError} unless running on Bun with `Bun.Image`. */
export function assertBunImageRuntime(scope: object = globalThis): void {
  if (!hasBunImage(scope)) {
    throw new BunOnlyImageError("Detected runtime: no `Bun.Image` global.");
  }
}
