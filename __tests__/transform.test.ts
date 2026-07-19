import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { transformJSX } from "../src/transform";
import { analyzeProject } from "../src/analyze";

describe("transformJSX", () => {
  it("hoists a fully static element", () => {
    const code = `const Card = () => <div class="card"><p>Hello</p></div>;`;
    const result = transformJSX(code, "test.tsx");

    expect(result.code).toContain("const _$tmpl_0");
    expect(result.code).toContain(
      'html: "<div class=\\"card\\"><p>Hello</p></div>"',
    );
    expect(result.code).toContain("_$createTemplate(_$tmpl_0");
    expect(result.code).toContain(
      'import { _$createTemplate } from "sinwan/renderer"',
    );
  });

  it("handles dynamic children with comment markers", () => {
    const code = `const Card = ({ title }) => <div class="card"><h1>{title}</h1></div>;`;
    const result = transformJSX(code, "test.tsx");

    expect(result.code).toContain("<!--s:0-->");
    expect(result.code).toContain(
      'slots: [{\n    path: [0, 0],\n    type: "child"\n  }]',
    );
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
  });

  it("leaves component calls untouched", () => {
    const code = `const App = () => <Card title="hello" />;`;
    const result = transformJSX(code, "test.tsx");

    // Card is capitalized, so it should NOT be compiled as a template
    expect(result.code).not.toContain("_$createTemplate");
    expect(result.code).toContain("<Card");
  });

  it("preserves code with no JSX", () => {
    const code = `const x = 1 + 2;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toBe("const x = 1 + 2;");
  });

  it("skips hoisting for elements with spread attributes", () => {
    const code = `const Card = (props) => <div {...props}><p>Hello</p></div>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("_$createTemplate");
    expect(result.code).toContain("<div");
    expect(result.code).toContain("{...props}");
  });

  it("skips hoisting for elements with ref", () => {
    const code = `const Input = () => <input ref={(el) => el?.focus()} />;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("_$createTemplate");
    expect(result.code).toContain("<input");
    expect(result.code).toContain("ref=");
  });

  it("ignores whitespace JSXText when computing child paths", () => {
    const code = `const Card = ({ title }) => (
      <div>
        <h1>{title}</h1>
      </div>
    );`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("<!--s:0-->");
    // h1 should be at index 0 (whitespace stripped), not index 1
    expect(result.code).toContain(
      'slots: [{\n    path: [0, 0],\n    type: "child"\n  }]',
    );
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
  });

  it("skips hoisting when a nested child is a component call", () => {
    const code = `const App = () => (
      <div>
        <Card title="hello" />
        <p>static</p>
      </div>
    );`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("_$createTemplate");
    expect(result.code).toContain("<div>");
    expect(result.code).toContain("<Card");
  });

  it("wraps createMutable property reads in JSX children", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ name: "" });
        return <p>Hello, {state.name}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => state.name])",
    );
  });

  it("wraps signal.value reads in JSX children", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const count = signal(0);
        return <p>{count.value}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => count.value])",
    );
  });

  it("wraps useState getter calls in JSX children", () => {
    const code = `
      import { useState } from "sinwan/react";
      const App = () => {
        const [count] = useState(0);
        return <p>{count()}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => count()])",
    );
  });

  it("wraps derived reactive expressions", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ count: 0 });
        return <p>{state.count + 1}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => state.count + 1])",
    );
  });

  it("does not wrap plain identifiers or constants", () => {
    const code = `
      const App = ({ title }) => <p>{title}</p>;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("() => title");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
  });

  it("does not double-wrap event handlers", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ count: 0 });
        return <button onclick={() => state.count++}>click</button>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => state.count++])",
    );
    expect(result.code).not.toContain("() => () => state.count++");
  });

  it("wraps calls to local functions that read reactive state", () => {
    const code = `
      import { useState } from "sinwan/react";
      const App = () => {
        const [tasks] = useState([{ status: "Done" }]);
        const getStats = () => tasks().filter(t => t.status === "Done").length;
        return <strong>{getStats()}</strong>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => getStats()])",
    );
  });

  it("does not wrap calls to local functions with no reactive reads", () => {
    const code = `
      const App = () => {
        const greet = () => "hello";
        return <p>{greet()}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("() => greet()");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [greet()])");
  });

  it("serializes static object styles into the HTML", () => {
    const code = `
      const Box = () => <div style={{ background: "red", width: "100px", padding: 8 }} />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      'html: "<div style=\\"background:red;width:100px;padding:8\\"></div>"',
    );
    expect(result.code).not.toContain('name: "style"');
  });

  it("serializes static string styles into the HTML", () => {
    const code = `
      const Box = () => <div style="background: red; width: 100px;" />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      'html: "<div style=\\"background: red; width: 100px;\\"></div>"',
    );
    expect(result.code).not.toContain('name: "style"');
  });

  it("keeps dynamic object styles as a runtime slot", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const Box = () => {
        const color = signal("red");
        return <div style={{ background: color.value }} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('style=\\"\\"');
    expect(result.code).toContain('name: "style"');
  });

  it("does not serialize reactive template literal styles into the HTML", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const Box = () => {
        const color = signal("red");
        return <div style={\`color:\${color};\`} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('html: "<div style=\\"\\"></div>"');
    expect(result.code).toContain('name: "style"');
    expect(result.code).toContain("slots: [{");
    expect(result.code).not.toContain('html: "<div style=\\"color:');
  });

  it("does not serialize non-reactive template literal styles into the HTML", () => {
    const code = `
      const Box = () => {
        const color = "red";
        return <div style={\`color:\${color};\`} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('html: "<div style=\\"\\"></div>"');
    expect(result.code).toContain('name: "style"');
  });

  it("wraps reactive reads in JSX attributes", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const count = signal(0);
        return <div title={count.value} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => count.value])",
    );
  });

  it("wraps reactive template literal values", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const color = signal("red");
        return <div style={\`color:\${color.value}\`} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => ");
    expect(result.code).toContain("color.value");
  });

  it("wraps nested mutable member expressions", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ user: { name: "" } });
        return <p>{state.user.name}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => state.user.name])",
    );
  });

  it("wraps reactive object style values", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const color = signal("red");
        const width = signal(100);
        return <div style={{ color: color.value, width: width.value + "px" }} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      '_$createTemplate(_$tmpl_0, [() => ({\n    color: color.value,\n    width: width.value + "px"\n  })])',
    );
  });

  it("wraps reactive class object values", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const active = signal(false);
        return <div class={{ active: active.value }} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => ({\n    active: active.value\n  })])",
    );
  });

  it("wraps destructured mutable property values", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ user: { name: "Ada" } });
        const { user } = state;
        const { name } = user;
        return <p>{name}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => name])");
  });

  it("does not wrap reactive reads passed as component props", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ user: { name: "Ada" } });
        const { user } = state;
        return <Child user={user} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("user={user}");
    expect(result.code).not.toContain("user={() => user}");
  });

  it("does not wrap reactive reads passed as component children", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      const App = () => {
        const state = createMutable({ user: { name: "Ada" } });
        const { name } = state.user;
        return <Child>{name}</Child>;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("<Child>{name}</Child>");
    expect(result.code).not.toContain("() => name");
  });

  it("still wraps reactive reads in DOM element attributes", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const count = signal(0);
        return <div title={count.value} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => count.value");
  });

  it("wraps reactive prop reads in component JSX", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc((props) => {
        return <p>{props.user.name}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => props.user.name])",
    );
  });

  it("wraps reactive reads from destructured props", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ user }) => {
        return <p>{user.name}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => user.name])",
    );
  });

  it("wraps reactive signal prop reads", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ count }) => {
        return <p>{count.value}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => count.value])",
    );
  });

  it("does not wrap props passed to nested components", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ user }) => {
        return <GrandChild user={user} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("user={user}");
    expect(result.code).not.toContain("user={() => user}");
  });

  it("wraps prop reads in DOM element attributes", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ count }) => {
        return <div title={count.value} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => count.value");
  });

  it("does not wrap static string props in component JSX", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
      const App = () => <Child title="Hello" />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
    expect(result.code).not.toContain("() => title");
  });

  it("does not wrap static numeric props in component JSX", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ count }) => {
        return <p>{count}</p>;
      });
      const App = () => <Child count={5} />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [count])");
    expect(result.code).not.toContain("() => count");
  });

  it("still wraps reactive signal props passed to components", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
      const App = () => {
        const title = signal("Hello");
        return <Child title={title.value} />;
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });

  it("treats exported component props as reactive when no call sites exist", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });

  it("treats exported component props as reactive even with local static call sites", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
      const App = () => <Child title="Hello" />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
    expect(result.code).not.toContain("_$createTemplate(_$tmpl_0, [title])");
  });

  it("still optimizes non-exported component props with local static call sites", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
      const App = () => <Child title="Hello" />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
    expect(result.code).not.toContain("() => title");
  });

  it("treats default exported cc(...) as reactive", () => {
    const code = `
      import { cc } from "sinwan/component";
      export default cc(({ title }) => {
        return <h1>{title}</h1>;
      });
      const App = () => <Child title="Hello" />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });

  it("treats default export of a component variable as reactive", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
      export default Child;
      const App = () => <Child title="Hello" />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });

  it("tracks reactive children through transitive component calls", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Parent = cc(() => {
        const count = signal(0);
        return <Child>{count.value}</Child>;
      });
      const Child = cc(({ children }) => {
        return <GrandChild>{children}</GrandChild>;
      });
      const GrandChild = cc(({ children }) => {
        return <p>{children}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => children])",
    );
  });

  it("treats exported component children as reactive", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ children }) => {
        return <h1>{children}</h1>;
      });
      const App = () => <Child>Hello</Child>;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => children])",
    );
  });

  it("treats all known props as reactive when an unknown spread is used", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Parent = cc((props) => {
        return <Child {...props} />;
      });
      const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });

  it("tracks reactive props through spread", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Parent = cc(() => {
        const title = signal("Hello");
        return <Child {...{ title: title.value }} />;
      });
      const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });

  it("treats children as reactive when an unknown spread is used", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Parent = cc((props) => {
        return <Child {...props} />;
      });
      const Child = cc(({ children }) => {
        return <h1>{children}</h1>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => children])",
    );
  });

  it("tracks mutable props through transitive component calls", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { createMutable } from "sinwan/store";
      const Parent = cc(() => {
        const state = createMutable({ user: { name: "Ada" } });
        return <Child user={state.user} />;
      });
      const Child = cc(({ user }) => {
        return <GrandChild user={user} />;
      });
      const GrandChild = cc(({ user }) => {
        return <p>{user.name}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => user.name])",
    );
  });

  it("tracks signal props through transitive component calls", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Parent = cc(() => {
        const count = signal(0);
        return <Child count={count} />;
      });
      const Child = cc(({ count }) => {
        return <GrandChild count={count} />;
      });
      const GrandChild = cc(({ count }) => {
        return <p>{count.value}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => count.value])",
    );
  });

  it("does not wrap static props forwarded through transitive component calls", () => {
    const code = `
      import { cc } from "sinwan/component";
      const Parent = cc(() => {
        return <Child title="Hello" />;
      });
      const Child = cc(({ title }) => {
        return <GrandChild title={title} />;
      });
      const GrandChild = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
    expect(result.code).not.toContain("() => title");
  });

  it("terminates with cyclic component references", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const A = cc(({ value }) => {
        return value ? <B value={value} /> : <p>done</p>;
      });
      const B = cc(({ value }) => {
        return <A value={value} />;
      });
      const App = cc(() => {
        const v = signal(1);
        return <A value={v.value} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
  });

  it("emits explicit text binding descriptors when explicitBindings is enabled", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const count = signal(0);
        return <p>{count.value}</p>;
      };
    `;
    const result = transformJSX(code, "test.tsx", { explicitBindings: true });
    expect(result.code).toContain("import { _$createTemplate, _$bindText");
    expect(result.code).toContain("_$bindText(() => count.value)");
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [_$bindText(() => count.value)])",
    );
  });

  it("emits explicit attribute binding descriptors when explicitBindings is enabled", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const count = signal(0);
        return <div title={count.value} />;
      };
    `;
    const result = transformJSX(code, "test.tsx", { explicitBindings: true });
    expect(result.code).toContain("_$bindAttr");
    expect(result.code).toContain('_$bindAttr("title", () => count.value)');
  });

  it("emits explicit style and class binding descriptors when explicitBindings is enabled", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const color = signal("red");
        const active = signal(false);
        return <div style={{ color: color.value }} class={{ active: active.value }} />;
      };
    `;
    const result = transformJSX(code, "test.tsx", { explicitBindings: true });
    expect(result.code).toContain("_$bindStyle");
    expect(result.code).toContain("_$bindClass");
    expect(result.code).toContain("_$bindStyle(() => ({");
    expect(result.code).toContain("_$bindClass(() => ({");
  });

  it("does not wrap non-reactive values in explicit binding descriptors", () => {
    const code = `
      const App = ({ title }) => <p>{title}</p>;
    `;
    const result = transformJSX(code, "test.tsx", { explicitBindings: true });
    expect(result.code).not.toContain("_$bindText(() => title)");
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
  });

  it("warns when a quoted style string contains ${...}", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      const code = 'const Box = () => <div style="color:${color};" />;';
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain('style=\\"color:${color};\\"');
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(
        'JSX string literal style attribute contains "${...}"',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("uses analyze metadata to optimize exported component static props", () => {
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const parentCode = `
      import { Child } from "./Child";
      const Parent = () => <Child title="Hello" />;
    `;
    const project = analyzeProject({
      root: "/project",
      files: {
        "/project/Child.tsx": childCode,
        "/project/Parent.tsx": parentCode,
      },
      resolve: (source, fromFile) => {
        const resolved = path.resolve(path.dirname(fromFile), source);
        if (resolved === "/project/Child") return "/project/Child.tsx";
        return null;
      },
    });
    const metadata: Record<string, Record<string, string[]>> = {};
    for (const [filePath, map] of project.reactiveProps) {
      metadata[filePath] = {};
      for (const [exportName, props] of map) {
        metadata[filePath][exportName] = Array.from(props);
      }
    }
    const metaPath = path.join(process.cwd(), "tmp-reactive-props.json");
    fs.writeFileSync(metaPath, JSON.stringify(metadata));
    try {
      const result = transformJSX(childCode, "/project/Child.tsx", {
        analyze: metaPath,
      });
      expect(result.code).toContain("_$createTemplate(_$tmpl_0, [title])");
      expect(result.code).not.toContain("() => title");
    } finally {
      fs.unlinkSync(metaPath);
    }
  });

  it("falls back to conservative when analyze metadata is missing", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const result = transformJSX(code, "/project/Child.tsx", {
      analyze: "/nonexistent/sinwan-reactive-props.json",
    });
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [() => title])");
  });
});

