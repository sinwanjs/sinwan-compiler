// Transform behaviours without a test before: props from an inline spread
// object (string and numeric keys), static style objects inlined into the
// template, a resolver that throws, and pure functions re-exported under a
// string name (`export { f as "name" }`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { transformJSX } from "../src/index";

const childCall = (code: string) => /\[[^\]]*format[^\]]*\]/.exec(code)?.[0];

describe("inline spread objects", () => {
  const parent = (value: string) =>
    transformJSX(
      `import { cc } from "sinwan/component";
import { signal } from "sinwan/reactivity";
const Child = cc((props: { label: string }) => <h1>{format(props.label)}</h1>);
function format(v: string) { return v; }
export const Parent = cc(() => { const title = signal("a"); return <Child {...{ "label": ${value}, 1: "one" }} />; });`,
      "/app/Parent.tsx",
    ).code;

  test("a string key passed a reactive value makes the child prop reactive", () => {
    expect(childCall(parent("title.value"))).toBe("[() => format(_$unwrap(props).label)]");
  });

  test("a static value (and a numeric key) leaves the child prop static", () => {
    expect(childCall(parent('"fixed"'))).toBe("[format(props.label)]");
  });
});

describe("static style objects", () => {
  test("are inlined with kebab-case keys; null and false are dropped, true is kept", () => {
    const code = transformJSX(
      `export const A = () => <div style={{ "font-size": "12px", hidden: true, opacity: null, zIndex: false, lineHeight: 2 }} />;`,
      "/app/A.tsx",
    ).code;
    expect(code).toContain('<div style=\\"font-size:12px;hidden:true;line-height:2\\"></div>');
  });
});

describe("import resolution", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-reexport-"));
    fs.writeFileSync(path.join(dir, "fmt.ts"), `/** @sinwan-pure */\nexport function fmt(v: unknown) { return String(v); }\n`);
    fs.writeFileSync(path.join(dir, "barrel.ts"), `export { fmt as "fmtAlias" } from "./fmt";\nexport { fmt as plainAlias } from "./fmt";\n`);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolveImport = (source: string, from: string) => {
    const base = path.resolve(path.dirname(from), source);
    return fs.existsSync(`${base}.ts`) ? `${base}.ts` : null;
  };
  const component = (importLine: string, local: string) =>
    `${importLine}\nexport const A = (props: { x: string }) => <p>{${local}(props.x)}</p>;`;
  // A `@sinwan-pure` function only depends on its arguments, so a derived
  // local calling it becomes a getter; an unknown import stays a snapshot.
  const derived = (importLine: string) =>
    transformJSX(
      `import { cc } from "sinwan/component";\nimport { signal } from "sinwan/reactivity";\n${importLine}\nexport const App = cc(() => { const count = signal(0); const label = fmt(count.value); return <span>{label}</span>; });`,
      path.join(dir, "App.tsx"),
      { resolveImport, derivedLocals: true },
    ).code.includes("() => fmt(");

  test("pure functions re-exported under a string or identifier name stay pure", () => {
    expect(derived(`import { fmt } from "./fmt";`)).toBe(true);
    expect(derived(`import { "fmtAlias" as fmt } from "./barrel";`)).toBe(true);
    expect(derived(`import { plainAlias as fmt } from "./barrel";`)).toBe(true);
    expect(derived(`import { fmt } from "./nowhere";`)).toBe(false);
  });

  test("a resolver that throws is treated as unresolved", () => {
    const throwing = () => {
      throw new Error("resolver down");
    };
    const code = component(`import { fmt } from "./fmt";`, "fmt");
    const unresolved = transformJSX(code, path.join(dir, "A.tsx"), { resolveImport: () => null }).code;
    expect(transformJSX(code, path.join(dir, "A.tsx"), { resolveImport: throwing }).code).toBe(unresolved);
  });
});
