# Compiler overview

`sinwan-compiler` is the shared engine behind the Bun and Vite plugins. It has three jobs: rewrite JSX, decide which props are reactive, and keep that decision cheap in dev.

If you are building a Sinwan app, start with [Plugins](plugins.md). If you are changing the compiler, start with [Architecture](architecture.md).

## Pipeline

1. **Auto-`cc`** — exported functions that look like components (`App`, `Card`, …) are wrapped with `cc(...)` so the rest of the pipeline sees the same components the runtime will.
2. **Live destructure** — flat `cc(({ value }) => …)` becomes `cc((props) => …)` so `{value}` stays a live `props.value` read. `{...props}` spreads the raw bag.
3. **Reactive wrap** — JSX expressions that read signals, stores, `useState`, `useFetch`, `.value` on signals returned from other modules (`useTheme`, `inject`), or zero-arity getters returned from hooks (`counter()`) become `() => …` (or explicit binding helpers when that mode is on).
4. **Template hoist** — static native-element trees become `_$createTemplate(...)` calls with slots for dynamic bits (`child`, `attr`, `event`, `ref`).
5. **Analyze (optional)** — a project-wide pass marks which *exported* component props are actually reactive, so static strings are not wrapped.

```text
source.tsx
    │
    ▼
autoWrapComponents()     plain `export function App()` → cc(App)
    │
    ▼
rewriteLiveCcDestructure()  cc(({ value }) => …) → props.value
    │
    ▼
wrapReactiveExpressions()   {count.value} → {() => count.value}
                            {arr.map(x => n.value)} → {() => arr.map(...)}
                            also wraps those reads as children/attrs of <Label>
    │
    ▼
hoist templates             <div class="card">…</div> → _$tmpl_N
    │
    ▼
generated module
```

## When analysis runs

| Mode | Who runs it | What the transform receives |
| ---- | ----------- | --------------------------- |
| Dev | Plugin `AnalyzerCache` | In-memory `analyzeMetadata` after each file update |
| Production | CLI / `analyze()` | JSON file via `analyze: "./.sinwan/reactive-props.json"` |
| Off | Nobody | Conservative wrapping (exported props treated as reactive) |

## Guides

- [Transform](transform.md) — what gets wrapped, auto-`cc`, hoisting, built-in components
- [Analyzer](analyzer.md) — call graph, spreads, workspaces, cache
- [CLI](cli.md) — `sinwan analyze`
- [Plugins](plugins.md) — wiring Bun and Vite
- [API](api.md) — exported functions and types
- [Architecture](architecture.md) — data structures and propagation
