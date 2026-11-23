import { describe, expect, it, spyOn } from "bun:test";
import { transformJSX, wrapReactiveExpressions } from "../src/index";
import { parse } from "../src/ast";
import {
  createReporter,
  formatDiagnostic,
  type SinwanDiagnostic,
} from "../src/diagnostics";
import { isCallbackPropName } from "../src/lint-jsx";

function diagnose(
  code: string,
  options: { dev?: boolean; derivedLocals?: boolean } = { dev: true },
): SinwanDiagnostic[] {
  const found: SinwanDiagnostic[] = [];
  transformJSX(code, "app.tsx", {
    ...options,
    onDiagnostic: (diagnostic) => found.push(diagnostic),
  });
  return found;
}

function codes(code: string): string[] {
  return diagnose(code).map((diagnostic) => diagnostic.code);
}

const header = `import { cc, Show, Match, Key, For } from "sinwan";
import { Gate, Select } from "./ui";
`;

describe("SW101 zero-argument function props", () => {
  it("reports the arrow with its line and column", () => {
    const found = diagnose(`${header}export const App = cc(() => (
  <Gate content={() => <p />} />
));`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: "SW101",
      file: "app.tsx",
      line: 4,
      column: 18,
    });
    expect(found[0]!.message).toContain("<Gate content={() => …}>");
  });

  it("counts UTF-16 columns after non-ASCII text", () => {
    const found = diagnose(`${header}const note = "é—ü";
export const App = cc(() => <Gate label="ü" action={() => save()} />);`);
    expect(found[0]).toMatchObject({ code: "SW101", line: 4, column: 53 });
  });

  it("reports async arrows, function expressions and member tags", () => {
    expect(
      codes(`${header}export const App = cc(() => <div>
  <Gate action={async () => save()} />
  <Gate render={function () { return 1; }} />
</div>);`),
    ).toEqual(["SW101", "SW101"]);
    const member = diagnose(`${header}export const App = cc(() => <UI.Card render={() => 1} />);`);
    expect(member[0]!.message).toContain("<UI.Card render=");
  });

  it("ignores callbacks, parameters, intrinsic elements and built-ins", () => {
    expect(
      codes(`${header}export const App = cc(() => <div title={() => 1}>
  <Gate onSelect={() => pick()} onclick={() => go()} />
  <Gate getRowId={(row) => row.id} children={() => 1} ref={() => 1} />
  <Gate title={count.value} spread {...rest} />
  <Foo:bar render={() => 1} />
  <Show when={() => ready.value} fallback={() => <p />}>x</Show>
</div>);`),
    ).toEqual([]);
  });

  it("treats a local component named Show as a component", () => {
    expect(
      codes(`import { cc } from "sinwan";
const Show = cc(() => null);
export const App = cc(() => <Show when={() => 1} />);`),
    ).toEqual(["SW101"]);
  });

  it("runs only in dev", () => {
    expect(
      diagnose(`${header}export const App = cc(() => <Gate content={() => 1} />);`, {}),
    ).toEqual([]);
  });
});

describe("SW102 fresh objects in when", () => {
  it("reports object, array, new, conditional and logical forms", () => {
    expect(
      codes(`${header}export const App = cc(() => <div>
  <Show when={a.value ? { ...a.value } : null}>x</Show>
  <Show when={a.value && [a.value]}>x</Show>
  <Key when={new Date()}>x</Key>
  <Match when={({ id: 1 } as Item)}>x</Match>
  <Show when={a.value ? null : { b: 1 }}>x</Show>
</div>);`),
    ).toEqual(["SW102", "SW102", "SW102", "SW102", "SW102"]);
  });

  it("follows import aliases from sinwan/control-flow", () => {
    expect(
      codes(`import { cc } from "sinwan";
import { Show as When } from "sinwan/control-flow";
export const App = cc(() => <When when={{ a: 1 }}>x</When>);`),
    ).toEqual(["SW102"]);
  });

  it("ignores stable values and non-identity props", () => {
    expect(
      codes(`${header}import Default, * as all from "sinwan";
import { "Show" as Quoted } from "sinwan/control-flow";
import { other } from "elsewhere";
export const App = cc(() => <div>
  <Show when={user.value}>x</Show>
  <Show when={!!user.value} fallback={{}}>x</Show>
  <Quoted when={user.value}>x</Quoted>
  <For each={[1, 2]}>{(n) => n}</For>
</div>);`),
    ).toEqual([]);
  });
});

