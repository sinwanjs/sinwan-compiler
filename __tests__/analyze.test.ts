import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { analyzeProject, analyzeModule } from "../src/analyze";

function resolve(files: Record<string, string>) {
  return (source: string, fromFile: string) => {
    const resolved = path.resolve(path.dirname(fromFile), source);
    if (files[resolved + ".tsx"]) return resolved + ".tsx";
    if (files[resolved + ".ts"]) return resolved + ".ts";
    if (files[resolved + ".jsx"]) return resolved + ".jsx";
    if (files[resolved + ".js"]) return resolved + ".js";
    return null;
  };
}

describe("analyzeProject", () => {
  it("marks exported props as static when all importers pass static values", () => {
    const files: Record<string, string> = {
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
      `,
      "/project/Parent.tsx": `
        import { Child } from "./Child";
        const Parent = () => <Child title="Hello" />;
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set());
  });

  it("marks exported props as reactive when an importer passes a reactive value", () => {
    const files: Record<string, string> = {
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
      `,
      "/project/Parent.tsx": `
        import { cc } from "sinwan/component";
        import { Child } from "./Child";
        import { signal } from "sinwan/reactivity";
        const Parent = cc(() => {
          const title = signal("Hello");
          return <Child title={title.value} />;
        });
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set(["title"]));
  });

  it("propagates reactivity transitively across files", () => {
    const files: Record<string, string> = {
      "/project/GrandChild.tsx": `
        import { cc } from "sinwan/component";
        export const GrandChild = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
      `,
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        import { GrandChild } from "./GrandChild";
        export const Child = cc(({ title }) => {
          return <GrandChild title={title} />;
        });
      `,
      "/project/Parent.tsx": `
        import { cc } from "sinwan/component";
        import { Child } from "./Child";
        import { signal } from "sinwan/reactivity";
        const Parent = cc(() => {
          const title = signal("Hello");
          return <Child title={title.value} />;
        });
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const grandChildProps = project.reactiveProps
      .get("/project/GrandChild.tsx")
      ?.get("GrandChild");
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set(["title"]));
    expect(grandChildProps).toEqual(new Set(["title"]));
  });

  it("handles default exported components", () => {
    const files: Record<string, string> = {
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        export default cc(({ title }) => {
          return <h1>{title}</h1>;
        });
      `,
      "/project/Parent.tsx": `
        import Child from "./Child";
        const Parent = () => <Child title="Hello" />;
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("default");
    expect(childProps).toEqual(new Set());
  });

  it("resolves tsconfig path aliases", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-tsconfig-"));
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
      const project = analyzeProject({
        root: tmpDir,
        tsConfigPath: path.join(tmpDir, "tsconfig.json"),
      });
      const childProps = project.reactiveProps
        .get(path.join(tmpDir, "src", "components", "Child.tsx"))
        ?.get("Child");
      expect(childProps).toEqual(new Set());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves bunfig.toml aliases", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-bunfig-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "bunfig.toml"),
        `[install]\nalias = { "@components": "src/components" }\n`,
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
        import { Child } from "@components/Child";
        const Parent = cc(() => {
          return <Child title="Hello" />;
        });
      `,
      );
      const project = analyzeProject({
        root: tmpDir,
        bunfigPath: path.join(tmpDir, "bunfig.toml"),
      });
      const childProps = project.reactiveProps
        .get(path.join(tmpDir, "src", "components", "Child.tsx"))
        ?.get("Child");
      expect(childProps).toEqual(new Set());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves bunfig.toml [install.alias] table", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-bunfig2-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "bunfig.toml"),
        `[install.alias]\n"@components" = "src/components"\n`,
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
        import { Child } from "@components/Child";
        const Parent = cc(() => {
          return <Child title="Hello" />;
        });
      `,
      );
      const project = analyzeProject({
        root: tmpDir,
        bunfigPath: path.join(tmpDir, "bunfig.toml"),
      });
      const childProps = project.reactiveProps
        .get(path.join(tmpDir, "src", "components", "Child.tsx"))
        ?.get("Child");
      expect(childProps).toEqual(new Set());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats object-literal spreads as named props", () => {
    const files: Record<string, string> = {
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title, count }) => {
          return <h1>{title} {count}</h1>;
        });
      `,
      "/project/Parent.tsx": `
        import { cc } from "sinwan/component";
        import { signal } from "sinwan/reactivity";
        import { Child } from "./Child";
        const Parent = cc(() => {
          const s = signal(0);
          return <Child {...{ title: "Hello", count: s.value }} />;
        });
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set(["count"]));
  });

  it("resolves local object-literal variables in spreads", () => {
    const files: Record<string, string> = {
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title, count }) => {
          return <h1>{title} {count}</h1>;
        });
      `,
      "/project/Parent.tsx": `
        import { cc } from "sinwan/component";
        import { signal } from "sinwan/reactivity";
        import { Child } from "./Child";
        const Parent = cc(() => {
          const s = signal(0);
          const props = { title: "Hello", count: s.value };
          return <Child {...props} />;
        });
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set(["count"]));
  });

  it("falls back to conservative spread when the spread value is unknown", () => {
    const files: Record<string, string> = {
      "/project/Child.tsx": `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title, count }) => {
          return <h1>{title} {count}</h1>;
        });
      `,
      "/project/Parent.tsx": `
        import { cc } from "sinwan/component";
        import { Child } from "./Child";
        const Parent = cc((props) => {
          return <Child {...props} />;
        });
      `,
    };
    const project = analyzeProject({
      root: "/project",
      resolve: resolve(files),
      files,
    });
    const childProps = project.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set(["title", "count", "children"]));
  });

  it("resolves components from workspace packages", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-workspace-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "apps", "web", "src"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(tmpDir, "packages", "ui", "src"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({
          name: "monorepo",
          workspaces: ["apps/*", "packages/*"],
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "packages", "ui", "package.json"),
        JSON.stringify({ name: "@sinwan/ui", version: "1.0.0" }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "packages", "ui", "src", "Button.tsx"),
        `
        import { cc } from "sinwan/component";
        export const Button = cc(({ label }) => {
          return <button>{label}</button>;
        });
      `,
      );
      fs.writeFileSync(
        path.join(tmpDir, "apps", "web", "src", "App.tsx"),
        `
        import { cc } from "sinwan/component";
        import { signal } from "sinwan/reactivity";
        import { Button } from "@sinwan/ui/Button";
        const App = cc(() => {
          const s = signal("Click");
          return <Button label={s.value} />;
        });
      `,
      );

      const project = analyzeProject({
        root: path.join(tmpDir, "apps", "web"),
        workspaces: path.join(tmpDir, "package.json"),
      });
      const buttonProps = project.reactiveProps
        .get(path.join(tmpDir, "packages", "ui", "src", "Button.tsx"))
        ?.get("Button");
      expect(buttonProps).toEqual(new Set(["label"]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves components from pnpm-workspace.yaml", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-pnpm-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "app", "src"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "lib", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'lib'\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, "lib", "package.json"),
        JSON.stringify({ name: "lib-ui", version: "1.0.0" }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "lib", "src", "Icon.tsx"),
        `
        import { cc } from "sinwan/component";
        export const Icon = cc(({ name }) => {
          return <i>{name}</i>;
        });
      `,
      );
      fs.writeFileSync(
        path.join(tmpDir, "app", "src", "App.tsx"),
        `
        import { cc } from "sinwan/component";
        import { signal } from "sinwan/reactivity";
        import { Icon } from "lib-ui/Icon";
        const App = cc(() => {
          const s = signal("star");
          return <Icon name={s.value} />;
        });
      `,
      );

      const project = analyzeProject({
        root: path.join(tmpDir, "app"),
        workspaces: path.join(tmpDir, "pnpm-workspace.yaml"),
      });
      const iconProps = project.reactiveProps
        .get(path.join(tmpDir, "lib", "src", "Icon.tsx"))
        ?.get("Icon");
      expect(iconProps).toEqual(new Set(["name"]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves components from explicit workspace package paths", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sinwan-ws-explicit-"),
    );
    try {
      fs.mkdirSync(path.join(tmpDir, "app", "src"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "shared", "src"), { recursive: true });
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
        import { signal } from "sinwan/reactivity";
        import { Badge } from "shared-ui/Badge";
        const Page = cc(() => {
          const s = signal("New");
          return <Badge text={s.value} />;
        });
      `,
      );

      const project = analyzeProject({
        root: path.join(tmpDir, "app"),
        workspaces: [path.join(tmpDir, "shared")],
      });
      const badgeProps = project.reactiveProps
        .get(path.join(tmpDir, "shared", "src", "Badge.tsx"))
        ?.get("Badge");
      expect(badgeProps).toEqual(new Set(["text"]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
