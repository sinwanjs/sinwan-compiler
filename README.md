# sinwan-compiler

Shared compiler for [Sinwan](https://sinwanjs.com). App code usually never imports this package: **`bun-plugin-sinwan`** and **`vite-plugin-sinwan`** call it for you.

Use this package directly when you write a plugin, run a production analysis pass, or want to understand what the compiler changes in your JSX.

## What it does

- **Transforms JSX** so reactive reads become lazy getters the runtime can track.
- **Hoists static markup** into reusable templates (including `ref` slots).
- **Wraps exported function components** with `cc()` when they look like components.
- **Analyzes the project** so static props stay static and only truly reactive props pay for an effect.

## Install

```bash
bun add -d sinwan-compiler
```

App templates already depend on the Bun or Vite plugin. You only need this package if you call the compiler yourself.

The plugins declare `sinwan-compiler` as `>=0.2.5 <1.0.0`. After you publish a new 0.x compiler, do **not** bump the plugins. Apps pick it up with a fresh install or `bun update sinwan-compiler`. Republish a plugin only if its own API changed.

## Production analysis

```bash
bunx sinwan-compiler analyze ./src ./.sinwan/reactive-props.json
```

Then point the plugin at that file:

```ts
sinwan({ analyze: "./.sinwan/reactive-props.json" });
```

In development the plugins keep an incremental `AnalyzerCache` instead. You do not need to run the CLI for `bun run dev` / `vite`.

## Documentation

| Guide | Topic |
| ----- | ----- |
| [Overview](docs/README.md) | How the pieces fit together |
| [Transform](docs/transform.md) | Wrapping rules, auto-`cc`, template hoisting |
| [Analyzer](docs/analyzer.md) | Cross-file reactive props, workspaces, cache |
| [CLI](docs/cli.md) | `analyze` command |
| [Plugins](docs/plugins.md) | Bun and Vite options |
| [API](docs/api.md) | Public TypeScript API |
| [Architecture](docs/architecture.md) | Internals for contributors |

## License

MIT
