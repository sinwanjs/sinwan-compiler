# Cross-file reactive-prop analyzer

The analyzer determines which props of an exported component are reactive. It runs over the whole project (or a cached subset) and produces a map of `filePath → exportName → Set<propName>`.

## How it works

1. **Parse** every `.tsx/.ts/.jsx/.js` file into a Babel AST.
2. **Track imports** of reactive sources (`createMutable`, `createStore`, `signal`, `computed`, `useState`) and the component factory `cc`.
3. **Collect component functions** defined with `cc(...)`.
4. **Build a call graph** of local and imported JSX calls (`<Child ... />`).
5. **Propagate reactivity** bottom-up through the call graph using a fixed-point algorithm.

A prop is reactive for a given component if any of its callers passes a value that reads a reactive source.

## Example

```tsx
// Child.tsx
import { cc } from "sinwan/component";
export const Child = cc(({ title }) => <h1>{title}</h1>);

// Parent.tsx
import { cc } from "sinwan/component";
import { signal } from "sinwan/reactivity";
import { Child } from "./Child";
const Parent = cc(() => <Child title={signal.value} />);
```

The analyzer produces:

```json
{
  "/project/Child.tsx": { "Child": ["title"] }
}
```

## Workspace packages

Cross-file analysis works for local monorepo packages. The analyzer discovers workspace packages from a `package.json` `workspaces` field, a `pnpm-workspace.yaml`, or explicit package paths. Only packages that are actually imported by the project are analyzed.

```ts
analyzeProject({
  root: "./apps/web",
  // From a workspace file
  workspaces: "../../package.json",
  // From a pnpm workspace
  workspaces: "../../pnpm-workspace.yaml",
  // Explicit package paths or globs
  workspaces: ["../../packages/sinwan-ui", "../../packages/shared"],
  // Or combine both
  workspaces: {
    file: "../../package.json",
    include: ["../../packages/sinwan-ui"],
  },
});
```

Package imports are resolved to files inside the declared package, typically under the package `src` directory (or the directory of the `source` field in `package.json`). Subpath imports such as `@sinwan/ui/Button` map to `packages/sinwan-ui/src/Button.tsx`.



## Import resolution

The analyzer resolves imports in this order:

1. `tsconfig.json` `paths` (if configured).
2. `bunfig.toml` aliases (if configured or auto-detected).
3. Workspace packages (if configured).
4. Relative imports with the configured extensions.

You can also provide a custom resolver:

```ts
analyzeProject({
  root: "/project",
  resolve: (source, fromFile) => {
    // return absolute path or null
  },
});
```

## Spread props

Spread props are handled precisely when possible:

- `<Child {...{ title: "Hello", count: signal.value }} />` is treated as two named props; only `count` becomes reactive.
- `<Child {...props} />` is also resolved precisely if `props` is a local variable initialized with an object literal in the same function:
  ```tsx
  const props = { title: "Hello", count: signal.value };
  return <Child {...props} />;
  ```
- Spreads of function parameters or other unknown runtime objects fall back to the conservative rule: all known props of the callee are marked reactive.

## Limitations

- Unknown runtime objects (`{...props}` where `props` is not a local object literal) are conservatively treated as reactive.
- Named slot props and `children` are regular props; they are reactive only when the passed value is reactive.
