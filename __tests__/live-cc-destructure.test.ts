import { describe, it, expect } from "bun:test";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { rewriteLiveCcDestructure } from "../src/live-cc-destructure";

function parseModule(code: string) {
  return parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
}

function exportedCcFunction(ast: ReturnType<typeof parseModule>): t.Function {
  const decl = ast.program.body[1] as t.ExportNamedDeclaration;
  const call = (decl.declaration as t.VariableDeclaration).declarations[0]!
    .init as t.CallExpression;
  return call.arguments[0] as t.Function;
}

describe("rewriteLiveCcDestructure", () => {
  it("is a no-op without a cc import", () => {
    const ast = parseModule(`const Child = cc(({ value }) => value);`);
    const result = rewriteLiveCcDestructure(ast);
    expect(result).toEqual({ rest: false, spread: false });
  });

  it("skips nested rest patterns", () => {
    const ast = parseModule(`
      import { cc } from "sinwan/component";
      const Child = cc((props) => <div />);
    `);
    const fn = (
      ast.program.body[1] as t.VariableDeclaration
    ).declarations[0]!.init as t.CallExpression;
    const component = fn.arguments[0] as t.ArrowFunctionExpression;
    component.params[0] = t.objectPattern([
      t.restElement(t.objectPattern([])),
    ]);
    const result = rewriteLiveCcDestructure(ast);
    expect(result.rest).toBe(false);
    expect(t.isObjectPattern(component.params[0])).toBe(true);
  });

  it("copies an optional object-pattern annotation onto props", () => {
    const ast = parseModule(`
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }: { title?: string }) => <h1>{title}</h1>);
    `);
    const fn = exportedCcFunction(ast);
    const pattern = fn.params[0] as t.ObjectPattern;
    pattern.optional = true;
    rewriteLiveCcDestructure(ast);
    expect(t.isIdentifier(fn.params[0], { name: "props" })).toBe(true);
    expect((fn.params[0] as t.Identifier).optional).toBe(true);
  });

  it("recognizes a string-literal cc import name", () => {
    const ast = parseModule(`
      import { "cc" as component } from "sinwan/component";
      export const Child = component(({ value }) => <span>{value}</span>);
    `);
    const result = rewriteLiveCcDestructure(ast);
    expect(result).toEqual({ rest: false, spread: false });
    const fn = exportedCcFunction(ast);
    expect(t.isIdentifier(fn.params[0], { name: "props" })).toBe(true);
  });
});
