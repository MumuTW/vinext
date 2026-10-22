import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import { createIsolatedFixture } from "./helpers.js";

describe("production Google Fonts with extensionless URLs", () => {
  // Google Fonts can serve WOFF2 from /l/font?kit=... rather than a .woff2 path.
  // Ported from Next.js' production asset and preload checks:
  // https://github.com/vercel/next.js/blob/98a73ead5bf711183e07398983c5c943f86328e7/test/e2e/app-dir/next-font-extensionless/next-font-extensionless.test.ts
  const googleFontUrl =
    "https://fonts.gstatic.com/l/font?kit=extensionless%2Bfont&skey=first%26second&v=1#font";
  const fontBytesPath = path.resolve(
    import.meta.dirname,
    "fixtures/app-basic/app/script-nonce/with-next-font/font.woff2",
  );
  let fontBytes: Buffer;
  let root: string;
  let server: http.Server | undefined;
  let baseUrl: string;
  const downloads: string[] = [];

  beforeAll(async () => {
    root = await createIsolatedFixture(
      path.resolve(import.meta.dirname, "fixtures/font-google-multiple"),
      "vinext-extensionless-font-",
      (src) => ![".vinext", "dist"].includes(path.basename(src)),
    );
    fontBytes = await fs.readFile(fontBytesPath);
    await fs.writeFile(
      path.join(root, "app/layout.tsx"),
      `import { Geist } from 'next/font/google';
const font = Geist({ subsets: ['latin'] });
export default function Layout({ children }) {
  return <html><body className={font.className}>{children}</body></html>;
}`,
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://fonts.googleapis.com/")) {
        return new Response(
          `/* latin */\n@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(${googleFontUrl}) format('woff2');
}`,
          { headers: { "content-type": "text/css" } },
        );
      }
      if (url.startsWith("https://fonts.gstatic.com/")) {
        downloads.push(url);
        return new Response(new Uint8Array(fontBytes), {
          headers: { "content-type": "font/woff2" },
        });
      }
      return originalFetch(input, init);
    };
    try {
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root })],
        logLevel: "silent",
        build: { assetsInlineLimit: 0 },
      });
      await builder.buildApp();
    } finally {
      globalThis.fetch = originalFetch;
    }
    ({ server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
    }));
    const address = server!.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start the extensionless-font production fixture");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 15000);

  it("downloads the complete upstream URL and serves the same font bytes locally", async () => {
    expect(downloads).toContain(googleFontUrl);
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const fontUrl = html.match(/url\((\/_next\/static\/_vinext_fonts\/[^)]+)\)/)?.[1];
    expect(fontUrl).toBeDefined();
    expect(html).not.toContain("fonts.gstatic.com");
    const fontResponse = await fetch(`${baseUrl}${fontUrl}`);
    expect(fontResponse.status).toBe(200);
    expect(Buffer.from(await fontResponse.arrayBuffer())).toEqual(fontBytes);
    expect(fontResponse.headers.get("cache-control")).toContain("immutable");
  });

  it("serves WOFF2 with matching HTML and HTTP preload MIME types", async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    const preload = html.match(/<link rel="preload"[^>]*as="font"[^>]*>/)?.[0];
    expect(preload).toBeDefined();
    const fontUrl = preload!.match(/href="([^"]+)"/)?.[1];
    expect(fontUrl).toBeDefined();
    expect(html).toContain(`url(${fontUrl}) format('woff2')`);
    const fontResponse = await fetch(`${baseUrl}${fontUrl}`);
    expect(fontResponse.status).toBe(200);
    expect.soft(fontResponse.headers.get("content-type")).toBe("font/woff2");
    expect.soft(preload).toContain('type="font/woff2"');
    expect
      .soft(response.headers.get("link"))
      .toContain(`<${fontUrl}>; rel=preload; as=font; type=font/woff2`);
  });
});
