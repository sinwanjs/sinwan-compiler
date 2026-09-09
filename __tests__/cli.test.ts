import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runAnalyzeCli, runCliIfMain } from "../src/cli";

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

  it("accepts --bunfig and --workspaces flags", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-cli-flags-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "app", "src"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "shared", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "bunfig.toml"),
        `[install]\nalias = { "@shared": "shared/src" }\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "shared", "package.json"),
        JSON.stringify({ name: "shared-ui", version: "1.0.0" }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "shared", "src", "Badge.tsx"),
        `
        import { cc } from "sinwan/component";
        export const Badge = cc(({ text }) => {
          return <span>{text}</span>;
        });
      `,
      );
      fs.writeFileSync(
        path.join(tmpDir, "app", "src", "Page.tsx"),
        `
        import { cc } from "sinwan/component";
        import { Badge } from "shared-ui/Badge";
        const Page = cc(() => {
          return <Badge text="New" />;
        });
      `,
      );
      const outFile = path.join(tmpDir, "out.json");
      runAnalyzeCli([
        "analyze",
        path.join(tmpDir, "app"),
        outFile,
        "--bunfig",
        path.join(tmpDir, "bunfig.toml"),
        "--workspaces",
        path.join(tmpDir, "shared"),
      ]);
      expect(fs.existsSync(outFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown commands", () => {
    const previousExit = process.exit;
    const previousError = console.error;
    const errors: string[] = [];
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      expect(() => runAnalyzeCli(["build"])).toThrow("exit 1");
      expect(exitCode).toBe(1);
      expect(errors.join(" ")).toContain("Unknown command");
    } finally {
      process.exit = previousExit;
      console.error = previousError;
    }
  });

  it("does not run when imported as a module", () => {
    runCliIfMain(false);
  });

  it("runs when marked as the entry point", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-cli-main-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "App.tsx"),
        `
        import { cc } from "sinwan/component";
        export const App = cc(() => <div />);
      `,
      );
      const outFile = path.join(tmpDir, "out.json");
      runCliIfMain(true, ["analyze", tmpDir, outFile]);
      expect(fs.existsSync(outFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
