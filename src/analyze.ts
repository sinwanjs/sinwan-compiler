/**
 * SinwanJS Compiler — Project-wide reactive prop analyzer.
 *
 * Scans a project for JSX/TSX files, builds a global component call graph,
 * and computes which exported component props are actually reactive across
 * modules. The result is written to a JSON metadata file consumed by the
 * per-file transform.
 */

import { parse } from "@babel/parser";
import * as t from "@babel/types";
import _traverse from "@babel/traverse";
import * as fs from "fs";
import * as path from "path";

const traverse =
  typeof _traverse === "function"
    ? _traverse
    : ((_traverse as any).default ?? _traverse);

import {
  collectComponentFunctions,
  collectComponentCallGraph,
  computeLocalScopes,
  propagateReactiveProps,
  containsReactiveValue,
  trackReactiveImports,
  type ReactiveScope,
  type CallSite,
} from "./reactive-wrap";

export type ImportInfo = {
  source: string;
  importedName: string;
};

export type ImportedCallSite = {
  caller: t.Function;
  source: string;
  name: string;
  props: { name: string; value: t.Expression }[];
  /** Spread expressions forwarded to the child. */
  spreads: t.Expression[];
};

export type ModuleAnalysis = {
  filePath: string;
  imports: Map<string, ImportInfo>;
  exports: Map<string, t.Function>;
  defaultExport: t.Function | null;
  componentFunctions: Set<t.Function>;
  localScopes: Map<t.Function, ReactiveScope>;
  localCallGraph: Map<t.Function, CallSite[]>;
  importedCallSites: ImportedCallSite[];
};

export type ProjectAnalysis = {
  modules: Map<string, ModuleAnalysis>;
  reactiveProps: Map<string, Map<string, Set<string>>>;
};

export type WorkspacesConfig =
  | string
  | string[]
  | { file?: string; include?: string[] };

export type AnalyzeOptions = {
  /** Project root directory to scan. */
  root: string;
  /** Output file path for the metadata JSON. */
  outFile: string;
  /** File extensions to scan. */
  extensions?: string[];
  /** Custom import resolver: returns absolute file path or null. */
  resolve?: (source: string, fromFile: string) => string | null;
  /** Path to tsconfig.json used to resolve path aliases. */
  tsConfigPath?: string;
  /** Path to bunfig.toml used to resolve Bun aliases. */
  bunfigPath?: string;
  /** Workspace package discovery: path to a workspace file, list of package paths/globs, or both. */
  workspaces?: WorkspacesConfig;
};

// ─── Cache persistence serialization ───────────────────────────

type FunctionRef = { start: number; end: number };

type SerializedScope = {
  bindings: Record<string, import("./reactive-wrap").Binding>;
};

type SerializedCallSite = {
  callee: FunctionRef;
  props: { name: string; value: t.Expression }[];
  spreads: t.Expression[];
};

type SerializedImportedCallSite = {
  caller: FunctionRef;
  source: string;
  name: string;
  props: { name: string; value: t.Expression }[];
  spreads: t.Expression[];
};

type SerializedModule = {
  imports: Record<string, ImportInfo>;
  exports: Record<string, FunctionRef>;
  defaultExport: FunctionRef | null;
  componentFunctions: FunctionRef[];
  localScopes: Record<string, SerializedScope>;
  localCallGraph: Record<string, SerializedCallSite[]>;
  importedCallSites: SerializedImportedCallSite[];
};

type SerializedCache = {
  version: 1;
  modules: Record<string, SerializedModule>;
  reactiveProps: Record<string, Record<string, string[]>>;
};

function functionRef(fn: t.Function): FunctionRef {
  return { start: fn.start ?? -1, end: fn.end ?? -1 };
}

function refKey(ref: FunctionRef): string {
  return `${ref.start}:${ref.end}`;
}

function findFunctionByRef(ast: t.Node, ref: FunctionRef): t.Function | null {
  let found: t.Function | null = null;
  traverse(ast, {
    Function(path: any) {
      const node = path.node as t.Function;
      if (node.start === ref.start && node.end === ref.end) {
        found = node;
        path.stop();
      }
    },
  });
  return found;
}

function serializeReactiveProps(
  reactiveProps: Map<string, Map<string, Set<string>>>,
): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {};
  for (const [filePath, fileMap] of reactiveProps) {
    const entry: Record<string, string[]> = {};
    for (const [exportName, props] of fileMap) {
      entry[exportName] = Array.from(props);
    }
    result[filePath] = entry;
  }
  return result;
}

