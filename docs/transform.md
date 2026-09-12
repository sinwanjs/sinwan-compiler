# JSX transform

`transformJSX(code, filename, options?)` rewrites one module so the Sinwan runtime can track reactive reads and reuse static markup.

You normally get this through a plugin. Call it yourself only in tests or custom tooling.

## Quick example

```tsx
import { cc } from "sinwan/component";
import { signal } from "sinwan/reactivity";

export const Counter = cc(() => {
  const count = signal(0);
  return <p>{count.value}</p>;
});
```

The compiler turns the child into a lazy getter:

```tsx
<p>{() => count.value}</p>
```

The same wrap applies to **user-component children**. `<Label>{checked.value ? "On" : "Off"}</Label>` becomes `{() => checked.value ? "On" : "Off"}` so a one-shot `cc()` parent does not snapshot the string.

The runtime runs that function inside an effect and updates the text when `count` changes.

## Automatic `cc()` wrapping

Exported functions that look like components are wrapped for you. You can write React-style components and still get a Sinwan instance and `displayName`.

A candidate must be:

- **Exported** (named or default)
- **Uppercase** (or an anonymous `export default function ()`)
- **0 or 1 parameter**
- **Returning JSX** in that function (not only in a nested helper)
- **Not already** `cc(...)` (or a local alias of `cc`)

```tsx
export function App() {
  return <h1>Hello</h1>;
}

// becomes
import { cc } from "sinwan/component";
export const App = cc(function App() {
  return <h1>Hello</h1>;
});
```

Not wrapped: lowercase helpers, generators, multi-argument functions, or functions that never return JSX. If `cc` is not imported yet, the compiler adds `import { cc } from "sinwan/component"`.

`cc` may be imported from `sinwan` or `sinwan/component`.

## Live `cc` props

`cc` setup runs once. The runtime wraps the raw props bag in a Proxy that invokes **zero-arity getters** on each read (`props.value`), while `'value' in props` inspects the raw bag.

The compiler rewrites **flat** destructure so those reads stay live:

```tsx
export const Child = cc(({ value }) => <span>{value}</span>);

// becomes (then wrap)
export const Child = cc((props) => <span>{() => props.value}</span>);
```

- Defaults `({ value = "" })` stay JS “undefined → default” **on each read**. Controlled vs omitted still uses `'value' in props`, not a destructure default.
- Rest `({ value, ...rest })` becomes `const rest = createLiveRest(props, ["value"])`.
- Nested `({ user: { name } })` is **not** rewritten (setup snapshot).
- Native or forwarded `{...props}` / `{...rest}` spreads `getSpreadProps(...)` so attributes keep getter functions instead of freezing unwrapped values at setup.

## What counts as reactive

Tracked imports:

| Module | Names |
| ------ | ----- |
| `sinwan/store` | `createMutable`, `createStore` |
| `sinwan/reactivity` | `signal`, `computed` |
| `sinwan/react` | `useState` |
| `sinwan/hook` | `useFetch` |

Reads the compiler wraps:

- Store / mutable fields: `state.name`, destructured `const { name } = state`
- Signals and computeds: `count.value`, including `count.value?.n` and `count.value!.n`
- `useState` getters: `count()`
- Zero-arity getters **returned from another hook**: `{count()}`, `{counter()}`, `{api.count()}`. Local helpers (`greet()`), calls with arguments (`format("x")`), and event attributes (`onclick={make()}`) stay eager.
- `useFetch` signal values: `f.data.value` (not the shell `f` or `f.data`)
- Calls to a **local** function whose body reads one of the above
- `.value` reads of signals that came from **another module** (`useTheme()`, `inject()`, custom hooks) even when the identifier was not created by a local `signal()` call: `{theme.value}`, `{api.theme.value}`. Nested JSX inside `.map` still wraps the inner slots (`variant={theme.value === value ? …}`) rather than remounting the list.
- Reads **inside call callbacks** that run while the JSX expression is evaluated: `.map` / `.filter` / `Array.from` callbacks, IIFEs, and default parameters of those callbacks. `<For each={keys.map((k) => groups[query.value])}>` becomes `each={() => keys.map(...)}`. Nested JSX inside those callbacks is a separate wrap site (`items.map((i) => <span>{count.value}</span>)` wraps the inner text, not the whole map).

