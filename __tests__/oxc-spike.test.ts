/**
 * Oxc parse → mutate → esrap print smoke tests.
 */

import { describe, expect, it } from "bun:test";
import { parseSync, Visitor } from "oxc-parser";
import { print } from "esrap";
import tsx from "esrap/languages/tsx";
import { parse, generate, traverse, t } from "../src/ast";

describe("oxc spike", () => {
  it("parses mutates and prints Sinwan TSX via oxc+esrap", () => {
    const code = `
import { cc, Show } from "sinwan/component";
import { signal } from "sinwan/reactivity";
export const App = cc(() => {
  const count = signal(0);
  return <Show when={count.value > 0}><span>{count.value}</span></Show>;
});
`;
    const result = parseSync("spike.tsx", code, {
      lang: "tsx",
      sourceType: "module",
    });
    expect(result.errors).toEqual([]);

    let mutated = false;
    new Visitor({
      JSXElement(node) {
        if (mutated) return;
        if (
          node.openingElement?.name?.type === "JSXIdentifier" &&
          node.openingElement.name.name === "span"
        ) {
          for (const child of node.children) {
            if (
              child.type === "JSXExpressionContainer" &&
              child.expression.type === "MemberExpression"
            ) {
              child.expression = {
                type: "ArrowFunctionExpression",
                params: [],
                body: child.expression,
                expression: true,
                async: false,
                generator: false,
                id: null,
              } as never;
              mutated = true;
            }
          }
        }
      },
    }).visit(result.program);

    const out = print(result.program, tsx());
    expect(mutated).toBe(true);
    expect(out.code).toContain("{() => count.value}");
  });

  it("facade parse+traverse+generate wraps a JSX expression", () => {
    const ast = parse(`export const App = () => <div>{count.value}</div>;`, {
      sourceFilename: "facade.tsx",
      sourceType: "module",
    });
    traverse(ast, {
      JSXExpressionContainer(path) {
        const expr = path.get("expression");
        if (!Array.isArray(expr) && expr.isMemberExpression()) {
          expr.replaceWith(t.arrowFunctionExpression([], expr.node));
        }
      },
    });
    const { code } = generate(ast, {
      sourceMaps: true,
      sourceFileName: "facade.tsx",
    });
    expect(code).toContain("{() => count.value}");
  });
});
