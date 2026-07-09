import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runAnalyzeCli } from "../src/cli";

describe("runAnalyzeCli", () => {
  it("analyzes a project with tsconfig path aliases", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-cli-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/components/*": ["src/components/*"],
            },
          },
        }),
      );
      fs.mkdirSync(path.join(tmpDir, "src", "components"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(tmpDir, "src", "pages"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "src", "components", "Child.tsx"),
        `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
      `,
      );
      fs.writeFileSync(
        path.join(tmpDir, "src", "pages", "Parent.tsx"),
        `
        import { cc } from "sinwan/component";
        import { Child } from "@/components/Child";
        const Parent = cc(() => {
          return <Child title="Hello" />;
        });
      `,
      );
      const outFile = path.join(tmpDir, "reactive-props.json");
      runAnalyzeCli([
        "analyze",
        tmpDir,
        outFile,
        "--tsconfig",
        path.join(tmpDir, "tsconfig.json"),
      ]);
      expect(fs.existsSync(outFile)).toBe(true);
      const metadata = JSON.parse(fs.readFileSync(outFile, "utf-8")) as Record<
        string,
        Record<string, string[]>
      >;
      const childPath = path.join(tmpDir, "src", "components", "Child.tsx");
      expect(metadata[childPath]?.Child).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
