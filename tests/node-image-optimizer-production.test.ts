import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  getImageOptimizer,
  setImageOptimizer,
} from "../packages/vinext/src/server/image-optimization.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const SOURCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

function serverOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe.each(["app", "pages"] as const)(
  "%s Node production configured image optimizer",
  (router) => {
    let fixtureDir: string | undefined;
    let upstream: Server | undefined;
    let server: Server | undefined;
    let baseUrl: string;
    const upstreamCredentials: boolean[] = [];

    beforeAll(async () => {
      setImageOptimizer(null);
      upstream = createServer((req, res) => {
        upstreamCredentials.push(Boolean(req.headers.cookie || req.headers.authorization));
        if (req.url?.startsWith("/not-image")) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("not an image");
        } else {
          res.writeHead(req.url === "/missing.png" ? 404 : 200, { "Content-Type": "image/png" });
          res.end(SOURCE_PNG);
        }
      });
      await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
      const upstreamUrl = serverOrigin(upstream);

      fixtureDir = await fs.mkdtemp(
        path.join(import.meta.dirname, `.tmp-${router}-image-optimizer-`),
      );
      await fs.mkdir(path.join(fixtureDir, router));
      await fs.mkdir(path.join(fixtureDir, "public"));
      await fs.mkdir(path.join(fixtureDir, "node_modules"));
      await fs.symlink(
        path.resolve(import.meta.dirname, "../packages/vinext"),
        path.join(fixtureDir, "node_modules/vinext"),
        "junction",
      );
      await fs.writeFile(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({ name: `vinext-${router}-image-optimizer`, private: true, type: "module" }),
      );
      if (router === "app") {
        await fs.writeFile(
          path.join(fixtureDir, "app/layout.jsx"),
          "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
        );
      }
      await fs.writeFile(
        path.join(fixtureDir, router === "app" ? "app/page.jsx" : "pages/index.jsx"),
        "export default function Page() { return <p>image optimizer fixture</p>; }\n",
      );
      await fs.writeFile(path.join(fixtureDir, "public/local.png"), SOURCE_PNG);
      await fs.writeFile(
        path.join(fixtureDir, "next.config.mjs"),
        `export default {
        rewrites: async () => [{ source: "/media/:path*", destination: ${JSON.stringify(upstreamUrl)} + "/:path*" }],
      };\n`,
      );
      const adapterPath = path.join(fixtureDir, "image-optimizer.mjs");
      await fs.writeFile(
        adapterPath,
        `export default function createOptimizer() {
        const encode = globalThis.require("./image-encoder.cjs");
        return {
          async transformImage(body, { width, format, quality }) {
            const source = Buffer.from(await new Response(body).arrayBuffer());
            return new Response(encode(source), {
              headers: {
                "Content-Type": format,
                "X-Optimizer-Width": String(width),
                "X-Optimizer-Quality": String(quality),
              },
            });
          },
        };
      }\n`,
      );
      const outDir = path.join(fixtureDir, "dist");
      const builder = await createBuilder({
        root: fixtureDir,
        configFile: false,
        logLevel: "silent",
        plugins: [
          vinext({
            ...(router === "app" ? { appDir: fixtureDir } : { disableAppRouter: true }),
            rscOutDir: path.join(outDir, "server"),
            ssrOutDir: path.join(outDir, "server/ssr"),
            clientOutDir: path.join(outDir, "client"),
            images: { optimizer: { adapter: adapterPath } },
          }),
        ],
      });
      await builder.buildApp();
      // Adapter initialization must resolve CommonJS dependencies relative to
      // the built server entry, just like its request handlers do.
      await fs.writeFile(
        path.join(outDir, "server/image-encoder.cjs"),
        'module.exports = (source) => "transformed:" + source.toString("base64");\n',
      );
      ({ server } = await startProdServer({ port: 0, host: "127.0.0.1", outDir }));
      baseUrl = serverOrigin(server);
    }, 120000);

    afterAll(async () => {
      await closeServer(server);
      await closeServer(upstream);
      setImageOptimizer(null);
      if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    });

    it("uses the configured optimizer for a public image", async () => {
      const response = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        headers: { Accept: "image/webp" },
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("x-optimizer-width")).toBe("64");
      expect(response.headers.get("x-optimizer-quality")).toBe("75");
      expect(body).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);

      const head = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const post = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        method: "POST",
      });
      await post.arrayBuffer();
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    });

    // Ported from Next.js: test/e2e/image-optimizer/image-optimizer.test.ts
    // https://github.com/vercel/next.js/blob/7657545d157a04c3b21112f08e4675a4ebffeb5a/test/e2e/image-optimizer/image-optimizer.test.ts#L444
    it.each(["banner.png", "banner", "banner.bin"])(
      "optimizes external rewrite source %s using its response content type",
      async (source) => {
        const direct = await fetch(`${baseUrl}/media/${source}`);
        const directBody = Buffer.from(await direct.arrayBuffer());
        expect(direct.status).toBe(200);
        expect(directBody).toEqual(SOURCE_PNG);

        upstreamCredentials.length = 0;
        const response = await fetch(
          `${baseUrl}/_next/image?url=${encodeURIComponent(`/media/${source}`)}&w=64&q=75`,
          {
            headers: {
              Accept: "image/webp",
              Cookie: "fixture=caller",
              Authorization: "Bearer fixture",
            },
          },
        );
        const body = await response.text();

        expect(response.status, body).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/webp");
        expect(body).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
        expect(upstreamCredentials).toEqual([false]);
      },
    );

    it("rejects unsuccessful and non-image rewrite sources before transformation", async () => {
      const optimizer = getImageOptimizer();
      expect(optimizer).not.toBeNull();
      const transform = vi.spyOn(optimizer!, "transformImage");
      try {
        for (const source of ["missing.png", "not-image.png", "not-image", "not-image.bin"]) {
          const response = await fetch(
            `${baseUrl}/_next/image?url=${encodeURIComponent(`/media/${source}`)}&w=64&q=75`,
          );
          const body = await response.text();

          expect(response.status, source).toBe(400);
          expect(response.headers.has("x-optimizer-width")).toBe(false);
          expect(body).not.toContain("transformed:");
        }
        expect(transform).not.toHaveBeenCalled();
      } finally {
        transform.mockRestore();
      }
    });

    it("passes through public and rewrite images when no optimizer is active", async () => {
      const configuredOptimizer = getImageOptimizer();
      setImageOptimizer(null);
      try {
        for (const source of [
          "/local.png",
          "/media/banner.png",
          "/media/banner",
          "/media/banner.bin",
        ]) {
          const response = await fetch(
            `${baseUrl}/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`,
            { headers: { Accept: "image/webp" } },
          );
          const body = Buffer.from(await response.arrayBuffer());

          expect(response.status, source).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/png");
          expect(body).toEqual(SOURCE_PNG);
        }
      } finally {
        setImageOptimizer(configuredOptimizer);
      }
    });
  },
);
