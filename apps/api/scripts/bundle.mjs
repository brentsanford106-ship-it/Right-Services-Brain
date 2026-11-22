// Builds the API into one file for Azure App Service: dist/server.mjs plus a tiny package.json
// listing only the native module (sharp) that Azure installs for Linux during deployment.
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist", import.meta.url));
await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["sharp", "pg-native"],
  sourcemap: false,
  legalComments: "none",
  // Some bundled packages use require(); give ESM output a working require.
  banner: { js: "import { createRequire as __rsbCreateRequire } from 'node:module'; const require = __rsbCreateRequire(import.meta.url);" },
  logLevel: "warning",
});
await writeFile(
  new URL("../dist/package.json", import.meta.url),
  JSON.stringify(
    { name: "rsb-api", private: true, type: "module", engines: { node: "22.x" }, scripts: { start: "node server.mjs" }, dependencies: { sharp: pkg.dependencies.sharp } },
    null,
    2,
  ) + "\n",
);
console.log("built dist/server.mjs");
