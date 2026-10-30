import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { analyzeProject } from "../src/analyze";
import { loadTsConfigPaths, stripJsonc } from "../src/tsconfig";

const CHILD = `
  import { cc } from "sinwan/component";
  export const Child = cc(({ title }) => <h1>{title}</h1>);
`;

const PARENT = `
  import { cc } from "sinwan/component";
  import { signal } from "sinwan/reactivity";
  import { Child } from "@/components/Child";
  export const Parent = cc(() => {
    const title = signal("Hello");
    return <Child title={title.value} />;
  });
`;

function withProject(
  files: Record<string, string>,
  run: (dir: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-tsconfig-paths-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function childProps(dir: string, tsConfigPath = "tsconfig.json") {
  const project = analyzeProject({
    root: dir,
    tsConfigPath: path.join(dir, tsConfigPath),
  });
  return project.reactiveProps
    .get(path.join(dir, "src", "components", "Child.tsx"))
    ?.get("Child");
}

const SOURCES = {
  "src/components/Child.tsx": CHILD,
  "src/pages/Parent.tsx": PARENT,
};

describe("tsconfig paths in the analyzer", () => {
  it("reads a tsconfig with comments and trailing commas (create-sinwan style)", () => {
    withProject(
      {
        ...SOURCES,
        "tsconfig.json": `{
          "$schema": "https://json.schemastore.org/tsconfig", // a URL is not a comment
          "compilerOptions": {
            /* Bundler mode */
            "moduleResolution": "bundler",
            "paths": {
              "@/*": ["./src/*"], // app alias
            },
          },
        }`,
      },
      (dir) => {
        expect(childProps(dir)).toEqual(new Set(["title"]));
      },
    );
  });

  it("follows a relative extends", () => {
    withProject(
      {
        ...SOURCES,
        "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }`,
        "tsconfig.json": `{ "extends": "./tsconfig.base", "compilerOptions": { "strict": true } }`,
      },
      (dir) => {
        expect(childProps(dir)).toEqual(new Set(["title"]));
      },
    );
  });

  it("resolves inherited paths against the config that declares them", () => {
    withProject(
      {
        ...SOURCES,
        "configs/tsconfig.base.json": `{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }`,
        "tsconfig.json": `{ "extends": "./configs/tsconfig.base.json" }`,
      },
      (dir) => {
        expect(childProps(dir)).toEqual(new Set(["title"]));
      },
    );
  });

  it("lets the extending config override inherited paths", () => {
    withProject(
      {
        ...SOURCES,
        "tsconfig.base.json": `{ "compilerOptions": { "paths": { "@/*": ["./wrong/*"] } } }`,
        "tsconfig.json": `{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
      },
      (dir) => {
        expect(childProps(dir)).toEqual(new Set(["title"]));
      },
    );
  });

  it("follows package and array extends, with baseUrl applied to inherited paths", () => {
    withProject(
      {
        ...SOURCES,
        "node_modules/@acme/tsconfig/package.json": `{ "name": "@acme/tsconfig", "version": "1.0.0" }`,
        "node_modules/@acme/tsconfig/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./nowhere/*"] } } }`,
        "node_modules/@acme/tsconfig/paths.json": `{ "compilerOptions": { "paths": { "@/*": ["*"] } } }`,
        "tsconfig.json": `{ "extends": ["@acme/tsconfig", "@acme/tsconfig/paths"], "compilerOptions": { "baseUrl": "./src" } }`,
      },
      (dir) => {
        expect(childProps(dir)).toEqual(new Set(["title"]));
      },
    );
  });

  it("returns no paths for missing, invalid, path-less or cyclic configs", () => {
    withProject(
      {
        "broken.json": `{ "compilerOptions": `,
        "empty.json": `{ "compilerOptions": { "strict": true } }`,
        "a.json": `{ "extends": "./b.json", "compilerOptions": { "strict": true } }`,
        "b.json": `{ "extends": "./a.json" }`,
        "unknown-extends.json": `{ "extends": "@missing/config" }`,
        "missing-relative.json": `{ "extends": "./nope" }`,
        "array.json": `[1, 2]`,
      },
      (dir) => {
        expect(loadTsConfigPaths(path.join(dir, "missing.json"))).toBeNull();
        expect(loadTsConfigPaths(path.join(dir, "broken.json"))).toBeNull();
        expect(loadTsConfigPaths(path.join(dir, "empty.json"))).toBeNull();
        expect(loadTsConfigPaths(path.join(dir, "a.json"))).toBeNull();
        expect(loadTsConfigPaths(path.join(dir, "unknown-extends.json"))).toBeNull();
        expect(loadTsConfigPaths(path.join(dir, "missing-relative.json"))).toBeNull();
        expect(loadTsConfigPaths(path.join(dir, "array.json"))).toBeNull();
      },
    );
  });
});

describe("stripJsonc", () => {
  it("removes line and block comments outside strings", () => {
    const text = `{ "a": "// keep", /* drop */ "b": "/* keep */" // drop\n }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: "// keep", b: "/* keep */" });
  });

  it("removes trailing commas, including before a comment", () => {
    const text = `{ "list": [1, 2, ], "obj": { "x": 1, // c\n }, }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ list: [1, 2], obj: { x: 1 } });
  });

  it("keeps escaped quotes and commas inside strings", () => {
    const text = `{ "q": "say \\"hi\\", }", }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ q: 'say "hi", }' });
  });

  it("drops an unterminated block comment", () => {
    expect(stripJsonc(`{ "a": 1 } /* open`).trim()).toBe(`{ "a": 1 }`);
  });
});
