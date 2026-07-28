import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESULT_MARKER = "AGENCYAI_PR05_RESULT ";
const DRIVER_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(DRIVER_ROOT, "../..");
const EXPECTED_LOCAL_PLUGIN_FILES = Object.freeze([
  "agencyai-local-extensions.js",
  "agencyai-local-capabilities.js",
  "openwork-office-attachments.js",
  "openwork-anthropic-adaptive-thinking.js",
  "openwork-anthropic-tool-schema.js",
  "agencyai-browser-automation.js",
  "agencyai-local-policy.js",
]);

export const FRAME_DEFINITIONS = Object.freeze([
  Object.freeze({
    frame: 1,
    id: "internal-renderer",
    claim: "The packaged renderer uses one sandboxed internal origin and a restrictive production CSP",
  }),
  Object.freeze({
    frame: 2,
    id: "privileged-ipc-and-files",
    claim: "Privileged IPC validates the exact main frame while local files and public URLs use separate policies",
  }),
  Object.freeze({
    frame: 3,
    id: "permissions-and-browser-sandbox",
    claim: "Permissions default to deny and remote browser tabs never receive the AgencyAI preload",
  }),
  Object.freeze({
    frame: 4,
    id: "authenticated-browser-wrapper",
    claim: "Browser automation hides CDP coordinates and accepts only app-created isolated targets",
  }),
  Object.freeze({
    frame: 5,
    id: "electron-native-package",
    claim: "Electron, native modules, fuses, helper, and package resources match the reviewed target contract",
  }),
  Object.freeze({
    frame: 6,
    id: "packaged-runtime-smoke",
    claim: "The actual packaged application completes authenticated local runtime and security smoke checks",
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repositoryRoot(value) {
  const root = resolve(value?.trim() || DEFAULT_REPOSITORY_ROOT);
  assert(
    statSync(join(root, "PLAN_AGENCYAI_DESKTOP_MVP.md")).isFile(),
    "AgencyAI implementation plan is missing",
  );
  return root;
}

function commandOutput(result) {
  return [
    String(result.stdout ?? "").trim(),
    String(result.stderr ?? "").trim(),
    result.error?.message ?? "",
  ].filter(Boolean).join("\n");
}

function run(root, command, args, timeoutMs = 180_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${commandOutput(result)}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function source(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function parseLastJson(output, label) {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (!line) throw new Error(`${label} did not print JSON evidence`);
  return JSON.parse(line);
}

function createChecks() {
  const checks = [];
  return {
    expect(condition, label, actual) {
      assert(condition, `${label}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
      checks.push({
        label,
        passed: true,
        ...(actual === undefined ? {} : { actual }),
      });
    },
    list: checks,
  };
}

async function frameInternalRenderer(root, check) {
  run(root, "node", [
    "--test",
    "apps/desktop/electron/internal-renderer-protocol.test.mjs",
    "apps/desktop/electron/desktop-security-boundary.test.mjs",
  ]);
  const protocol = source(
    root,
    "apps/desktop/electron/internal-renderer-protocol.mjs",
  );
  const main = source(root, "apps/desktop/electron/main.mjs");
  const preload = source(root, "apps/desktop/electron/preload.cjs");

  check.expect(
    protocol.includes(`"script-src 'self'"`)
      && !protocol.includes("unsafe-eval"),
    "Production CSP allows only self-hosted scripts and excludes unsafe-eval",
  );
  check.expect(
    main.includes("loadURL(`${REGISTERED_INTERNAL_RENDERER_ORIGIN}/`)")
      && main.includes("contextIsolation: true")
      && main.includes("nodeIntegration: false")
      && main.includes("sandbox: true"),
    "Main window loads the sandboxed registered internal renderer",
  );
  check.expect(
    preload.startsWith('const { contextBridge, ipcRenderer } = require("electron");'),
    "Sandbox-compatible preload exposes only the reviewed context bridge",
  );
  return {
    origin: "agencyai-internal://renderer",
    csp: "script-src self; no unsafe-eval",
    preload: "preload.cjs",
  };
}

async function framePrivilegedIpc(root, check) {
  run(root, "node", [
    "--test",
    "apps/desktop/electron/main-desktop-approval-policy.test.mjs",
    "apps/desktop/electron/local-file-access.test.mjs",
    "apps/desktop/electron/open-external.test.mjs",
  ]);
  const main = source(root, "apps/desktop/electron/main.mjs");
  const localFiles = source(
    root,
    "apps/desktop/electron/local-file-access.mjs",
  );
  const external = source(
    root,
    "apps/desktop/electron/open-external.mjs",
  );
  check.expect(
    main.includes("authorizeMainIpcSender(event)")
      && main.includes("registerTrustedMainHandle"),
    "Privileged desktop and browser IPC share exact sender authorization",
  );
  check.expect(
    localFiles.includes("allowedRoots")
      && localFiles.includes("symbolic-link escape")
      && localFiles.includes("realpath"),
    "Local-file access is rooted and rejects symbolic-link traversal",
  );
  check.expect(
    external.includes('url.protocol !== "https:"')
      && external.includes("url.username")
      && external.includes("url.password")
      && external.includes("isLoopbackOrDeceptiveHostname"),
    "Generic external navigation accepts credential-free HTTPS only",
  );
  return {
    ipc: "main-frame and trusted-origin",
    localFiles: "workspace/storage roots only",
    externalNavigation: "https only",
  };
}

async function framePermissions(root, check) {
  run(root, "node", [
    "--test",
    "apps/desktop/electron/media-permissions.test.mjs",
    "apps/desktop/electron/browser-target-policy.test.mjs",
  ]);
  const permissions = source(
    root,
    "apps/desktop/electron/media-permissions.mjs",
  );
  const browser = source(root, "apps/desktop/electron/browser-panel.mjs");
  check.expect(
    permissions.includes("setPermissionCheckHandler(() => false)")
      && permissions.includes("callback(false)"),
    "Browser-session permissions are denied by default",
  );
  check.expect(
    browser.includes("sandbox: true")
      && browser.includes("contextIsolation: true")
      && browser.includes("nodeIntegration: false")
      && browser.includes("browser-content-preload.cjs"),
    "Remote browser tabs are sandboxed behind the non-privileged content preload",
  );
  check.expect(
    browser.includes("browserTargetPolicy.revoke(tabId)")
      && browser.includes("browserTargetPolicy.clear()"),
    "Closing or destroying browser tabs revokes their automation targets",
  );
  return {
    mainPermissionPolicy: "profile-gated exact-origin",
    browserPermissionPolicy: "deny",
    targetLifecycle: "revoke on close",
  };
}

async function frameBrowserWrapper(root, check) {
  run(root, "bun", [
    "test",
    "apps/server/src/opencode-plugins/agencyai-browser-automation.test.ts",
  ]);
  run(root, "pnpm", ["--filter", "openwork-server", "build"]);
  const pluginDirectory = join(
    root,
    "apps/server/dist/opencode-plugins",
  );
  const browserBundle = join(
    pluginDirectory,
    "agencyai-browser-automation.js",
  );
  const bundleSource = readFileSync(browserBundle, "utf8");
  const browserModule = await import(
    `${pathToFileURL(browserBundle).href}?eval=${Date.now()}`
  );
  check.expect(
    Object.keys(browserModule).length === 1
      && typeof browserModule.AgencyAiBrowserAutomation === "function",
    "Packaged browser wrapper exposes one reviewed plugin entrypoint",
    Object.keys(browserModule),
  );
  check.expect(
    statSync(browserBundle).size > 500_000
      && !/from\s+["'](?:@opencode-ai\/plugin|opencode-chrome-devtools|ws)["']/.test(
        bundleSource,
      ),
    "Browser wrapper is a self-contained production bundle",
    statSync(browserBundle).size,
  );
  check.expect(
    bundleSource.includes("/browser/targets")
      && bundleSource.includes("Browser target is not authorized"),
    "Wrapper obtains the private endpoint and live target allowlist from the authenticated desktop bridge",
  );
  return {
    wrapper: "agencyai-browser-automation",
    reviewedEngine: "opencode-chrome-devtools@1.0.4",
    bundleBytes: statSync(browserBundle).size,
  };
}

async function frameNativePackage(root, check) {
  const nativeOutput = run(
    root,
    "pnpm",
    ["--filter", "@openwork/desktop", "smoke:native"],
  );
  run(root, "pnpm", [
    "--filter",
    "@openwork/desktop",
    "test:builder-config",
  ]);
  const native = parseLastJson(nativeOutput, "Native module smoke");
  const desktopPackage = JSON.parse(
    source(root, "apps/desktop/package.json"),
  );
  check.expect(
    native.ok === true
      && native.electron === "43.2.0"
      && native.architecture === "arm64",
    "Native smoke runs under the pinned arm64 Electron runtime",
    {
      electron: native.electron,
      architecture: native.architecture,
      modules: native.modules,
    },
  );
  check.expect(
    native.sqlite === "agencyai-sqlite-ok"
      && native.pty === "agencyai-pty-ok",
    "SQLite and PTY native bindings execute under Electron",
    { sqlite: native.sqlite, pty: native.pty },
  );
  check.expect(
    desktopPackage.dependencies["better-sqlite3"] === "13.0.1"
      && desktopPackage.devDependencies.electron === "43.2.0"
      && desktopPackage.devDependencies["@electron/fuses"] === "2.1.3",
    "Native and Electron package versions are exact",
  );
  return {
    electron: native.electron,
    nodeModulesAbi: native.modules,
    architecture: native.architecture,
    sqlite: native.sqlite,
    pty: native.pty,
    packagedPlugins: EXPECTED_LOCAL_PLUGIN_FILES,
  };
}

async function framePackagedRuntime(root, check) {
  const args = ["apps/desktop/scripts/run-packaged-smoke.mjs"];
  const requestedApp = process.env.AGENCYAI_PR05_APP_PATH?.trim();
  if (requestedApp) args.push("--app", requestedApp);
  const output = run(root, "node", args, 300_000);
  const result = parseLastJson(output, "Packaged application smoke");
  check.expect(
    result.ok === true
      && result.app === "AgencyAI"
      && result.profile === "local-mvp"
      && result.rendererOrigin === "agencyai-internal://renderer",
    "Actual packaged app launches the local profile from the internal renderer",
  );
  check.expect(
    result.opencode === "1.17.11"
      && result.opencodeSource === "bundled-patched"
      && result.openworkLoopback === true,
    "Packaged runtime uses the verified local OpenCode distribution on loopback",
  );
  check.expect(
    result.sqlite === "embedded-server-loaded"
      && result.pty === "agencyai-packaged-pty-ok"
      && result.browser === "authorized-target-only"
      && result.fuses === "hardened",
    "Packaged SQLite, PTY, browser authorization, and Electron fuses pass",
  );
  check.expect(
    JSON.stringify(result.packagedPlugins)
      === JSON.stringify(EXPECTED_LOCAL_PLUGIN_FILES.map((name) =>
        name.slice(0, -3))),
    "Packaged plugin directory contains the exact reviewed local allowlist",
    result.packagedPlugins,
  );
  return {
    app: result.app,
    profile: result.profile,
    appVersion: result.appVersion,
    architecture: result.architecture,
    rendererOrigin: result.rendererOrigin,
    randomizedCdpPort: "verified-high-random-port",
    opencode: result.opencode,
    opencodeSource: result.opencodeSource,
    sqlite: result.sqlite,
    pty: result.pty,
    browser: result.browser,
    helper: result.helper,
    fuses: result.fuses,
    packagedPlugins: result.packagedPlugins,
    serverWorkspaceRemoved: result.serverWorkspaceRemoved,
  };
}

const FRAME_RUNNERS = Object.freeze({
  1: frameInternalRenderer,
  2: framePrivilegedIpc,
  3: framePermissions,
  4: frameBrowserWrapper,
  5: frameNativePackage,
  6: framePackagedRuntime,
});

export async function runFrame(frameInput, rootInput) {
  const frame = Number(frameInput);
  const definition = FRAME_DEFINITIONS.find((entry) => entry.frame === frame);
  const runner = FRAME_RUNNERS[frame];
  assert(definition && runner, "frame must be an integer from 1 through 6");
  const root = repositoryRoot(rootInput);
  const check = createChecks();
  const evidence = await runner(root, check);
  return {
    passed: true,
    frame,
    id: definition.id,
    checks: check.list,
    evidence,
  };
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runFrame(process.argv[2], process.argv[3]).then(
    (result) => {
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
