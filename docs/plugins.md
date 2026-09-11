# Using the compiler from Bun and Vite

App projects should depend on **`bun-plugin-sinwan`** or **`vite-plugin-sinwan`**. Those packages import `sinwan-compiler` at runtime (`packages: "external"` in their builds) and pass the right options. You do not add `sinwan-compiler` unless you customize the pipeline.

The plugins accept any compiler `>=0.2.5 <1.0.0`. A new compiler release does not need a matching plugin publish. Existing apps update with `bun update sinwan-compiler`.

## Bun

```ts
import { sinwan } from "bun-plugin-sinwan";

export default sinwan({
  hoist: true,
  cache: {
    root: process.cwd(),
    tsConfigPath: "./tsconfig.json",
    bunfigPath: "./bunfig.toml",
    workspaces: "../../package.json",
    cachePath: "./.sinwan/cache.json",
  },
});
```

`bunfig.toml` `[serve.static] plugins` can only load a **ready-made** plugin object. Scaffolded apps keep a small `sinwan-plugin.ts` that calls `sinwan({ cache: … })` and export that object.

The Bun plugin pins `sinwan` / `sinwan/*` to the **app** `node_modules` so a `file:` or `link:` package (for example `sinwan-router`) does not load a second runtime.

## Vite

```ts
import { sinwan } from "vite-plugin-sinwan";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sinwan({
      hoist: true,
      cache: {
        tsConfigPath: "./tsconfig.json",
        cachePath: "./.sinwan/cache.json",
      },
    }),
  ],
});
```

The Vite plugin sets `resolve.dedupe: ["sinwan"]` for the same duplicate-runtime problem.

## Shared plugin options

| Option | Default | Role |
| ------ | ------- | ---- |
| `hoist` | `true` | Template hoisting |
| `dev` | Bun: `NODE_ENV !== "production"` at `sinwan()`; Vite: `config.mode !== "production"` | Warn when hoisting is skipped. Pass `false` for library/`Bun.build` production bundles. |
| `explicitBindings` | `false` | `_$bind*` helpers instead of bare `() =>` |
| `analyze` | unset | Path to CLI JSON (production) |
| `cache` | `true` | Incremental analyzer in dev. `false` turns it off. An object sets `root`, `tsConfigPath`, `bunfigPath`, `workspaces`, `cachePath` |
| `fastRefresh` | `true` (Vite) | In-place component HMR in `vite serve` only |

## Dev vs production

**Dev** — leave `cache` on (the default). Each transformed file calls `AnalyzerCache.update`. No CLI step.

**Production** — run [the CLI](cli.md) (or `analyze()`) and set `analyze` to that JSON so every CI machine uses the same metadata.

If a file is deleted in HMR, the plugin should call `cache.remove(path)` so child components drop reactive props that only that caller needed. The compiler’s `remove` updates both importers and imported modules.
