# Changelog

All notable changes to **sinwan-compiler** are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com) and sinwan-compiler adheres to [Semantic Versioning](https://semver.org).

## [1.1.3] — Static label `htmlFor` emits `for`

### Fixed

- **`htmlFor` in hoisted template HTML (`transform.ts`)**: A static `<label htmlFor="email">` was serialized into the template markup as `htmlFor="email"`, which the HTML parser stores as an `htmlfor` attribute that browsers ignore, so the label was not tied to its control. Hoisted HTML now uses `for`, like `defaultValue` → `value`. Dynamic slots keep the JSX name `htmlFor`; **sinwan 2.1.2** maps it to `for` at runtime.

## [1.1.2] — Analyzer reads commented tsconfig files and `extends`

### Fixed

- **tsconfig `paths` with comments (`analyze.ts`, new `tsconfig.ts`)**: The analyzer read `tsConfigPath` with `JSON.parse`. tsconfig files are JSONC, and create-sinwan templates ship with `//` comments, so parsing failed silently and `@/…` aliases were never resolved. Props passed through an aliased import were then treated as static: for example `<PlanCard billing={billing.value} />` imported from `@/components/…` compiled `priceLabel(props.plan, props.billing)` as a one-time read, so the card never updated. Comments and trailing commas are now accepted.
- **tsconfig `extends` (`tsconfig.ts`)**: `paths` and `baseUrl` are now inherited through `extends` (relative files, packages, and arrays, with later entries winning). Mappings resolve against `baseUrl` when set, otherwise against the config that declares `paths`, as in TypeScript. Missing, invalid or cyclic configs still fall back to no aliases instead of throwing.

## [1.1.1] — Compact analyzer cache

### Fixed

- **Analyzer cache is written without indentation (`analyze.ts`)**: `AnalyzerCache.save()` pretty-printed `cachePath` (`.sinwan/cache.json`) with two-space indentation and rewrites it after every transform, so a large app's dev cache reached 3 MB. It is now compact JSON, about 60% smaller and faster to write. The format is unchanged and older pretty-printed caches still restore.

## [1.1.0] — More derived locals, `LiveRead` arguments, and `export { X }` components

### Added

- **Same-file pure helpers and local getters promote (`reactive-wrap.ts`)**: With `derivedLocals`, a call to a same-file `/** @sinwan-pure */` function or const, or to a local zero-arity arrow getter whose body is itself safe (`const yearNow = () => …`), no longer blocks promotion, so `const fromYear = props.fromYear ?? yearNow() - 10` stays live. Getters with side effects (`() => count++`), block bodies or recursion, and unannotated helpers, stay eager.
- **Array and `Date` reads promote (`reactive-wrap.ts`)**: `Array.from(...)` and non-mutating array reads (`map`, `filter`, `slice`, `join`, …) on a known array, and `Date` getters (`getFullYear`, `getTime`, …) on a known `Date`, are promotable. A receiver is known when it is an array literal, `Array.from(...)`, an array read that returns an array, a `const` annotated or initialized as an array or `Date`, or a call to a same-file function with that return type. Callbacks must be inline or `@sinwan-pure`. Reads on unknown values such as `props.query.filter(...)`, and mutating calls such as `push` and `setFullYear`, stay eager. Pure array reads on a promoted local are rewritten (`monthList.map(...)` → `monthList().map(...)`).
- **`LiveRead<T>` arguments (`reactive-wrap.ts`)**: A reactive, non-function argument passed to a parameter typed `LiveRead<T>` (`T | (() => T)`) is wrapped as `() => value`, so APIs such as `createLiveState(..., props.selected)` re-read it. Other parameters are unchanged.
- **Auto-`cc` for `export { X }` (`auto-cc.ts`)**: A top-level `function X` or `const X = <fn>` exported through `export { X }` / `export { X as Name }` is wrapped with `cc(...)` like `export function X`. Before, such a child received a `cc` parent's derived props as getter functions and dropped them (for example `class={cn(...)}` never reached the DOM). Type-only exports, re-exports and lowercase export names are not wrapped, and neither is a `function X` that module code reads before its declaration (`Object.assign(X, { Item })` above it), since a `const` there would throw. Components written this way now run as `cc` components; a non-exported component that receives props from a `cc` parent still needs an explicit `cc(...)`.

### Fixed

- **Live rest helpers are not imported as types (`live-cc-destructure.ts`)**: `createLiveRest` / `getSpreadProps` were added to an existing `import type { … } from "sinwan/component"`, so they were erased and the component threw `ReferenceError: _$createLiveRest is not defined`. They now go into a value import.
- **Wrapped components keep type parameters (`auto-cc.ts`)**: `export function List<T>(props: Props<T>): JSX.Element` lost `<T>` and the return type when it was rewritten to `cc(function List(...))`. Both are kept now, for every auto-`cc` form.
- **Pure and `LiveRead` scans follow file edits (`reactive-wrap.ts`)**: The `@sinwan-pure` and `LiveRead<T>` scans of imported files were cached for the life of the process, so a dev server kept the first result after the helper file changed. A cached scan is reused only while the file, and every file it re-exports from, keeps its modification time.

## [1.0.0] — Oxc Compiler, Nested Hoist, and `sinway` Stores

sinwan-compiler 1.0.0 replaces Babel with oxc-parser and esrap, hoists native elements inside list and conditional expressions, and follows Sinwan 2.0.0’s public entries. Pair with **sinwan 2.0.0**. `transformJSX`, analyze, and the plugin options stay the same.

### Breaking

- **Babel removed (`package.json`, `src/ast/`)**: Parse, walk, and print no longer use `@babel/parser`, `@babel/traverse`, `@babel/types`, or `@babel/generator`. The compiler depends on `oxc-parser` and `esrap`. Public `transformJSX` and analyze behavior is unchanged. Printed code can differ in parentheses, quotes, and whitespace.
- **Store reads come from `sinway` (`reactive-wrap.ts`)**: `createMutable` and `createStore` are recognized on `import … from "sinway"`. `sinwan/store` is no longer a reactive source. Sinwan 2.0.0 removed that entry.
- **Hoist helpers import `sinwan/renderer/web` (`transform.ts`)**: `_$createTemplate`, `_$bindText`, `_$bindAttr`, and the other hoist bindings are imported from `sinwan/renderer/web`, not `sinwan/renderer`.

### Added

- **Nested template hoist (`transform.ts`)**: A native element inside an expression (`<For>{(row) => <tr/>}</For>`, `{cond && <span/>}`, `.map` callbacks) is hoisted on its own. A fragment does not block that hoist, so `<For>{(row) => <><td/></></For>}` hoists the cell. A native child written directly under another element still belongs to the parent template.
- **Parent-fill child slots (`transform.ts`)**: When an element’s only meaningful child is one dynamic expression, one component, or one enhancer, the template omits the `<!--s:N-->` marker and points the child slot at that element. A fragment around that only child is transparent (`<div><>{name}</></div>`). A fragment with siblings keeps markers, so `<div><>{name}</>tail</div>` stays in source order. Mixed static and dynamic children still use markers.

### Fixed

- **JSX comments stay comments (`src/ast/parse.ts`, `transform.ts`)**: `{/* note */}` is not printed as text. Inside a hoisted element it becomes an HTML comment (`<!-- note -->`). A block comment after the last child of a function or object stays on that container, so it cannot mark the next export `@sinwan-pure`.
- **Derived locals keep real bindings (`src/ast/path.ts`)**: Loop bindings, `catch` parameters, `switch` consts, function names, and class method keys are not rewritten into calls. `import type` is not a value binding. A `typeof` query in a type position does not freeze the const. `import.meta` does not abort the pass.
- **Optional prop chains unwrap (`reactive-wrap.ts`)**: `props.user?.name` compiles to `_$unwrap(props).user?.name`. An optional call through a pure import, such as `helpers?.merge(count.value)`, can still be promoted when `derivedLocals` is on.
- **Namespaced attributes stay in hoisted HTML (`transform.ts`)**: `xlink:href` and `xml:lang` are written into the template.
- **Renderer helper imports are reused (`transform.ts`)**: An existing `_$createTemplate` or `_$bind*` import from `sinwan/renderer` or `sinwan/renderer/web` is not imported again.
- **Parentheses still wrap (`auto-cc.ts`, `live-cc-destructure.ts`, `exports.ts`, `analyze.ts`)**: `export const Foo = (() => <div/>)` is auto-wrapped with `cc`. The same unwrap applies to live destructure, export collection, and analyze.
- **Parse stays JSX and TypeScript for every script extension (`src/ast/parse.ts`)**: `.js`, `.jsx`, `.ts`, and `.tsx` parse as TSX, matching the 0.4.0 Babel plugins.
- **Dynamic `class` and `on*` omit empty placeholders (`transform.ts`)**: Hoisted HTML does not emit ` class=""` or ` onclick=""`. The client binds those slots by path. Server rendering inserts the attribute when the placeholder is absent. Static `class="card"` is unchanged.

### Internal

- `src/ast/` is the parse, Path/Scope, and print facade. Optional chains (`ChainExpression`) and parentheses (`ParenthesizedExpression`) are unwrapped in the reactive walks.
- Docs: `docs/architecture.md`, `docs/api.md`, `docs/transform.md`.

## [0.4.0] — @sinwan-pure JSDoc Annotation

sinwan-compiler 0.4.0 extends `derivedLocals: true` with `@sinwan-pure` JSDoc annotation support. Imported functions annotated with `/** @sinwan-pure */` are recognized as safe pure calls, allowing the compiler to promote derived locals that call them — eliminating manual `() =>` getters for utility functions like `cn(...)`. Pair with **sinwan 1.5.1** (reactive child untrack + Virtual props resolve).

```ts
// lib/utils.ts
/** @sinwan-pure */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// comp.tsx — source stays clean, compiler auto-promotes
import { cn } from "../lib/utils";
const handleClass = cn("base", seamInactive && "hidden");

// Compiled output — fully reactive, no manual getter
const handleClass = () => cn("base", seamInactive() && "hidden");
```

### Added

- **`@sinwan-pure` JSDoc annotation (`reactive-wrap.ts`)**: Exported functions and consts annotated with `/** @sinwan-pure */` are recognized as safe pure calls. The compiler resolves the import source, reads the file, parses it, and caches the result. Calls to annotated imports are treated as pure, allowing the containing `const` initializer to be promoted to a getter.
- **Arbitrary import resolution**: All import types are scanned — relative imports (`./`, `../`), bare specifiers (`clsx`, `sinwan/reactivity`), scoped packages (`@scope/utils`), and subpath imports (`@scope/utils/merge`). The compiler walks up the directory tree to find `node_modules/<pkg>`, reads `package.json`, and resolves the entry point via `exports`, `module`, `main`, `source`, or `index` files. Extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`.
- **Plugin resolver forwarding**: When the `resolveImport` callback is provided by `bun-plugin-sinwan` or `vite-plugin-sinwan`, the compiler uses it for path resolution (handles tsconfig paths, bunfig aliases, workspace packages, and Bun/Vite module resolution). Otherwise, the compiler falls back to direct filesystem resolution.
- **Re-export following**: Named re-exports (`export { cn } from`), aliased re-exports (`export { cn as merge } from`), default re-exports (`export { default } from`), aliased default re-exports (`export { default as merge } from`), and namespace re-exports (`export * from`) are all followed recursively. Circular re-exports are handled with a depth limit (10) to prevent infinite loops.
- **Default export/import support**: `/** @sinwan-pure */ export default function helper()` and `import helper from "./utils"` are recognized. Default arrow functions and default class exports are also supported.
- **Namespace import support**: `import * as ns from "./utils"` followed by `ns.cn(...)` is recognized. Nested member calls (`ns.Utils.merge()`) and string literal access (`ns["cn"]()`) are also supported.
- **Class and object export support**: `/** @sinwan-pure */ export class Utils { static merge() }` and `/** @sinwan-pure */ export const helpers = { merge: () => }` are recognized. Any static method or property call on the imported binding is treated as pure.
- **Object/array literal promotion**: Safe object and array literal initializers with reactive reads (e.g. `const panelStyle = { flexBasis: \`${size.value}%\` }`) are now promoted to getters.

### Fixed

- **Object/array literals rejected by `isDerivedInitializer`**: `ObjectExpression`, `ObjectProperty`, and `ArrayExpression` nodes were rejected as unsafe, preventing promotion of derived locals like `const panelStyle = { flexBasis: \`${size.value}%\` }`. These are now allowed when they contain only safe expressions.

### Not scanned (by design)

- **Dynamic imports** (`await import("./utils")`) — binding is runtime, not compile-time. Use a static import instead.
- **`require()`** — CommonJS, not used in Sinwan's ESM target. Use a static ESM import instead.
- **Computed member access with non-literal keys** (`ns[key]()` with variable keys, `ns[\`cn`]()` with template literals) — cannot statically resolve the property name. Use direct member access (`ns.cn()`) or string literal access (`ns["cn"]()`).

### Internal

- Compiler regressions: 28 new tests covering `@sinwan-pure` annotation detection, relative/bare/scoped/subpath imports, `node_modules` package resolution, `package.json` `exports`/`module`/`main`/`source` fields, conditional exports, root index fallback, broken packages (missing `package.json`, invalid JSON, wrong `main`, unresolvable subpaths), plugin `resolveImport` callback, barrel re-exports, aliased re-exports, circular re-exports, `export *` re-exports, default export/import, namespace import, class static methods, object property calls, default class exports, non-annotated imports, computed member access, and workarounds for unsupported patterns.
- `bun run scripts/run-tests.ts` — 311 pass / 0 fail. `src/` is 100% lines and functions. `bun run typecheck` clean. `bun run build` clean.
- Documentation updated in `docs/transform.md` (full `@sinwan-pure` contract, supported forms tables, workarounds section, complete demo), `docs/plugins.md`.

## [0.3.2] — Derived Locals

sinwan-compiler 0.3.2 adds opt-in `derivedLocals: true` promotion of setup-time derived `const` initializers to zero-arity getters, so locals that read signals stay reactive without authors writing `() => …` or `computed(…)`. Pair with **sinwan 1.5.0** (plain getter attribute hydration).

```ts
// Before — snapshots once at setup, never updates
const leftCollapsed = leftPanel?.collapsed.value;
const showStartExpand = !seamInactive && leftCollapsed && !rightCollapsed;
<Show when={showStartExpand} />

// After — with derivedLocals: true, the compiler promotes to live getters
const leftCollapsed = () => leftPanel?.collapsed.value;
const showStartExpand = () => !seamInactive && leftCollapsed() && !rightCollapsed;
<Show when={() => showStartExpand()} />
```

### Added

- **`derivedLocals` option (`reactive-wrap.ts`, `transform.ts`)**: When `true`, `promoteReactiveConstInitializers` rewrites eligible component-local `const` declarations whose initializers contain reactive reads (signal `.value`, store members, props, or references to already-promoted getters) into zero-arity arrow functions. Dependent references are rewritten to call the promoted getters so truthiness and ordinary reads keep their semantics. Opt-in; defaults remain off for compatibility.
- **Declaration-chain promotion**: Initializers that reference already-promoted getters are rewritten to call them, preserving declaration order and reactive dependency chains.
- **`/* sinwan-snapshot */` pragma**: Declarations or initializers carrying this comment are skipped, documenting intentional snapshots.
- **Development diagnostics**: When `derivedLocals` is disabled and a derived reactive local is referenced from JSX, dev mode warns explaining the snapshot and how to opt in. A setup `if` read of a promoted getter warns that it is one-time control flow and recommends `Show` for reactive branching.
- **Plugin forwarding (`bun-plugin-sinwan`, `vite-plugin-sinwan`)**: Both plugins forward `derivedLocals` to the compiler.

### Fixed

- **`collectExportedComponents` skips type-only exports (`exports.ts`)**: `export type { ButtonProps }` and `export { type Foo }` are not runtime bindings. Fast Refresh footers that called `$$sinwanReplace(ButtonProps, …)` threw `ReferenceError: ButtonProps is not defined` when linked UI source (for example `sinwan-ui` `button.tsx`) hot-reloaded with a demo page.
- **Scope crawl after auto-cc (`reactive-wrap.ts`)**: `promoteReactiveConstInitializers` now re-crawls the program scope before the promotion traverse so the module-kind binding guard sees the `cc` import injected by `autoWrapComponents`. Without this, derived locals in auto-cc-wrapped components were not promoted.

### Internal

- Export-detection regressions for `export type { … }`, mixed `export { Value, type Type }`, and type-only modules.
- Compiler regressions: 14 new derived-local tests covering basic promotion, late-panel chains, declaration order, ordinary reads, shorthand, closures, event bodies, props, `useState` getters, coercions, TypeScript assertions/satisfies, static constants, containers, manual getters, mutable declarations, side effects, hook init, writes, TDZ, module-level locals, helpers, callbacks, shadowing, component tags, `eval`, snapshot pragmas, disabled diagnostics, idempotence, hoisted/non-hoisted JSX, and explicit bindings on/off.
- `bun run scripts/run-tests.ts` — 283 pass / 0 fail. `src/` is 100% lines and functions. `bun run typecheck` clean. `bun run build` clean.
- Documentation updated in `docs/transform.md`, `docs/architecture.md`, `docs/plugins.md`.

## [0.3.1] — Unwrap Helper Alias

sinwan-compiler 0.3.1 always injects `unwrap as _$unwrap` even when the file already imports `unwrap`. Pair with **sinwan 1.4.1** (Show/Portal skip remount) for sinwan-ui Presence overlays. CSS exit fill-mode is sinwan-ui, not this package.

`Presence` `present` is still **not** a builtin wrap name (unlike `Show.when`). Overlay internals must pass a live getter: `present={() => api.open.value}`. `present={api.open.value}` snapshots closed.

### Fixed

- **`_$unwrap` helper import (`reactive-wrap.ts`)**: `import { unwrap }` from `sinwan/reactivity` no longer suppresses `import { unwrap as _$unwrap }`. Generated getters always call `_$unwrap`, so a same-export different local name left `ReferenceError: _$unwrap is not defined` (Combobox `defaultOpen={props.defaultOpen}`).

### Internal

- Transform regression that `import { unwrap }` still emits a separate `unwrap as _$unwrap` specifier.
- `bun run test` — 266 pass / 0 fail. `src/` is 100% lines and functions.

## [0.3.0] — Live `cc` Destructure

sinwan-compiler 0.3.0 rewrites flat `cc` / auto-`cc` object destructure so props stay live after Sinwan 1.4.0 unwraps zero-arity getters. Pair with **sinwan 1.4.0** (`createLiveRest` / `getSpreadProps`).

### Added

- **`rewriteLiveCcDestructure` (`live-cc-destructure.ts`)**: After auto-`cc` and before wrap, `cc(({ value }) => …)` becomes `cc((props) => …)` and locals rewrite to `props.value`. Defaults use JS `=== void 0` on each read. Nested / computed patterns are left as snapshots.

### Changed

- **Rest and JSX spread**: `{ value, ...rest }` is `createLiveRest(props, omittedKeys)`. Native or forwarded `{...props}` / `{...rest}` becomes `{...getSpreadProps(...)}` so attributes keep getter functions instead of freezing unwrapped values at setup.
- **Forwarded prop members**: Destructured props used as child attributes wrap as getters (`user={() => _$unwrap(props).user}`) so the child stays live.

### Internal

- Transform regressions for flat destructure, rest + spread helpers, identifier `{...props}`, nested snapshot leave-alone, and `explicitBindings` children getters.
- `bun run test` — 264 pass / 0 fail. `src/` is 100% lines and functions. `bun run typecheck` clean.

## [0.2.11] — Wrap Hook And inject Reads (`.value` And Getters)

sinwan-compiler 0.2.11 wraps reactive reads that come from another module so a `cc()` setup does not snapshot them: `{theme.value}` / `{api.theme.value}` from `useTheme()` or `inject()`, and `{count()}` / `{counter()}` / `{api.count()}` from a hook that returns `useState` getters.

### Fixed

- **Untracked `.value` reads (`reactive-wrap.ts`)**: Auto-wrap only recorded identifiers created by local `signal()` / `useFetch()` / props. `const { theme } = useTheme()` left `{theme.value}` as a one-time string, and wrapping was skipped entirely when the `cc()` body had no local reactive bindings. `.value` on an untracked root (`theme.value`, `api.theme.value`) now counts as a reactive read, including on imported component props such as `variant={theme.value === value ? …}`. Nested JSX inside `.map` still wraps the inner slots, not the list.
- **Untracked getter calls (`reactive-wrap.ts`)**: Local `const [count] = useState(0)` already wrapped `{count()}`. `const { count } = useCounter()` / `const counter = useCounter()` left `{count()}` as a setup-time snapshot because the identifier was not a tracked getter. Zero-arity identifier calls and `api.count()` now wrap like `useState`. Local helpers (`greet()`), calls with arguments (`format("x")`), store methods, and event attributes (`onclick={make()}`) stay eager.

### Internal

- Transform regressions for `useTheme` / `inject` children, map + imported `Button` variant, `explicitBindings` native `bindText` vs component getters, hook-returned getters, optional `count?.()`, imported `disabled={count() > 0}`, and non-wrap cases (local helper, args, store method, `onclick`).

## [0.2.10] — Component Props Stay Getters With explicitBindings

sinwan-compiler 0.2.10 wraps reactive **component** props as `() => …` even when `explicitBindings` is on, so `<For each={keys.map(...)}>` renders instead of an empty list.

### Fixed

- **Component prop wrapping (`reactive-wrap.ts`)**: With `explicitBindings: true`, auto-wrapped `For.each` / `Show.when` / `Label htmlFor` became `_$bindAttr("each", () => …)`. `resolve()` does not unwrap bind descriptors, so `For` treated `each` as a non-array and rendered nothing. Manual `each={() => …}` worked because `shouldWrap` skipped it. Component attributes now stay getters; native tags still use `_$bindAttr` / `_$bindStyle` / `_$bindClass`.

### Internal

- Transform regressions: `For each` map callbacks, `Show when`, and imported `htmlFor` with `explicitBindings` emit getters and not `_$bindAttr`.

## [0.2.9] — Wrap Reactive Reads Inside Call Callbacks

sinwan-compiler 0.2.9 wraps JSX expressions whose only reactive reads sit inside `.map` / `.filter` callbacks (or IIFEs), so `<For each={keys.map((k) => groups[query.value])}>` stays live without a manual `() =>`.

### Fixed

- **Call-callback reads (`reactive-wrap.ts`)**: `containsReactiveRead` skipped every nested function, so `each={arr.map((x) => query.value)}` was a setup-time snapshot. Reads inside **called** functions (map/filter callbacks, IIFE callees, default params, spread arguments) now count. Render props, event-handler factories (`const make = () => () => …`), and functions stored as values stay unwrapped. Already-emitted `_$bind*` getters are not re-entered. Prop-rooted members inside those callbacks get `unwrap(...)` when the outer expression is wrapped.

### Internal

- Transform regressions for `For each` map/optional-map/function-expression callbacks, static maps, filter-only local helpers, IIFE children, handler factories, and prop unwrap inside map callbacks.

## [0.2.8] — Wrap User-Component Children And Derived Props

sinwan-compiler 0.2.8 wraps reactive reads in user-component children and derived attributes on unknown imported components, so `<Label>{checked.value ? "On" : "Off"}</Label>` stays live inside a `cc()` parent.

### Fixed

- **User-component children (`reactive-wrap.ts`)**: `{count.value}` and `{checked.value ? "On" : "Off"}` passed to `<Label>` / `<Child>` were left as a one-time snapshot because wrapping only ran for native tags and built-in control-flow. Those reads are now wrapped as `() => …`. With `explicitBindings`, component children still use a getter (not `_$bindText`) so vnode-returning expressions do not stringify as `[object Object]`.
- **Unknown imported component props**: derived reads such as `htmlFor={id.value}` are wrapped even without analyzer metadata. Bare signal/store identifiers (`checked={checked}`, `user={user}`) stay unwrapped so the child receives the container.

### Internal

- Transform regressions for Label-style children, explicitBindings vnode children, imported `htmlFor={id.value}`, and `user={user!}` / forwarded `user={user}` pass-through.

## [0.2.7] — Children Passthrough Is Not bindText

sinwan-compiler 0.2.7 stops wrapping a bare `{children}` identifier as `_$bindText`, so hoisted hosts such as Menubar render menu vnodes instead of `[object Object]`.

### Fixed

- **Bare `children` identifier (`reactive-wrap.ts`)**: With `explicitBindings`, `{children}` inside a `cc()` component became `_$bindText(() => children)`. `String` of a vnode array is `[object Object],[object Object],…`. The identifier is now wrapped as `() => children` so `_$createTemplate` renders a node tree. Signal text such as `{count.value}` still uses `_$bindText`.

### Internal

- Added a transform regression that `cc(({ children }) => <div>{children}</div>)` emits `() => children` and not `_$bindText(() => children)` when `explicitBindings` is on.
- Compiler tests: 220 pass / 0 fail (was 219). `src/` is 100% lines and 100% functions.

## [0.2.6] — Hoisted Form Defaults & JSX Enhancer Child Slots

sinwan-compiler 0.2.6 maps uncontrolled input defaults to real HTML in hoisted templates, and keeps every `enhanced-elements.ts` special case on the `jsx()` path so compiled trees match the runtime enhancers.

### Fixed

- **Hoisted `defaultValue` / `defaultChecked` (`transform.ts`)**: Hoisted `<input defaultValue="/api/hello" />` copied the JSX prop name into HTML. Browsers ignore `defaultValue` as a content attribute, so the field rendered empty. Static `defaultValue` now serializes as `value`, `defaultChecked` as `checked`, and a static textarea `defaultValue` becomes text content. Dynamic `defaultValue={v}` still emits an attr slot named `defaultValue`; the runtime maps it to the IDL property.
- **Enhanced tags skipped the `jsx()` enhancers (`transform.ts`)**: Hoisting inlined `select`, function `action` / `formAction`, `option selected`, controlled `textarea` / `progress`, and head tags (`link` / `meta` / `title` / `style` / `script`) as inert HTML. Those props need refs, option selection, or `document.head` insertion. Roots that need an enhancer are no longer hoisted; nested ones become child slots so the native shell can still hoist.

### Changed

- **Template hoisting docs (`docs/transform.md`, `docs/plugins.md`, `README.md`)**: Document enhancer skip/child-slot rules. Plugins declare `sinwan-compiler` as `>=0.2.5 <1.0.0` and import it at runtime, so a 0.x compiler publish does not require a plugin republish; existing apps pick it up with `bun update sinwan-compiler`.

### Internal

- Compiler tests: 219 pass / 0 fail (was 195). `src/` is 100% lines and 100% functions.

## [0.2.5] — Analyzer Cache Delete Fix, Isolated Tests & Docs Rewrite

sinwan-compiler 0.2.5 fixes stale reactive-prop metadata when a caller file is deleted, stops cache restore from throwing on stale function spans, isolates the test runner to this package, and rewrites the docs to match the current compiler API.

### Fixed

- **Analyzer Cache Remove (`analyze.ts`)**: `AnalyzerCache.remove()` only recomputed files that imported the deleted module. Callers are the files that _pass_ props, so a deleted parent left its children marked reactive. Remove now also recomputes modules the deleted file imported, then saves.
- **Cache Restore on Stale Spans (`analyze.ts`)**: Restoring a cache whose source no longer matched serialized callee spans threw `Failed to restore callee`. `restoreModule` now returns `null` and skips that module; the next `update` rebuilds it.
- **Package Test Isolation (`scripts/run-tests.ts`)**: `bun test` from this package could pick up other workspace `cli.test.ts` files. `bun run test` now runs only `sinwan-compiler/__tests__` with coverage.

### Changed

- **Documentation**: README and `docs/` now describe auto-`cc`, `useFetch`, `useState` from `sinwan/react`, built-in control-flow wrapping, `ref`/style hoisting, cache remove/restore, import resolve order (tsconfig → bunfig → workspaces → relative), CLI bin `sinwan`, and plugin wiring. Analyzer “Limitations” are documented as conservative rules (unknown spreads, `children` as a prop, exported props reactive without metadata).
- **CLI Entry (`cli.ts`)**: `runCliIfMain()` is the testable entry; it still runs `runAnalyzeCli()` when the module is the process main.

### Internal

- Compiler tests: 195 pass / 0 fail (was 141). `src/` is 100% lines and 100% functions.
- CI and Release workflows run `bun run test` instead of bare `bun test`.

## [0.2.4] — Template Hoisting with Refs, Protocol Drift Fix & Test Expansion

sinwan-compiler 0.2.4 adds support for hoisting JSX elements with `ref` attributes (previously a hard error), fixes a type assertion issue in the template slot protocol, and significantly expands test coverage for compiler transforms.

### Added

- **Template Hoisting with Refs (`transform.ts`)**: The compiler no longer throws `Cannot hoist element with ref` when encountering a `ref` attribute during template hoisting. Instead, it emits a new `"ref"` slot type with the element's path and the ref expression. The static HTML shell is hoisted as usual (no HTML placeholder for refs — they are client-only), and the runtime `_$createTemplate` binds the ref to the cloned element via `applyRef()` after template instantiation. This works for both function refs (`ref={(el) => el?.focus()}`) and object refs (`ref={inputRef}`). The SSR renderer skips ref slots entirely (no `ref=` attribute in server output), and the hydration walker binds refs to existing DOM elements during in-place hydration. Supports refs on root elements, nested elements (with correct path resolution), and combinations with attr/event/child slots.
- **5 new compiler tests for ref hoisting**: Tests covering function ref hoisting, object ref hoisting, ref + attr slot combination, ref + event handler combination, and nested element ref path resolution.

### Fixed

- **COMPILER_TEMPLATE_SLOT_PROTOCOL Const Assertion (`transform.ts`)**: Removed the `as const` assertion from the `COMPILER_TEMPLATE_SLOT_PROTOCOL` object that caused a type mismatch with the runtime's `DEFAULT_TEMPLATE_SLOT_PROTOCOL`. The `slotPrefix` property was typed as `"s"` (literal) instead of `string`, causing a type error when the drift test compared the two protocols. The object is now typed as a plain object with `string` properties, matching the runtime interface.

### Changed

- **TemplateSlot Type Extended**: The `TemplateSlot.type` field in the runtime (`sinwan/src/renderer/template-protocol.ts`) now accepts `"ref"` in addition to `"child"`, `"attr"`, and `"event"`. The compiler's internal `TemplateSlot` interface (which uses `type: string`) was already compatible.

### Internal

- Compiler tests: 141 pass / 0 fail (was 136, +5 new tests).
- `walkToSlot` is now exported from `sinwan/src/renderer/template.ts` for use by the hydration walker.

## [0.2.3] — Comprehensive Test Coverage & Slot Path Generation

sinwan-compiler 0.2.3 significantly expands test coverage for the compiler transform, including component export detection, template hoisting edge cases, auto-cc wrapping, and useFetch reactive source tracking. Also adds dedicated tests for template slot path generation with fragments and siblings.

### Added

- **Template Slot Path Generation Tests**: Added dedicated tests verifying slot path computation for JSXFragment children (basic and nested), reactive children with attr siblings, and multiple reactive children ordering. Ensures the compiler emits correct `path` arrays that the runtime `walkToSlot` can resolve.
- **Component Export Detection Tests**: Added 9 tests for `collectExportedComponents` covering named functions, named variables, default exports, export specifiers with rename, multiple components, non-component exports, unparseable code, and re-exports.
- **Auto-cc Wrapping Tests**: Added tests verifying that exported uppercase functions returning JSX are automatically wrapped with `cc(...)`, including idempotency (skipping already-wrapped functions) and correct import injection.
- **useFetch Reactive Source Tracking Tests**: Added tests verifying that `useFetch` from `sinwan/hook` is recognized as a reactive source, and that destructured members (`data`, `error`, `isLoading`) are tracked as reactive signals.

### Internal

- Compiler tests: 136 pass / 0 fail.

## [0.2.2] — React Import Path Fix

sinwan-compiler 0.2.2 fixes the reactive source module list to use the unified `sinwan/react` import path instead of the removed `sinwan/react-client`.

### Fixed

- **Remove `sinwan/react-client` from Reactive Sources (`reactive-wrap.ts`)**: The reactive source module list still referenced `sinwan/react-client`, which was removed in favor of the unified `sinwan/react` barrel. Updated `REACTIVE_SOURCE_MODULES` to use `sinwan/react` so that `useState` imported from `sinwan/react` is correctly tracked as a reactive source.

## [0.2.1] — useState Import Path Tracking

sinwan-compiler 0.2.1 fixes the reactive expression wrapper to track `useState` from the correct `sinwan/react` import path.

### Fixed

- **Track `useState` from `sinwan/react` (`reactive-wrap.ts`)**: `useState` was not being tracked as a reactive source because the import path check looked for `sinwan/react-client` instead of `sinwan/react`. Updated `REACTIVE_SOURCE_MODULES` and import tracking to recognize `sinwan/react` as a valid reactive source module, ensuring `const [count, setCount] = useState(0)` produces tracked bindings and `count.value` reads are wrapped in zero-arity getters.

## [0.2.0] — Auto-Wrap Reactive Component Props

sinwan-compiler 0.2.0 introduces automatic wrapping of reactive values passed to component props, using a built-in registry and call-graph analysis. This eliminates the need for manual `_$bindAttr` / `_$bindText` calls at component call sites.

### Added

- **Auto-Wrap Reactive Component Props (`reactive-wrap.ts`)**: New `autoWrapComponentProps` pass that detects reactive values (signals, computed, state getters, derived expressions) passed to component props and automatically wraps them in zero-arity getter functions. Uses a built-in registry of known reactive component props (e.g. `Show.when`, `For.each`, `Switch.fallback`) and a call-graph analysis to infer which props are reactive for user-defined components. When a component's reactive props cannot be inferred (no metadata), the pass falls back to conservative behavior (no wrapping). The pass runs after `wrapReactiveExpressions` and before template hoisting.

## [0.1.0] — Initial Release

sinwan-compiler 0.1.0 is the initial standalone release of the Sinwan compiler core, extracted from the monorepo. It provides the JSX transform, reactive expression wrapping, and reactive prop analysis shared by the Bun and Vite plugins.

### Added

- **JSX Transform (`transform.ts`)**: Transforms JSX AST to use template hoisting. Static JSX elements are extracted to module-level template strings and replaced with optimized `_$createTemplate` calls. Supports:
  - Static HTML shell extraction with `<!--s:N-->` slot markers for dynamic children
  - Attribute slots (`type: "attr"`) with ` name=""` placeholders
  - Event slots (`type: "event"`) with ` onEvent=""` placeholders
  - Component child slots (capitalized tags emitted as dynamic child slots)
  - JSXFragment children inlining with correct path tracking
  - Static style serialization (object and string styles serialized directly into HTML)
  - Spread attribute detection (skips hoisting with a warning)
  - Ref attribute detection (skips hoisting with a warning — _enhanced in 0.4.0_)
- **Reactive Expression Wrapping (`reactive-wrap.ts`)**: Auto-wraps reactive JSX expressions in zero-arity functions. Supports `createMutable` / `createStore` from `sinwan/store`, `signal` / `computed` from `sinwan/reactivity`, and `useState` from `sinwan/react`. Handles optional chaining (`?.`) and non-null assertions (`!.`) on reactive reads. Tracks reactive source imports and wraps derived expressions.
- **Auto-cc Component Wrapping (`auto-cc.ts`)**: `autoWrapComponents()` compiler pass that detects exported uppercase functions returning JSX and automatically wraps them with `cc(...)`, injecting the import only when needed. Idempotent — skips already-wrapped functions.
- **Reactive Prop Analysis (`analyze.ts`)**: `analyzeProject` / `analyzeModule` / `loadMetadata` utilities for analyzing which component props are reactive. Produces a `reactive-props.json` metadata file consumed by the auto-wrap pass. Supports tsconfig path aliases and cross-module analysis. Includes `AnalyzerCache` for persistence.
- **Component Export Detection (`exports.ts`)**: `collectExportedComponents` utility for detecting exported component-like functions in source files. Used by HMR to determine which modules need fast refresh.
- **CLI (`cli.ts`)**: `runAnalyzeCli` command-line interface for running the reactive prop analyzer on a project.
- **Template Slot Protocol (`transform.ts`)**: `COMPILER_TEMPLATE_SLOT_PROTOCOL` defining the `s:N` slot marker format, shared with the runtime's `DEFAULT_TEMPLATE_SLOT_PROTOCOL` via a drift test in the `sinwan` package.
- **GitHub Actions CI/CD**: Build, test, and release workflows.
- **MIT License**: Added license file.
- **README**: Added comprehensive README.
- **Analyzer Test Suite**: Comprehensive test suite for the reactive prop analyzer.
