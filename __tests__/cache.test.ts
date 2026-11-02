import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AnalyzerCache } from "../src/analyze";

describe("AnalyzerCache", () => {
  it("updates reactive props incrementally", () => {
    const cache = new AnalyzerCache({ root: "/project" });
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const parentCode = `
      import { cc } from "sinwan/component";
      import { Child } from "./Child";
      const Parent = cc(() => {
        return <Child title="Hello" />;
      });
    `;
    cache.update("/project/Child.tsx", childCode);
    cache.update("/project/Parent.tsx", parentCode);
    const childProps = cache.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set());
  });

  it("recomputes when a caller changes to pass a reactive value", () => {
    const cache = new AnalyzerCache({ root: "/project" });
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const parentCode = `
      import { cc } from "sinwan/component";
      import { Child } from "./Child";
      const Parent = cc(() => {
        return <Child title="Hello" />;
      });
    `;
    cache.update("/project/Child.tsx", childCode);
    cache.update("/project/Parent.tsx", parentCode);

    const reactiveParentCode = `
      import { cc } from "sinwan/component";
      import { Child } from "./Child";
      import { signal } from "sinwan/reactivity";
      const Parent = cc(() => {
        const title = signal("Hello");
        return <Child title={title.value} />;
      });
    `;
    cache.update("/project/Parent.tsx", reactiveParentCode);
    const childProps = cache.reactiveProps
      .get("/project/Child.tsx")
      ?.get("Child");
    expect(childProps).toEqual(new Set(["title"]));
  });

  it("persists and restores the cache across instances", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-persist-"));
    try {
      const childFile = path.join(tmpDir, "Child.tsx");
      const parentFile = path.join(tmpDir, "Parent.tsx");
      const cachePath = path.join(tmpDir, "cache.json");
      const childCode = `
        import { cc } from "sinwan/component";
        export const Child = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
      `;
      const parentCode = `
        import { cc } from "sinwan/component";
        import { Child } from "./Child";
        const Parent = cc(() => {
          return <Child title="Hello" />;
        });
      `;
      fs.writeFileSync(childFile, childCode);
      fs.writeFileSync(parentFile, parentCode);

      const cache1 = new AnalyzerCache({ root: tmpDir, cachePath });
      cache1.update(childFile, childCode);
      cache1.update(parentFile, parentCode);
      expect(cache1.reactiveProps.get(childFile)?.get("Child")).toEqual(
        new Set(),
      );
      // Rewritten on every transform, so it is stored without indentation.
      expect(fs.readFileSync(cachePath, "utf-8")).not.toContain("\n");

      const cache2 = new AnalyzerCache({ root: tmpDir, cachePath });
      expect(cache2.modules.has(childFile)).toBe(true);
      expect(cache2.modules.has(parentFile)).toBe(true);
      expect(cache2.reactiveProps.get(childFile)?.get("Child")).toEqual(
        new Set(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists and restores workspace modules across instances", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-ws-persist-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "app", "src"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "shared", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "shared", "package.json"),
        JSON.stringify({ name: "shared-ui", version: "1.0.0" }),
      );
      const badgeFile = path.join(tmpDir, "shared", "src", "Badge.tsx");
      const pageFile = path.join(tmpDir, "app", "src", "Page.tsx");
      const cachePath = path.join(tmpDir, "cache.json");
      fs.writeFileSync(
        badgeFile,
        `
        import { cc } from "sinwan/component";
        export const Badge = cc(({ text }) => {
          return <span>{text}</span>;
        });
      `,
      );
      fs.writeFileSync(
        pageFile,
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

      const cache1 = new AnalyzerCache({
        root: path.join(tmpDir, "app"),
        cachePath,
        workspaces: [path.join(tmpDir, "shared")],
      });
      cache1.update(badgeFile, fs.readFileSync(badgeFile, "utf-8"));
      cache1.update(pageFile, fs.readFileSync(pageFile, "utf-8"));
      expect(cache1.reactiveProps.get(badgeFile)?.get("Badge")).toEqual(
        new Set(["text"]),
      );

      const cache2 = new AnalyzerCache({
        root: path.join(tmpDir, "app"),
        cachePath,
        workspaces: [path.join(tmpDir, "shared")],
      });
      expect(cache2.modules.has(badgeFile)).toBe(true);
      expect(cache2.modules.has(pageFile)).toBe(true);
      expect(cache2.reactiveProps.get(badgeFile)?.get("Badge")).toEqual(
        new Set(["text"]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists same-file component call graphs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-local-call-"));
    try {
      const appFile = path.join(tmpDir, "App.tsx");
      const cachePath = path.join(tmpDir, "cache.json");
      const code = `
        import { cc } from "sinwan/component";
        import { signal } from "sinwan/reactivity";
        const Child = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
        export const App = cc(() => {
          const title = signal("Hi");
          return <Child title={title.value} />;
        });
      `;
      fs.writeFileSync(appFile, code);
      const cache1 = new AnalyzerCache({ root: tmpDir, cachePath });
      cache1.update(appFile, code);
      expect(cache1.modules.get(appFile)?.localCallGraph.size).toBeGreaterThan(
        0,
      );

      const cache2 = new AnalyzerCache({ root: tmpDir, cachePath });
      expect(cache2.modules.has(appFile)).toBe(true);
      expect(cache2.modules.get(appFile)?.localCallGraph.size).toBeGreaterThan(
        0,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips a cached module when the file no longer matches serialized functions", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-stale-"));
    try {
      const appFile = path.join(tmpDir, "App.tsx");
      const cachePath = path.join(tmpDir, "cache.json");
      const code = `
        import { cc } from "sinwan/component";
        const Child = cc(({ title }) => {
          return <h1>{title}</h1>;
        });
        export const App = cc(() => {
          return <Child title="Hi" />;
        });
      `;
      fs.writeFileSync(appFile, code);
      const cache1 = new AnalyzerCache({ root: tmpDir, cachePath });
      cache1.update(appFile, code);
      fs.writeFileSync(
        appFile,
        `
        import { cc } from "sinwan/component";
        export const App = cc(() => {
          return <p>gone</p>;
        });
      `,
      );
      const cache2 = new AnalyzerCache({ root: tmpDir, cachePath });
      expect(cache2.modules.has(appFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes a module and recomputes importers", () => {
    const cache = new AnalyzerCache({ root: "/project" });
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const parentCode = `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      import { Child } from "./Child";
      const Parent = cc(() => {
        const title = signal("Hello");
        return <Child title={title.value} />;
      });
    `;
    cache.update("/project/Child.tsx", childCode);
    cache.update("/project/Parent.tsx", parentCode);
    expect(cache.reactiveProps.get("/project/Child.tsx")?.get("Child")).toEqual(
      new Set(["title"]),
    );
    cache.remove("/project/Parent.tsx");
    expect(cache.modules.has("/project/Parent.tsx")).toBe(false);
    // No caller left to learn from: every prop stays possibly reactive.
    expect(cache.reactiveProps.get("/project/Child.tsx")?.get("Child")).toEqual(
      new Set(["title", "children"]),
    );
  });

  it("resolves in-memory index files for relative imports", () => {
    const cache = new AnalyzerCache({ root: "/project" });
    const childCode = `
      import { cc } from "sinwan/component";
      export const Child = cc(({ title }) => {
        return <h1>{title}</h1>;
      });
    `;
    const parentCode = `
      import { cc } from "sinwan/component";
      import { Child } from "./ui";
      const Parent = cc(() => {
        return <Child title="Hello" />;
      });
    `;
    cache.update("/project/ui/index.tsx", childCode);
    cache.update("/project/Parent.tsx", parentCode);
    expect(cache.reactiveProps.get("/project/ui/index.tsx")?.get("Child")).toEqual(
      new Set(),
    );
  });

  it("ignores missing files discovered through importers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-missing-"));
    try {
      const parentFile = path.join(tmpDir, "Parent.tsx");
      const ghostFile = path.join(tmpDir, "Ghost.tsx");
      const cache = new AnalyzerCache({
        root: tmpDir,
        resolve: (source) => (source === "./Ghost" ? ghostFile : null),
      });
      cache.update(
        parentFile,
        `
        import { cc } from "sinwan/component";
        import { Ghost } from "./Ghost";
        const Parent = cc(() => {
          return <Ghost />;
        });
      `,
      );
      expect(cache.modules.has(ghostFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("follows a barrel the bundler never loads (plain .ts), in bundler order", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-barrel-"));
    const write = (rel: string, code: string) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, code);
      return file;
    };
    const card = write(
      "ui/card.tsx",
      `
      import { cc } from "sinwan/component";
      const Inner = cc((props) => <p>{props.value}</p>);
      export const Card = cc((props) => <Inner value={props.value} />);
    `,
    );
    write("ui/index.ts", `export { Card } from "./card";`);
    const page = write(
      "Page.tsx",
      `
      import { cc } from "sinwan/component";
      import { signal } from "sinwan/reactivity";
      import { Card } from "./ui";
      const Page = cc(() => {
        const value = signal(1);
        return <Card value={value.value} />;
      });
    `,
    );
    const cachePath = path.join(dir, ".sinwan/cache.json");
    try {
      const cache = new AnalyzerCache({ root: dir, cachePath });
      // The plugin only loads .tsx files: the importer first, then the component.
      cache.update(page, fs.readFileSync(page, "utf-8"));
      cache.update(card, fs.readFileSync(card, "utf-8"));
      expect(cache.reactiveProps.get(card)?.get("Card")).toEqual(new Set(["value"]));

      // The barrel links the component back to its importer: editing the
      // component recomputes with the page's call site still in the graph.
      cache.update(card, fs.readFileSync(card, "utf-8") + "\n");
      expect(cache.reactiveProps.get(card)?.get("Card")).toEqual(new Set(["value"]));

      // The re-exports survive a save and restore.
      const restored = new AnalyzerCache({ root: dir, cachePath });
      expect(restored.modules.get(path.join(dir, "ui/index.ts"))?.reExports).toEqual([
        { exported: "Card", source: "./card", imported: "Card" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a cache written by an older format", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-cache-v1-"));
    const cachePath = path.join(dir, "cache.json");
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ version: 1, modules: {}, reactiveProps: { "/x.tsx": { X: [] } } }),
      );
      const cache = new AnalyzerCache({ root: dir, cachePath });
      expect(cache.reactiveProps.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
