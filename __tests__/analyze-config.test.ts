// Analyzer configuration paths without a test before: bunfig.toml aliases
// (inline and section forms), exact tsconfig paths, JSX children passed to
// imported components, workspace discovery (package.json, pnpm-workspace.yaml,
// globs, package `source`), unreadable inputs, cache restore and the CLI
// output directory.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AnalyzerCache, analyze, analyzeProject, loadWorkspacePackages } from "../src/analyze";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `files` (relative paths) into a fresh directory and returns it. */
function fixture(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sinwan-analyze-")));
  dirs.push(root);
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const component = (name: string, prop = "label") =>
  `import { cc } from "sinwan/component";\nexport const ${name} = cc((props: { ${prop}: string }) => <p>{props.${prop}}</p>);\n`;

const parent = (imports: string, jsx: string) => `import { cc } from "sinwan/component";
import { signal } from "sinwan/reactivity";
${imports}
export const Page = cc(() => {
  const title = signal("a");
  const other = signal("b");
  return <main>${jsx}</main>;
});
`;

const reactive = (root: string, file: string, name: string) =>
  [...(analyzeProject({ root, bunfigPath: path.join(root, "bunfig.toml"), tsConfigPath: path.join(root, "tsconfig.json") }).reactiveProps.get(path.join(root, file))?.get(name) ?? [])];

describe("bunfig.toml aliases", () => {
  test("inline [install] alias objects and [install.alias] entries resolve exact and nested imports", () => {
    const root = fixture({
      "bunfig.toml": `# app aliases
[install]
alias = { "@ui" = "./src/ui", '#lib' = "./src/lib", "skip", "q" = "a,b" }

[install.alias]
"@x" = './src/x'
plain = src/plain
noequals
`,
      "tsconfig.json": "{}",
      "src/ui/index.tsx": component("Button"),
      "src/ui/Card.tsx": component("Card"),
      "src/lib/index.tsx": component("Lib"),
      "src/x.tsx": component("X"),
      "src/plain.tsx": component("Plain"),
      "src/Page.tsx": parent(
        `import { Missing } from "@ui/Missing";\nimport { Ghost } from "./Ghost";\nimport { Button } from "@ui";\nimport { Card } from "@ui/Card";\nimport { Lib } from "#lib";\nimport { X } from "@x";\nimport { Plain } from "plain";`,
        `<Missing label={title.value} /><Ghost label={title.value} /><Button label={title.value} /><Card label={title.value} /><Lib label={title.value} /><X label={title.value} /><Plain label={title.value} />`,
      ),
    });
    expect(reactive(root, "src/ui/index.tsx", "Button")).toEqual(["label"]);
    expect(reactive(root, "src/ui/Card.tsx", "Card")).toEqual(["label"]);
    expect(reactive(root, "src/lib/index.tsx", "Lib")).toEqual(["label"]);
    expect(reactive(root, "src/x.tsx", "X")).toEqual(["label"]);
    expect(reactive(root, "src/plain.tsx", "Plain")).toEqual(["label"]);
  });

  test("a missing or alias-less bunfig is ignored", () => {
    const root = fixture({ "bunfig.toml": "[test]\nroot = \".\"\n", "src/Page.tsx": parent("", "") });
    expect(() => analyzeProject({ root, bunfigPath: path.join(root, "bunfig.toml") })).not.toThrow();
    expect(() => analyzeProject({ root, bunfigPath: path.join(root, "missing.toml") })).not.toThrow();
  });
});

describe("tsconfig paths", () => {
  test("an exact (non-wildcard) path maps one specifier", () => {
    const root = fixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@card": ["./src/card/Card"] } } }),
      "src/card/Card.tsx": component("Card"),
      "src/Page.tsx": parent(`import { Card } from "@card";`, `<Card label={title.value} />`),
    });
    expect(reactive(root, "src/card/Card.tsx", "Card")).toEqual(["label"]);
  });
});

describe("JSX children of imported components", () => {
  test("one or several expression children make `children` reactive", () => {
    const root = fixture({
      "tsconfig.json": "{}",
      "src/Box.tsx": component("Box", "children"),
      "src/List.tsx": component("List", "children"),
      "src/Page.tsx": parent(
        `import { Box } from "./Box";\nimport { List } from "./List";`,
        `<Box>{title.value}</Box><List>{title.value}{other.value}{/* note */}</List>`,
      ),
    });
    expect(reactive(root, "src/Box.tsx", "Box")).toEqual(["children"]);
    expect(reactive(root, "src/List.tsx", "List")).toEqual(["children"]);
  });
});

