# Changelog

All notable changes to **sinwan-compiler** are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com) and sinwan-compiler adheres to [Semantic Versioning](https://semver.org).

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

- **Analyzer Cache Remove (`analyze.ts`)**: `AnalyzerCache.remove()` only recomputed files that imported the deleted module. Callers are the files that *pass* props, so a deleted parent left its children marked reactive. Remove now also recomputes modules the deleted file imported, then saves.
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
