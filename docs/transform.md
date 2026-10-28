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

- **Exported** (named or default): `export function`, `export const`, `export default`, or a top-level `function` / `const` exported through `export { X }` or `export { X as Name }` (the exported name must be uppercase)
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

Not wrapped: lowercase helpers, generators, multi-argument functions, functions that never return JSX, type-only exports, re-exports (`export { X } from "./x"`), components that are not exported, and a `function X` exported through `export { X }` that module code reads before its declaration (for example `const Group = Object.assign(X, { Item })` above it), because turning it into `const X = cc(...)` would make that read throw. Reads inside functions, export specifiers and types do not count. A `cc` parent passes reactive props to child components as getters, so a non-exported component that receives props from one must be wrapped with `cc(...)` explicitly. If `cc` is not imported yet, the compiler adds `import { cc } from "sinwan/component"`.

Type parameters and return types are kept on the wrapped function. A circular import that reads `X` at module load before this file finishes evaluating is not detected; `export function X` has the same limitation.

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

| Module              | Names                          |
| ------------------- | ------------------------------ |
| `sinway`      | `createMutable`, `createStore` |
| `sinwan/reactivity` | `signal`, `computed`           |
| `sinwan/react`      | `useState`                     |
| `sinwan/hook`       | `useFetch`                     |

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
- Nested function _values_ passed as props (`title={() => s.value}` stays a render prop)
- Functions stored as object/array values (`{ onClick: () => s.value }`) or returned from a factory (`const make = () => () => s.value`)
- `useFetch` methods such as `abort` / `execute`
- Static values the [analyzer](analyzer.md) proved never change

## Derived locals (opt-in)

JSX expressions containing reactive reads already stay live without an author-written arrow. By default, moving that read into `const open = count.value > 0` still takes a **setup snapshot**. Inline one-off expressions in JSX; use a getter or `computed()` for shared derivations when promotion is disabled.

Enable `derivedLocals: true` in `transformJSX` or either plugin to promote eligible component-local constants:

```tsx
export function App() {
  const count = signal(0);
  const positive = count.value > 0;
  const label = positive ? "positive" : "zero";
  return (
    <Show when={positive}>
      <span title={label}>{label}</span>
    </Show>
  );
}
```

The derived declarations become zero-argument getters, and references become value reads:

```tsx
const positive = () => count.value > 0;
const label = () => (positive() ? "positive" : "zero");
return (
  <Show when={() => positive()}>
    <span title={() => label()}>{() => label()}</span>
  </Show>
);
```

### Eligibility and semantics

