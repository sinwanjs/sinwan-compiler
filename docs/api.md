# API reference

## `transformJSX(code, filename, options?)`

Transforms a single JSX/TSX file.

```ts
import { transformJSX } from "sinwan-compiler";

const result = transformJSX(code, filename, {
  hoist: true,
  explicitBindings: false,
  analyze: "./.sinwan/reactive-props.json",
  analyzeMetadata: new Map(),
});
```

Returns `{ code: string; map?: any }`.

## `analyze(options)`

Production entry point. Analyzes the project and writes metadata to disk.

```ts
import { analyze } from "sinwan-compiler";

analyze({
  root: "./src",
  outFile: "./.sinwan/reactive-props.json",
  tsConfigPath: "./tsconfig.json",
  bunfigPath: "./bunfig.toml",
  workspaces: "../../package.json",
});
```

## `analyzeProject(options)`

Programmatic analyzer. Returns the full project analysis without writing to disk.

```ts
import { analyzeProject } from "sinwan-compiler";

const project = analyzeProject({
  root: "./src",
  files: { "/project/A.tsx": "..." },
  tsConfigPath: "./tsconfig.json",
});

project.reactiveProps.get("/project/A.tsx")?.get("Component");
```

## `AnalyzerCache`

Incremental analyzer for dev/HMR.

```ts
import { AnalyzerCache } from "sinwan-compiler";

const cache = new AnalyzerCache({
  root: "./src",
  tsConfigPath: "./tsconfig.json",
  bunfigPath: "./bunfig.toml",
  workspaces: "../../package.json",
  cachePath: "./.sinwan/cache.json",
});

cache.update(filePath, newCode);
const metadata = cache.reactiveProps;
```

### Methods

- `update(filePath, code)` — re-analyze a file and recompute affected files.
- `remove(filePath)` — remove a file and recompute affected files.
- `save()` — persist the cache to `cachePath`.
- `restore()` — load the cache from `cachePath` (called automatically if `cachePath` exists).

## Types

- `CallSite` — local component call site.
- `ImportedCallSite` — cross-file component call site.
- `ModuleAnalysis` — analysis of a single module.
- `ProjectAnalysis` — analysis of the whole project.
- `WorkspacesConfig` — workspace file path, explicit package paths/globs, or both. Used to enable cross-package analysis in monorepos.