describe("workspaces", () => {
  const packages = {
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", source: "lib/index.ts" }),
    "packages/ui/lib/Badge.tsx": component("Badge"),
    "packages/ui/lib/index.ts": `export { Badge } from "./Badge";\n`,
    "packages/kit/package.json": JSON.stringify({ name: "@acme/kit" }),
    "packages/kit/src/Chip.tsx": component("Chip"),
    "packages/kit/src/index.ts": `export { Chip as KitChip } from "./Chip";\n`,
    "packages/broken/package.json": "{ not json",
    "packages/nameless/package.json": "{}",
    "packages/notes.md": "not a package",
  };

  test("package.json, pnpm-workspace.yaml, globs and include lists", () => {
    const root = fixture({
      ...packages,
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "bad/package.json": "{ not json",
      "pnpm-workspace.yaml": `# workspace\npackages:\n  - "packages/ui"\n  - 'packages/kit'\n\nother:\n  - ignored\n`,
      "README.md": "readme",
    });
    const sorted = (list: string[]) => list.map((dir) => path.relative(root, dir)).sort();
    const all = ["packages/broken", "packages/kit", "packages/nameless", "packages/ui"];
    expect(sorted(loadWorkspacePackages("package.json", root))).toEqual(all);
    expect(sorted(loadWorkspacePackages("pnpm-workspace.yaml", root))).toEqual(["packages/kit", "packages/ui"]);
    expect(sorted(loadWorkspacePackages("packages/*", root))).toEqual(all);
    expect(sorted(loadWorkspacePackages("packages/ui", root))).toEqual(["packages/ui"]);
    expect(sorted(loadWorkspacePackages("README.md", root))).toEqual([]);
    expect(sorted(loadWorkspacePackages(["packages/kit"], root))).toEqual(["packages/kit"]);
    expect(sorted(loadWorkspacePackages({ file: "pnpm-workspace.yaml", include: ["packages/broken"] }, root))).toEqual([
      "packages/broken",
      "packages/kit",
      "packages/ui",
    ]);
    expect(sorted(loadWorkspacePackages({ file: "package.json" }, root))).toEqual(all);
    expect(loadWorkspacePackages({ file: "bad/package.json" }, root)).toEqual([]);
    expect(loadWorkspacePackages({ file: "missing/pnpm-workspace.yaml" }, root)).toEqual([]);
    expect(loadWorkspacePackages({ file: "other.json" }, root)).toEqual([]);
    expect(loadWorkspacePackages("missing/*", root)).toEqual([]);
  });

  test("imports resolve through the package `source` entry, else `src/`", () => {
    const root = fixture({
      ...packages,
      "tsconfig.json": "{}",
      "app/Page.tsx": parent(
        `import { Badge } from "@acme/ui/Badge";\nimport { Chip } from "@acme/kit/Chip";\nimport { KitChip } from "@acme/kit";`,
        `<Badge label={title.value} /><Chip label={title.value} /><KitChip label={title.value} />`,
      ),
    });
    const props = analyzeProject({ root, workspaces: ["packages/*"] }).reactiveProps;
    expect([...(props.get(path.join(root, "packages/ui/lib/Badge.tsx"))?.get("Badge") ?? [])]).toEqual(["label"]);
    expect([...(props.get(path.join(root, "packages/kit/src/Chip.tsx"))?.get("Chip") ?? [])]).toEqual(["label"]);
  });
});

describe("unreadable inputs", () => {
  test("a missing root and an imported file that does not parse are skipped", () => {
    expect(analyzeProject({ root: path.join(os.tmpdir(), "sinwan-missing-root-dir") }).modules.size).toBe(0);
    const root = fixture({
      "src/Broken.tsx": "export const = <;",
      "src/Box.tsx": component("Box"),
    });
    const page = path.join(root, "src/Page.tsx");
    // Only the page is given; its imports are analyzed on demand.
    const project = analyzeProject({
      root,
      files: { [page]: parent(`import { Box } from "./Box";\nimport { Broken } from "./Broken";`, `<Box label={title.value} /><Broken />`) },
    });
    expect([...(project.reactiveProps.get(path.join(root, "src/Box.tsx"))?.get("Box") ?? [])]).toEqual(["label"]);
    expect(project.modules.has(path.join(root, "src/Broken.tsx"))).toBe(false);
  });
});

describe("AnalyzerCache persistence", () => {
  test("restores default exports, drops deleted files and ignores a corrupt cache", () => {
    const root = fixture({
      "src/Card.tsx": `import { cc } from "sinwan/component";\nconst Card = cc((props: { label: string }) => <p>{props.label}</p>);\nexport default Card;\n`,
      "src/Gone.tsx": component("Gone"),
    });
    const cachePath = path.join(root, ".sinwan", "nested", "cache.json");
    const first = new AnalyzerCache({ root, cachePath });
    for (const file of ["src/Card.tsx", "src/Gone.tsx"]) first.update(path.join(root, file), fs.readFileSync(path.join(root, file), "utf8"));
    first.save();
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(path.join(root, "src/Gone.tsx"));
    const restored = new AnalyzerCache({ root, cachePath });
    const page = path.join(root, "src/Page.tsx");
    restored.update(page, parent(`import Card from "./Card";`, `<Card label={title.value} />`));
    expect([...(restored.reactiveProps.get(path.join(root, "src/Card.tsx"))?.get("default") ?? [])]).toEqual(["label"]);

    fs.writeFileSync(cachePath, "{ not json");
    expect(() => new AnalyzerCache({ root, cachePath })).not.toThrow();
  });
});

describe("analyze CLI output", () => {
  test("creates the output directory", () => {
    const root = fixture({ "src/Box.tsx": component("Box") });
    const outFile = path.join(root, "out", "deep", "meta.json");
    analyze({ root, outFile });
    // A component without known callers keeps every prop reactive ("*").
    expect(JSON.parse(fs.readFileSync(outFile, "utf8"))).toEqual({ [path.join(root, "src/Box.tsx")]: { Box: ["*"] } });
  });
});