describe("reactive component prop wrapping", () => {
  describe("built-in components", () => {
    it("wraps For each with reactive useState getter", () => {
      const code = `
        import { useState } from "sinwan/react";
        const App = () => {
          const [count, setCount] = useState(0);
          return <For each={Array.from({ length: count() }, (_, i) => i)}>{(item) => <div>{item}</div>}</For>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("each={() => Array.from");
    });

    it("does NOT wrap For each with static array", () => {
      const code = `
        const App = () => {
          return <For each={[1, 2, 3]}>{(item) => <div>{item}</div>}</For>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).not.toContain("each={() =>");
    });

    it("wraps Show when with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const visible = signal(true);
          return <Show when={visible.value}>content</Show>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("when={() => visible.value");
    });

    it("does NOT wrap Show when with static boolean", () => {
      const code = `
        const App = () => {
          return <Show when={true}>content</Show>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).not.toContain("when={() =>");
    });

    it("wraps Switch when with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const mode = signal("on");
          return <Switch when={mode.value}>content</Switch>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("when={() => mode.value");
    });

    it("wraps Match when with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const active = signal(true);
          return <Match when={active.value}>content</Match>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("when={() => active.value");
    });

    it("wraps Index each with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const items = signal([1, 2, 3]);
          return <Index each={items.value}>{(item) => <div>{item()}</div>}</Index>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("each={() => items.value");
    });

    it("wraps Key when with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const key = signal("abc");
          return <Key when={key.value}>content</Key>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("when={() => key.value");
    });

    it("wraps Dynamic component with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const tag = signal("div");
          return <Dynamic component={tag.value}>content</Dynamic>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("component={() => tag.value");
    });

    it("wraps Visible when with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const show = signal(true);
          return <Visible when={show.value}>content</Visible>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("when={() => show.value");
    });

    it("wraps Portal mount with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const target = signal(document.body);
          return <Portal mount={target.value}>content</Portal>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("mount={() => target.value");
    });

    it("wraps Virtual each with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const items = signal([1, 2, 3]);
          return <Virtual each={items.value} itemHeight={30} containerHeight={300}>{(item) => <div>{item}</div>}</Virtual>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("each={() => items.value");
    });

    it("wraps Activity mode with reactive signal", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const mode = signal("visible");
          return <Activity mode={mode.value}>content</Activity>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("mode={() => mode.value");
    });

    it("does NOT wrap non-reactive prop on built-in (For fallback)", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const items = signal([1, 2, 3]);
          return <For each={items.value} fallback={<div>empty</div>}>{(item) => <div>{item}</div>}</For>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).not.toContain("fallback={() =>");
    });

    it("does NOT wrap Suspense fallback (not in registry)", () => {
      const code = `
        import { signal } from "sinwan/reactivity";
        const App = () => {
          const loading = signal(true);
          return <Suspense fallback={loading.value}>content</Suspense>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).not.toContain("fallback={() =>");
    });
  });

  describe("user cc() components", () => {
    it("wraps reactive prop on user component via call graph analysis", () => {
      const code = `
        import { cc } from "sinwan/component";
        import { useState } from "sinwan/react";

        const Child = cc(({ label }) => {
          return <p>{label}</p>;
        });

        const Parent = () => {
          const [count, setCount] = useState(0);
          return <Child label={count()} />;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("label={() => count()}");
    });

    it("does NOT wrap static prop on user component", () => {
      const code = `
        import { cc } from "sinwan/component";

        const Child = cc(({ label }) => {
          return <p>{label}</p>;
        });

        const Parent = () => {
          return <Child label="hello" />;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).not.toContain("label={() =>");
    });

    it("does NOT wrap non-reactive prop on user component", () => {
      const code = `
        import { cc } from "sinwan/component";
        import { useState } from "sinwan/react";

        const Child = cc(({ label, staticProp }) => {
          return <p>{label}</p>;
        });

        const Parent = () => {
          const [count, setCount] = useState(0);
          return <Child label={count()} staticProp="fixed" />;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("label={() => count()}");
      expect(result.code).not.toContain("staticProp={() =>");
    });

    it("tracks useState from sinwan/react import path", () => {
      const code = `
        import { useState } from "sinwan/react";
        const App = () => {
          const [arr, setArr] = useState<number[]>([]);
          return <div>{arr().length}</div>;
        };
      `;
      const result = transformJSX(code, "test.tsx");
      expect(result.code).toContain("() => arr().length");
    });
  });
});
