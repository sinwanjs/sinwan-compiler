#!/usr/bin/env bun
import * as path from "path";

const testsDir = path.resolve(import.meta.dir, "../__tests__");
const files = [
  "analyze.test.ts",
  "cache.test.ts",
  "ast-facade.test.ts",
  "cli.test.ts",
  "exports.test.ts",
  "live-cc-destructure.test.ts",
  "oxc-spike.test.ts",
  "reactive-wrap-api.test.ts",
  "transform.test.ts",
  "compiler-1-0-review.test.ts",
  "auto-cc.test.ts",
].map((file) => path.join(testsDir, file));

const result = Bun.spawnSync({
  cmd: ["bun", "test", "--coverage", ...files],
  cwd: path.resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode ?? 1);
