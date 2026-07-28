import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronHelperDir = resolve(desktopRoot, "resources", "helpers");
const electronRoot = resolve(desktopRoot, "electron");
const packagedServerRoot = resolve(desktopRoot, "server");
const agencyAiDocsRoot = resolve(desktopRoot, ".generated", "agencyai-docs");
const releaseInputsRoot = resolve(desktopRoot, ".generated", "release-inputs");

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeCmd = process.execPath;
const releaseBuild = process.argv.slice(2).includes("--release")
  || process.env.OPENWORK_RELEASE_BUILD === "1";

function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: needsShell(command),
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(nodeCmd, [resolve(repoRoot, "scripts", "check-source-closure.mjs")], repoRoot);
rmSync(releaseInputsRoot, { recursive: true, force: true });
run(pnpmCmd, ["--filter", "@openwork/product-config", "build"], repoRoot);
run(nodeCmd, [resolve(__dirname, "stage-agencyai-docs.mjs")], repoRoot);
run(
  nodeCmd,
  [resolve(__dirname, "prepare-sidecar.mjs"), "--force", "--outdir", electronSidecarDir],
  desktopRoot,
  {
    AGENCYAI_RELEASE_INPUTS_DIR: releaseInputsRoot,
    ...(releaseBuild ? { OPENWORK_RELEASE_BUILD: "1" } : {}),
  },
);
run(nodeCmd, [resolve(__dirname, "prepare-computer-use-helper.mjs"), "--force", "--outdir", electronHelperDir], desktopRoot);
// Build the server TS → JS so Electron can import it in-process
run(pnpmCmd, ["--filter", "openwork-server", "build"], repoRoot, {
  AGENCYAI_RELEASE_INPUTS_DIR: releaseInputsRoot,
});
// OPENWORK_ELECTRON_BUILD tells Vite to emit relative asset paths so the
// packaged app-dist tree resolves beneath agencyai-internal://renderer/.
run(pnpmCmd, ["--filter", "@openwork/app", "build"], repoRoot, {
  AGENCYAI_RELEASE_INPUTS_DIR: releaseInputsRoot,
  OPENWORK_ELECTRON_BUILD: "1",
});
run(nodeCmd, [resolve(__dirname, "check-agencyai-product-surface.mjs")], repoRoot);
// Copy constants.json next to server dist so the packaged asar can resolve it.
// Also patch the compiled import path so it works from both dev and packaged layouts.
const serverDistDir = resolve(repoRoot, "apps", "server", "dist");
const constantsSrc = resolve(repoRoot, "constants.json");
copyFileSync(constantsSrc, resolve(serverDistDir, "constants.json"));
const serverJsPath = resolve(serverDistDir, "server.js");
const serverJsSrc = readFileSync(serverJsPath, "utf8");
const patched = serverJsSrc.replace(
  /from\s+["']\.\.\/\.\.\/\.\.\/constants\.json["']/,
  'from "./constants.json"',
);
if (patched !== serverJsSrc) {
  writeFileSync(serverJsPath, patched, "utf8");
}
rmSync(packagedServerRoot, { recursive: true, force: true });
cpSync(serverDistDir, resolve(packagedServerRoot, "dist"), { recursive: true });
const sourceServerPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "apps", "server", "package.json"), "utf8"),
);
writeFileSync(
  resolve(packagedServerRoot, "package.json"),
  `${JSON.stringify(
    {
      name: sourceServerPackage.name,
      version: sourceServerPackage.version,
      private: true,
      type: sourceServerPackage.type,
      dependencies: sourceServerPackage.dependencies,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
run(
  nodeCmd,
  [
    resolve(repoRoot, "scripts", "check-source-closure.mjs"),
    "--staged-dir",
    resolve(repoRoot, "apps", "app", "dist"),
    "--staged-dir",
    packagedServerRoot,
    "--staged-dir",
    agencyAiDocsRoot,
    "--staged-dir",
    electronSidecarDir,
    "--staged-dir",
    electronHelperDir,
  ],
  repoRoot,
);
for (const fileName of readdirSync(electronRoot).filter((name) => name.endsWith(".mjs")).sort()) {
  run(nodeCmd, ["--check", resolve(electronRoot, fileName)], repoRoot);
}
run(nodeCmd, [resolve(__dirname, "check-electron-bridge.mjs")], repoRoot);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      renderer: "apps/app/dist",
      electronMain: "apps/desktop/electron/main.mjs",
      electronPreload: "apps/desktop/electron/preload.cjs",
    },
    null,
    2,
  )}\n`,
);
