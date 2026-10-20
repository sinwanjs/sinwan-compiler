import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { jsxAttrName, transformJSX } from "../src/transform";

function compile(code: string, filename = "App.tsx", derivedLocals = false) {
  return transformJSX(code, filename, { derivedLocals, hoist: true }).code;
}

describe("1.0.0 review regressions", () => {
  it("prints JSX comments as comments", () => {
    const hoisted = compile(
      `const View = () => <div>{/* note */}<span>hi</span></div>;`,
    );
    expect(hoisted).toContain("<!-- note -->");
    const open = compile(`
      import { signal } from "sinwan/reactivity";
      const View = (props) => {
        const open = signal(true);
        return <section>{open.value ? <span>{/* note */}hi</span> : null}</section>;
      };
    `);
    expect(open).toContain("<!-- note -->");
  });

  it("does not treat a trailing inner comment as the next export's pure annotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "sinwan-pure-"));
    const file = join(dir, "helpers.ts");
    writeFileSync(
      file,
      `export const helpers = {\n  merge() { return 1; }\n  /** @sinwan-pure */\n};\nexport function cn(...inputs: unknown[]) { return String(inputs); }\n`,
    );
    const code = compile(
      `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      import { cn } from ${JSON.stringify(file)};
      export const App = cc(() => {
        const count = signal(0);
        const label = cn(count.value);
        return <span>{label}</span>;
      });
    `,
      "App.tsx",
      true,
    );
    expect(code).not.toContain("() => cn(");
  });

  it("does not throw on import.meta when promoting derived locals", () => {
    const code = compile(
      `
      import { cc } from "sinwan/component";
      export const App = cc(() => {
        const meta = import.meta;
        return <span>{meta.url}</span>;
      });
    `,
      "App.tsx",
      true,
    );
    expect(code).toContain("import.meta");
  });

  it("does not call a for-of binding", () => {
    const code = compile(
      `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const items = signal([1]);
        let text = "";
        for (const item of items.value) text += String(item);
        return <span>{text}</span>;
      });
    `,
      "App.tsx",
      true,
    );
    expect(code).not.toContain("item()");
  });

  it("does not call a function expression's own name", () => {
    const code = compile(
      `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const value = signal(1);
        const f = function value() { return value; };
        return <span>{value.value}{f()}</span>;
      });
    `,
      "App.tsx",
      true,
    );
    expect(code).toContain("return value;");
    expect(code).not.toContain("return value()");
  });

  it("does not rewrite a class method key", () => {
    const code = compile(
      `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const value = signal(1);
        class Box { value() { return 1; } }
        return <span>{value.value}</span>;
      });
    `,
      "App.tsx",
      true,
    );
    expect(code).toContain("value()");
    expect(code).not.toContain("value()()");
  });

  it("unwraps optional prop member chains", () => {
    const code = compile(`
      import { cc } from "sinwan/component";
      export const App = cc((props) => <span>{props.user?.name}</span>);
    `);
    expect(code).toContain("_$unwrap(props).user?.name");
  });

  it("keeps a leading fragment sibling in order", () => {
    const code = compile(`
      const View = (name) => <div><>{name}</>tail</div>;
    `);
    expect(code).toContain("tail");
    expect(code).toContain("<!--s:");
    expect(code).not.toMatch(/html: "<div>tail<\/div>"/);
  });

  it("hoists a native element inside a fragment expression", () => {
    const code = compile(`
      const View = (row) => <>{row && <span class="cell">{row.id}</span>}</>;
    `);
    expect(code).toContain("_$createTemplate");
    expect(code).toContain('class=\\"cell\\"');
  });

  it("keeps namespaced attributes in hoisted HTML", () => {
    const code = compile(`
      const View = () => <svg><use xlink:href="#i" /></svg>;
    `);
    expect(code).toContain("xlink:href");
  });

  it("unwraps a parenthesized prop member", () => {
    const code = compile(`
      import { cc } from "sinwan/component";
      export const App = cc((props) => <span>{(props.user).name}</span>);
    `);
    expect(code).toContain("_$unwrap(props)");
  });

  it("reuses a helper when the renderer import has other names", () => {
    const code = compile(`
      import { _$bindText, _$createTemplate } from "sinwan/renderer";
      const View = () => <div class="card">Hi</div>;
    `);
    expect(code.match(/_\$createTemplate/g)?.length).toBeGreaterThan(0);
    expect(code.match(/from "sinwan\/renderer\/web"/g) ?? []).toHaveLength(0);
  });

  it("auto-wraps a parenthesized component export", () => {
    const code = compile(`export const Foo = (() => <div />);`);
    expect(code).toContain("cc(");
    expect(code).toContain("Foo");
  });

  it("does not double-wrap a parenthesized cc call", () => {
    const code = compile(`
      import { cc } from "sinwan/component";
      export const Foo = (cc(() => <div />));
    `);
    expect(code.match(/cc\(/g)?.length).toBe(1);
  });

  it("rewrites a parenthesized live destructure", () => {
    const code = compile(`
      import { cc } from "sinwan/component";
      export const Foo = cc((({ value }) => <span>{value}</span>));
    `);
    expect(code).toContain("props.value");
  });

  it("promotes an optional call through a pure member", () => {
    const dir = mkdtempSync(join(tmpdir(), "sinwan-opt-"));
    const helpers = join(dir, "helpers.ts");
    const app = join(dir, "App.tsx");
    writeFileSync(
      helpers,
      "/** @sinwan-pure */\nexport class Helpers { static merge(x: unknown) { return x; } }\n",
    );
    writeFileSync(
      app,
      `import { cc } from "sinwan/component";
import { signal } from "sinwan/reactivity";
import { Helpers } from "./helpers";
export const App = cc(() => {
  const count = signal(0);
  const label = (Helpers?.merge)(count.value);
  return <span>{label}</span>;
});
`,
    );
    const code = transformJSX(readFileSync(app, "utf8"), app, {
      derivedLocals: true,
    }).code;
    expect(code).toContain("Helpers?.merge");
    expect(code).toContain("() =>");
  });

  it("ignores a renderer namespace import when adding hoist helpers", () => {
    const code = compile(`
      import * as renderer from "sinwan/renderer";
      const View = () => <div class="card">{renderer}</div>;
    `);
    expect(code).toContain('from "sinwan/renderer/web"');
    expect(
      jsxAttrName({
        type: "JSXAttribute",
        name: { type: "Oops" },
      } as never),
    ).toBeUndefined();
  });

  it("parses JSX in a .ts filename", () => {
    const code = compile(`export const Foo = () => <div />;`, "Foo.ts");
    expect(code).toContain("cc(");
  });
});
