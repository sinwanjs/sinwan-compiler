import { $ } from "bun";
import { rm } from "node:fs/promises";

const ROOT = import.meta.dir;
const DIST = `${ROOT}/dist`;

async function cleanDist() {
  console.log("🧹  Cleaning dist/");
  await rm(DIST, { recursive: true, force: true });
}

async function emitDeclarations() {
  console.log("📝  Emitting type declarations");
  await $`bunx tsc -p tsconfig.build.json`.cwd(ROOT);
}

async function buildBundle() {
  console.log("📦  Bundling with Bun.build");
  await Bun.build({
    entrypoints: [`${ROOT}/src/index.ts`, `${ROOT}/src/cli.ts`],
    outdir: DIST,
    root: `${ROOT}/src`,
    target: "bun",
    splitting: true,
    packages: "external",
  });
}

async function main() {
  await cleanDist();
  await emitDeclarations();
  await buildBundle();
  console.log("✅  Build complete → dist/");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
