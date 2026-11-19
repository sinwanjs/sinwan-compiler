// Path, scope, parse, generate and type-guard behaviours of the AST facade
// that the transform tests do not reach: loop/catch/switch scopes, `var`
// hoisting, array patterns, `get` on missing or indexed paths, replace
// errors, holes and duplicates during traversal, `{ enter, exit }` visitors,
// comment placement, source types and source maps.
import { describe, expect, test } from "bun:test";

import { generate, parse, singlePath, t, traverse, type NodePath, type Node } from "../src/ast";

function pathsOf(code: string, type: string): NodePath[] {
  const found: NodePath[] = [];
  traverse(parse(code), {
    [type](path: NodePath) {
      found.push(path);
    },
  });
  return found;
}

function bindingKind(code: string, name: string): string | undefined {
  let kind: string | undefined;
  traverse(parse(code), {
    CallExpression(path: NodePath) {
      if (t.isIdentifier(path.node.callee, { name: "probe" })) kind = path.scope.getBinding(name)?.kind;
    },
  });
  return kind;
}

describe("scopes", () => {
  test("loop, catch and switch declarations are bound in their own scope", () => {
    expect(bindingKind("for (let i = 0; i < 1; i++) probe();", "i")).toBe("let");
    expect(bindingKind("for (const k in o) probe();", "k")).toBe("const");
    expect(bindingKind("for (const v of list) probe();", "v")).toBe("const");
    expect(bindingKind("try {} catch ({ message }) { probe(); }", "message")).toBe("const");
    expect(bindingKind("switch (x) { case 1: const found = 1; probe(); }", "found")).toBe("const");
    expect(bindingKind("switch (x) { case 1: probe(); }", "found")).toBeUndefined();
  });

  test("var hoists to the function, past nested blocks", () => {
    const code = "function f() { { { var deep = 1; } } probe(); }";
    expect(bindingKind(code, "deep")).toBe("var");
    expect(bindingKind("{ var top = 1; } probe();", "top")).toBe("var");
  });

  test("array patterns bind rest and defaulted elements", () => {
    const code = "const [first = 1, , ...rest] = list; probe();";
    expect(bindingKind(code, "first")).toBe("const");
    expect(bindingKind(code, "rest")).toBe("const");
  });
});

describe("Path", () => {
  test("singlePath refuses a list", () => {
    const [program] = pathsOf("a; b;", "Program");
    expect(() => singlePath(program!.get("body"))).toThrow("Expected a single NodePath");
  });

  test("get: indexes need a list, missing children give an empty path", () => {
    const [ifPath] = pathsOf("if (a) b();", "IfStatement");
    expect(() => ifPath!.get("test.0")).toThrow("Unexpected index without array at test.0");
    const missing = singlePath(ifPath!.get("alternate"));
    expect(missing.node.type).toBe("EmptyStatement");
    expect(singlePath(ifPath!.get("alternate.argument")).node.type).toBe("EmptyStatement");
  });

  test("replace errors name what is wrong", () => {
    const [program] = pathsOf("a;", "Program");
    expect(() => program!.replaceWith(t.identifier("x"))).toThrow("Cannot replace root");
    const [ifPath] = pathsOf("if (a) b();", "IfStatement");
    expect(() => singlePath(ifPath!.get("test")).replaceWithMultiple([])).toThrow("replaceWithMultiple requires a list path");
  });

  test("isUnaryExpression with an operator filter", () => {
    const [unary] = pathsOf("!a;", "UnaryExpression");
    expect(unary!.isUnaryExpression()).toBe(true);
    expect(unary!.isUnaryExpression({ operator: "!" })).toBe(true);
    expect(unary!.isUnaryExpression({ operator: "-" })).toBe(false);
    const [identifier] = pathsOf("a;", "Identifier");
    expect(identifier!.isUnaryExpression()).toBe(false);
  });
});

describe("traverse", () => {
  test("object visitors get enter and exit in order", () => {
    const events: string[] = [];
    traverse(parse("f(a);"), {
      CallExpression: { enter: () => events.push("enter"), exit: () => events.push("exit") },
      Identifier: { exit: (path: NodePath) => events.push(`exit:${String(path.node.name)}`) },
    });
    expect(events).toEqual(["enter", "exit:f", "exit:a", "exit"]);
  });

  test("holes and repeated nodes in lists are skipped", () => {
    const ast = parse("[, a, , b];");
    const repeated = t.identifier("same");
    const statement = (expression: Node): Node => ({ type: "ExpressionStatement", expression });
    ast.program.body.push(statement(repeated), statement(repeated));
    const shared = ast.program.body[1]!;
    ast.program.body.push(shared);
    const seen: string[] = [];
    traverse(ast, {
      Identifier(path: NodePath) {
        seen.push(String(path.node.name));
      },
    });
    expect(seen).toEqual(["a", "b", "same", "same"]);

    const nested: string[] = [];
    traverse(parse("[, c, , d];"), {
      ArrayExpression(path: NodePath) {
        path.traverse({ Identifier: (inner: NodePath) => nested.push(String(inner.node.name)) });
      },
    });
    expect(nested).toEqual(["c", "d"]);
  });
});

describe("parse and generate", () => {
  test("a comment after the last statement of a block becomes an inner comment", () => {
    const ast = parse("function f() { a(); /* tail */ }\nb();");
    const block = (ast.program.body[0] as Node & { body: Node }).body;
    const inner = block.innerComments;
    expect(Array.isArray(inner) ? inner.map((comment: { value?: unknown }) => comment.value) : inner).toEqual([" tail "]);
  });

  test("source types", () => {
    expect(parse("a;", { sourceType: "unambiguous" }).program.sourceType).toBe("script");
    expect(parse("export const a = 1;", { sourceType: "unambiguous" }).program.sourceType).toBe("module");
    expect(parse("a;", { sourceType: "script" }).program.sourceType).toBe("script");
  });

  test("source maps keep the generated sources without a file name", () => {
    const result = generate(parse("const a = 1;"), { sourceMaps: true });
    expect(result.map).toMatchObject({ sources: expect.any(Array) });
    expect(Reflect.get(result.map ?? {}, "file")).toBeUndefined();
    expect(generate(parse("a;")).map).toBeNull();
  });
});

describe("type guards", () => {
  test("optional calls inside a chain", () => {
    const [chain] = pathsOf("a?.();", "ChainExpression");
    expect(t.isOptionalCallExpression(chain!.node)).toBe(true);
    const [member] = pathsOf("a?.b;", "ChainExpression");
    expect(t.isOptionalCallExpression(member!.node)).toBe(false);
  });

  test("importedBindingName handles identifiers, strings and anything else", () => {
    expect(t.importedBindingName(t.identifier("a"))).toBe("a");
    expect(t.importedBindingName(t.stringLiteral("b"))).toBe("b");
    expect(t.importedBindingName(t.numericLiteral(1))).toBeNull();
    expect(t.importedBindingName(null)).toBeNull();
  });
});
