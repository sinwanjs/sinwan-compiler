import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { COMPILER_TEMPLATE_SLOT_PROTOCOL, transformJSX } from "../src/transform";
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

  it("hoists elements with ref into template with ref slot", () => {
    const code = `const Input = () => <input ref={(el) => el?.focus()} />;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
    // The ref expression should be passed as a dynamic
    expect(result.code).toContain("focus");
    // The template should have a ref slot
    expect(result.code).toContain('type: "ref"');
  });

  it("hoists elements with object ref into template with ref slot", () => {
    const code = `const Input = () => { const r = { current: null }; return <input ref={r} />; };`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
    expect(result.code).toContain('type: "ref"');
  });

  it("hoists elements with ref + dynamic attr into template with both slot types", () => {
    const code = `const Input = ({ placeholder }) => <input ref={(el) => el?.focus()} placeholder={placeholder} />;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
    expect(result.code).toContain('type: "ref"');
    expect(result.code).toContain('type: "attr"');
  });

  it("hoists elements with ref + event handler into template with both slot types", () => {
    const code = `const Input = () => <input ref={(el) => el?.focus()} onclick={() => console.log("click")} />;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
    expect(result.code).toContain('type: "ref"');
    expect(result.code).toContain('type: "event"');
  });

  it("hoists nested elements with ref with correct path", () => {
    const code = `const Form = () => <form><input ref={(el) => el?.focus()} /></form>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
    expect(result.code).toContain('type: "ref"');
    // The input is at child index 0 of the form (root)
    expect(result.code).toContain("path: [0]");
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

  it("hoists the static shell with a component child slot", () => {
    const code = `const App = () => (
      <div>
        <Card title="hello" />
        <p>static</p>
      </div>
    );`;
    const result = transformJSX(code, "test.tsx");
    // The static <div> shell and <p> are hoisted; <Card> becomes a child slot.
    expect(result.code).toContain("const _$tmpl_0");
    expect(result.code).toContain("<!--s:0-->");
    expect(result.code).toContain('html: "<div><!--s:0--><p>static</p></div>"');
    expect(result.code).toContain(
      'slots: [{\n    path: [0],\n    type: "child"\n  }]',
    );
    expect(result.code).toContain(
      '_$createTemplate(_$tmpl_0, [<Card title="hello" />])',
    );
  });

  it("hoists mixed tree with a reactive prop on the component child", () => {
    const code = `
      import { createMutable } from "sinwan/store";
      import { cc } from "sinwan/component";
      const Card = cc(({ title }) => <p>{title}</p>);
      const App = () => {
        const state = createMutable({ name: "x" });
        return (
          <div>
            <Card title={state.name} />
            <p>static</p>
          </div>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    // Static shell is hoisted; the reactive prop read stays wrapped.
    expect(result.code).toContain("<!--s:0-->");
    expect(result.code).toContain('html: "<div><!--s:0--><p>static</p></div>"');
    // The component JSX is emitted as a dynamic, with state.name wrapped.
    expect(result.code).toContain("<Card title={() => state.name} />");
  });

  it("hoists mixed tree with multiple component and native children", () => {
    const code = `const App = () => (
      <section>
        <Header />
        <p>intro</p>
        <Footer />
      </section>
    );`;
    const result = transformJSX(code, "test.tsx");
    // Two component child slots + one static <p> in the hoisted shell.
    expect(result.code).toContain("<!--s:0-->");
    expect(result.code).toContain("<!--s:1-->");
    expect(result.code).toContain(
      'html: "<section><!--s:0--><p>intro</p><!--s:1--></section>"',
    );
    expect(result.code).toContain(
      'slots: [{\n    path: [0],\n    type: "child"\n  }, {\n    path: [2],\n    type: "child"\n  }]',
    );
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [<Header />, <Footer />])",
    );
  });

  it("hoists a component as the only child of a native element", () => {
    const code = `const App = () => <main><Card /></main>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('html: "<main><!--s:0--></main>"');
    expect(result.code).toContain("_$createTemplate(_$tmpl_0, [<Card />])");
  });

  it("warns in dev mode when hoisting is skipped", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      // Spread attributes force a hoist skip.
      const code = `const Card = (props) => <div {...props}><p>Hello</p></div>;`;
      transformJSX(code, "test.tsx", { dev: true });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("[Sinwan]");
      expect(warnings[0]).toContain("test.tsx");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("does not warn when dev mode is off", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const code = `const Card = (props) => <div {...props}><p>Hello</p></div>;`;
      transformJSX(code, "test.tsx");
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
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
      const Box = () => <div style={{ backgroundColor: "red", width: "100px", padding: 8 }} />;
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(
      'html: "<div style=\\"background-color:red;width:100px;padding:8\\"></div>"',
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
    // props is a prop binding; member access on it must be unwrapped
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => _$unwrap(props).user.name])",
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
      "_$createTemplate(_$tmpl_0, [() => _$unwrap(user).name])",
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
      "_$createTemplate(_$tmpl_0, [() => _$unwrap(count).value])",
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
    expect(result.code).toContain("() => _$unwrap(count).value");
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
    // user arrives as a getter (forwarded through Child), so member access
    // must be unwrapped: _$unwrap(user).name
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => _$unwrap(user).name])",
    );
    expect(result.code).toContain(
      'import { unwrap as _$unwrap } from "sinwan/reactivity"',
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
    // count arrives as a getter wrapping the signal; unwrap gets the signal,
    // then .value reads it. Unlike resolve, unwrap does NOT double-unwrap.
    expect(result.code).toContain(
      "_$createTemplate(_$tmpl_0, [() => _$unwrap(count).value])",
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

  it("wraps reactive values passed to imported components at the call site", () => {
    // Child is defined in another module and exported; the parent imports it.
    // Without cross-module metadata + a resolver, the call site cannot know
    // that `class` is a reactive prop, so the template literal would be
    // evaluated eagerly and never update.
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ class: className }) => {
        return <div class={className} />;
      });
    `;
    const parentCode = `
      import { useState } from "sinwan/react";
      import { Child } from "./Child";
      const App = () => {
        const [count, setCount] = useState(0);
        return <Child class={\`base \${count() === 4 ? "red" : "blue"}\`} />;
      };
    `;
    const project = analyzeProject({
      root: "/project",
      files: {
        "/project/Child.tsx": childCode,
        "/project/App.tsx": parentCode,
      },
      resolve: (source, fromFile) => {
        const resolved = path.resolve(path.dirname(fromFile), source);
        if (resolved === "/project/Child") return "/project/Child.tsx";
        return null;
      },
    });
    const result = transformJSX(parentCode, "/project/App.tsx", {
      analyzeMetadata: project.reactiveProps,
      resolveImport: (source, fromFile) => {
        const resolved = path.resolve(path.dirname(fromFile), source);
        if (resolved === "/project/Child") return "/project/Child.tsx";
        return null;
      },
    });
    // The class expression must be wrapped in a zero-arity getter so the
    // runtime can re-evaluate it when `count` changes.
    expect(result.code).toContain(
      'class={() => `base ${count() === 4 ? "red" : "blue"}`}',
    );
  });

  it("does not wrap static values passed to imported reactive-prop components", () => {
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ class: className }) => {
        return <div class={className} />;
      });
    `;
    const parentCode = `
      import { Child } from "./Child";
      const App = () => <Child class="always-static" />;
    `;
    const project = analyzeProject({
      root: "/project",
      files: {
        "/project/Child.tsx": childCode,
        "/project/App.tsx": parentCode,
      },
      resolve: (source, fromFile) => {
        const resolved = path.resolve(path.dirname(fromFile), source);
        if (resolved === "/project/Child") return "/project/Child.tsx";
        return null;
      },
    });
    const result = transformJSX(parentCode, "/project/App.tsx", {
      analyzeMetadata: project.reactiveProps,
      resolveImport: (source, fromFile) => {
        const resolved = path.resolve(path.dirname(fromFile), source);
        if (resolved === "/project/Child") return "/project/Child.tsx";
        return null;
      },
    });
    // Static string must remain eager (no getter) — the prop is reactive but
    // the value contains no reactive reads.
    expect(result.code).toContain('class="always-static"');
    expect(result.code).not.toContain("class={() =>");
  });

  it("leaves imported component call sites unwrapped without a resolver", () => {
    // When no resolveImport is provided (e.g. the offline `analyze` path
    // without a plugin cache), cross-module call sites fall back to the
    // conservative non-wrapping behavior so behavior never regresses.
    const parentCode = `
      import { useState } from "sinwan/react";
      import { Child } from "./Child";
      const App = () => {
        const [count, setCount] = useState(0);
        return <Child class={\`base \${count() === 4 ? "red" : "blue"}\`} />;
      };
    `;
    const result = transformJSX(parentCode, "/project/App.tsx", {
      analyzeMetadata: new Map(),
    });
    expect(result.code).not.toContain("class={() =>");
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

describe("template slot path generation", () => {
  it("generates correct slot paths when reactive child precedes attr slot on sibling", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const val = signal("hello");
        const cls = signal("active");
        return (
          <div>
            <span>{val.value}</span>
            <button class={cls.value}>btn</button>
          </div>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("path: [0, 0]");
    expect(result.code).toContain("path: [1]");
  });

  it("generates correct slot paths with multiple reactive children in same parent", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const a = signal("A");
        const b = signal("B");
        const c = signal("C");
        return (
          <p>
            <span>{a.value}</span>
            <span>{b.value}</span>
            <span>{c.value}</span>
          </p>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("path: [0, 0]");
    expect(result.code).toContain("path: [1, 0]");
    expect(result.code).toContain("path: [2, 0]");
  });

  it("handles JSXFragment children without dropping them", () => {
    const code = `
      const App = () => {
        return (
          <div>
            <p>before</p>
            <>
              <span>frag1</span>
              <span>frag2</span>
            </>
            <p>after</p>
          </div>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("frag1");
    expect(result.code).toContain("frag2");
    expect(result.code).toContain("after");
  });

  it("generates correct slot paths for reactive children inside JSXFragment", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const a = signal("A");
        const b = signal("B");
        return (
          <div>
            <p>before</p>
            <>
              <span>{a.value}</span>
              <span>{b.value}</span>
            </>
            <p>after</p>
          </div>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("path: [1, 0]");
    expect(result.code).toContain("path: [2, 0]");
    expect(result.code).toContain("after");
  });

  it("handles nested JSXFragments", () => {
    const code = `
      const App = () => {
        return (
          <div>
            <>
              <span>outer</span>
              <>
                <span>inner</span>
              </>
            </>
            <p>end</p>
          </div>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("outer");
    expect(result.code).toContain("inner");
    expect(result.code).toContain("end");
  });

  it("generates correct slot paths with attr and event on same element after reactive sibling", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      const App = () => {
        const val = signal("x");
        const cls = signal("btn");
        return (
          <div>
            {val.value}
            <button class={cls.value} onclick={() => {}}>click</button>
          </div>
        );
      };
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("path: [0]");
    expect(result.code).toContain("path: [1]");
    expect(result.code).toContain('name: "class"');
    expect(result.code).toContain('name: "onclick"');
  });
});

describe("auto-cc wrapping", () => {
  it("wraps an exported function declaration returning JSX with cc()", () => {
    const code = `
      import { Show } from "sinwan/component";
      export function App() {
        return <Show when={true}>hi</Show>;
      }
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('import { cc } from "sinwan/component";');
    expect(result.code).toMatch(/export const App = cc\(function App\(\)/);
  });

  it("wraps an exported const arrow returning JSX with cc()", () => {
    const code = `export const Card = (props) => <div>{props.title}</div>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('import { cc } from "sinwan/component";');
    expect(result.code).toMatch(/export const Card = cc\(props =>/);
  });

  it("wraps a default-exported named function declaration, preserving binding", () => {
    const code = `export default function App() { return <div/>; }`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('import { cc } from "sinwan/component";');
    expect(result.code).toMatch(/function App\(\)/);
    expect(result.code).toMatch(/export default cc\(App\)/);
  });

  it("wraps a default-exported arrow with cc()", () => {
    const code = `export default () => <div/>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('import { cc } from "sinwan/component";');
    expect(result.code).toMatch(/export default cc\(\(\) =>/);
  });

  it("does NOT double-wrap an already cc()-wrapped export", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => <h1>{title}</h1>);
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("cc(cc(");
    // only the original single import remains (no extra injected import)
    const ccImports = result.code.match(
      /import \{ cc \} from "sinwan\/component";/g,
    );
    expect(ccImports?.length ?? 0).toBe(1);
  });

  it("does NOT wrap non-component exports (lowercase, multi-arg, no JSX, non-fn)", () => {
    const code = `
      export function helper() { return 1; }
      export function MapThings(a, b) { return a + b; }
      export const notComp = 42;
      export function NoJsx() { return "text"; }
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("import { cc }");
    expect(result.code).not.toContain("= cc(");
  });

  it("auto-cc'd plain function component gets reactive JSX wrapping", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      export function App() {
        const count = signal(0);
        return <p>{count.value}</p>;
      }
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toMatch(/export const App = cc\(function App\(\)/);
    expect(result.code).toContain("() => count.value");
  });
});

describe("useFetch reactive tracking", () => {
  it("wraps destructured useFetch signal reads in JSX", () => {
    const code = `
      import { Show } from "sinwan/component";
      import { useFetch } from "sinwan/hook";
      export function App() {
        const { data } = useFetch<{ message: string }>("/api");
        return <Show when={data}>{data?.value?.message}</Show>;
      }
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => data?.value?.message");
  });

  it("wraps property-access reads on a useFetch shell (signalObject)", () => {
    const code = `
      import { Show } from "sinwan/component";
      import { useFetch } from "sinwan/hook";
      export const App = cc(() => {
        const f = useFetch<{ name: string }>("/api").json();
        return (
          <Show when={f.data}>
            <article>
              <h2>{f.data.value!.name}</h2>
            </article>
          </Show>
        );
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => f.data.value!.name");
  });

  it("does NOT wrap the useFetch shell object or a bare property (signal object)", () => {
    const code = `
      import { Show } from "sinwan/component";
      import { useFetch } from "sinwan/hook";
      export const App = cc(() => {
        const f = useFetch<{ name: string }>("/api");
        return <Show when={f.data}>x</Show>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    // when={f.data} is a bare signal object — runtime resolve() handles it,
    // the compiler must not wrap it.
    expect(result.code).not.toContain("when={() => f.data}");
  });

  it("does NOT wrap useFetch methods/properties (abort/execute/etc.)", () => {
    // A bare method call used as a child is not wrapped (it is not a signal read).
    const code = `
      import { useFetch } from "sinwan/hook";
      export const App = cc(() => {
        const f = useFetch("/api");
        return <p>{f.execute()}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("() => f.execute()");
    // A bare non-signal property (e.g. the abort function) is not wrapped either.
    const code2 = `
      import { useFetch } from "sinwan/hook";
      export const App = cc(() => {
        const f = useFetch("/api");
        return <p>{f.abort}</p>;
      });
    `;
    const result2 = transformJSX(code2, "test.tsx");
    expect(result2.code).not.toContain("() => f.abort");
  });
});

describe("optional chaining and non-null reactive reads", () => {
  it("wraps optional-chained signal reads (data?.value?.x)", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal<{ n: number } | null>(null);
        return <p>{s.value?.n}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => s.value?.n");
  });

  it("wraps non-null-asserted signal reads (s.value!.n)", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal<{ n: number } | null>(null);
        return <p>{s.value!.n}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => s.value!.n");
  });

  it("wraps optional + non-null mixed chains", () => {
    const code = `
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal<{ a: { b: number } } | null>(null);
        return <p>{s.value?.a!.b}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => s.value?.a!.b");
  });
});

describe("built-in control-flow direct reactive children", () => {
  it("wraps a reactive expression child of <Show>", () => {
    const code = `
      import { Show } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal<{ msg: string } | null>(null);
        return <Show when={s.value}>{s.value?.msg}</Show>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("{() => s.value?.msg}");
  });

  it("does NOT wrap a render-prop function child of <Show>", () => {
    const code = `
      import { Show } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal<{ msg: string } | null>(null);
        return <Show when={s.value}>{(v) => v?.msg}</Show>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    // render-prop functions are passed through untouched
    expect(result.code).not.toContain("() => (v) =>");
  });

  it("does NOT wrap a static text child of <Show>", () => {
    const code = `
      import { Show } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal(true);
        return <Show when={s.value}>content</Show>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain(">content</Show>");
  });

  it("does NOT wrap reactive children forwarded to a user component", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { createMutable } from "sinwan/store";
      const Child = cc(({ children }) => <h1>{children}</h1>);
      export const App = cc(() => {
        const state = createMutable({ user: { name: "Ada" } });
        const { name } = state.user;
        return <Child>{name}</Child>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    // forwarded children stay unwrapped (the child's own JSX handles it)
    expect(result.code).toContain("<Child>{name}</Child>");
    expect(result.code).not.toContain("() => name");
  });
});

describe("template protocol and hoist edge cases", () => {
  it("decodes compiler template slot markers", () => {
    expect(COMPILER_TEMPLATE_SLOT_PROTOCOL.encodeSlot(3)).toBe("s:3");
    expect(COMPILER_TEMPLATE_SLOT_PROTOCOL.decodeSlot("s:3")).toBe(3);
    expect(COMPILER_TEMPLATE_SLOT_PROTOCOL.decodeSlot("s:x")).toBeNull();
    expect(COMPILER_TEMPLATE_SLOT_PROTOCOL.decodeSlot("nope")).toBeNull();
  });

  it("keeps a space between multiline JSX text lines", () => {
    const code = `const Card = () => (
      <p>
        hello
        world
      </p>
    );`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("hello world");
  });

  it("serializes an empty template-literal style", () => {
    const code = "const Card = () => <div style={``}></div>;";
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain('style=\\"\\"');
  });

  it("emits boolean attributes without a value", () => {
    const code = `const Btn = () => <button disabled>Go</button>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("<button disabled>");
  });

  it("skips hoisting when a member-expression child looks like a component", () => {
    const code = `const App = () => <div><Icons.Star /></div>;`;
    const result = transformJSX(code, "test.tsx", { dev: true });
    expect(result.code).toContain("<Icons.Star");
    expect(result.code).not.toContain("_$createTemplate");
  });

  it("imports binding helpers when explicitBindings has no hoisted templates", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Card = cc(({ title }) => title);
      export const App = cc(() => {
        const s = signal(1);
        return <Card title={s.value} />;
      });
    `;
    const result = transformJSX(code, "test.tsx", { explicitBindings: true });
    expect(result.code).not.toContain("_$createTemplate");
    expect(result.code).toContain("_$bindText");
    expect(result.code).toContain('from "sinwan/renderer"');
  });
});

describe("auto-cc additional candidates", () => {
  it("wraps an anonymous default-exported function declaration", () => {
    const code = `export default function () { return <div/>; }`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("export default cc(function");
  });

  it("does not wrap generator function expressions", () => {
    const code = `export const App = function* () { return <div/>; };`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("= cc(");
  });

  it("does not treat a nested function's JSX as the export's return", () => {
    const code = `
      export function App() {
        function Inner() { return <span/>; }
        return helper;
      }
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("= cc(");
  });

  it("wraps a component that returns JSX inside an array", () => {
    const code = `export function List() { return [[<div key="a" />]]; }`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("export const List = cc(");
  });

  it("leaves namespaced child tags out of the HTML template", () => {
    const code = `const Icon = () => <div><svg:rect /></div>;`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$createTemplate");
  });

  it("wraps a component that returns JSX inside an object", () => {
    const code = `export function Node() { return { el: <div/> }; }`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("export const Node = cc(");
  });

  it("does not wrap an arrow whose body is only a nested function", () => {
    const code = `export const App = () => (() => <div/>);`;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("= cc(");
  });
});

describe("additional reactive wrap paths", () => {
  it("wraps createStore and computed reads", () => {
    const storeCode = `
      import { cc } from "sinwan/component";
      import { createStore } from "sinwan/store";
      export const App = cc(() => {
        const [state] = createStore({ n: 1 });
        return <p>{state.n}</p>;
      });
    `;
    const storeResult = transformJSX(storeCode, "test.tsx");
    expect(storeResult.code).toContain("() => state.n");

    const computedCode = `
      import { cc } from "sinwan/component";
      import { signal, computed } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal(1);
        const doubled = computed(() => s.value * 2);
        return <p>{doubled.value}</p>;
      });
    `;
    const computedResult = transformJSX(computedCode, "test.tsx");
    expect(computedResult.code).toContain("() => doubled.value");
  });

  it("does not treat a non-chain useFetch method as a fetch shell", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { useFetch } from "sinwan/hook";
      export const App = cc(() => {
        const aborted = useFetch("/api").abort();
        return <p>{aborted}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("() => aborted");
  });

  it("does not wrap member access on a local getter function", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { useState } from "sinwan/react";
      export const App = cc(() => {
        const [count] = useState(0);
        function doubled() { return count(); }
        return <p>{doubled.name}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("() => doubled.name");
  });

  it("wraps calls to a local function declaration that reads reactive state", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { useState } from "sinwan/react";
      export const App = cc(() => {
        const [count] = useState(0);
        function doubled() { return count(); }
        return <p>{doubled()}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => doubled()");
  });

  it("treats rest-parameter components as having no named props", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const App = cc((...args) => <div>{args[0]}</div>);
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("args[0]");
  });

  it("tracks string-literal keys in object spreads", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Child = cc(({ title }) => <h1>{title}</h1>);
      export const App = cc(() => {
        const s = signal("Hi");
        return <Child {...{ "title": s.value }} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("<Child");
  });

  it("resolves a local object-literal variable in a same-file spread", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Child = cc(({ title }) => <h1>{title}</h1>);
      export const App = cc(() => {
        const s = signal("Hi");
        const props = { title: s.value };
        return <Child {...props} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("{...props}");
  });

  it("wraps non-null asserted destructured mutable values", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { createMutable } from "sinwan/store";
      export const App = cc(() => {
        const state = createMutable({ name: "Ada" });
        const { name } = state;
        return <p>{name!}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => name!");
  });

  it("does not wrap a useFetch property that is not .value", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { useFetch } from "sinwan/hook";
      export const App = cc(() => {
        const f = useFetch("/api");
        return <p>{f.data}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).not.toContain("() => f.data");
  });

  it("wraps useFetch .value reads passed to another component", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { useFetch } from "sinwan/hook";
      const Child = cc(({ title }) => <h1>{title}</h1>);
      export const App = cc(() => {
        const f = useFetch<{ title: string }>("/api");
        return <Child title={f.data.value} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("title={() => f.data.value}");
  });

  it("does not look inside nested functions when checking a prop value", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Child = cc(({ title }) => <h1>{title}</h1>);
      export const App = cc(() => {
        const s = signal("Hi");
        return <Child title={() => s.value} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("title={() => s.value}");
    expect(result.code).not.toContain("title={() => () =>");
  });

  it("wraps reactive children inside a fragment", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      export const App = cc(() => {
        const s = signal(1);
        return <div>{<>{s.value}</>}</div>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("() => s.value");
  });

  it("resolves member-expression component names", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Mod = { Show: (_props) => null };
      export const App = cc(() => {
        const s = signal(true);
        return <Mod.Show when={s.value}>x</Mod.Show>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("<Mod.Show");
  });

  it("unwraps non-null asserted prop member access", () => {
    const code = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ user }) => {
        return <p>{user!.name}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$unwrap(user)");
  });

  it("reuses an existing unwrap import", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { unwrap } from "sinwan/reactivity";
      export const Child = cc(({ user }) => {
        void unwrap;
        return <p>{user.name}</p>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("_$unwrap(user)");
    expect(result.code).toContain("unwrap");
  });

  it("ignores invalid analyze metadata files", () => {
    const tmp = path.join(import.meta.dir, ".tmp-bad-analyze.json");
    fs.writeFileSync(tmp, "{not-json");
    try {
      const code = `
        import { cc } from "sinwan/component";
        import { signal } from "sinwan/reactivity";
        export const App = cc(() => {
          const s = signal(1);
          return <p>{s.value}</p>;
        });
      `;
      const result = transformJSX(code, "test.tsx", {
        analyze: tmp,
      });
      expect(result.code).toContain("() => s.value");
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("tracks multiple expression children and empty JSX comments", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const Child = cc(({ children }) => <div>{children}</div>);
      export const App = cc(() => {
        const a = signal(1);
        const b = signal(2);
        return <Child>{/* skip */}{a.value}{b.value}</Child>;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("{a.value}{b.value}");
  });

  it("treats export default of a cc() variable as exported", () => {
    const code = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      const App = cc(({ title }) => <h1>{title}</h1>);
      export default App;
      export const Page = cc(() => {
        const s = signal("Hi");
        return <App title={s.value} />;
      });
    `;
    const result = transformJSX(code, "test.tsx");
    expect(result.code).toContain("title={() => s.value}");
  });
});
