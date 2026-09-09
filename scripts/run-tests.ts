#!/usr/bin/env bun
import * as path from "path";

const testsDir = path.resolve(import.meta.dir, "../__tests__");
const files = [
  "analyze.test.ts",
  "cache.test.ts",
  "cli.test.ts",
  "exports.test.ts",
  "reactive-wrap-api.test.ts",
  "transform.test.ts",
].map((file) => path.join(testsDir, file));

const result = Bun.spawnSync({
  cmd: ["bun", "test", "--coverage", ...files],
  cwd: path.resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode ?? 1);