- Only referenced, identifier-named `const` declarations directly in a `cc` setup body (including auto-`cc` components) are candidates. Dependencies are processed in declaration order, including multiple declarators in one statement.
- Pure read expressions are supported: member/index/optional access, arithmetic, comparisons, boolean/conditional expressions, template strings, object/array literals, and TypeScript expression annotations. Direct imported `useState` getter calls and unshadowed single-argument `Boolean`, `Number`, and `String` coercions are also supported. Property reads and coercions must be free of user-defined side effects.
- Calls to arbitrary helpers, hooks, factories or methods, assignments, updates, allocations, destructuring, `let`/`var`, mutable captures, and forward/TDZ references remain eager — **unless** the callee is a function annotated with `/** @sinwan-pure */` (imported, or declared in the same file), a local zero-arity arrow getter whose expression body is itself safe (`const yearNow = () => …`, then `props.fromYear ?? yearNow() - 10`), or a built-in read on a known array or `Date` (below). See [`@sinwan-pure` JSDoc contract](#sinwan-pure-jsdoc-contract) below. A getter with a block body, side effects (`() => count++`) or a call back into itself stays eager. Explicit getter and `computed` initializers are unchanged.
- Built-in reads: `Array.from(...)`, non-mutating array reads (`map`, `filter`, `flatMap`, `flat`, `slice`, `concat`, `join`, `at`, `find`, `findIndex`, `some`, `every`, `reduce`, `includes`, `indexOf`, `entries`, `keys`, `values`) and `Date` getters (`getFullYear`, `getMonth`, `getDate`, `getDay`, `getTime`, `getHours`, `getMinutes`, `getSeconds`, `getMilliseconds`, `valueOf`) promote only on a receiver the compiler knows is an array or `Date`: an array literal, `Array.from(...)`, an array read that returns a new array, a `const` annotated `T[]` / `Array<T>` / `ReadonlyArray<T>` / `Date` or initialized from one of these, or a call to a same-file function with that return type annotation. A callback must be inline (its body is inspected) or a `@sinwan-pure` function; `items.map(track)` with an unannotated `track` stays eager. Reads on other values (`props.items.map(...)`, `props.query.filter(...)`) stay eager because the method may not be the built-in one; annotate a `const` (`const items: Item[] = props.items`) to opt in.
- A pure method read on a promoted local such as `monthList.map(...)` or `today.getFullYear()` is rewritten to `monthList().map(...)` / `today().getFullYear()`. Mutating reads such as `list.push` and `date.setFullYear` stay snapshots. A promoted local that holds a function is still called: `const close = props.onClose; close()` becomes `close()()`. Module, event-handler, render-callback, loop and nested-block declarations are not promoted.
- A reactive value passed to a parameter typed `LiveRead<T>` (`T | (() => T)`) is wrapped as `() => value`. An argument that is already a function is left alone. `createLiveState(..., props.selected)` therefore re-reads `props.selected` on each `state.value` access.
- Bare signal/store containers still pass through unchanged. Bare component prop-bag aliases retain their ordinary JavaScript value semantics. References are resolved by lexical binding, so shadowed locals and object keys are not rewritten.
- Every ordinary value use is called, including chained initializers, closures, event bodies, shorthand object values and setup `if` tests. A boolean does **not** become an accidentally truthy function. Setup control flow still runs once; use `Show`/`Switch` for reactive branches.
- Variables used as JSX tag names, in type queries, or as mutation/method-call receivers are left eager. Components containing direct `eval` are excluded.
- Getters are lazy, not cached. Use explicit `computed()` when caching matters. This is not whole-program dataflow, and does not turn arbitrary setup side effects into effects.

### Intentional snapshots and diagnostics

Put `/* sinwan-snapshot */` immediately before a declaration or its initializer to retain a one-shot read:

```tsx
/* sinwan-snapshot */ const initial = count.value;
const alsoInitial = /* sinwan-snapshot */ count.value;
```

A declaration-level pragma applies to all its declarators. A snapshot can read another promoted local: the compiler calls that dependency once at the snapshot declaration.

With `dev: true`, the compiler warns when an eligible unpromoted derivation is used in JSX while promotion is disabled. It also warns about a promoted local used directly as a setup `if` test, explaining that the value is read once even though the compiler preserves boolean semantics. Intentional snapshot pragmas suppress the snapshot diagnostic; production (`dev: false`) is quiet.

### `@sinwan-pure` JSDoc contract

The compiler can promote derived `const` initializers that call imported utility functions when those functions are annotated with `/** @sinwan-pure */` in their source file. This eliminates the need for manual `() =>` wrappers around common utilities like className mergers.

**Annotation:**

```ts
/** @sinwan-pure */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Both `export function` and `export const` declarations are recognized. The annotation must be a block comment (`/** */`) immediately before the `export` keyword. A non-exported function in the same file is also recognized when the comment sits directly above `function` or `const`.

**What the compiler guarantees:**

- When `derivedLocals: true` is enabled, calls to `@sinwan-pure`-annotated imported functions are treated as safe expressions. The containing `const` initializer is promoted to a zero-argument getter, and references inside the function arguments are rewritten (e.g. `seamInactive` → `seamInactive()`).
- The compiler resolves the import path, reads the source file, parses it, and checks for `/** @sinwan-pure */` on exported declarations. Results are cached per resolved file path and reused while that file, and any file it re-exports from, keeps its modification time, so a dev server picks up a new or removed annotation without a restart. The same applies to the `LiveRead<T>` parameter scan.
- All import types are scanned: relative imports (`./`, `../`), bare specifiers (`clsx`, `sinwan/reactivity`), scoped packages (`@scope/utils`), and subpath imports (`@scope/utils/merge`). The compiler walks up the directory tree to find `node_modules/<pkg>`, reads `package.json`, and resolves the entry point via `exports`, `module`, `main`, `source`, or `index` files.
- If the `resolveImport` callback is provided by the plugin, it is used for path resolution (handles tsconfig paths, bunfig aliases, workspace packages, and Bun/Vite module resolution). Otherwise, the compiler falls back to direct filesystem resolution with common extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) and `index` files.

**Supported export forms (annotate with `/** @sinwan-pure \*/`):\*\*

| Export form            | Example                                                     | Call shape           |
| ---------------------- | ----------------------------------------------------------- | -------------------- |
| Named function         | `/** @sinwan-pure */ export function cn()`                  | `cn(...)`            |
| Named const (function) | `/** @sinwan-pure */ export const merge = () =>`            | `merge(...)`         |
| Named const (object)   | `/** @sinwan-pure */ export const helpers = { ... }`        | `helpers.merge(...)` |
| Named class            | `/** @sinwan-pure */ export class Utils { static merge() }` | `Utils.merge(...)`   |
| Default function       | `/** @sinwan-pure */ export default function helper()`      | `helper(...)`        |
| Default arrow          | `/** @sinwan-pure */ export default () =>`                  | `helper(...)`        |
| Default class          | `/** @sinwan-pure */ export default class {}`               | `helper.merge(...)`  |

**Supported import forms:**

| Import form            | Example                                 | Call shape    |
| ---------------------- | --------------------------------------- | ------------- |
| Named import           | `import { cn } from "./utils"`          | `cn(...)`     |
| Named import (aliased) | `import { cn as merge } from "./utils"` | `merge(...)`  |
| Default import         | `import helper from "./utils"`          | `helper(...)` |
| Namespace import       | `import * as ns from "./utils"`         | `ns.cn(...)`  |

**Supported re-export forms:**

| Re-export form            | Example                                      |
| ------------------------- | -------------------------------------------- |
| Named re-export           | `export { cn } from "./utils"`               |
| Aliased re-export         | `export { cn as merge } from "./utils"`      |
| Default re-export         | `export { default } from "./utils"`          |
| Aliased default re-export | `export { default as merge } from "./utils"` |
| Namespace re-export       | `export * from "./utils"`                    |

For class and object exports, any static method or property call on the imported binding is treated as pure (e.g. `Utils.merge(...)`, `Utils.format(...)`, `helpers.merge(...)`, `helpers.format(...)`).

**What the annotation author is responsible for:**

- **Purity:** The function must not produce side effects — no signal writes, no DOM mutations, no I/O, no global state changes. Calling the function with the same arguments must always return the same value. The compiler does not verify this; it trusts the annotation.
- **No hidden reactivity:** The function must not read signals, stores, or other reactive sources internally. If it does, those reads will not be tracked because the function is called inside a getter that the runtime evaluates in an effect — but only the arguments passed to the function are tracked, not reads inside the function body.
- **Export visibility:** The annotation must be on an exported declaration (`export function`, `export const`, `export class`, `export default`). Re-exports are followed recursively — the compiler resolves the re-export source and scans it for the annotation. Named, aliased, default, and `export *` re-exports are all supported. Circular re-exports are handled with a depth limit to prevent infinite loops.
- **Import resolvability:** The annotated file must be reachable via any import (relative, bare specifier, scoped package, or subpath). The compiler resolves `node_modules` packages via `package.json` `exports`/`module`/`main`/`source` fields and walks up the directory tree.

**What happens when the annotation is wrong:**

- **Annotated a non-pure function:** The compiler will promote the containing `const` to a getter. If the function has side effects, those side effects will run on every re-evaluation of the getter (whenever its tracked dependencies change), not just once at setup. This will not crash, but may cause unexpected repeated side effects.
- **Annotated a function that reads signals internally:** Those internal signal reads will not be tracked as dependencies of the promoted getter. The getter will not re-evaluate when those internal signals change, producing stale values. No crash, but incorrect reactivity.
- **Forgot to annotate a pure function:** The compiler will reject the containing `const` initializer as unsafe. The value will be a one-shot setup snapshot. No crash, but the value will not update when its dependencies change. The `dev: true` diagnostic will warn about eligible unpromoted derivations used in JSX.
- **Annotation on a non-exported function:** The annotation is ignored. Only exported declarations are scanned.
- **Import path unresolvable:** The annotation is not found. The function is treated as a non-pure call. No crash, but the containing `const` will not be promoted. This can happen if the package's `package.json` entry points don't lead to a source file, or if the `node_modules` directory is not in the expected location.

**Plugin forwarding:**

Both `bun-plugin-sinwan` and `vite-plugin-sinwan` forward the `resolveImport` callback to the compiler when the analyzer cache is enabled (`cache: true`, the default). This uses the plugin's module resolver, which handles workspace packages, tsconfig paths, and Bun/Vite resolution. When the cache is disabled or the minimal preload is used, the compiler falls back to direct filesystem resolution, which works for relative imports in a standard project layout.

**What is not scanned (by design):**

- **Dynamic imports** (`const { cn } = await import("./utils")`) — the binding is established at runtime, not compile time. The compiler cannot statically resolve which module a dynamic import loads, so it cannot scan the source for `@sinwan-pure` annotations. Use a static import instead.
- **`require()`** (`const { cn } = require("./utils")`) — CommonJS, not used in Sinwan's ESM target. Bun and Vite both use ESM for application code. Annotate the function and import it via a static ESM import.
- **Computed member access with non-literal keys** (`ns[key]()` where `key` is a variable, or `ns[\`cn`]()` with template literals) — the compiler cannot statically determine which property is being accessed. Use direct member access (`ns.cn()`) or string literal access (`ns["cn"]()`) instead.

### Workarounds for unsupported patterns

When the compiler cannot auto-promote a derived local (dynamic import, `require()`, or computed member access), use one of these workarounds to preserve reactivity.

#### 1. Replace dynamic import with static import (recommended)

If the module is available at startup, use a static ESM import instead of `await import()`. The compiler can then scan the source file for `@sinwan-pure` annotations and auto-promote the derived local.

```ts
// ❌ Does NOT work — dynamic import, binding is runtime
const { cn } = await import("./utils");
const cls = cn("base", size.value > 50 && "big");

// ✅ Works — static import, compiler auto-promotes
import { cn } from "./utils"; // /** @sinwan-pure */ export function cn(...)
const cls = cn("base", size.value > 50 && "big");

// Compiled output:
// const cls = () => cn("base", size.value > 50 && "big");
```

#### 2. Replace `require()` with static ESM import (recommended)

Sinwan targets ESM. Use a static ESM import instead of `require()`.

```ts
// ❌ Does NOT work — CommonJS require(), not ESM
const { cn } = require("./utils");
const cls = cn("base", size.value > 50 && "big");

// ✅ Works — static ESM import, compiler auto-promotes
import { cn } from "./utils";
const cls = cn("base", size.value > 50 && "big");
```

#### 3. Replace computed member access with direct or string literal access (recommended)

If you control the call site, use direct member access (`ns.cn()`) or string literal access (`ns["cn"]()`) instead of a variable key.

```ts
import * as ns from "./utils";

// ❌ Does NOT work — variable key, compiler can't resolve
const key = "cn";
const cls = ns[key]("base", size.value > 50 && "big");

// ❌ Does NOT work — template literal key, compiler can't resolve
const cls = ns[`cn`]("base", size.value > 50 && "big");

// ✅ Works — direct member access, compiler auto-promotes
const cls = ns.cn("base", size.value > 50 && "big");

// ✅ Works — string literal key, compiler auto-promotes
const cls = ns["cn"]("base", size.value > 50 && "big");
```

#### 4. Use a manual `() =>` getter (fallback for truly dynamic patterns)

If you genuinely need dynamic import (e.g. for code-splitting) or computed member access with a variable key, wrap the expression in a manual `() =>` getter. The runtime will re-evaluate it in an effect whenever its tracked dependencies change.

```ts
import * as ns from "./utils";
import { computed } from "sinwan/reactivity";

// Manual getter — the compiler does not promote it, but the runtime
// wraps it in an effect so it stays reactive.
const cls = () => {
  const key = "cn";
  return ns[key]("base", size.value > 50 && "big");
};

// Or use computed() for a memoized version (re-evaluates only when
// size.value changes, not on every access):
const clsMemo = computed(() => {
  const key = "cn";
  return ns[key]("base", size.value > 50 && "big");
});
```

#### 5. Use `computed()` for expensive dynamic patterns

If the dynamic expression is expensive (e.g. involves an `await import()`), use `computed()` to memoize the result. The computation runs once and caches until a dependency changes.

```ts
import { computed } from "sinwan/reactivity";

// computed() runs the async import lazily and caches the result.
// The compiler does not promote this (it's already a getter),
// but the runtime tracks size.value as a dependency.
const cls = computed(() => {
  // For dynamic import, you would need to resolve the module
  // outside the computed() and only use the dynamic key inside:
  const key = "cn";
  return ns[key]("base", size.value > 50 && "big");
});
```

#### Complete demo

```ts
// lib/utils.ts
/** @sinwan-pure */
export function cn(...inputs: unknown[]): string {
  return String(inputs);
}

/** @sinwan-pure */
export const helpers = {
  merge: (...inputs: unknown[]): string => String(inputs),
};

// comp.tsx
import { cc } from "sinwan/component";
import { signal, computed } from "sinwan/reactivity";
import { cn, helpers } from "../lib/utils";
import * as ns from "../lib/utils";

export const App = cc(() => {
  const size = signal(30);

  // ✅ Auto-promoted — static import + @sinwan-pure
  const a = cn("base", size.value > 50 && "big");

  // ✅ Auto-promoted — namespace import + direct member access
  const b = ns.cn("base", size.value > 50 && "big");

  // ✅ Auto-promoted — string literal key
  const c = ns["cn"]("base", size.value > 50 && "big");

  // ✅ Auto-promoted — object member call
  const d = helpers.merge("base", size.value > 50 && "big");

  // ✅ Manual getter — for computed member access with variable key
  const e = () => {
    const key = "cn";
    return ns[key]("base", size.value > 50 && "big");
  };

  // ✅ computed() — memoized, re-evaluates only when size.value changes
  const f = computed(() => ns.cn("base", size.value > 50 && "big"));

  return <div class={a} data-b={b} data-c={c} data-d={d} data-e={e} data-f={f} />;
});
```

Compiled output:

```ts
const a = () => cn("base", size.value > 50 && "big");
const b = () => ns.cn("base", size.value > 50 && "big");
const c = () => ns["cn"]("base", size.value > 50 && "big");
const d = () => helpers.merge("base", size.value > 50 && "big");
const e = () => {
  // manual getter — preserved as-is
  const key = "cn";
  return ns[key]("base", size.value > 50 && "big");
};
const f = computed(() => ns.cn("base", size.value > 50 && "big")); // already a getter
```

### Client, SSR and hydration

Generated getter calls use the existing JSX wrapping and explicit-binding rules; manual getter identifiers do not need a new blanket wrapping policy. Native attributes must use a runtime build with plain zero-argument getter hydration support. Text, attributes and `Show` remain reactive after hydration; event handlers and nonzero-arity callbacks are not invoked as getters.

The runtime's existing complex-template hydration fallback can replace a hoisted server subtree during initial hydration. Promotion does not change that policy; subsequent signal updates do not remount the native shell. Non-hoisted attribute hydration binds to the existing DOM in place.

## DOM vs component JSX

**Native elements** (`div`, `p`, `button`, …): wrap reactive children and attributes.

**User components** (`<Label>`, `<Child title={…} />`):

- **Children:** wrap reactive reads the same way as DOM text (`{count.value}`, `{checked.value ? "On" : "Off"}`) so `cc()` parents do not snapshot the value. Use a getter (`() => …`), never `_$bindText`, because the child may render nodes as well as strings. Render-prop functions (`{(v) => …}`) stay untouched.
- **Props:** wrap a prop if it is known-reactive for that component (built-in registry, local call graph, analyzer metadata). For _unknown_ imported components, still wrap **derived reads** (`htmlFor={id.value}`, `disabled={off.value}`) and leave **container pass-through** alone (`checked={checked}`, `user={user}`) so the child receives the signal or store proxy. With `explicitBindings`, component props stay **getters** (`each={() => …}`), never `_$bindAttr` — `For` / `Show` / `Label` call `resolve(prop)`, which does not unwrap bind descriptors.

**Built-in control-flow** components wrap specific props, and they wrap reactive expression children (those children render directly):

| Component                        | Reactive props  |
| -------------------------------- | --------------- |
| `For`, `Index`, `Virtual`        | `each`          |
| `Show`, `Switch`, `Match`, `Key` | `when`          |
| `Dynamic`                        | `component`     |
| `Visible`                        | `when`, `style` |
| `Portal`                         | `mount`         |
| `Activity`                       | `mode`          |

`Suspense` is not in this list; its props are left alone.

## Template hoisting

Static native trees become a module-level template plus `_$createTemplate(tmpl, [dynamic…])`.

Slots:

| Type    | When                                       |
| ------- | ------------------------------------------ |
| `child` | `{expr}`, or a capitalized child component |
| `attr`  | Dynamic attribute (not `on*`)              |
| `event` | `onClick={…}` and other `on*` handlers     |
| `ref`   | `ref={fn}` or `ref={object}`               |

Static `style` objects and strings are written into the HTML (`backgroundColor` → `background-color`). Quoted style strings that contain `${…}` log a warning in the compiler: use a template literal, `style={\`…${x}\`}`.

Hoisting is skipped (the JSX is left as JSX) when the root is a component, the tag is a member expression (`Icons.Star` as the root), a spread is on a native element (`<div {...props}>`), or the element needs a JSX enhancer (`<select defaultValue>`, function `action`/`formAction`, head tags without `itemProp`, and the other cases in `enhanced-elements.ts`). Nested enhanced tags become child slots so the native shell can still hoist. In `dev: true`, skipped hoists from extract errors log a warning.

Boolean attributes without a value are emitted as HTML flags: `<button disabled>`.

The slot marker format is `COMPILER_TEMPLATE_SLOT_PROTOCOL` (`s:0`, `s:1`, …). It must stay aligned with the runtime protocol in `sinwan`.

## Options

```ts
transformJSX(code, "src/App.tsx", {
  derivedLocals: false,
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