function serializeModule(mod: ModuleAnalysis): SerializedModule {
  const localScopes: Record<string, SerializedScope> = {};
  for (const [fn, scope] of mod.localScopes) {
    localScopes[refKey(functionRef(fn))] = {
      bindings: Object.fromEntries(scope.bindings),
    };
  }

  const localCallGraph: Record<string, SerializedCallSite[]> = {};
  for (const [callerFn, sites] of mod.localCallGraph) {
    localCallGraph[refKey(functionRef(callerFn))] = sites.map((s) => ({
      callee: functionRef(s.callee),
      props: s.props,
      spreads: s.spreads,
    }));
  }

  return {
    imports: Object.fromEntries(mod.imports),
    exports: Object.fromEntries(
      Array.from(mod.exports.entries()).map(([name, fn]) => [
        name,
        functionRef(fn),
      ]),
    ),
    defaultExport: mod.defaultExport ? functionRef(mod.defaultExport) : null,
    componentFunctions: Array.from(mod.componentFunctions).map(functionRef),
    localScopes,
    localCallGraph,
    importedCallSites: mod.importedCallSites.map((s) => ({
      caller: functionRef(s.caller),
      source: s.source,
      name: s.name,
      props: s.props,
      spreads: s.spreads,
    })),
  };
}

