import { describe, expect, it } from "bun:test";
import { transformJSX } from "../src/transform";

function compile(code: string, derivedLocals = false) {
  return transformJSX(code, "App.tsx", { derivedLocals, hoist: true }).code;
}

describe("auto-cc through export specifiers", () => {
  it("wraps a function declaration exported with export { X }", () => {
    const code = compile(`
      function Child(props) { return <div class={props.class} />; }
      export { Child };
    `);
    expect(code).toContain('import { cc } from "sinwan/component"');
    expect(code).toMatch(/const Child = cc\(function Child\(props\)/);
    expect(code).toContain("export { Child }");
  });

  it("wraps const components and renamed exports", () => {
    const code = compile(`
      const Root = (props) => <section>{props.children}</section>;
      const Item = function (props) { return <article />; };
      export { Root as Accordion, Item as AccordionItem };
    `);
    expect(code).toMatch(/const Root = cc\(\(?props\)? =>/);
    expect(code).toMatch(/const Item = cc\(function \(props\)/);
  });

  it("leaves non-components and type-only exports alone", () => {
    const code = compile(`
      function helper() { return <i />; }
      function Two(a, b) { return <b />; }
      function NoJsx() { return 1; }
      const value = 1;
      let Later;
      function Lower() { return <u />; }
      type Props = {};
      export { helper, Two, NoJsx, value, Later, Lower as lower };
      export type { Props };
    `);
    expect(code).not.toContain("cc(");
    expect(code).not.toContain("sinwan/component");
  });

  it("ignores re-exports, nested declarations and already wrapped components", () => {
    const code = compile(`
      import { cc as wrap } from "sinwan/component";
      export { Remote } from "./remote";
      const Done = wrap((props) => <p />);
      function outer() {
        function Inner() { return <span />; }
        return Inner;
      }
      export { Done, outer as Outer };
    `);
    expect(code.match(/wrap\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/\bcc\(/);
    expect(code).toContain("function Inner()");
  });

  it("keeps a function declaration that module code reads before it", () => {
    const code = compile(`
      export { Root, Item, Group, Later };
      const Group = Object.assign(Root, { Item });
      const render = () => <Later />;
      type LaterType = typeof Later;
      function Root(props) { return <div>{props.children}</div>; }
      function Item(props) { return <span />; }
      function Later(props) { return <i />; }
    `);
    expect(code).toContain("function Root(props)");
    expect(code).not.toMatch(/const Root = cc\(/);
    expect(code).toContain("function Item(props)");
    expect(code).toMatch(/const Later = cc\(function Later\(props\)/);
  });

  it("keeps type parameters and return types when wrapping", () => {
    const code = compile(`
      function List<T>(props: { items: T[] }): JSX.Element { return <ul />; }
      export function Grid<T>(props: { rows: T[] }): JSX.Element { return <table />; }
      export { List };
    `);
    expect(code).toMatch(/const List = cc\(function List<T,?>\(props: \{\s*items: T\[\]\s*\}\): JSX\.Element/);
    expect(code).toMatch(/const Grid = cc\(function Grid<T,?>\(props: \{\s*rows: T\[\]\s*\}\): JSX\.Element/);
    const named = compile(`export default function Page<T>(props: { v: T }): JSX.Element { return <main />; }`);
    expect(named).toMatch(/function Page<T,?>\(props: \{\s*v: T\s*\}\): JSX\.Element/);
    const anonymous = compile(`export default function <T>(props: { v: T }): JSX.Element { return <main />; }`);
    expect(anonymous).toMatch(/cc\(function <T,?>\(props: \{\s*v: T\s*\}\): JSX\.Element/);
  });

  it("passes derived props to a specifier-exported child as values", () => {
    const code = compile(
      `
      import { signal } from "sinwan/reactivity";
      function Child(props) { return <div class={props.class} />; }
      export function Parent() {
        const on = signal(false);
        const className = on.value ? "on" : "off";
        return <Child class={className} />;
      }
      export { Child };
    `,
      true,
    );
    expect(code).toMatch(/const Child = cc\(/);
    expect(code).toMatch(/const Parent = cc\(/);
  });
});

describe("live rest helper imports", () => {
  it("adds value helpers next to a type-only sinwan/component import", () => {
    const code = compile(`
      import type { SinwanNode } from "sinwan/component";
      export function Nav({ class: className, ...props }: { class?: string; children?: SinwanNode }) {
        return <nav class={className} {...props} />;
      }
    `);
    expect(code).toMatch(/import type \{\s*SinwanNode\s*\} from "sinwan\/component"/);
    expect(code).toMatch(/import \{[^}]*createLiveRest as _\$createLiveRest[^}]*\} from "sinwan\/component"/);
    expect(code).toMatch(/import \{[^}]*getSpreadProps as _\$getSpreadProps[^}]*\} from "sinwan\/component"/);
  });
});
