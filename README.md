# sinwan-compiler

Shared compiler core for the SinwanJS framework. Provides the JSX transform, the project-wide reactive-prop analyzer, and the dev/HMR cache used by both the Bun and Vite plugins.

## Documentation

See the [`docs/`](docs/) folder:

- [Overview](docs/README.md)
- [Analyzer](docs/analyzer.md)
- [Transform](docs/transform.md)
- [CLI](docs/cli.md)
- [Plugins](docs/plugins.md)
- [API reference](docs/api.md)
- [Architecture](docs/architecture.md)

## Quick start

```bash
bunx sinwan-compiler analyze ./src ./.sinwan/reactive-props.json
```

## Installation

```bash
bun add -d sinwan-compiler
```