function restoreModule(
  filePath: string,
  serialized: SerializedModule,
): ModuleAnalysis | null {
  let code: string;
  try {
    code = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const ast = parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  const imports = new Map<string, ImportInfo>(
    Object.entries(serialized.imports),
  );
  const exports = new Map<string, t.Function>();
  for (const [name, ref] of Object.entries(serialized.exports)) {
    const fn = findFunctionByRef(ast, ref);
    if (!fn) return null;
    exports.set(name, fn);
  }
  const defaultExport = serialized.defaultExport
    ? findFunctionByRef(ast, serialized.defaultExport)
    : null;
  if (serialized.defaultExport && !defaultExport) return null;

  const componentFunctions = new Set<t.Function>();
  for (const ref of serialized.componentFunctions) {
    const fn = findFunctionByRef(ast, ref);
    if (!fn) return null;
    componentFunctions.add(fn);
  }

  const localScopes = new Map<t.Function, ReactiveScope>();
  for (const [key, scope] of Object.entries(serialized.localScopes)) {
    const ref = parseRefKey(key);
    if (!ref) return null;
    const fn = findFunctionByRef(ast, ref);
    if (!fn) return null;
    localScopes.set(fn, {
      bindings: new Map(Object.entries(scope.bindings)),
    });
  }

  const localCallGraph = new Map<t.Function, CallSite[]>();
  for (const [key, sites] of Object.entries(serialized.localCallGraph)) {
    const ref = parseRefKey(key);
    if (!ref) return null;
    const callerFn = findFunctionByRef(ast, ref);
    if (!callerFn) return null;
    localCallGraph.set(
      callerFn,
      sites.map((s) => {
        const callee = findFunctionByRef(ast, s.callee);
        if (!callee) throw new Error("Failed to restore callee");
        return {
          callee,
          props: s.props,
          spreads: s.spreads,
        };
      }),
    );
  }

  const importedCallSites: ImportedCallSite[] = [];
  for (const s of serialized.importedCallSites) {
    const caller = findFunctionByRef(ast, s.caller);
    if (!caller) return null;
    importedCallSites.push({
      caller,
      source: s.source,
      name: s.name,
      props: s.props,
      spreads: s.spreads,
    });
  }

  return {
    filePath,
    imports,
    exports,
    defaultExport,
    componentFunctions,
    localScopes,
    localCallGraph,
    importedCallSites,
  };
}

function parseRefKey(key: string): FunctionRef | null {
  const parts = key.split(":");
  if (parts.length !== 2) return null;
  const startStr = parts[0];
  const endStr = parts[1];
  if (!startStr || !endStr) return null;
  const start = Number(startStr);
  const end = Number(endStr);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

function collectImports(ast: t.Node): Map<string, ImportInfo> {
  const imports = new Map<string, ImportInfo>();
  traverse(ast, {
    ImportDeclaration(path: any) {
      const source: string = path.node.source.value;
      for (const spec of path.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          const localName = spec.local.name;
          const importedName = t.isIdentifier(spec.imported)
            ? spec.imported.name
            : spec.imported.value;
          imports.set(localName, { source, importedName });
        } else if (t.isImportDefaultSpecifier(spec)) {
          imports.set(spec.local.name, { source, importedName: "default" });
        }
      }
    },
  });
  return imports;
}

function collectImportedCallSites(
  ast: t.Node,
  componentNames: Map<string, t.Function>,
  imports: Map<string, ImportInfo>,
): ImportedCallSite[] {
  const sites: ImportedCallSite[] = [];
  traverse(ast, {
    JSXElement(path: any) {
      const name = path.node.openingElement.name;
      if (!t.isJSXIdentifier(name)) return;
      const tagName = name.name;
      if (!/^[A-Z]/.test(tagName)) return;
      if (componentNames.has(tagName)) return;

      const importInfo = imports.get(tagName);
      if (!importInfo) return;

      const callerPath = path.findParent((p: any) => p.isFunction());
      if (!callerPath) return;
      const callerFn = callerPath.node as t.Function;

      const props: { name: string; value: t.Expression }[] = [];
      const spreads: t.Expression[] = [];
      for (const attr of path.node.openingElement.attributes) {
        if (t.isJSXSpreadAttribute(attr)) {
          if (attr.argument) {
            spreads.push(attr.argument as t.Expression);
          }
          continue;
        }
        if (t.isJSXAttribute(attr)) {
          const attrName = (attr.name as t.JSXIdentifier).name;
          if (!attrName) continue;
          if (t.isJSXExpressionContainer(attr.value)) {
            const expr = attr.value.expression;
            if (!expr || t.isJSXEmptyExpression(expr)) continue;
            props.push({ name: attrName, value: expr as t.Expression });
          }
        }
      }

      const childExprs: t.Expression[] = [];
      for (const child of path.node.children) {
        if (t.isJSXExpressionContainer(child)) {
          const expr = child.expression;
          if (!expr || t.isJSXEmptyExpression(expr)) continue;
          childExprs.push(expr as t.Expression);
        }
      }
      if (childExprs.length === 1) {
        props.push({ name: "children", value: childExprs[0]! });
      } else if (childExprs.length > 1) {
        props.push({ name: "children", value: t.arrayExpression(childExprs) });
      }

      sites.push({
        caller: callerFn,
        source: importInfo.source,
        name: importInfo.importedName,
        props,
        spreads,
      });
    },
  });
  return sites;
}

export function analyzeModule(code: string, filePath: string): ModuleAnalysis {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  const names = trackReactiveImports(ast);
  const {
    functions,
    names: componentNames,
    exported,
  } = collectComponentFunctions(ast, names.cc);
  const localScopes = computeLocalScopes(ast, names);
  const localCallGraph = collectComponentCallGraph(ast, componentNames);
  const imports = collectImports(ast);
  const importedCallSites = collectImportedCallSites(
    ast,
    componentNames,
    imports,
  );

  const exports = new Map<string, t.Function>();
  let defaultExport: t.Function | null = null;

  for (const [localName, fn] of componentNames) {
    if (exported.has(fn)) {
      exports.set(localName, fn);
    }
  }

  traverse(ast, {
    ExportDefaultDeclaration(path: any) {
      const decl = path.node.declaration;
      if (t.isIdentifier(decl)) {
        const fn = componentNames.get(decl.name);
        if (fn) defaultExport = fn;
      } else if (t.isCallExpression(decl)) {
        const callee = decl.callee;
        if (t.isIdentifier(callee) && names.cc.has(callee.name)) {
          const firstArg = decl.arguments[0];
          if (firstArg && t.isFunction(firstArg)) {
            defaultExport = firstArg;
          }
        }
      }
    },
  });

  return {
    filePath,
    imports,
    exports,
    defaultExport,
    componentFunctions: functions,
    localScopes,
    localCallGraph,
    importedCallSites,
  };
}

type TsConfigPaths = Map<string, string[]>;

function loadTsConfigPaths(tsConfigPath: string): TsConfigPaths | null {
  try {
    const raw = JSON.parse(fs.readFileSync(tsConfigPath, "utf-8")) as {
      compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string };
    };
    const paths = raw.compilerOptions?.paths;
    if (!paths) return null;
    const baseUrl = raw.compilerOptions?.baseUrl;
    const root = path.dirname(tsConfigPath);
    const resolvedBase = baseUrl ? path.resolve(root, baseUrl) : root;
    const result = new Map<string, string[]>();
    for (const [pattern, mappings] of Object.entries(paths)) {
      result.set(
        pattern,
        mappings.map((m) => path.resolve(resolvedBase, m)),
      );
    }
    return result;
  } catch {
    return null;
  }
}

function matchTsConfigPath(
  source: string,
  paths: TsConfigPaths,
): string | null {
  for (const [pattern, mappings] of paths) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (source.startsWith(prefix)) {
        const rest = source.slice(prefix.length);
        for (const mapping of mappings) {
          if (mapping.endsWith("/*")) {
            return mapping.slice(0, -1) + rest;
          }
        }
      }
    } else if (pattern === source) {
      return mappings[0] ?? null;
    }
  }
  return null;
}

