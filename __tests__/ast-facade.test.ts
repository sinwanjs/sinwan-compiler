/**
 * Coverage and contract tests for the oxc/esrap AST facade.
 */

import { describe, expect, it } from "bun:test";
import { parse, generate, traverse, t, Path } from "../src/ast";
import { asProgram } from "../src/ast/parse";

describe("ast facade", () => {
  it("throws when oxc does not return a Program", () => {
    expect(() => asProgram(null)).toThrow(/did not return a Program/);
    expect(() => asProgram({ type: "File" })).toThrow(/did not return a Program/);
    expect(() => asProgram({ type: "Program" })).toThrow(
      /did not return a Program/,
    );
  });

  it("normalizes script programs", () => {
    const program = asProgram({
      type: "Program",
      body: [],
      sourceType: "script",
    });
    expect(program.sourceType).toBe("script");
  });

  it("reads template element raw text from both shapes", () => {
    expect(t.templateElementRaw(null)).toBe("");
    expect(t.templateElementRaw({ type: "TemplateElement", value: "hi" })).toBe(
      "hi",
    );
    expect(
      t.templateElementRaw({ type: "TemplateElement", value: { raw: "x" } }),
    ).toBe("x");
    expect(
      t.templateElementRaw({
        type: "TemplateElement",
        value: { raw: undefined },
      }),
    ).toBe("");
  });

  it("parses scripts, recovered syntax, and non-tsx filenames", () => {
    const script = parse("var x = 1;", {
      sourceType: "script",
      sourceFilename: "file.js",
    });
    expect(script.program.sourceType).toBe("script");

    const jsx = parse("const n = <span/>;", { sourceFilename: "file.jsx" });
    expect(jsx.program.body.length).toBeGreaterThan(0);

    const dts = parse("export const n: number = 1;", {
      sourceFilename: "file.mts",
    });
    expect(dts.program.body.length).toBeGreaterThan(0);

    const cts = parse("export const n: number = 1;", {
      sourceFilename: "file.cts",
    });
    expect(cts.program.body.length).toBeGreaterThan(0);

    expect(() => parse("const x =", { sourceFilename: "bad.ts" })).toThrow();

    const recovered = parse("const x =", {
      sourceFilename: "bad.ts",
      errorRecovery: true,
    });
    expect(recovered.program.type).toBe("Program");
  });

  it("prints a Program node without a File wrapper", () => {
    const ast = parse("const x = 1;", { sourceFilename: "prog.ts" });
    const { code, map } = generate(ast.program);
    expect(code).toContain("const x = 1");
    expect(map).toBeNull();
  });

  it("attaches trailing comments at EOF and prints leading comments", () => {
    const ast = parse("const x = /* keep */ 1;\n// eof\n", {
      sourceFilename: "comments.ts",
    });
    expect(ast.program.trailingComments?.length).toBeGreaterThan(0);
    const { code } = generate(ast);
    expect(code).toContain("keep");
    ast.program.body[0]!.leadingComments = [{ type: "Line", value: " line" }];
    ast.program.body[0]!.trailingComments = [
      { type: "Block", value: " block" },
    ];
    const reprinted = generate(ast).code;
    expect(reprinted).toContain("line");
    expect(reprinted).toContain("block");
  });

  it("emits a source map when requested", () => {
    const ast = parse("export const n = 1;", { sourceFilename: "map.ts" });
    const withName = generate(ast, {
      sourceMaps: true,
      sourceFileName: "map.ts",
    });
    expect(withName.map).not.toBeNull();
    const withoutName = generate(ast, { sourceMaps: true });
    expect(withoutName.map).not.toBeNull();
  });

  it("covers path type guards used by rewrite passes", () => {
    const ast = parse(
      `
      import def from "./m";
      export function Fn() {
        const [{ a = 1 }] = [{}];
        const obj = { x: true };
        const arr = (n: number) => n;
        const expr = function inner() { return <div/>; };
        const grouped = (1);
        if (obj.x) return arr(1);
      }
    `,
      { sourceFilename: "guards.tsx", sourceType: "module" },
    );
    const seen = {
      objectExpression: false,
      objectPattern: false,
      arrayPattern: false,
      importDefault: false,
      importDecl: false,
      arrow: false,
      fnExpr: false,
      fnDecl: false,
      program: false,
      ifStmt: false,
      parens: false,
    };
    traverse(ast, {
      Program(path: Path) {
        seen.program = path.isProgram();
      },
      ObjectExpression(path: Path) {
        seen.objectExpression = path.isObjectExpression();
      },
      ObjectPattern(path: Path) {
        seen.objectPattern = path.isObjectPattern();
      },
      ArrayPattern(path: Path) {
        seen.arrayPattern = path.isArrayPattern();
      },
      ImportDefaultSpecifier(path: Path) {
        seen.importDefault = path.isImportDefaultSpecifier();
      },
      ImportDeclaration(path: Path) {
        seen.importDecl = path.isImportDeclaration();
      },
      ArrowFunctionExpression(path: Path) {
        seen.arrow = path.isArrowFunctionExpression();
      },
      FunctionExpression(path: Path) {
        seen.fnExpr = path.isFunctionExpression();
      },
      FunctionDeclaration(path: Path) {
        seen.fnDecl = path.isFunctionDeclaration();
      },
      IfStatement(path: Path) {
        seen.ifStmt = path.isIfStatement();
      },
      ParenthesizedExpression(path: Path) {
        seen.parens = path.isParenthesizedExpression();
      },
    });
    expect(seen).toEqual({
      objectExpression: true,
      objectPattern: true,
      arrayPattern: true,
      importDefault: true,
      importDecl: true,
      arrow: true,
      fnExpr: true,
      fnDecl: true,
      program: true,
      ifStmt: true,
      parens: true,
    });
  });

  it("builds ESTree nodes and unwraps parens/chains", () => {
    const bool = t.booleanLiteral(false);
    const nil = t.nullLiteral();
    const asExpr = t.tsAsExpression(
      t.identifier("n"),
      { type: "TSNumberKeyword" },
    );
    const assertion = t.tsTypeAssertion(
      t.identifier("n"),
      { type: "TSNumberKeyword" },
    );
    const pattern = t.assignmentPattern(t.identifier("a"), t.numericLiteral(1));
    expect(t.isBooleanLiteral(bool)).toBe(true);
    expect(t.isNullLiteral(nil)).toBe(true);
    expect(t.isTSAsExpression(asExpr)).toBe(true);
    expect(t.isTSTypeAssertion(assertion)).toBe(true);
    expect(t.isAssignmentPattern(pattern)).toBe(true);

    const grouped = {
      type: "ParenthesizedExpression",
      expression: {
        type: "ParenthesizedExpression",
        expression: t.identifier("x"),
      },
    };
    expect(t.unwrapParens(grouped).type).toBe("Identifier");
    const chain = {
      type: "ChainExpression",
      expression: t.callExpression(t.identifier("fn"), []),
    };
    expect(t.unwrapCall(chain).type).toBe("CallExpression");
    expect(t.unwrapCall(t.identifier("fn")).type).toBe("Identifier");
  });

  it("throws when assertExpression is given a non-expression", () => {
    expect(() => t.assertExpression({ type: "EmptyStatement" })).toThrow(
      /Expected Expression/,
    );
    expect(() => t.assertExpression(null)).toThrow(/Expected Expression/);
  });

  it("keeps a comment after the last object child on that object", () => {
    const file = parse(
      "export const helpers = {\n  merge() { return 1; }\n  /** @sinwan-pure */\n};\n",
      { sourceFilename: "helpers.ts" },
    );
    const found: string[] = [];
    const visit = (node: { [key: string]: unknown } | null): void => {
      if (!node || typeof node !== "object") return;
      const inner = node.innerComments as { value?: string }[] | undefined;
      if (inner?.some((comment) => comment.value?.includes("@sinwan-pure"))) {
        found.push(String(node.type));
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object") visit(item as { [key: string]: unknown });
          }
        } else if (value && typeof value === "object" && "type" in (value as object)) {
          visit(value as { [key: string]: unknown });
        }
      }
    };
    visit(file.program as unknown as { [key: string]: unknown });
    expect(found.length).toBeGreaterThan(0);
  });
});
