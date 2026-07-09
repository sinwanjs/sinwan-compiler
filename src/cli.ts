#!/usr/bin/env bun
/**
 * SinwanJS CLI — project-wide reactive prop analyzer.
 *
 * Usage:
 *   bunx sinwan-compiler analyze [root] [outFile]
 *
 * Writes `.sinwan/reactive-props.json` by default.
 */

import * as path from "path";
import { analyze } from "./analyze";

export function runAnalyzeCli(args: string[] = process.argv.slice(2)): void {
  let command: string | undefined;
  let root: string | undefined;
  let outFile: string | undefined;
  let tsConfigPath: string | undefined;
  let bunfigPath: string | undefined;
  let workspaces: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tsconfig" || arg === "-t") {
      tsConfigPath = args[++i];
    } else if (arg === "--bunfig" || arg === "-b") {
      bunfigPath = args[++i];
    } else if (arg === "--workspaces" || arg === "-w") {
      workspaces = args[++i];
    } else if (command === undefined) {
      command = arg;
    } else if (root === undefined) {
      root = arg;
    } else if (outFile === undefined) {
      outFile = arg;
    }
  }

  if (command !== "analyze") {
    console.error(
      "Unknown command. Use: sinwan analyze [root] [outFile] [--tsconfig path] [--bunfig path] [--workspaces path]",
    );
    process.exit(1);
  }

  root = root ?? process.cwd();
  outFile = outFile ?? path.join(root, ".sinwan/reactive-props.json");

  analyze({ root, outFile, tsConfigPath, bunfigPath, workspaces });
  console.log(`[sinwan] analyzed ${root} -> ${outFile}`);
}

// Run immediately when executed as the entry point (not when imported).
if (import.meta.main) {
  runAnalyzeCli();
}