function resolveRelativeImport(
  source: string,
  fromFile: string,
  extensions: string[],
): string | null {
  if (!source.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), source);
  const candidates = [
    ...extensions.map((ext) => base + ext),
    ...extensions.map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseTomlString(value: string): string | null {
  value = value.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseAliasObject(content: string, aliases: Map<string, string>): void {
  // Split by comma, but ignore commas inside quoted strings.
  const pairs: string[] = [];
  let current = "";
  let inQuotes: string | null = null;
  for (const char of content) {
    if (char === '"' || char === "'") {
      if (inQuotes === char) {
        inQuotes = null;
      } else if (!inQuotes) {
        inQuotes = char;
      }
    }
    if (char === "," && !inQuotes) {
      pairs.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) pairs.push(current);

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = parseTomlString(pair.slice(0, eq));
    const value = parseTomlString(pair.slice(eq + 1));
    if (key && value) aliases.set(key, value);
  }
}

function loadBunfigAliases(bunfigPath: string): Map<string, string> | null {
  try {
    const content = fs.readFileSync(bunfigPath, "utf-8");
    const aliases = new Map<string, string>();
    const lines = content.split("\n");
    let section: string | null = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[") && line.endsWith("]")) {
        section = line.slice(1, -1);
        continue;
      }
      if (section === "install" && line.startsWith("alias")) {
        const start = line.indexOf("{");
        const end = line.lastIndexOf("}");
        if (start >= 0 && end > start) {
          parseAliasObject(line.slice(start + 1, end), aliases);
        }
        continue;
      }
      if (section === "install.alias") {
        const eq = line.indexOf("=");
        if (eq >= 0) {
          const key = parseTomlString(line.slice(0, eq));
          const value = parseTomlString(line.slice(eq + 1));
          if (key && value) aliases.set(key, value);
        }
      }
    }
    return aliases.size > 0 ? aliases : null;
  } catch {
    return null;
  }
}

function matchBunfigAlias(
  source: string,
  aliases: Map<string, string>,
  root: string,
): string | null {
  for (const [alias, target] of aliases) {
    if (source === alias) {
      return path.resolve(root, target);
    }
    if (source.startsWith(alias + "/")) {
      return path.resolve(root, target, source.slice(alias.length + 1));
    }
  }
  return null;
}

function resolveWithExtensions(
  mapped: string,
  extensions: string[],
): string | null {
  const candidates = [
    ...extensions.map((ext) => mapped + ext),
    ...extensions.map((ext) => path.join(mapped, "index" + ext)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readPackageName(pkgDir: string): string | null {
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"),
    ) as { name?: string };
    return pkgJson.name ?? null;
  } catch {
    return null;
  }
}

function resolveWorkspacePackage(
  source: string,
  packages: string[],
  extensions: string[],
): string | null {
  if (packages.length === 0) return null;
  if (source.startsWith(".") || source.startsWith("/")) return null;

  let matchedPkg: string | null = null;
  let matchedName: string | null = null;
  for (const pkg of packages) {
    const pkgName = readPackageName(pkg);
    if (!pkgName) continue;
    if (source === pkgName || source.startsWith(pkgName + "/")) {
      if (!matchedName || pkgName.length > matchedName.length) {
        matchedName = pkgName;
        matchedPkg = pkg;
      }
    }
  }
  if (!matchedPkg || !matchedName) return null;

  const subpath = source.slice(matchedName.length + 1);
  let sourceDir: string;
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(matchedPkg, "package.json"), "utf-8"),
    ) as { source?: string; main?: string; module?: string };
    if (pkgJson.source) {
      sourceDir = path.dirname(path.resolve(matchedPkg, pkgJson.source));
    } else {
      sourceDir = path.join(matchedPkg, "src");
    }
  } catch {
    sourceDir = path.join(matchedPkg, "src");
  }

  const targetBase = subpath
    ? path.join(sourceDir, subpath)
    : path.join(sourceDir, "index");
  return resolveWithExtensions(targetBase, extensions);
}

function loadPackageJsonWorkspaces(filePath: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      workspaces?: string[];
    };
    return pkg.workspaces ?? [];
  } catch {
    return [];
  }
}

function loadPnpmWorkspaces(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const patterns: string[] = [];
    let inPackages = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("packages:")) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        if (!line.startsWith("-") && !line.startsWith("  ")) {
          inPackages = false;
          continue;
        }
        const match = line.match(/^-\s*["']?([^"']+)["']?$/);
        if (match) patterns.push(match[1]!);
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

function expandGlob(pattern: string, cwd: string): string[] {
  const fullPattern = path.resolve(cwd, pattern);
  const parts = fullPattern.split(path.sep);
  const wildcardIndex = parts.findIndex((p) => p.includes("*"));
  if (wildcardIndex === -1) {
    return fs.existsSync(fullPattern) ? [fullPattern] : [];
  }

  const prefix = parts.slice(0, wildcardIndex).join(path.sep);
  const suffixParts = parts.slice(wildcardIndex + 1);
  const suffix = suffixParts.join(path.sep);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(prefix, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(prefix, entry.name, suffix);
    results.push(...expandGlob(candidate, cwd));
  }
  return results;
}

