# sinwan-compiler

Shared compiler for [Sinwan](https://sinwanjs.com). App code usually never imports this package: **`bun-plugin-sinwan`** and **`vite-plugin-sinwan`** call it for you.

Use this package directly when you write a plugin, run a production analysis pass, or want to understand what the compiler changes in your JSX.

## What it does

- **Transforms JSX** so reactive reads become lazy getters the runtime can track.
- **Hoists static markup** into reusable templates (including `ref` slots).
- **Wraps exported function components** with `cc()` when they look like components.
- **Analyzes the project** so static props stay static and only truly reactive props pay for an effect.

## Reactive imports

A call in JSX becomes a getter when it reads signals. The compiler sees the reads in the file it compiles. For values made in another module, it reads that module:

- **Known factories.** `export const i18n = createI18n(...)` from `sinwan-i18n` is a reactive object, so `{i18n.t("nav.sales")}`, `title={i18n.money(total, "MAD")}` and `<Child label={i18n.t("x")} />` update when the locale changes. Functions taken from it are reactive too: `export const { t } = i18n` and `export const t = i18n.t`.
- **`/** @sinwan-reactive */`.** Put it on an exported object, class or function whose calls read signals or stores. Every member call (`presence.isOnline(id)`) or direct call (`label(key)`) is then wrapped, whatever its arguments.

Re-exports, `export * as ns`, default exports, namespace imports and tsconfig `paths` aliases are followed, and results are cached until a file changes. A parameter or local with the same name shadows the import. Calls that run once by design stay eager: at module level, in event handlers, and in a component-body `const`. With `dev: true` the compiler warns about such a `const` when it is used in JSX; with `derivedLocals`, it becomes a getter.

## Images (`<Img>`, Bun only)

`transformJSX(code, file, { images: { host: "bun" } })` rewrites static `<Img src>` (from `sinwan/image`) to `?sinwan-img=` asset imports. bun-plugin-sinwan passes `host: "bun"`, and so does vite-plugin-sinwan when Vite runs on Bun. Any `<Img>` compiled for another host throws `BunOnlyImageError`; for Vite on Node, the error says to run `bunx --bun vite`. `sinwan-compiler/image` holds the pipeline, which runs on `Bun.Image` only:

- `resolveImageConfig`, `validateBuildOptions`, `planImage`: configuration, strict prop validation and variant planning (never upscales).
- `encodeVariant`, `createPlaceholder`, `canEncodeAvif`: encoding and the ThumbHash blur.
- `ImageCache` / `imageCacheFor`: content-addressed disk cache (`.sinwan/images/`); `prune(maxBytes)`.
- `loadImageModule`: the asset module behind a `?sinwan-img=` import (bun-plugin-sinwan calls it).
- `createImageHandler(config)`: `Bun.serve` route for runtime sources, `?url=&w=&q=[&f=]`.
  - Only configured widths and qualities are accepted.
  - Local files must be under `publicDir`.
  - Remote URLs need a `remotePatterns` entry and are fetched without redirects, with `fetchTimeoutMs` and `maxInputBytes`.
  - The format follows `Accept`; responses carry `Vary`, `ETag` and `Cache-Control: public, max-age=<cacheTTL>`.

## Install

```bash
bun add -d sinwan-compiler
```

App templates already depend on the Bun or Vite plugin. You only need this package if you call the compiler yourself.

The plugins depend on `sinwan-compiler` `>=1.0.0 <2.0.0`. A new 1.x compiler is picked up with `bun update sinwan-compiler`. Publish a new plugin when its own API changes, or when the compiler reaches 2.0.

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
