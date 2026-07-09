# Bun and Vite plugins

Both plugins use the shared compiler package. The cache is optional and enabled by passing the `cache` option.

## Bun plugin

```ts
import { sinwan } from "bun-plugin-sinwan";

Bun.build({
  entrypoints: ["./src/index.tsx"],
  plugins: [
    sinwan({
      hoist: true,
      cache: {
        root: "./src",
        tsConfigPath: "./tsconfig.json",
        bunfigPath: "./bunfig.toml",
        workspaces: "../../package.json",
        cachePath: "./.sinwan/cache.json",
      },
    }),
  ],
});
```

## Vite plugin

```ts
import { sinwan } from "vite-plugin-sinwan";

export default {
  plugins: [
    sinwan({
      hoist: true,
      cache: {
        tsConfigPath: "./tsconfig.json",
        bunfigPath: "./bunfig.toml",
        workspaces: "../../package.json",
        cachePath: "./.sinwan/cache.json",
      },
    }),
  ],
};
```

## Cache options

| Option         | Description                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `root`         | Project root for the analyzer.                                                                        |
| `tsConfigPath` | Path to `tsconfig.json`.                                                                              |
| `bunfigPath`   | Path to `bunfig.toml`. If omitted, the plugin tries to auto-detect `bunfig.toml` in the project root. |
| `workspaces`   | Path to a workspace file (`package.json` or `pnpm-workspace.yaml`) or explicit package paths/globs.   |
| `cachePath`    | Path to a JSON file for persistent cache.                                                             |

## Dev vs production

- In **dev**, enable the `cache` option for incremental HMR analysis.
- In **production**, run the CLI ahead of time and pass the generated JSON via the `analyze` option for deterministic builds.
