import { describe, it, expect } from "bun:test";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import {
  collectComponentCallGraph,
  collectComponentFunctions,
  computeLocalScopes,
  containsReactiveValue,
  getComponentExpressionInfo,
  isReactiveValue,
  propagateReactiveProps,
  resolveLocalObjectLiteral,
  trackReactiveImports,
  wrapReactiveExpressions,
  type ReactiveScope,
} from "../src/reactive-wrap";

function parseModule(code: string) {
  return parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
}

describe("isReactiveValue", () => {
  const scope: ReactiveScope = {
    bindings: new Map([
      ["s", { kind: "signal" }],
      ["c", { kind: "computed" }],
      ["f", { kind: "signalObject" }],
      ["p", { kind: "prop" }],
      ["m", { kind: "mutable", root: "state", path: ["name"] }],
      ["g", { kind: "getter" }],
    ]),
  };

  it("unwraps non-null assertions and member paths", () => {
    const signalValue = t.memberExpression(
      t.identifier("s"),
      t.identifier("value"),
    );
    expect(isReactiveValue(t.tsNonNullExpression(signalValue), scope)).toBe(
      true,
    );
    expect(
      isReactiveValue(
        t.memberExpression(t.identifier("c"), t.identifier("value")),
        scope,
      ),
    ).toBe(true);
    expect(
      isReactiveValue(
        t.memberExpression(
          t.memberExpression(t.identifier("f"), t.identifier("data")),
          t.identifier("value"),
        ),
        scope,
      ),
    ).toBe(true);
    expect(
      isReactiveValue(
        t.memberExpression(t.identifier("f"), t.identifier("data")),
        scope,
      ),
    ).toBe(false);
    expect(isReactiveValue(t.identifier("g"), scope)).toBe(false);
    expect(
      isReactiveValue(
        t.memberExpression(t.identifier("g"), t.identifier("name")),
        scope,
      ),
    ).toBe(false);
    expect(isReactiveValue(t.identifier("p"), scope)).toBe(true);
    expect(isReactiveValue(t.identifier("m"), scope)).toBe(true);
  });

  it("treats untracked .value chains as signal reads", () => {
    const empty: ReactiveScope = { bindings: new Map() };
    expect(
      isReactiveValue(
        t.memberExpression(t.identifier("theme"), t.identifier("value")),
        empty,
      ),
    ).toBe(true);
    expect(
      isReactiveValue(
        t.memberExpression(
          t.memberExpression(t.identifier("api"), t.identifier("theme")),
          t.identifier("value"),
        ),
        empty,
      ),
    ).toBe(true);
    expect(isReactiveValue(t.identifier("theme"), empty)).toBe(false);
    expect(
      isReactiveValue(
        t.memberExpression(t.identifier("user"), t.identifier("name")),
        empty,
      ),
    ).toBe(false);
  });
});

describe("containsReactiveValue", () => {
  it("does not enter nested function expressions", () => {
    const scope: ReactiveScope = {
      bindings: new Map([["s", { kind: "signal" }]]),
    };
    const nested = t.arrowFunctionExpression(
      [],
      t.memberExpression(t.identifier("s"), t.identifier("value")),
    );
    expect(containsReactiveValue(nested, scope)).toBe(false);
  });
});

describe("collectComponentFunctions and call graph", () => {
  it("collects exported cc() components and local call sites", () => {
    const ast = parseModule(`
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => <h1>{title}</h1>);
      const App = cc(() => (
        <Child title="Hi">
          {1}
          {2}
        </Child>
      ));
      export default App;
    `);
    const names = trackReactiveImports(ast);
    const collected = collectComponentFunctions(ast, names.cc);
    expect(collected.names.has("Child")).toBe(true);
    expect(collected.names.has("App")).toBe(true);
    expect(collected.exported.size).toBeGreaterThan(0);

    const graph = collectComponentCallGraph(ast, collected.names);
    expect(graph.size).toBeGreaterThan(0);
    const sites = Array.from(graph.values()).flat();
    expect(
      sites.some((site) => site.props.some((p) => p.name === "children")),
    ).toBe(true);
  });

  it("ignores member-expression tags and module-level JSX", () => {
    const ast = parseModule(`
      import { cc } from "sinwan/component";
      const Child = cc(() => <div />);
      const App = cc(() => <Foo.Bar title={true} />);
      const unused = <Child />;
    `);
    const names = trackReactiveImports(ast);
    const collected = collectComponentFunctions(ast, names.cc);
    const graph = collectComponentCallGraph(ast, collected.names);
    expect(graph.size).toBe(0);
  });

  it("records a single expression child", () => {
    const ast = parseModule(`
      import { cc } from "sinwan/component";
      const Child = cc(({ children }) => <div>{children}</div>);
      const App = cc(() => <Child>{1}</Child>);
    `);
    const names = trackReactiveImports(ast);
    const collected = collectComponentFunctions(ast, names.cc);
    const graph = collectComponentCallGraph(ast, collected.names);
    const sites = Array.from(graph.values()).flat();
    expect(sites.some((site) => site.props.some((p) => p.name === "children"))).toBe(
      true,
    );
  });

  it("propagates reactive props through a local object-literal spread", () => {
    const ast = parseModule(`
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Child = cc(({ title }) => <h1>{title}</h1>);
      export const App = cc(() => {
        const s = signal("Hi");
        const props = { title: s.value };
        return <Child {...props} />;
      });
    `);
    const names = trackReactiveImports(ast);
    const collected = collectComponentFunctions(ast, names.cc);
    const scopes = computeLocalScopes(ast, names);
    const graph = collectComponentCallGraph(ast, collected.names);
    const sites = Array.from(graph.values()).flat();
    expect(sites.some((site) => site.spreads.length > 0)).toBe(true);
    const props = propagateReactiveProps(scopes, graph, collected.functions);
    const childFn = collected.names.get("Child");
    expect(childFn).toBeDefined();
    expect(props.get(childFn!)?.has("title")).toBe(true);
    const object = resolveLocalObjectLiteral(collected.names.get("App")!, "props");
    expect(object?.type).toBe("ObjectExpression");
  });
});

describe("getComponentExpressionInfo", () => {
  it("returns a non-component result without a parent path", () => {
    expect(getComponentExpressionInfo({})).toEqual({
      isComponent: false,
      componentName: null,
      attributeName: null,
    });
  });
});

describe("wrapReactiveExpressions", () => {
  it("is a no-op when there are no reactive imports", () => {
    const ast = parseModule(`const App = () => <div>hi</div>;`);
    wrapReactiveExpressions(ast);
    expect(ast.program.body.length).toBe(1);
  });
});