export function loadWorkspacePackages(
  workspaces: WorkspacesConfig,
  root: string,
): string[] {
  const patternEntries: { pattern: string; base: string }[] = [];

  if (typeof workspaces === "string") {
    const resolved = path.resolve(root, workspaces);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        patternEntries.push({ pattern: workspaces, base: root });
      } else if (resolved.endsWith("package.json")) {
        const base = path.dirname(resolved);
        for (const p of loadPackageJsonWorkspaces(resolved)) {
          patternEntries.push({ pattern: p, base });
        }
      } else if (resolved.endsWith("pnpm-workspace.yaml")) {
        const base = path.dirname(resolved);
        for (const p of loadPnpmWorkspaces(resolved)) {
          patternEntries.push({ pattern: p, base });
        }
      } else {
        patternEntries.push({ pattern: workspaces, base: root });
      }
    } else {
      patternEntries.push({ pattern: workspaces, base: root });
    }
  } else if (Array.isArray(workspaces)) {
    for (const p of workspaces) {
      patternEntries.push({ pattern: p, base: root });
    }
  } else if (workspaces && typeof workspaces === "object") {
    if (workspaces.file) {
      const resolved = path.resolve(root, workspaces.file);
      if (resolved.endsWith("package.json")) {
        const base = path.dirname(resolved);
        for (const p of loadPackageJsonWorkspaces(resolved)) {
          patternEntries.push({ pattern: p, base });
        }
      } else if (resolved.endsWith("pnpm-workspace.yaml")) {
        const base = path.dirname(resolved);
        for (const p of loadPnpmWorkspaces(resolved)) {
          patternEntries.push({ pattern: p, base });
        }
      }
    }
    if (workspaces.include) {
      for (const p of workspaces.include) {
        patternEntries.push({ pattern: p, base: root });
      }
    }
  }

  const packages = new Set<string>();
  for (const { pattern, base } of patternEntries) {
    for (const dir of expandGlob(pattern, base)) {
      const pkgJson = path.join(dir, "package.json");
      if (fs.existsSync(pkgJson)) {
        packages.add(dir);
      }
    }
  }
  return Array.from(packages);
}

function createResolver(
  root: string,
  extensions: string[],
  tsConfigPath?: string,
  bunfigPath?: string,
  workspaces?: WorkspacesConfig,
): (source: string, fromFile: string) => string | null {
  const paths = tsConfigPath ? loadTsConfigPaths(tsConfigPath) : null;
  const aliases = bunfigPath ? loadBunfigAliases(bunfigPath) : null;
  const packages = workspaces ? loadWorkspacePackages(workspaces, root) : [];
  return (source: string, fromFile: string) => {
    if (paths) {
      const mapped = matchTsConfigPath(source, paths);
      if (mapped) {
        const resolved = resolveWithExtensions(mapped, extensions);
        if (resolved) return resolved;
      }
    }
    if (aliases) {
      const mapped = matchBunfigAlias(source, aliases, root);
      if (mapped) {
        const resolved = resolveWithExtensions(mapped, extensions);
        if (resolved) return resolved;
      }
    }
    const pkgResolved = resolveWorkspacePackage(source, packages, extensions);
    if (pkgResolved) return pkgResolved;
    return resolveRelativeImport(source, fromFile, extensions);
  };
}

function findFiles(root: string, extensions: string[]): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(fullPath);
      } else if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        files.push(fullPath);
      }
    }
  }
  walk(root);
  return files;
}

