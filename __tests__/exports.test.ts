import { collectExportedComponents } from "../src/index";
import { expect, test, describe } from "bun:test";

describe("collectExportedComponents", () => {
  test("detects named function exports", () => {
    const code = `
export function App() { return null; }
export function helper() { return null; }
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ local: "App", key: "App" });
  });

  test("detects named variable exports", () => {
    const code = `
export const Counter = () => null;
export const notComponent = 42;
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ local: "Counter", key: "Counter" });
  });

  test("detects default export (identifier)", () => {
    const code = `
const App = () => null;
export default App;
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ local: "App", key: "default" });
  });

  test("detects default export (function declaration)", () => {
    const code = `
export default function App() { return null; }
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ local: "App", key: "default" });
  });

  test("detects export specifiers with rename", () => {
    const code = `
const Foo = () => null;
export { Foo as Bar };
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ local: "Foo", key: "Bar" });
  });

  test("detects multiple components", () => {
    const code = `
export function Header() { return null; }
export function Footer() { return null; }
export default function App() { return null; }
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.key).sort()).toEqual([
      "Footer",
      "Header",
      "default",
    ]);
  });

  test("returns empty for non-component exports", () => {
    const code = `
export const max = 100;
export function util() { return 1; }
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(0);
  });

  test("returns empty for unparseable code", () => {
    const code = `export function {{{ }`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(0);
  });

  test("skips re-exports from other modules", () => {
    const code = `
export { App } from "./App.tsx";
`;
    const result = collectExportedComponents(code, "test.tsx");
    expect(result).toHaveLength(0);
  });

  test("skips export type specifiers that have no runtime binding", () => {
    const code = `
const Button = () => null;
type ButtonProps = { variant?: string };
export { Button };
export type { ButtonProps };
`;
    const result = collectExportedComponents(code, "button.tsx");
    expect(result).toEqual([{ local: "Button", key: "Button" }]);
  });

  test("skips inline type specifiers mixed with value exports", () => {
    const code = `
const Button = () => null;
type ButtonProps = { variant?: string };
export { Button, type ButtonProps };
`;
    const result = collectExportedComponents(code, "button.tsx");
    expect(result).toEqual([{ local: "Button", key: "Button" }]);
  });

  test("returns empty for a type-only named export", () => {
    const code = `
type IconNode = [string, Record<string, string>][];
export type { IconNode };
`;
    const result = collectExportedComponents(code, "icons.tsx");
    expect(result).toHaveLength(0);
  });
});
