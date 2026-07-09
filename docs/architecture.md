# Architecture

## File layout

```
src/
  index.ts          Public exports
  transform.ts      JSX transform and template hoisting
  reactive-wrap.ts  Reactive source detection, call graph, propagation
  analyze.ts        Cross-file analyzer, cache, import resolution, CLI
  cli.ts            CLI entry point
```

## Data flow

1. **Transform**: receives source code and optional reactive-prop metadata.
2. **Analyzer (dev)**: builds `AnalyzerCache` incrementally as files are transformed.
3. **Analyzer (production)**: `analyzeProject()` scans the whole project and writes metadata.
4. **Propagation**: `propagateReactiveProps()` runs a fixed-point algorithm over the call graph.

## Key data structures

### `CallSite`

```ts
{
  callee: t.Function;
  props: { name: string; value: t.Expression }[];
  spreads: t.Expression[];
}
```

`spreads` stores the spread expressions. Object-literal spreads are analyzed precisely; unknown spreads are treated conservatively.

### `ModuleAnalysis`

Per-file analysis including:

- imports
- exports
- default export
- component functions
- local scopes
- local call graph
- imported call sites

### `AnalyzerCache`

- Stores `ModuleAnalysis` objects keyed by absolute file path.
- Maintains `reactiveProps: Map<filePath, Map<exportName, Set<propName>>>`.
- Maintains a reverse importer index for targeted incremental propagation.
- Serializes to JSON for persistence across process restarts.

## Propagation algorithm

1. Initialize every exported component with an empty reactive-prop set.
2. For each component function, build a full scope that includes its own bindings and the reactive props of its parent.
3. For each call site, check every named prop and object-literal spread key. If the value contains a reactive read, add the prop name to the callee's reactive set.
4. For unknown spreads, add all known callee prop names.
5. If a callee's reactive set grows, add the callee to the worklist and repeat until stable.

## Import resolution

The resolver combines multiple sources:

- `tsconfig.json` `paths`
- `bunfig.toml` aliases
- Relative imports
- Custom resolver

Resolution order: tsconfig → bunfig → relative → custom.

## Serialization

The cache serializes modules using function start/end positions as stable identifiers. When restoring, the source file is re-parsed and functions are matched by position. This allows the cache to survive source edits as long as the analyzed functions remain at the same positions.