export function analyzeProject(options: {
  root: string;
  extensions?: string[];
  resolve?: (source: string, fromFile: string) => string | null;
  files?: Record<string, string>;
  tsConfigPath?: string;
  bunfigPath?: string;
  workspaces?: WorkspacesConfig;
}): ProjectAnalysis {
  const extensions = options.extensions ?? [".tsx", ".ts", ".jsx", ".js"];
  const resolve =
    options.resolve ??
    createResolver(
      options.root,
      extensions,
      options.tsConfigPath,
      options.bunfigPath,
      options.workspaces,
    );

  const modules = new Map<string, ModuleAnalysis>();
  const providedFiles = options.files;
  if (providedFiles) {
    for (const [filePath, code] of Object.entries(providedFiles)) {
      modules.set(filePath, analyzeModule(code, filePath));
    }
  } else {
    const files = findFiles(options.root, extensions);
    for (const file of files) {
      const code = fs.readFileSync(file, "utf-8");
      modules.set(file, analyzeModule(code, file));
    }
  }

  // Lazily analyze imported workspace files so only reachable packages are
  // included in the module graph.
  function ensureAnalyzed(filePath: string): ModuleAnalysis | undefined {
    if (modules.has(filePath)) return modules.get(filePath);
    try {
      const code = fs.readFileSync(filePath, "utf-8");
      const mod = analyzeModule(code, filePath);
      modules.set(filePath, mod);
      return mod;
    } catch {
      return undefined;
    }
  }

  // Combine per-file scopes/call graphs into a single global structure so the
  // existing fixed-point propagation can run across modules.
  const globalLocalScopes = new Map<t.Function, ReactiveScope>();
  const globalCallGraph = new Map<t.Function, CallSite[]>();
  const globalComponentFunctions = new Set<t.Function>();

  for (const mod of modules.values()) {
    for (const [fn, scope] of mod.localScopes) {
      globalLocalScopes.set(fn, scope);
    }
    for (const fn of mod.componentFunctions) {
      globalComponentFunctions.add(fn);
    }
    for (const [callerFn, sites] of mod.localCallGraph) {
      const list = globalCallGraph.get(callerFn) ?? [];
      list.push(...sites);
      globalCallGraph.set(callerFn, list);
    }
  }

  const reactiveProps = buildProjectReactiveProps(
    modules,
    resolve,
    globalLocalScopes,
    globalCallGraph,
    globalComponentFunctions,
    ensureAnalyzed,
  );

  return { modules, reactiveProps };
}

function buildProjectReactiveProps(
  modules: Map<string, ModuleAnalysis>,
  resolve: (source: string, fromFile: string) => string | null,
  globalLocalScopes: Map<t.Function, ReactiveScope>,
  globalCallGraph: Map<t.Function, CallSite[]>,
  globalComponentFunctions: Set<t.Function>,
  ensureAnalyzed?: (filePath: string) => ModuleAnalysis | undefined,
): Map<string, Map<string, Set<string>>> {
  // Map imported call sites to target component functions and add them to the
  // global call graph. Lazily analyze workspace files that are not in the
  // initial project scan.
  for (const mod of modules.values()) {
    for (const site of mod.importedCallSites) {
      const resolvedFile = resolve(site.source, mod.filePath);
      if (!resolvedFile) continue;
      let targetMod = modules.get(resolvedFile);
      if (!targetMod && ensureAnalyzed) {
        targetMod = ensureAnalyzed(resolvedFile);
        if (targetMod) {
          for (const [fn, scope] of targetMod.localScopes) {
            globalLocalScopes.set(fn, scope);
          }
          for (const fn of targetMod.componentFunctions) {
            globalComponentFunctions.add(fn);
          }
          for (const [callerFn, sites] of targetMod.localCallGraph) {
            const list = globalCallGraph.get(callerFn) ?? [];
            list.push(...sites);
            globalCallGraph.set(callerFn, list);
          }
        }
      }
      if (!targetMod) continue;
      const targetFn =
        site.name === "default"
          ? targetMod.defaultExport
          : targetMod.exports.get(site.name);
      if (!targetFn) continue;

      const list = globalCallGraph.get(site.caller) ?? [];
      list.push({
        callee: targetFn,
        props: site.props,
        spreads: site.spreads,
      });
      globalCallGraph.set(site.caller, list);
    }
  }

  // Run the existing fixed-point propagation over the global graph.
  const globalReactiveProps = propagateReactiveProps(
    globalLocalScopes,
    globalCallGraph,
    globalComponentFunctions,
  );

  // Extract reactive props for exported components only.
  const reactiveProps = new Map<string, Map<string, Set<string>>>();
  for (const mod of modules.values()) {
    const fileMap = new Map<string, Set<string>>();
    for (const [exportName, fn] of mod.exports) {
      const props = globalReactiveProps.get(fn);
      fileMap.set(exportName, props ? new Set(props) : new Set());
    }
    if (mod.defaultExport) {
      const props = globalReactiveProps.get(mod.defaultExport);
      fileMap.set("default", props ? new Set(props) : new Set());
    }
    reactiveProps.set(mod.filePath, fileMap);
  }

  return reactiveProps;
}

export class AnalyzerCache {
  root: string;
  extensions: string[];
  tsConfigPath?: string;
  bunfigPath?: string;
  workspaces?: WorkspacesConfig;
  cachePath?: string;
  resolve: (source: string, fromFile: string) => string | null;
  modules: Map<string, ModuleAnalysis> = new Map();
  reactiveProps: Map<string, Map<string, Set<string>>> = new Map();
  // filePath -> set of files that import it (for targeted recompute).
  private importers: Map<string, Set<string>> = new Map();