describe("SW103 undefined controlled props", () => {
  it("reports value, checked and open set to undefined", () => {
    expect(
      codes(`${header}export const App = cc(() => <div>
  <Select value={undefined} />
  <Gate checked={void 0} />
  <Gate open={undefined as never} />
</div>);`),
    ).toEqual(["SW103", "SW103", "SW103"]);
  });

  it("ignores defined values, other props and intrinsic elements", () => {
    expect(
      codes(`${header}export const App = cc(() => <div>
  <Select value={choice.value} label={undefined} />
  <Gate checked={void check()} />
  <input value={undefined} />
</div>);`),
    ).toEqual([]);
  });
});

describe("sinwan-ignore comments", () => {
  it("silences one code on the same line or the line above", () => {
    expect(
      codes(`${header}export const App = cc(() => <div>
  <Gate content={/* sinwan-ignore SW101 */ () => 1} />
  <Gate
    // sinwan-ignore SW101
    content={() => 1}
  />
  <Gate content={() => 1} /* sinwan-ignore */ />
</div>);`),
    ).toEqual([]);
  });

  it("keeps other codes", () => {
    expect(
      codes(`${header}export const App = cc(() => (
  <Gate content={/* sinwan-ignore SW103 */ () => 1} />
));`),
    ).toEqual(["SW101"]);
  });
});

