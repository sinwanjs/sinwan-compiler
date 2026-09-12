# API reference

Import from `sinwan-compiler`. Types below match the package exports.

## Transform

### `transformJSX(code, filename, options?)`

Rewrite one module. Returns `{ code: string; map?: unknown }`.

```ts
import { transformJSX } from "sinwan-compiler";

const { code, map } = transformJSX(source, "src/App.tsx", {
  hoist: true,
  dev: false,
  explicitBindings: false,
  analyze: "./.sinwan/reactive-props.json",
  analyzeMetadata: cache.reactiveProps,
  resolveImport: (source, fromFile) => /* absolute path or null */,
});
```

See [Transform](transform.md) for wrapping rules and options.

### `COMPILER_TEMPLATE_SLOT_PROTOCOL`

`{ slotPrefix, encodeSlot(index), decodeSlot(data) }`. Markers look like `s:0`. Keep this aligned with the Sinwan runtime protocol.

### `autoWrapComponents(ast, filename?)`

Mutates a Babel AST: wrap exported component-like functions with `cc(...)`. Returns `true` if anything changed. `transformJSX` already runs this.

### `rewriteLiveCcDestructure(ast)`

Mutates a Babel AST: rewrite flat `cc(({ value }) => …)` params to a `props` identifier and `{...props}` spreads to `getSpreadProps(props)`. Nested destructure is left as a snapshot. `transformJSX` already runs this before reactive wrap.

## Analysis

### `analyze(options)`

Scan a project and write JSON to `outFile`.

```ts
import { analyze } from "sinwan-compiler";

analyze({
  root: "./src",
  outFile: "./.sinwan/reactive-props.json",
  extensions: [".tsx", ".ts", ".jsx", ".js"], // default
  tsConfigPath: "./tsconfig.json",
  bunfigPath: "./bunfig.toml",
  workspaces: "../../package.json",
  resolve: (source, fromFile) => null,
});
```

Missing `tsconfig.json` / `bunfig.toml` next to `root` are skipped unless you pass the paths explicitly.

### `analyzeProject(options)`

Same scan, no disk write. Returns `{ modules, reactiveProps }`.

```ts
import { analyzeProject } from "sinwan-compiler";

const project = analyzeProject({
  root: "./src",
  files: { "/tmp/A.tsx": "export const A = () => <div/>" }, // optional in-memory map
  tsConfigPath: "./tsconfig.json",
  workspaces: { file: "../../package.json", include: ["../../packages/ui"] },
});

project.reactiveProps.get("/tmp/A.tsx")?.get("A"); // Set<string> | undefined
```

### `analyzeModule(code, filePath)`

Analyze one file. Used by the cache and tests.

### `loadMetadata(filePath)`

Read analyzer JSON into `Map<file, Map<exportName, Set<prop>>>`. Missing file → empty map.

### `loadWorkspacePackages(workspaces, root)`

Resolve workspace directories from a file, a list of globs/paths, or `{ file, include }`.

### `AnalyzerCache`

Incremental graph for plugins.

```ts
import { AnalyzerCache } from "sinwan-compiler";

const cache = new AnalyzerCache({
  root: process.cwd(),
  tsConfigPath: "./tsconfig.json",
  bunfigPath: "./bunfig.toml",
  workspaces: "../../package.json",
  cachePath: "./.sinwan/cache.json",
  resolve: (source, fromFile) => null, // optional
});

cache.update(absPath, source);
cache.remove(absPath); // also recomputes modules this file imported
cache.save(); // no-op without cachePath

cache.reactiveProps; // Map<file, Map<export, Set<prop>>>
cache.modules;
```

`restore` runs in the constructor when `cachePath` exists. Stale function spans skip that module instead of throwing.

## CLI helpers

### `runAnalyzeCli(args?)`

Parse `analyze [root] [outFile] [--tsconfig] [--bunfig] [--workspaces]` and call `analyze()`. Defaults to `process.argv.slice(2)`. Unknown commands write to stderr and `process.exit(1)`.

## Other exports

| Name | Role |
| ---- | ---- |
| `collectExportedComponents(code)` | File-local exported component names (no `cc` required) |
| `wrapReactiveExpressions(ast, options?)` | Reactive wrap without hoisting |
| `trackReactiveImports(ast)` | Import-name sets for signals, `cc`, `useFetch`, … |
| `collectComponentFunctions(ast, ccNames)` | `cc(...)` functions, names, and exports |
| `computeLocalScopes(ast, names)` | Per-function reactive bindings |
| `collectComponentCallGraph(ast, names)` | Local JSX call sites |
| `propagateReactiveProps(scopes, graph, fns)` | Fixed-point prop sets |
| `buildFullScope(scopes, fn, reactiveProps)` | Local bindings plus reactive props |
| `containsReactiveValue(expr, scope)` | Whether an expression reads a reactive value |
| `isReactiveValue(node, scope)` | Single-node check |
| `getAllPropNames(params)` | Prop names from a component parameter (`*` for a bare identifier) |

## Types

`AnalyzeOptions`, `WorkspacesConfig`, `ModuleAnalysis`, `ProjectAnalysis`, `ImportInfo`, `ImportedCallSite`, `CallSite`, `ReactiveScope`, `Binding`, `ImportNames`, `ComponentExpressionInfo`, `ExportedComponent`, `TransformOptions`.