  constructor(options: {
    root: string;
    extensions?: string[];
    tsConfigPath?: string;
    bunfigPath?: string;
    workspaces?: WorkspacesConfig;
    resolve?: (source: string, fromFile: string) => string | null;
    cachePath?: string;
  }) {
    this.root = options.root;
    this.extensions = options.extensions ?? [".tsx", ".ts", ".jsx", ".js"];
    this.tsConfigPath = options.tsConfigPath;
    this.bunfigPath = options.bunfigPath;
    this.workspaces = options.workspaces;
    this.cachePath = options.cachePath;
    const bunfigPath = options.bunfigPath;
    const diskResolver =
      options.resolve ??
      createResolver(
        this.root,
        this.extensions,
        this.tsConfigPath,
        bunfigPath,
        this.workspaces,
      );
    this.resolve = (source: string, fromFile: string) => {
      // Resolve against in-memory modules first so dev/HMR updates do not
      // require files to exist on disk yet.
      if (source.startsWith(".")) {
        const base = path.resolve(path.dirname(fromFile), source);
        for (const ext of this.extensions) {
          if (this.modules.has(base + ext)) return base + ext;
          const indexCandidate = path.join(base, "index" + ext);
          if (this.modules.has(indexCandidate)) return indexCandidate;
        }
      }
      return diskResolver(source, fromFile);
    };

    if (this.cachePath) {
      this.restore();
    }
  }

  update(filePath: string, code: string): void {
    const oldMod = this.modules.get(filePath);
    const newMod = analyzeModule(code, filePath);
    this.modules.set(filePath, newMod);
    if (oldMod) this.removeImporters(oldMod);
    this.addImporters(newMod);
    this.recomputeFor([filePath]);
    this.save();
  }

  remove(filePath: string): void {
    const oldMod = this.modules.get(filePath);
    const affectedImporters = new Set(this.importers.get(filePath) ?? []);
    this.modules.delete(filePath);
    this.importers.delete(filePath);
    if (oldMod) this.removeImporters(oldMod);
    this.recomputeFor(affectedImporters);
    this.save();
  }

