/**
 * SinwanJS Compiler — tsconfig `paths` loading for the analyzer.
 *
 * tsconfig files are JSONC (comments and trailing commas are allowed, and
 * create-sinwan templates ship with comments) and may inherit `paths` and
 * `baseUrl` through `extends`. Uses Node APIs only so the compiler keeps
 * working under Vite.
 */
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

export type TsConfigPaths = Map<string, string[]>;

type CompilerPathOptions = {
  paths?: Record<string, string[]>;
  /** Directory of the config that declared `paths`. */
  pathsDir?: string;
  /** Absolute `baseUrl`. */
  baseUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathsRecord(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.every((m) => typeof m === "string"),
    )
  );
}

/** Index just past the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === "\\" ? 2 : 1;
  }
  return i + 1;
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Turns tsconfig-style JSONC into JSON: drops comments and trailing commas. */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function readConfig(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(fs.readFileSync(file, "utf-8")));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function existingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Resolves an `extends` entry the way TypeScript does: relative file or package. */
function resolveExtends(specifier: string, fromFile: string): string | null {
  const dir = path.dirname(fromFile);
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    const base = path.resolve(dir, specifier);
    return existingFile([base, `${base}.json`]);
  }
  const require = createRequire(fromFile);
  for (const candidate of [specifier, `${specifier}.json`, `${specifier}/tsconfig.json`]) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try the next TypeScript-style candidate.
    }
  }
  return null;
}

function loadPathOptions(file: string, seen: Set<string>): CompilerPathOptions | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const config = readConfig(file);
  if (!config) return null;

  const extendsField = config["extends"];
  const parents =
    typeof extendsField === "string"
      ? [extendsField]
      : Array.isArray(extendsField)
        ? extendsField.filter((entry): entry is string => typeof entry === "string")
        : [];

  const result: CompilerPathOptions = {};
  for (const parent of parents) {
    const parentFile = resolveExtends(parent, file);
    const inherited = parentFile ? loadPathOptions(parentFile, seen) : null;
    if (inherited) Object.assign(result, inherited);
  }

  const options = config["compilerOptions"];
  if (isRecord(options)) {
    const dir = path.dirname(file);
    if (typeof options["baseUrl"] === "string") {
      result.baseUrl = path.resolve(dir, options["baseUrl"]);
    }
    if (isPathsRecord(options["paths"])) {
      result.paths = options["paths"];
      result.pathsDir = dir;
    }
  }
  return result;
}

/**
 * Loads `compilerOptions.paths` (following `extends`) with each mapping made
 * absolute. Mappings resolve against `baseUrl` when set, otherwise against
 * the config that declares `paths`. Returns `null` when there are no paths
 * or the config cannot be read.
 */
export function loadTsConfigPaths(tsConfigPath: string): TsConfigPaths | null {
  const options = loadPathOptions(path.resolve(tsConfigPath), new Set());
  if (!options?.paths || !options.pathsDir) return null;
  const base = options.baseUrl ?? options.pathsDir;
  const result: TsConfigPaths = new Map();
  for (const [pattern, mappings] of Object.entries(options.paths)) {
    result.set(
      pattern,
      mappings.map((mapping) => path.resolve(base, mapping)),
    );
  }
  return result;
}
