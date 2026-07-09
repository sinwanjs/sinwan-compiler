# CLI

The `sinwan-compiler` package ships a small CLI for production analysis.

## Command

```bash
bunx sinwan-compiler analyze [root] [outFile] [options]
```

- `root` — project root to scan (default: current working directory).
- `outFile` — path for the output JSON (default: `<root>/.sinwan/reactive-props.json`).

## Options

| Flag                 | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `--tsconfig`, `-t`   | Path to `tsconfig.json` for path alias resolution.                                |
| `--bunfig`, `-b`     | Path to `bunfig.toml` for Bun alias resolution.                                   |
| `--workspaces`, `-w` | Path to a `package.json` or `pnpm-workspace.yaml` to discover workspace packages. |

## Example

```bash
bunx sinwan-compiler analyze ./src ./.sinwan/reactive-props.json --tsconfig ./tsconfig.json --workspaces ../../package.json
```

## Output format

The CLI writes a JSON file mapping each source file to its exported component names and their reactive props:

```json
{
  "/project/src/Child.tsx": {
    "Child": ["title"]
  }
}
```

## Use in plugins

Pass the generated JSON to the Bun or Vite plugin via the `analyze` option:

```ts
sinwan({ analyze: "./.sinwan/reactive-props.json" });
```
