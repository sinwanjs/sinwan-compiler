# Architecture

This page is for people changing the compiler. App authors can stay on [Transform](transform.md) and [Plugins](plugins.md).

## Layout

```
src/
  index.ts           Public exports
  auto-cc.ts         Exported function → cc(...)
  reactive-wrap.ts   Imports, scopes, call graph, wrap
  transform.ts       Hoist + transformJSX
  analyze.ts         Project scan, resolution, AnalyzerCache
  cli.ts             analyze CLI
  exports.ts         collectExportedComponents
```

## Data flow

```text
transformJSX
  autoWrapComponents
  wrapReactiveExpressions   ← analyze / analyzeMetadata / resolveImport
  hoist JSXElement roots    ← _$createTemplate + slots

analyze / AnalyzerCache.update
  autoWrapComponents
  analyzeModule             ← scopes + local + imported call sites
  buildProjectReactiveProps
  propagateReactiveProps
```

Dev plugins call `cache.update` on each file, then pass `cache.reactiveProps` into `transformJSX` as `analyzeMetadata`. Production writes the same map to JSON (`analyze`) and the plugin sets `analyze: path`.

## Call graph

A **local** site is `<Child />` where `Child` is `cc(...)` in the same file.

An **imported** site stores `{ caller, source, name, props, spreads }`. The project pass resolves `source` to a file and attaches the site to that file’s export (or `"default"`).

`spreads` are analyzed when the expression is an object literal or a local `const props = { … }` in the caller. Otherwise every known callee prop is marked reactive.

## Propagation

1. Seed callee sets from values that are already reactive in the caller’s local scope.
2. Worklist over all component functions.
3. For each site, add prop names whose values are reactive in the caller’s **full** scope (local bindings + that function’s own reactive props).
4. Repeat until sets stop growing.

Cycles terminate because sets only grow.

## Import resolution

`createResolver` order:

1. `tsconfig` `paths`
2. `bunfig.toml` aliases
3. Workspace package name + subpath
4. Relative path + extensions / `index.*`

`AnalyzerCache` wraps that with an in-memory lookup so HMR can resolve `./Child` to a module that exists only in the cache.

## Cache persistence

Serialized modules store function **start/end** offsets. Restore re-parses the file and remaps those spans. If a span is gone (the file was edited), `restoreModule` returns `null` and that entry is dropped. The next `update` fills it in.

`remove(path)`:

1. Collect importers of `path` and modules `path` imported
2. Delete the module and importer index entries
3. `recomputeFor` that set
4. `save()` if `cachePath` is set

That second set matters: deleting a parent must let the child’s props become static again.

## Template protocol

`COMPILER_TEMPLATE_SLOT_PROTOCOL` in `transform.ts` is duplicated from the runtime (`sinwan` template protocol). A drift test in the `sinwan` package keeps the two in sync. Slot types: `child`, `attr`, `event`, `ref`.
