# JSX transform

The transform rewrites JSX so the Sinwan runtime can wrap reactive reads in effects at render time.

## Reactive wrapping

The compiler wraps expressions that read reactive values in zero-arity arrow functions. For example:

```tsx
<p>{state.name}</p>
```

becomes:

```tsx
<p>{() => state.name}</p>
```

The runtime calls these functions inside an effect so the DOM updates when the value changes.

## What is reactive

The compiler recognizes values from:

- `createMutable` / `createStore` from `sinwan/store`
- `signal` / `computed` from `sinwan/reactivity`
- `useState` from `sinwan/react-client`

Reactive reads include:

- Member expressions: `state.name`, `signal.value`
- Function calls: `getCount()`
- Derived expressions: `count() + 1`

## What is NOT wrapped

- Plain literals: `"Hello"`, `123`
- Event handlers: `onClick={handleClick}`
- Static bindings that the analyzer proved are non-reactive

## Cross-file optimization

When the analyzer is enabled, the transform can skip wrapping a prop if the analyzer determined that all callers pass a static value. This reduces runtime overhead.

```tsx
// Without analyzer: onClick={handleClick} is safe to skip wrapping
// With analyzer: title="Hello" is also known static, so it is skipped
<Child title="Hello" onClick={handleClick} />
```

## Options

```ts
transformJSX(code, filename, {
  hoist: true,              // template hoisting
  explicitBindings: false,  // emit compiler-driven binding descriptors
  analyze: "path/to/reactive-props.json", // production metadata
  analyzeMetadata: cache?.reactiveProps,  // dev cache metadata
});
```

## Template hoisting

Static JSX subtrees are hoisted into a top-level template factory so they are not recreated on every render.