  save(): void {
    if (!this.cachePath) return;
    const data: SerializedCache = {
      version: 1,
      modules: Object.fromEntries(
        Array.from(this.modules.entries()).map(([filePath, mod]) => [
          filePath,
          serializeModule(mod),
        ]),
      ),
      reactiveProps: serializeReactiveProps(this.reactiveProps),
    };
    const dir = path.dirname(this.cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2));
  }

  private restore(): void {
    if (!this.cachePath || !fs.existsSync(this.cachePath)) return;
    let data: SerializedCache;
    try {
      data = JSON.parse(
        fs.readFileSync(this.cachePath, "utf-8"),
      ) as SerializedCache;
    } catch {
      return;
    }
    if (data.version !== 1) return;

    for (const [filePath, serialized] of Object.entries(data.modules)) {
      const mod = restoreModule(filePath, serialized);
      if (mod) {
        this.modules.set(filePath, mod);
      }
    }

    // Rebuild reverse importer index from restored modules.
    this.importers = new Map();
    for (const mod of this.modules.values()) {
      this.addImporters(mod);
    }

    this.reactiveProps = new Map();
    for (const [filePath, fileMap] of Object.entries(data.reactiveProps)) {
      const map = new Map<string, Set<string>>();
      for (const [exportName, props] of Object.entries(fileMap)) {
        map.set(exportName, new Set(props));
      }
      this.reactiveProps.set(filePath, map);
    }
  }

  private addImporters(mod: ModuleAnalysis): void {
    for (const site of mod.importedCallSites) {
      const resolvedFile = this.resolve(site.source, mod.filePath);
      if (!resolvedFile) continue;
      let set = this.importers.get(resolvedFile);
      if (!set) {
        set = new Set();
        this.importers.set(resolvedFile, set);
      }
      set.add(mod.filePath);
    }
  }

  private removeImporters(mod: ModuleAnalysis): void {
    for (const site of mod.importedCallSites) {
      const resolvedFile = this.resolve(site.source, mod.filePath);
      if (!resolvedFile) continue;
      this.importers.get(resolvedFile)?.delete(mod.filePath);
    }
  }

  private ensureAnalyzed(filePath: string): ModuleAnalysis | undefined {
    if (this.modules.has(filePath)) return this.modules.get(filePath);
    try {
      const code = fs.readFileSync(filePath, "utf-8");
      const mod = analyzeModule(code, filePath);
      this.modules.set(filePath, mod);
      return mod;
    } catch {
      return undefined;
    }
  }

  private collectAffected(filePaths: Iterable<string>): Set<string> {
    const affected = new Set<string>();
    const queue = Array.from(filePaths);
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (affected.has(current)) continue;

      // Lazily analyze workspace files so they are included in the subgraph.
      let mod = this.modules.get(current);
      if (!mod) {
        mod = this.ensureAnalyzed(current);
        if (mod) this.addImporters(mod);
      }
      if (!mod) continue;
      affected.add(current);

      // Add transitive importers.
      for (const importer of this.importers.get(current) ?? []) {
        if (!affected.has(importer)) queue.push(importer);
      }

      // Add imported modules so the subgraph has enough context to propagate.
      for (const site of mod.importedCallSites) {
        const resolved = this.resolve(site.source, mod.filePath);
        if (resolved && !affected.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
    return affected;
  }

  private recomputeFor(filePaths: Iterable<string>): void {
    const affected = this.collectAffected(filePaths);

    const subgraphModules = new Map<string, ModuleAnalysis>();
    for (const filePath of affected) {
      const mod = this.modules.get(filePath);
      if (mod) subgraphModules.set(filePath, mod);
    }

    const globalLocalScopes = new Map<t.Function, ReactiveScope>();
    const globalCallGraph = new Map<t.Function, CallSite[]>();
    const globalComponentFunctions = new Set<t.Function>();
    for (const mod of subgraphModules.values()) {
      for (const [fn, scope] of mod.localScopes) {
        globalLocalScopes.set(fn, scope);
      }
      for (const fn of mod.componentFunctions) {
        globalComponentFunctions.add(fn);
      }
      for (const [callerFn, sites] of mod.localCallGraph) {
        const list = globalCallGraph.get(callerFn) ?? [];
        list.push(...sites);
        globalCallGraph.set(callerFn, list);
      }
    }

    const subgraphReactiveProps = buildProjectReactiveProps(
      subgraphModules,
      this.resolve,
      globalLocalScopes,
      globalCallGraph,
      globalComponentFunctions,
    );

    for (const filePath of affected) {
      const map = subgraphReactiveProps.get(filePath);
      if (map) {
        this.reactiveProps.set(filePath, map);
      }
    }
  }

  private recompute(): void {
    const affected = this.collectAffected(Array.from(this.modules.keys()));
    const subgraphModules = new Map<string, ModuleAnalysis>();
    for (const filePath of affected) {
      const mod = this.modules.get(filePath);
      if (mod) subgraphModules.set(filePath, mod);
    }

    const globalLocalScopes = new Map<t.Function, ReactiveScope>();
    const globalCallGraph = new Map<t.Function, CallSite[]>();
    const globalComponentFunctions = new Set<t.Function>();
    for (const mod of subgraphModules.values()) {
      for (const [fn, scope] of mod.localScopes) {
        globalLocalScopes.set(fn, scope);
      }
      for (const fn of mod.componentFunctions) {
        globalComponentFunctions.add(fn);
      }
      for (const [callerFn, sites] of mod.localCallGraph) {
        const list = globalCallGraph.get(callerFn) ?? [];
        list.push(...sites);
        globalCallGraph.set(callerFn, list);
      }
    }

    this.reactiveProps = buildProjectReactiveProps(
      subgraphModules,
      this.resolve,
      globalLocalScopes,
      globalCallGraph,
      globalComponentFunctions,
    );
  }
}

export function analyze(options: AnalyzeOptions): void {
  const tsConfigPath =
    options.tsConfigPath ?? path.join(options.root, "tsconfig.json");
  const bunfigPath =
    options.bunfigPath ?? path.join(options.root, "bunfig.toml");
  const project = analyzeProject({
    root: options.root,
    extensions: options.extensions,
    resolve: options.resolve,
    tsConfigPath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    bunfigPath: fs.existsSync(bunfigPath) ? bunfigPath : undefined,
    workspaces: options.workspaces,
  });

  const serialized: Record<string, Record<string, string[]>> = {};
  for (const [filePath, fileMap] of project.reactiveProps) {
    const entry: Record<string, string[]> = {};
    for (const [exportName, props] of fileMap) {
      entry[exportName] = Array.from(props);
    }
    serialized[filePath] = entry;
  }

  const dir = path.dirname(options.outFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(options.outFile, JSON.stringify(serialized, null, 2));
}

export function loadMetadata(
  filePath: string,
): Map<string, Map<string, Set<string>>> {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
    string,
    Record<string, string[]>
  >;
  const result = new Map<string, Map<string, Set<string>>>();
  for (const [filePath, fileMap] of Object.entries(raw)) {
    const map = new Map<string, Set<string>>();
    for (const [exportName, props] of Object.entries(fileMap)) {
      map.set(exportName, new Set(props));
    }
    result.set(filePath, map);
  }
  return result;
}
