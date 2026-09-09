# CLI

Production analysis is a single command. Dev servers do not need it; plugins keep a live cache.

The published binary name is `sinwan` (see `package.json` `"bin"`). After install you can also run the package name:

```bash
bunx sinwan-compiler analyze [root] [outFile] [options]
# same after a local install:
sinwan analyze [root] [outFile] [options]
```

| Argument | Default |
| -------- | ------- |
| `root` | Current working directory |
| `outFile` | `<root>/.sinwan/reactive-props.json` |

| Flag | Meaning |
| ---- | ------- |
| `--tsconfig`, `-t` | `tsconfig.json` for `paths` |
| `--bunfig`, `-b` | `bunfig.toml` for Bun aliases |
| `--workspaces`, `-w` | `package.json`, `pnpm-workspace.yaml`, or a package directory |

Anything other than `analyze` prints a short usage line and exits with code `1`.

## Example

```bash
bunx sinwan-compiler analyze ./src ./.sinwan/reactive-props.json \
  --tsconfig ./tsconfig.json \
  --workspaces ../../package.json
```

## Output

JSON: absolute file path → export name → reactive prop names.

```json
{
  "/project/src/Child.tsx": {
    "Child": ["title"],
    "default": ["label"]
  }
}
```

Pass that file to a plugin:

```ts
sinwan({ analyze: "./.sinwan/reactive-props.json" });
```

Programmatic equivalent: `analyze({ root, outFile, tsConfigPath, bunfigPath, workspaces })` from [API](api.md).
