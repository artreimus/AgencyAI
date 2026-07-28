import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(serverRoot, "dist");
const pluginDist = path.join(distRoot, "opencode-plugins");
const pluginSourceRoot = path.join(serverRoot, "src", "opencode-plugins");
const pluginEntrypoints = Object.freeze([
  "openwork-extensions-preview",
  "openwork-capabilities-knowledge",
  "openwork-office-attachments",
  "openwork-anthropic-adaptive-thinking",
  "openwork-anthropic-tool-schema",
  "agencyai-local-extensions",
  "agencyai-local-capabilities",
  "agencyai-browser-automation",
  "agencyai-local-policy",
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: serverRoot,
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with ${result.status ?? 1}`);
  }
}

function validatePluginBundles() {
  const expectedFiles = pluginEntrypoints
    .map((name) => `${name}.js`)
    .sort();
  const actualFiles = readdirSync(pluginDist).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `OpenCode plugin bundle closure mismatch: ${actualFiles.join(", ")}`,
    );
  }

  const browserBundle = path.join(
    pluginDist,
    "agencyai-browser-automation.js",
  );
  const browserSource = readFileSync(browserBundle, "utf8");
  if (statSync(browserBundle).size < 500_000) {
    throw new Error(
      "AgencyAI browser automation output is not a self-contained bundle",
    );
  }
  if (
    /from\s+["'](?:@opencode-ai\/plugin|opencode-chrome-devtools|ws)["']/.test(
      browserSource,
    )
  ) {
    throw new Error(
      "AgencyAI browser automation bundle retained a runtime package import",
    );
  }
  if (
    existsSync(path.join(pluginDist, "src"))
    || actualFiles.some((name) => name.includes(".test."))
  ) {
    throw new Error("OpenCode plugin output contains source or test artifacts");
  }
}

rmSync(distRoot, { recursive: true, force: true });
run(process.execPath, [
  require.resolve("typescript/bin/tsc"),
  "-p",
  path.join(serverRoot, "tsconfig.build.json"),
]);
rmSync(pluginDist, { recursive: true, force: true });
run(process.platform === "win32" ? "bun.exe" : "bun", [
  "build",
  ...pluginEntrypoints.map((name) =>
    path.join(pluginSourceRoot, `${name}.ts`)),
  "--outdir",
  pluginDist,
  "--root",
  pluginSourceRoot,
  "--target",
  "node",
  "--format",
  "esm",
]);
validatePluginBundles();

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    server: distRoot,
    opencodePlugins: expectedPluginOutput(),
  })}\n`,
);

function expectedPluginOutput() {
  return pluginEntrypoints.map((name) =>
    path.join(pluginDist, `${name}.js`));
}