Not wrapped:

- Literals and plain identifiers
- Event-handler functions (`onClick={fn}` or `onClick={() => …}`)
- Nested function *values* passed as props (`title={() => s.value}` stays a render prop)
- Functions stored as object/array values (`{ onClick: () => s.value }`) or returned from a factory (`const make = () => () => s.value`)
- `useFetch` methods such as `abort` / `execute`
- Static values the [analyzer](analyzer.md) proved never change

## DOM vs component JSX

**Native elements** (`div`, `p`, `button`, …): wrap reactive children and attributes.

**User components** (`<Label>`, `<Child title={…} />`):

- **Children:** wrap reactive reads the same way as DOM text (`{count.value}`, `{checked.value ? "On" : "Off"}`) so `cc()` parents do not snapshot the value. Use a getter (`() => …`), never `_$bindText`, because the child may render nodes as well as strings. Render-prop functions (`{(v) => …}`) stay untouched.
- **Props:** wrap a prop if it is known-reactive for that component (built-in registry, local call graph, analyzer metadata). For *unknown* imported components, still wrap **derived reads** (`htmlFor={id.value}`, `disabled={off.value}`) and leave **container pass-through** alone (`checked={checked}`, `user={user}`) so the child receives the signal or store proxy. With `explicitBindings`, component props stay **getters** (`each={() => …}`), never `_$bindAttr` — `For` / `Show` / `Label` call `resolve(prop)`, which does not unwrap bind descriptors.

**Built-in control-flow** components wrap specific props, and they wrap reactive expression children (those children render directly):

| Component | Reactive props |
| --------- | -------------- |
| `For`, `Index`, `Virtual` | `each` |
| `Show`, `Switch`, `Match`, `Key` | `when` |
| `Dynamic` | `component` |
| `Visible` | `when`, `style` |
| `Portal` | `mount` |
| `Activity` | `mode` |

`Suspense` is not in this list; its props are left alone.

## Template hoisting

Static native trees become a module-level template plus `_$createTemplate(tmpl, [dynamic…])`.

Slots:

| Type | When |
| ---- | ---- |
| `child` | `{expr}`, or a capitalized child component |
| `attr` | Dynamic attribute (not `on*`) |
| `event` | `onClick={…}` and other `on*` handlers |
| `ref` | `ref={fn}` or `ref={object}` |

Static `style` objects and strings are written into the HTML (`backgroundColor` → `background-color`). Quoted style strings that contain `${…}` log a warning in the compiler: use a template literal, `style={\`…${x}\`}`.

Hoisting is skipped (the JSX is left as JSX) when the root is a component, the tag is a member expression (`Icons.Star` as the root), a spread is on a native element (`<div {...props}>`), or the element needs a JSX enhancer (`<select defaultValue>`, function `action`/`formAction`, head tags without `itemProp`, and the other cases in `enhanced-elements.ts`). Nested enhanced tags become child slots so the native shell can still hoist. In `dev: true`, skipped hoists from extract errors log a warning.

Boolean attributes without a value are emitted as HTML flags: `<button disabled>`.

The slot marker format is `COMPILER_TEMPLATE_SLOT_PROTOCOL` (`s:0`, `s:1`, …). It must stay aligned with the runtime protocol in `sinwan`.

## Options

```ts
transformJSX(code, "src/App.tsx", {
  hoist: true, // default true
  dev: false, // warn when hoisting is skipped
  explicitBindings: false, // emit _$bindText / _$bindAttr / …
  analyze: "./.sinwan/reactive-props.json",
  analyzeMetadata: cache.reactiveProps,
  resolveImport: (source, fromFile) => absolutePathOrNull,
});
```

- **`analyze` / `analyzeMetadata`** — cross-file reactive props. Invalid JSON is ignored (transform still succeeds).
- **`resolveImport`** — maps `./Child` to an absolute file so imported components can use analyzer metadata. Without it, imported call sites are not wrapped at the parent.
- **`explicitBindings`** — wrap **native** text/attrs with `_$bindText` / `_$bindAttr` / `_$bindStyle` / `_$bindClass`. Component props and component children stay `() => …` so `resolve(prop)` still sees a getter.

Returns `{ code, map }` with a source map.
