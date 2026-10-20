# Architecture

This page is for people changing the compiler. App authors can stay on [Transform](transform.md) and [Plugins](plugins.md).

## Layout

```
src/
  ast/               oxc parse, Path/Scope, esrap print
  index.ts           Public exports
  auto-cc.ts         Exported function → cc(...)
  live-cc-destructure.ts  Flat cc(({ value }) => …) → props.value
  reactive-wrap.ts   Imports, scopes, call graph, wrap
  transform.ts       Hoist + transformJSX
  analyze.ts         Project scan, resolution, AnalyzerCache
  cli.ts             analyze CLI
  exports.ts         collectExportedComponents
```

## AST pipeline

`transformJSX` and analyze parse with **oxc-parser** (`parseSync`, ESTree / TS-ESTree). The compiler parses as TSX so JSX and TypeScript are accepted in `.js`, `.jsx`, `.ts`, and `.tsx`, matching the previous Babel plugin set. Comments are copied onto `leadingComments` / `trailingComments`. A JSX `{/* comment */}` stays on its empty expression. A comment that sits inside a function or object after the last child stays on that container. Rewrite passes walk a Babel-shaped **Path/Scope** facade built on oxc `visitorKeys` (parent pointers, `getBinding`, `replaceWith`). Print is **esrap** with `esrap/languages/tsx` and double quotes.

Babel is not used. oxc-parser JS/JSX matches Acorn ESTree; TS/TSX matches TS-ESTree. Passes must treat:

- `Literal` (not `StringLiteral` / `NumericLiteral`)
- `Property` (not `ObjectProperty`)
- `ChainExpression` around optional calls/members
- `ParenthesizedExpression` (`preserveParens` defaults true) — unwrap in reactive walks, do not require Babel’s implicit paren stripping

Print is esrap, not oxc-codegen or MagicString, so mutations stay on the tree. Acorn / acorn-walk cannot own this pipeline: Acorn does not parse TSX, and acorn-walk has no bindings or JSX/TS visitor keys. Bun.Transpiler and SWC are out of scope (no AST mutation API / not the primary engine).

`derivedLocals` uses the Path/Scope facade; a Rust rewrite of passes is not required while those tests pass.

## Data flow

```text
transformJSX
  autoWrapComponents
  rewriteLiveCcDestructure  ← flat destructure stays live; raw JSX spreads
  wrapReactiveExpressions   ← analyze / analyzeMetadata / resolveImport
    promoteReactiveConstInitializers ← opt-in derivedLocals, snapshot diagnostics
    rebuild scopes / call graph / JSX wrapping
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
