# Cross-file analyzer

The analyzer answers: **for each exported component, which props actually change?** The transform uses that map so a static `title="Hello"` does not become an effect.

Result shape: `filePath → exportName → Set<propName>`.

## How it works

1. Scan `.tsx` / `.ts` / `.jsx` / `.js` (or the files you pass in).
2. Auto-wrap the same exported components the transform would wrap.
3. Track reactive imports and `cc(...)`.
4. Build a call graph: local `<Child />` and imported `<Child />`.
5. Propagate reactivity until the sets stop growing.

A prop is reactive if **any** caller passes a value that reads a reactive source (including through another component).

## Example

```tsx
// Child.tsx
import { cc } from "sinwan/component";
export const Child = cc(({ title }) => <h1>{title}</h1>);

// Parent.tsx
import { cc } from "sinwan/component";
import { signal } from "sinwan/reactivity";
import { Child } from "./Child";

const Parent = cc(() => {
  const title = signal("Hello");
  return <Child title={title.value} />;
});
```

```json
{
  "/project/Child.tsx": { "Child": ["title"] }
}
```

If every caller passed `title="Hello"`, `Child` would be `[]` and the transform would not wrap `title` inside `Child`.

Default exports are stored under the name `"default"`.

## Spreads

The analyzer is precise when it can see the object:

```tsx
<Child {...{ title: "Hello", count: s.value }} />
// only `count` is reactive

const props = { title: "Hello", count: s.value };
<Child {...props} />
// same, if `props` is that object literal in the same function
```

String keys work (`{ "title": s.value }`). If the spread is an unknown value (`{...rest}` from parameters), **every known prop of the callee**, including `children`, is marked reactive.

## Import resolution

Lookups run in this order:

1. `tsconfig.json` `paths` (when a config is passed or `tsconfig.json` exists next to `root`)
2. `bunfig.toml` aliases (`[install] alias = { … }` or `[install.alias]`)
3. Workspace packages (see below)
4. Relative imports (`./Child`, `./ui` → `ui.tsx` or `ui/index.tsx`)

You can replace that with `resolve(source, fromFile)`.

`AnalyzerCache` also resolves **in-memory** modules first (HMR can update a file before it hits disk), including `./ui` → `ui/index.tsx` already in the cache.

## Workspaces

Only packages that the app actually imports are pulled in.

```ts
analyzeProject({
  root: "./apps/web",
  workspaces: "../../package.json", // npm/bun `workspaces`
  // or "../../pnpm-workspace.yaml"
  // or ["../../packages/ui"]
  // or { file: "../../package.json", include: ["../../packages/ui"] }
});
```

`@scope/ui/Button` maps to `packages/ui/src/Button.tsx` (or the directory of `package.json` `"source"`).

## Cache (`AnalyzerCache`)

Dev plugins call `update(file, code)` on each transform. The cache:

- Re-analyzes that file
- Walks importers **and** imported modules
- Writes `cachePath` when you set one

`remove(file)` is for deletes / HMR unlinks. It drops the module and **recomputes both**:

- files that imported it (parents)
- files it imported (children — their props may become static again)

If `cachePath` exists, the constructor restores it. Function identities are start/end offsets. If a file changed so those spans no longer match, that module is skipped (no throw); the next `update` rebuilds it.

## Conservative rules

- Unknown spreads are conservative (all callee props).
- `children` is a normal prop.
- Without metadata, the transform treats **exported** component props as reactive so a parent in another file cannot silently go stale.
