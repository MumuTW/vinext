import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { toSlash } from "pathslash";
import { createOgInlineFetchAssetsPlugin } from "../packages/vinext/src/plugins/og-assets.js";

let server: ViteDevServer | undefined;
const roots: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function createProject() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-og-resolve-"));
  roots.push(workspaceRoot);
  const root = path.join(workspaceRoot, "app");
  const packageRoot = path.join(workspaceRoot, "packages", "linked-og");
  const entry = path.join(packageRoot, "index.js");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "linked-og": "file:../packages/linked-og" } }),
  );
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"linked-og"}');
  await fs.writeFile(entry, "export const value = 'linked package';");
  return { root, entry, packageRoot, importer: path.join(root, "index.js") };
}

describe("OG asset import resolution", () => {
  it.each(["client", "ssr"])(
    "resolves a tracked package once and retains its metadata in %s",
    async (environmentName) => {
      const { root, entry, packageRoot, importer } = await createProject();
      const font = Buffer.from("linked-package-font");
      await fs.writeFile(path.join(packageRoot, "font.ttf"), font);
      await fs.writeFile(
        entry,
        'export const font = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());',
      );
      let resolutions = 0;
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          createOgInlineFetchAssetsPlugin(),
          {
            name: "linked-package-resolver",
            enforce: "pre",
            resolveId(source) {
              if (source !== "linked-og") return null;
              resolutions += 1;
              return {
                id: toSlash(entry),
                moduleSideEffects: false,
                meta: { linkedPackage: true },
              };
            },
          },
        ],
        server: { middlewareMode: true, watch: null, fs: { allow: [root, packageRoot] } },
        optimizeDeps: { noDiscovery: true },
      });

      const environment = server.environments[environmentName];
      const container = environment.pluginContainer;
      const resolved = await container.resolveId("linked-og", toSlash(importer));
      expect(resolutions).toBe(1);
      expect(resolved).toMatchObject({
        id: toSlash(entry),
        moduleSideEffects: false,
        meta: { linkedPackage: true },
      });

      // Returning the resolved import must still register the linked package's
      // ownership, so its runtime-fetched font can be safely inlined.
      const transformed = await environment.transformRequest(`/@fs/${toSlash(entry)}`);
      expect(transformed?.code).toContain(font.toString("base64"));
      expect(transformed?.code).not.toContain("fetch(");
    },
  );

  it("resolves an external tracked package once and preserves externalization", async () => {
    const { root, importer } = await createProject();
    let resolutions = 0;
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        createOgInlineFetchAssetsPlugin(),
        {
          name: "external-package-resolver",
          enforce: "pre",
          resolveId(source) {
            if (source !== "linked-og") return null;
            resolutions += 1;
            return { id: source, external: true, meta: { externalPackage: true } };
          },
        },
      ],
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true },
    });

    const resolved = await server.environments.ssr.pluginContainer.resolveId(
      "linked-og",
      toSlash(importer),
    );
    expect(resolutions).toBe(1);
    expect(resolved).toMatchObject({
      id: "linked-og",
      external: true,
      meta: { externalPackage: true },
    });
  });
});