describe("existing warnings", () => {
  it("reports derived-local snapshots and setup ifs with codes", () => {
    const input = `import { cc } from "sinwan/component";
export const App = cc(() => {
  const value = source.value;
  const open = value > 0;
  if (open) consume(value);
  return <div>{open}</div>;
});`;
    expect(diagnose(input)).toMatchObject([
      { code: "SW110", line: 4, column: 9 },
    ]);
    expect(diagnose(input, { dev: true, derivedLocals: true })).toMatchObject([
      { code: "SW111", line: 5, column: 7 },
    ]);
  });

  it("reports skipped hoisting and style interpolation", () => {
    expect(
      codes(`const Card = (props) => <div {...props}><p>Hello</p></div>;
const Box = () => <div style="color:\${c}" />;`),
    ).toEqual(["SW112", "SW113"]);
  });

  it("prints with console.warn when no handler is given", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      transformJSX(`${header}export const App = cc(() => <Gate a={() => 1} />);`, "app.tsx", {
        dev: true,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toStartWith(
        "[Sinwan] app.tsx:3:38 SW101:",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to console.warn when the wrap pass runs alone", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ast = parse(`import { cc } from "sinwan/component";
export const App = cc(() => {
  const open = source.value > 0;
  return <div>{open}</div>;
});`, { sourceFilename: "alone.tsx" });
      wrapReactiveExpressions(ast, { dev: true });
      expect(String(warn.mock.calls[0]?.[0])).toContain("<module>:1:");
      expect(String(warn.mock.calls[0]?.[0])).toContain("SW110");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("diagnostic helpers", () => {
  it("formats the location, code, message and hint", () => {
    expect(
      formatDiagnostic({
        code: "SW101",
        message: "message",
        hint: "hint",
        file: "a.tsx",
        line: 2,
        column: 5,
      }),
    ).toBe("[Sinwan] a.tsx:2:5 SW101: message\n  hint");
  });

  it("reports a missing offset at the start of the file", () => {
    const found: SinwanDiagnostic[] = [];
    createReporter("x\ny", "a.tsx", (d) => found.push(d))(
      "SW112",
      undefined,
      "m",
      "h",
    );
    expect(found[0]).toMatchObject({ line: 1, column: 1 });
  });

  it("matches the runtime callback-prop rule", () => {
    expect(isCallbackPropName("onSelect")).toBe(true);
    expect(isCallbackPropName("onclick")).toBe(true);
    expect(isCallbackPropName("onkeydown")).toBe(true);
    expect(isCallbackPropName("open")).toBe(false);
    expect(isCallbackPropName("on")).toBe(false);
    expect(isCallbackPropName("online")).toBe(false);
  });
});

const listHeader = `import { cc, For, Index, Dynamic } from "sinwan";
import { Virtual } from "sinwan/control-flow";
import { Row } from "./row";
`;

function listCodes(code: string): string[] {
  return codes(listHeader + code);
}

describe("SW104 Index item getters", () => {
  it("reports property reads, operands, templates and truthiness tests", () => {
    expect(
      listCodes(`export const A = cc(() => <div>
  <Index each={rows}>{(item) => <p>{item.name}</p>}</Index>
  <Index each={rows}>{(item) => <p>{item + 1}</p>}</Index>
  <Index each={rows}>{(item) => <p>{\`#\${item}\`}</p>}</Index>
  <Index each={rows}>{(item) => <p>{item && "x"}</p>}</Index>
  <Index each={rows}>{(item) => <p>{!item}</p>}</Index>
  <Index each={rows}>{({ name }) => <p>{name}</p>}</Index>
  <Index each={rows}>{function (item) { return <p>{item.id}</p>; }}</Index>
</div>);`),
    ).toEqual(["SW104", "SW104", "SW104", "SW104", "SW104", "SW104", "SW104"]);
  });

  it("points at the misuse and names the getter", () => {
    const found = diagnose(`${listHeader}export const A = cc(() => (
  <Index each={rows}>{(row) => <p>{row.name}</p>}</Index>
));`);
    expect(found[0]).toMatchObject({ code: "SW104", line: 5, column: 36 });
    expect(found[0]!.message).toContain("this uses row itself");
    expect(found[0]!.hint).toContain("row()");
  });

  it("accepts calls, plain uses, typeof, shadowing and For values", () => {
    expect(
      listCodes(`export const A = cc(() => <div>
  <Index each={rows}>{(item) => <p>{item().name}{item}<Row get={item} /></p>}</Index>
  <Index each={rows}>{(item) => <p>{typeof item}{[1].map((item) => item.x)}</p>}</Index>
  <Index each={rows}>{(item) => { function f(item) { return item.x; } return <p>{f(1)}</p>; }}</Index>
  <Index each={rows}>{() => <p>none</p>}</Index>
  <Index each={rows}>{(item = fallback) => <p>{item}</p>}</Index>
  <Index each={rows}>{render}</Index>
  <For each={rows}>{(item) => <p>{item.name}</p>}</For>
</div>);`),
    ).toEqual([]);
  });
});

describe("SW105 list children that are not render functions", () => {
  it("reports JSX, text and string children of For, Index and Virtual", () => {
    expect(
      listCodes(`export const A = cc(() => <div>
  <For each={rows}><Row /></For>
  <Index each={rows}>{<Row />}</Index>
  <Virtual each={rows} itemHeight={20} containerHeight={200}>row</Virtual>
  <For each={rows}>{"row"}</For>
  <For each={rows}>{\`row\`}</For>
  <For each={rows}><>x</></For>
</div>);`),
    ).toEqual(["SW105", "SW105", "SW105", "SW105", "SW105", "SW105"]);
  });

  it("accepts render functions, references and whitespace", () => {
    expect(
      listCodes(`export const A = cc(() => <div>
  <For each={rows}>
    {(item) => <Row item={item} />}
  </For>
  <For each={rows}>{renderRow}</For>
  <For each={rows}>{/* empty */}</For>
  <Row><b>not a list</b></Row>
</div>);`),
    ).toEqual([]);
  });
});

describe("SW106 inline zero-argument Dynamic components", () => {
  it("reports a zero-argument arrow or function", () => {
    expect(
      listCodes(`export const A = cc(() => <div>
  <Dynamic component={() => <b />} />
  <Dynamic component={function () { return <b />; }} />
</div>);`),
    ).toEqual(["SW106", "SW106"]);
  });

  it("accepts components, props parameters and other props", () => {
    expect(
      listCodes(`export const A = cc(() => <div>
  <Dynamic component={Row} />
  <Dynamic component={(props) => <b title={props.t} />} />
  <Dynamic component={pick.value ? Row : "span"} title={() => 1} />
</div>);`),
    ).toEqual([]);
  });
});
