import { describe, expect, test } from "bun:test";

import { BunOnlyImageError, ImageTransformError, parseImageQueryForTest, transformJSX } from "./support/image-transform";

const bun = { images: { host: "bun" as const } };
const compile = (code: string, options: Parameters<typeof transformJSX>[2] = bun) => transformJSX(code, "/app/src/Hero.tsx", options).code;

/** The `?sinwan-img=` specifiers in compiled code, decoded. */
function imageImports(code: string) {
  return [...code.matchAll(/from\s+"([^"]*\?sinwan-img=[^"]*)"/g)].map((match) => parseImageQueryForTest(match[1] ?? ""));
}

describe("<Img> compile pass", () => {
  test("rewrites a literal src to an optimized asset import, keeping the props", () => {
    const out = compile(`
      import { Img } from "sinwan/image";
      export const Hero = () => <Img src="./hero.jpg" alt="Hero" width={1200} height={800} quality={85} format="webp" fit="cover" loading="lazy" />;
    `);
    expect(imageImports(out)).toEqual([
      { file: "./hero.jpg", options: { width: 1200, height: 800, quality: 85, format: "webp", fit: "cover" } },
    ]);
    expect(out).toContain("_$sinwanImg0");
    expect(out).not.toContain('"./hero.jpg"');
  });

  test("handles aliases, imported image identifiers, public paths, template literals and dedupes", () => {
    const out = compile(`
      import { Img as Picture } from "sinwan/image";
      import shop from "@/assets/shop.png";
      import data from "./data.json";
      export const A = () => (
        <div>
          <Picture src={shop} alt="" sizes="50vw" densities={[1, 2]} placeholder="blur" aspectRatio={16 / 9} />
          <Picture src={\`/photos/a.webp\`} alt="" priority />
          <Picture src="/photos/a.webp" alt="" />
          <Picture src={("./b.avif" as string)} alt="" width={-(-10)} />
          <Picture src={data} alt="" />
        </div>
      );
    `);
    const imports = imageImports(out);
    expect(imports).toEqual([
      { file: "@/assets/shop.png", options: { sizes: "50vw", densities: [1, 2], placeholder: "blur", aspectRatio: 16 / 9 } },
      { file: "/photos/a.webp", options: {} },
      { file: "./b.avif", options: { width: 10 } },
    ]);
    expect(out.match(/_\$sinwanImg1/g)?.length).toBe(3);
    expect(out).toContain("src={data}");
  });

  test("leaves dynamic, remote, inline and unoptimized sources alone", () => {
    const out = compile(`
      import { Img } from "sinwan/image";
      export const A = (props) => (
        <div>
          <Img src={props.url} alt="" width={400} />
          <Img src="https://cdn.test/x.jpg" alt="" width={400} />
          <Img src="//cdn.test/x.jpg" alt="" width={400} />
          <Img src="data:image/png;base64,AA" alt="" width={1} />
          <Img src="./logo.svg" alt="" unoptimized />
          <Img src="./photo.jpg" alt="" unoptimized={true} />
          <Img src={\`./\${props.name}.jpg\`} alt="" />
          <Img alt="no src" />
          <img src="./plain.jpg" />
        </div>
      );
    `);
    expect(imageImports(out)).toEqual([]);
    const optimizedAnyway = compile(`
      import { Img } from "sinwan/image";
      export const A = () => <Img src="./photo.jpg" alt="" unoptimized={false} />;
    `);
    expect(imageImports(optimizedAnyway)).toHaveLength(1);
  });

  test("files without <Img> from sinwan/image are untouched", () => {
    expect(compile(`import { Img } from "./my-img"; export const A = () => <Img src="./a.jpg" />;`)).not.toContain("sinwan-img");
    expect(compile(`import type { Img } from "sinwan/image"; export const A = () => <div />;`, {})).not.toContain("sinwan-img");
    expect(compile(`import { type Img, Show } from "sinwan/image"; export const A = () => <Img src="./a.jpg" />;`)).not.toContain("sinwan-img");
  });

  test("dynamic optimization props and invalid values are compile errors with a location", () => {
    expect(() =>
      compile(`import { Img } from "sinwan/image";
export const A = (p) => <Img src="./a.jpg" alt="" quality={p.q} />;`),
    ).toThrow(/\/app\/src\/Hero\.tsx:2:\d+: <Img> prop "quality" must be a static value/);
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.jpg" alt="" densities={[1, x]} />;`)).toThrow(ImageTransformError);
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.jpg" alt="" width={-x} />;`)).toThrow(ImageTransformError);
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.jpg" alt="" aspectRatio={a / 2} />;`)).toThrow(ImageTransformError);
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.jpg" alt="" sizes={\`\${a}vw\`} />;`)).toThrow(ImageTransformError);
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.jpg" alt="" densities={[1, , 2]} />;`)).toThrow(ImageTransformError);
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.jpg" alt="" quality={500} />;`)).toThrow(
      '<Img> "quality" must be an integer from 1 to 100',
    );
    expect(() => compile(`import { Img } from "sinwan/image"; export const A = () => <Img src="./a.gif" alt="" />;`)).toThrow(
      '"./a.gif" is not one. Add `unoptimized`',
    );
  });

  test("any <Img> outside Bun's bundler is refused", () => {
    const code = `import { Img } from "sinwan/image"; export const A = (p) => <Img src={p.url} alt="" width={10} />;`;
    expect(() => compile(code, { images: { host: "vite" } })).toThrow(BunOnlyImageError);
    expect(() => compile(code, { images: { host: "vite" } })).toThrow("while compiling with Vite on Node. Start Vite on Bun: `bunx --bun vite`");
    expect(() => compile(code, {})).toThrow("while compiling for a non-Bun host");
    expect(() => compile(code, { images: { host: "other" } })).toThrow(BunOnlyImageError);
    expect(() => compile(code)).not.toThrow();
  });
});
