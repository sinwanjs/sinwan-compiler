# sinwan-compiler

The shared compiler package for SinwanJS. It provides the JSX transform, the project-wide reactive-prop analyzer, and the dev/HMR cache used by both the Bun and Vite plugins.

## What it does

- **JSX transform**: Converts reactive JSX expressions into lazy zero-arity functions so the Sinwan runtime can update the DOM efficiently.
- **Cross-file analysis**: Determines which component props are reactive across the whole project, allowing the transform to avoid wrapping static props in effects.
- **Dev cache**: Maintains an incremental, persistent cache for Bun and Vite so dev startup and HMR are fast.

## Packages

- `src/transform.ts` — JSX transform and reactive expression wrapping.
- `src/analyze.ts` — `analyze`, `analyzeProject`, `AnalyzerCache`, and import resolution.
- `src/reactive-wrap.ts` — Helpers for detecting reactive sources, collecting component call graphs, and propagating reactivity.
- `src/cli.ts` — `sinwan-compiler analyze` CLI.
- `src/index.ts` — Public package exports.

## Documentation

- [`analyzer.md`](analyzer.md) — Cross-file reactive-prop analyzer and cache.
- [`transform.md`](transform.md) — JSX transform and wrapping rules.
- [`cli.md`](cli.md) — Command-line usage.
- [`plugins.md`](plugins.md) — Using the compiler with Bun and Vite.
- [`api.md`](api.md) — Public API reference.
- [`architecture.md`](architecture.md) — Internal design and data flow.
