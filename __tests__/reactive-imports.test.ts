import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { analyzeProject } from "../src/analyze";
import { collectReactiveImports } from "../src/reactive-wrap";
import { parse } from "../src/ast/parse";
import { transformJSX } from "../src/index";

const dirs: string[] = [];

/** Writes `files` (relative paths) into a fresh temp directory and returns it. */
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(import.meta.dir, "tmp-reactive-imports-"));
  dirs.push(dir);
  for (const [file, code] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, code);
  }
  return dir;
}

function compile(dir: string, file: string, options: Parameters<typeof transformJSX>[2] = {}): string {
  const full = path.join(dir, file);
  return transformJSX(fs.readFileSync(full, "utf-8"), full, options).code;
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const I18N = `
import { createI18n } from "sinwan-i18n";
export const i18n = createI18n({ locales: ["en", "fr"], fallback: "en", load: async () => ({}) });
export const { t, money: formatMoney = undefined } = i18n;
export const tr = i18n.t;
export const intl = i18n;
`;

describe("reactive imports: createI18n", () => {
  const dir = project({
    "lib/i18n.ts": I18N,
    "Demo.tsx": `
      import { cc } from "sinwan/component";
      import { Show } from "sinwan/control-flow";
      import { i18n, t, tr, intl, formatMoney } from "./lib/i18n";
      const Child = cc((props: { label: string }) => <b>{props.label}</b>);
      export const Demo = cc(() => {
        const label = (k: string) => i18n.t(k);
        return (
          <div title={i18n.t("attr")}>
            <h1>{i18n.t("child")}</h1>
            <Child label={t("prop", { count: 2 })} />
            <Show when={i18n.loading.value}><i>{tr("show")}</i></Show>
            <p>{label("helper")}{intl.n(5)}{formatMoney(1, "MAD")}{i18n.locale.value}</p>
            <p>{i18n.locales.length}</p>
            <ul>{["a"].map((t) => <li onclick={() => i18n.t("click")}>{t}</li>)}</ul>
          </div>
        );
      });
    `,
  });
  const code = compile(dir, "Demo.tsx");

  it("wraps member calls on the instance in children and attributes", () => {
    expect(code).toContain('() => i18n.t("attr")');
    expect(code).toContain('() => i18n.t("child")');
    expect(code).toContain("() => intl.n(5)");
  });

  it("wraps functions taken from the instance, with arguments, in props and control flow", () => {
    expect(code).toContain('label={() => t("prop", { count: 2 })}');
    expect(code).toContain('() => tr("show")');
    expect(code).toContain('() => formatMoney(1, "MAD")');
  });

  it("makes a local helper that calls the instance a getter", () => {
    expect(code).toContain('() => label("helper")');
  });

  it("keeps .value reads reactive and plain fields static", () => {
    expect(code).toContain("() => i18n.locale.value");
    expect(code).toContain("i18n.locales.length,");
    expect(code).not.toContain("() => i18n.locales.length");
  });

  it("leaves shadowing parameters and event handlers alone", () => {
    expect(code).toMatch(/_\$tmpl_\d+, \[\(\) => i18n\.t\("click"\), t\]/);
  });
});

describe("reactive imports: re-exports, defaults and namespaces", () => {
  const dir = project({
    "lib/i18n.ts": I18N,
    "lib/index.ts": `export * from "./i18n";\nexport { i18n as translator } from "./i18n";\nexport * as all from "./i18n";\nexport * from "./missing";`,
    "lib/default-id.ts": `import { createI18n } from "sinwan-i18n";\nconst made = createI18n({} as never);\nexport default made;\nexport { made };`,
    "lib/default-call.ts": `import { createI18n as make } from "sinwan-i18n";\nexport default make({} as never);`,
    "lib/default-fn.ts": `/** @sinwan-reactive */\nexport default function useLabel(key: string) { return key; }`,
    "lib/default-object.ts": `/** @sinwan-reactive */\nexport default { isOnline: (id: string) => id !== "" };`,
    "lib/default-plain.ts": `export default function plain(x: string) { return x; }`,
    "Demo.tsx": `
      import { cc } from "sinwan/component";
      import { i18n, translator, all } from "./lib";
      import * as ns from "./lib/i18n";
      import made, { made as named } from "./lib/default-id";
      import call from "./lib/default-call";
      import useLabel from "./lib/default-fn";
      import presence from "./lib/default-object";
      import plain from "./lib/default-plain";
      import * as nothing from "./lib/default-plain";
      export const Demo = cc(() => (
        <p>{i18n.t("a")}{translator.t("b")}{all.i18n.t("c")}{ns.t("d")}{made.t("e")}{named.t("f")}{call.t("g")}{useLabel("h")}{presence.isOnline("i")}{plain("j")}{nothing.default("k")}</p>
      ));
    `,
  });
  const code = compile(dir, "Demo.tsx");

  it("follows export *, renamed re-exports and export * as", () => {
    expect(code).toContain('() => i18n.t("a")');
    expect(code).toContain('() => translator.t("b")');
    expect(code).toContain('() => all.i18n.t("c")');
  });

  it("treats a namespace import with a reactive export as a reactive object", () => {
    expect(code).toContain('() => ns.t("d")');
    expect(code).not.toContain('() => nothing.default("k")');
  });

  it("reads default exports: an instance, a factory call, and annotated values", () => {
    expect(code).toContain('() => made.t("e")');
    expect(code).toContain('() => named.t("f")');
    expect(code).toContain('() => call.t("g")');
    expect(code).toContain('() => useLabel("h")');
    expect(code).toContain('() => presence.isOnline("i")');
    expect(code).not.toContain('() => plain("j")');
  });
});

describe("reactive imports: @sinwan-reactive", () => {
  const dir = project({
    "lib/stores.ts": `
      /** @sinwan-reactive */
      export const presence = { isOnline: (id: string) => id !== "" };
      /** @sinwan-reactive */
      export const label = (key: string) => key;
      /** @sinwan-reactive */
      export function fullName(id: string) { return id; }
      /** @sinwan-reactive */
      export class Clock { static now(zone: string) { return zone; } }
      export const helpers = { format: (x: string) => x };
      export function formatDay(x: string) { return x; }
    `,
    "Demo.tsx": `
      import { cc } from "sinwan/component";
      import type { Clock as ClockType } from "./lib/stores";
      import { presence, label, fullName, Clock, helpers, formatDay } from "./lib/stores";
      import { gone } from "./lib/missing";
      /** @sinwan-reactive */
      const local = { read: (k: string) => k };
      /** @sinwan-reactive */
      function localFn(k: string) { return k; }
      export const Demo = cc((props: { id: string }) => (
        <p>
          {presence.isOnline("a")}{label("b")}{fullName("c")}{Clock.now("UTC")}
          {local.read("d")}{localFn("e")}
          {helpers.format("x")}{formatDay("y")}{gone("z")}
        </p>
      ));
    `,
  });
  const code = compile(dir, "Demo.tsx");

  it("wraps annotated objects, functions and classes, imported or same-file", () => {
    expect(code).toContain('() => presence.isOnline("a")');
    expect(code).toContain('() => label("b")');
    expect(code).toContain('() => fullName("c")');
    expect(code).toContain('() => Clock.now("UTC")');
    expect(code).toContain('() => local.read("d")');
    expect(code).toContain('() => localFn("e")');
  });

  it("leaves unannotated helpers and unresolved imports eager", () => {
    expect(code).not.toContain('() => helpers.format("x")');
    expect(code).not.toContain('() => formatDay("y")');
    expect(code).not.toContain('() => gone("z")');
  });
});

describe("reactive imports: same file and edge cases", () => {
  it("detects a module-level createI18n and its functions in the compiled file", () => {
    const dir = project({
      "Demo.tsx": `
        import { cc } from "sinwan/component";
        import { createI18n } from "sinwan-i18n";
        const i18n = createI18n({} as never);
        const { t } = i18n;
        export { i18n };
        export const Demo = cc(() => <p>{i18n.t("a")}{t("b")}</p>);
      `,
    });
    const code = compile(dir, "Demo.tsx");
    expect(code).toContain('() => i18n.t("a")');
    expect(code).toContain('() => t("b")');
  });

  it("works without a filename for same-file values", () => {
    const code = transformJSX(
      `import { cc } from "sinwan/component";
       import { createI18n } from "sinwan-i18n";
       import { other } from "./other";
       const i18n = createI18n({} as never);
       export const Demo = cc(() => <p>{i18n.t("a")}{other.t("b")}</p>);`,
      "",
    ).code;
    expect(code).toContain('() => i18n.t("a")');
    expect(code).not.toContain('() => other.t("b")');
  });

  it("survives import cycles, unparsable modules and long re-export chains", () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 13; i++) chain[`chain/c${i}.ts`] = `export * from "./c${i + 1}";`;
    chain["chain/c13.ts"] = `/** @sinwan-reactive */\nexport const deep = { read: (k: string) => k };`;
    const dir = project({
      ...chain,
      "a.ts": `import { b } from "./b";\nexport const a = b;\n/** @sinwan-reactive */\nexport const seed = { read: (k: string) => k };`,
      "b.ts": `import { a, seed } from "./a";\nexport const b = a;\nexport const fromSeed = seed;`,
      "broken.ts": "export const = ;",
      "Demo.tsx": `
        import { cc } from "sinwan/component";
        import { fromSeed } from "./b";
        import { broken } from "./broken";
        import { deep } from "./chain/c0";
        export const Demo = cc(() => <p>{fromSeed.read("a")}{broken.read("b")}{deep.read("c")}</p>);
      `,
    });
    const code = compile(dir, "Demo.tsx");
    expect(code).toContain('() => fromSeed.read("a")');
    expect(code).not.toContain('() => broken.read("b")');
    expect(code).not.toContain('() => deep.read("c")');
  });

  it("sees a changed module on the next compile", () => {
    const dir = project({
      "lib/store.ts": `export const store = { read: (k: string) => k };`,
      "Demo.tsx": `
        import { cc } from "sinwan/component";
        import { store } from "./lib/store";
        export const Demo = cc(() => <p>{store.read("a")}</p>);
      `,
    });
    expect(compile(dir, "Demo.tsx")).not.toContain('() => store.read("a")');
    const file = path.join(dir, "lib/store.ts");
    fs.writeFileSync(file, `/** @sinwan-reactive */\nexport const store = { read: (k: string) => k };`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(compile(dir, "Demo.tsx")).toContain('() => store.read("a")');
  });

  it("collects each compiled file once", () => {
    const ast = parse(`import { createI18n } from "sinwan-i18n";\nconst i18n = createI18n({} as never);`, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    const first = collectReactiveImports(ast, undefined, undefined);
    expect(first.objects).toEqual(new Set(["i18n"]));
    expect(collectReactiveImports(ast, undefined, undefined)).toBe(first);
  });
});

describe("reactive imports: derived locals", () => {
  const dir = project({
    "lib/i18n.ts": I18N,
    "Demo.tsx": `
      import { cc } from "sinwan/component";
      import { i18n } from "./lib/i18n";
      export const Demo = cc(() => {
        const title = i18n.t("title");
        return <h1>{title}</h1>;
      });
    `,
  });

  it("warns in dev that a const snapshots the translation when derivedLocals is off", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      compile(dir, "Demo.tsx", { dev: true, derivedLocals: false });
      expect(warn.mock.calls.some(([message]) => String(message).includes('derived local "title"'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("promotes the const to a getter with derivedLocals", () => {
    const code = compile(dir, "Demo.tsx", { derivedLocals: true });
    expect(code).toContain('const title = () => i18n.t("title")');
    expect(code).toContain("() => title()");
  });
});

describe("reactive imports: analyzer", () => {
  it("marks a prop reactive when the parent passes a translation", () => {
    const dir = project({
      "lib/i18n.ts": I18N,
      "Child.tsx": `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title }) => <h1>{title}</h1>);
      `,
      "Parent.tsx": `
        import { cc } from "sinwan/component";
        import { Child } from "./Child";
        import { t } from "./lib/i18n";
        export const Parent = cc(() => <Child title={t("hello")} />);
      `,
    });
    const analysis = analyzeProject({ root: dir });
    expect(analysis.reactiveProps.get(path.join(dir, "Child.tsx"))?.get("Child")).toEqual(new Set(["title"]));
  });
});
