import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  connect,
  debuggerUrlFor,
  evaluate,
  listTargets,
} from "../../../evals/runner/cdp.ts";
import {
  loadPackagedRuntimeIntegritySync,
} from "../electron/opencode-distribution.mjs";

const require = createRequire(import.meta.url);
const {
  FuseState,
  FuseV1Options,
  getCurrentFuseWire,
} = require("@electron/fuses");

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptPath);
const desktopRoot = path.resolve(scriptRoot, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const profilePath = path.join(
  repoRoot,
  "packages",
  "product-config",
  "profiles",
  "local-mvp.json",
);
const APP_WAIT_MS = 90_000;
const RUNTIME_WAIT_MS = 90_000;
const CHILD_OUTPUT_LIMIT = 40_000;
const EXPECTED_PLUGIN_NAMES = Object.freeze([
  "agencyai-local-extensions",
  "agencyai-local-capabilities",
  "openwork-office-attachments",
  "openwork-anthropic-adaptive-thinking",
  "openwork-anthropic-tool-schema",
  "agencyai-browser-automation",
  "agencyai-local-policy",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function captureBoundedText(stream, limit = CHILD_OUTPUT_LIMIT) {
  assert(
    Number.isSafeInteger(limit) && limit > 0,
    "captured output limit must be a positive safe integer",
  );
  let output = "";
  if (stream) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (output.length > limit) output = output.slice(-limit);
    });
  }
  return () => output;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

async function regularNonSymlinkFile(filePath, label) {
  const fileStat = await lstat(filePath);
  assert(fileStat.isFile() && !fileStat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  return filePath;
}

async function walkFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(candidate));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files;
}

export function packagedMacAppCandidates(
  root = desktopRoot,
) {
  return [
    path.join(root, "dist-electron", "mac-arm64", "AgencyAI.app"),
    path.join(root, "dist-electron", "mac", "AgencyAI.app"),
  ];
}

export function packagedSmokeLaunchArguments(platform = process.platform) {
  // Keep repeatedly rebuilt macOS test apps from blocking on native Keychain,
  // incoming-network, or crash-restoration dialogs. These arguments are
  // injected only by this smoke runner; normal packaged launches receive none.
  return platform === "darwin"
    ? [
        "--use-mock-keychain",
        "--disable-features=DialMediaRouteProvider",
        "-ApplePersistenceIgnoreState",
        "YES",
      ]
    : [];
}

export async function resolvePackagedMacApp(
  requestedPath = null,
  root = desktopRoot,
) {
  const candidates = requestedPath
    ? [path.resolve(requestedPath)]
    : packagedMacAppCandidates(root);
  for (const candidate of candidates) {
    try {
      const candidateStat = await lstat(candidate);
      if (
        candidate.endsWith(".app")
        && candidateStat.isDirectory()
        && !candidateStat.isSymbolicLink()
      ) {
        return realpath(candidate);
      }
    } catch {
      // Try the next deterministic electron-builder output.
    }
  }
  throw new Error(`Packaged AgencyAI.app not found. Checked: ${candidates.join(", ")}`);
}

export function packagedUiControlDiscoveryPath(profile, userHome = homedir()) {
  return path.join(
    userHome,
    "Library",
    "Application Support",
    profile.brand.appId,
    "electron",
    "user-data",
    "openwork-ui-control.json",
  );
}

function exactLoopbackOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new Error(`${label} must be an exact 127.0.0.1 origin`);
  }
  return parsed.origin;
}

async function readDiscovery(discoveryPath) {
  const fileStat = await lstat(discoveryPath);
  assert(fileStat.isFile() && !fileStat.isSymbolicLink(), "UI discovery must be a regular file");
  if (process.platform !== "win32") {
    assert((fileStat.mode & 0o077) === 0, "UI discovery must be owner-only");
  }
  const parsed = JSON.parse(await readFile(discoveryPath, "utf8"));
  assert(
    typeof parsed.token === "string"
      && parsed.token.length >= 32
      && !/\s/.test(parsed.token),
    "UI discovery token is invalid",
  );
  return {
    baseUrl: exactLoopbackOrigin(parsed.baseUrl, "UI control URL"),
    token: parsed.token,
  };
}

async function bridgeJson(bridge, pathname, options = {}) {
  const response = await fetch(new URL(pathname, `${bridge.baseUrl}/`), {
    method: options.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`UI bridge ${pathname} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`UI bridge ${pathname} failed: HTTP ${response.status}`);
  }
  return payload;
}

async function waitForBridge(discoveryPath, previousToken = null) {
  const deadline = Date.now() + APP_WAIT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const bridge = await readDiscovery(discoveryPath);
      if (bridge.token === previousToken) {
        throw new Error("waiting for a fresh packaged-app bridge");
      }
      const response = await fetch(
        new URL("/health", `${bridge.baseUrl}/`),
        {
          redirect: "error",
          signal: AbortSignal.timeout(2_000),
        },
      );
      const health = await response.json();
      if (
        response.ok
        && health?.ok === true
        && health?.app === "AgencyAI"
      ) {
        return bridge;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Packaged AgencyAI UI bridge did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function waitForRendererContext(bridge) {
  const deadline = Date.now() + APP_WAIT_MS;
  let lastPayload = null;
  while (Date.now() < deadline) {
    lastPayload = await bridgeJson(bridge, "/context").catch(() => null);
    if (lastPayload?.ok === true) return lastPayload;
    await sleep(250);
  }
  throw new Error(
    `Packaged renderer control surface did not become ready: ${JSON.stringify(lastPayload)}`,
  );
}

function runtimeExpression(command, ...args) {
  return `(async () => window.__OPENWORK_ELECTRON__.invokeDesktop(${JSON.stringify(command)}, ...${JSON.stringify(args)}))()`;
}

async function waitForRuntime(client) {
  const deadline = Date.now() + RUNTIME_WAIT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await evaluate(
      client,
      runtimeExpression("runtimeStatus"),
      { awaitPromise: true },
    );
    if (
      lastStatus?.lifecycleState === "healthy"
      && lastStatus?.engine?.running === true
      && lastStatus?.openworkServer?.running === true
      && lastStatus?.storage?.root
    ) {
      return lastStatus;
    }
    await sleep(500);
  }
  throw new Error(
    `Packaged local runtime did not become ready: ${JSON.stringify(lastStatus)}`,
  );
}

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      "<!doctype html><title>AgencyAI browser smoke</title>"
      + "<main><h1>AgencyAI browser smoke</h1><button>Ready</button></main>",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser smoke fixture did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function inspectPackagedLayout(appPath, profile) {
  const executable = await regularNonSymlinkFile(
    path.join(appPath, "Contents", "MacOS", profile.brand.executableName),
    "AgencyAI executable",
  );
  const infoPlistPath = await regularNonSymlinkFile(
    path.join(appPath, "Contents", "Info.plist"),
    "AgencyAI Info.plist",
  );
  const infoPlist = JSON.parse(commandOutput(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", infoPlistPath],
  ));
  const transportSecurity = infoPlist.NSAppTransportSecurity;
  assert(
    transportSecurity?.NSAllowsArbitraryLoads === false,
    "Packaged macOS transport policy allows arbitrary loads",
  );
  assert(
    transportSecurity?.NSAllowsLocalNetworking === true,
    "Packaged macOS transport policy does not allow required local networking",
  );
  for (const host of ["127.0.0.1", "localhost"]) {
    assert(
      transportSecurity?.NSExceptionDomains?.[host]
        ?.NSTemporaryExceptionAllowsInsecureHTTPLoads === true,
      `Packaged macOS transport policy is missing the ${host} HTTP exception`,
    );
  }
  assert(
    !Object.hasOwn(infoPlist, "CFBundleURLTypes"),
    "Packaged AgencyAI unexpectedly registers a public URL protocol",
  );
  const resources = path.join(appPath, "Contents", "Resources");
  await regularNonSymlinkFile(
    path.join(resources, "app.asar"),
    "Electron ASAR",
  );
  await regularNonSymlinkFile(
    path.join(resources, "app-dist", "index.html"),
    "internal renderer index",
  );
  await regularNonSymlinkFile(
    path.join(resources, "app-dist", "theme-bootstrap.js"),
    "external theme bootstrap",
  );
  await regularNonSymlinkFile(
    path.join(resources, "packaged-runtime-integrity.json"),
    "packaged runtime integrity",
  );

  const pluginDirectory = path.join(resources, "opencode-plugins");
  const pluginFiles = (await readdir(pluginDirectory)).sort();
  assert(
    JSON.stringify(pluginFiles)
      === JSON.stringify(
        EXPECTED_PLUGIN_NAMES.map((name) => `${name}.js`).sort(),
      ),
    `Packaged plugin closure mismatch: ${pluginFiles.join(", ")}`,
  );

  const sidecar = await regularNonSymlinkFile(
    path.join(resources, "sidecars", "opencode-aarch64-apple-darwin"),
    "verified OpenCode sidecar",
  );
  const ripgrep = await regularNonSymlinkFile(
    path.join(resources, "toolchain", "aarch64-apple-darwin", "rg"),
    "packaged ripgrep",
  );
  const helper = await regularNonSymlinkFile(
    path.join(
      resources,
      "helpers",
      profile.brand.computerUse.bundleName,
      "Contents",
      "MacOS",
      "ComputerUse",
    ),
    "computer-use helper",
  );

  const nativeModules = (await walkFiles(
    path.join(resources, "app.asar.unpacked"),
  )).filter((filePath) => filePath.endsWith(".node"));
  assert(
    nativeModules.some((filePath) => filePath.includes("better-sqlite3")),
    "Packaged better-sqlite3 native binding is missing",
  );
  assert(
    nativeModules.some((filePath) =>
      filePath.includes("node-pty")
      || filePath.includes("pty.node")),
    "Packaged node-pty native binding is missing",
  );

  for (const binary of [
    executable,
    sidecar,
    ripgrep,
    helper,
    ...nativeModules,
  ]) {
    assert(
      /\barm64\b/.test(commandOutput("/usr/bin/file", [binary])),
      `Packaged binary is not arm64: ${binary}`,
    );
  }

  const fuses = await getCurrentFuseWire(executable);
  const expectedFuses = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  ]);
  for (const [fuse, expected] of expectedFuses) {
    assert(fuses[fuse] === expected, `Packaged Electron fuse ${fuse} is incorrect`);
  }

  const integrity = loadPackagedRuntimeIntegritySync({
    resourcesPath: resources,
    target: "aarch64-apple-darwin",
  });
  assert(
    integrity.manifest.target === "aarch64-apple-darwin",
    "Runtime integrity target is incorrect",
  );
  const sidecarVersion = commandOutput(sidecar, ["--version"]).trim();
  assert(
    sidecarVersion === "1.17.11",
    "Packaged OpenCode version is not 1.17.11",
  );
  assert(
    commandOutput(ripgrep, ["--version"]).startsWith("ripgrep "),
    "Packaged ripgrep did not execute",
  );
  const helperStatus = JSON.parse(commandOutput(helper, ["--check"]));
  assert(typeof helperStatus.ok === "boolean", "Computer-use helper returned invalid permission status");

  return {
    executable,
    resources,
    pluginDirectory,
    sidecar,
    ripgrep,
    helper,
    nativeModules,
    fuses,
    integrity,
    sidecarVersion,
    helperStatus,
  };
}

async function ptySmoke(client, workspacePath) {
  return evaluate(
    client,
    `(async () => {
      const terminal = window.__OPENWORK_ELECTRON__.terminal;
      let output = "";
      let resolveExit;
      const exited = new Promise((resolve) => { resolveExit = resolve; });
      const created = await terminal.create({
        cwd: ${JSON.stringify(workspacePath)},
        cols: 80,
        rows: 24,
      });
      const offData = terminal.onData((event) => {
        if (event.terminalId === created.terminalId) output += event.data;
      });
      const offExit = terminal.onExit((event) => {
        if (event.terminalId === created.terminalId) resolveExit(event);
      });
      await terminal.write(
        created.terminalId,
        "printf agencyai-packaged-pty-ok; exit\\n",
      );
      const exit = await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("PTY smoke timed out")), 10000)),
      ]);
      offData();
      offExit();
      return {
        output,
        exitCode: exit.exitCode,
      };
    })()`,
    { awaitPromise: true },
  );
}

async function cleanupServerWorkspace(serverInfo, workspacePath) {
  if (
    !serverInfo?.baseUrl
    || !serverInfo?.clientToken
    || !serverInfo?.hostToken
  ) {
    return false;
  }
  const listResponse = await fetch(
    new URL("/workspaces", `${serverInfo.baseUrl}/`),
    {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${serverInfo.clientToken}`,
      },
    },
  );
  if (!listResponse.ok) return false;
  const list = await listResponse.json();
  const workspaces = Array.isArray(list?.items)
    ? list.items
    : Array.isArray(list?.workspaces)
      ? list.workspaces
      : [];
  const workspace = workspaces.find((entry) =>
    path.resolve(String(entry?.path ?? "")) === path.resolve(workspacePath));
  if (!workspace?.id) return false;
  const deleteResponse = await fetch(
    new URL(
      `/workspaces/${encodeURIComponent(workspace.id)}`,
      `${serverInfo.baseUrl}/`,
    ),
    {
      method: "DELETE",
      redirect: "error",
      headers: {
        "X-OpenWork-Host-Token": serverInfo.hostToken,
      },
    },
  );
  return deleteResponse.ok;
}

async function createServerWorkspace(serverInfo, workspacePath) {
  if (
    !serverInfo?.baseUrl
    || !serverInfo?.hostToken
  ) {
    throw new Error("Packaged embedded server is missing its host connection");
  }
  const response = await fetch(
    new URL("/workspaces/local", `${serverInfo.baseUrl}/`),
    {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-OpenWork-Host-Token": serverInfo.hostToken,
      },
      body: JSON.stringify({
        folderPath: workspacePath,
        name: "AgencyAI PR05 packaged smoke",
        preset: "starter",
      }),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Packaged embedded server workspace creation failed `
      + `(HTTP ${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function stopChild(child) {
  if (
    !child
    || child.exitCode !== null
    || child.signalCode !== null
  ) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(5_000)]);
  }
}

async function runPackagedSmoke({ appPath: requestedAppPath = null } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("PR05 packaged smoke requires macOS arm64");
  }
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const appPath = await resolvePackagedMacApp(requestedAppPath);
  const layout = await inspectPackagedLayout(appPath, profile);
  const discoveryPath = packagedUiControlDiscoveryPath(profile);
  let previousToken = null;
  try {
    const previousBridge = await readDiscovery(discoveryPath);
    const live = await fetch(
      new URL("/health", `${previousBridge.baseUrl}/`),
      { signal: AbortSignal.timeout(1_000) },
    ).then((response) => response.ok).catch(() => false);
    if (live) {
      throw new Error(
        "Another AgencyAI instance is running; close it before packaged smoke",
      );
    }
    previousToken = previousBridge.token;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes("Another AgencyAI instance")
    ) {
      throw error;
    }
  }

  const fixture = await startFixtureServer();
  const workspacePath = await realpath(await mkdtemp(
    path.join(tmpdir(), "agencyai-pr05-packaged-"),
  ));
  let child = null;
  let client = null;
  let bridge = null;
  let createdWorkspaceId = null;
  let serverInfo = null;
  let serverWorkspaceRemoved = false;
  let readStdout = () => "";
  let readStderr = () => "";
  const originalStorageRoot = process.env.OPENWORK_STORAGE_ROOT;
  const originalDiscovery = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  try {
    child = spawn(layout.executable, packagedSmokeLaunchArguments(), {
      cwd: desktopRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    readStdout = captureBoundedText(child.stdout);
    readStderr = captureBoundedText(child.stderr);
    const childExitedBeforeBridge = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(new Error(
          `AgencyAI exited before its UI bridge became ready `
          + `(code=${String(code)}, signal=${String(signal)})`,
        ));
      });
    });

    bridge = await Promise.race([
      waitForBridge(discoveryPath, previousToken),
      childExitedBeforeBridge,
    ]);
    await waitForRendererContext(bridge);
    const browserPolicyBefore = await bridgeJson(
      bridge,
      "/browser/targets",
    );
    const cdpBaseUrl = exactLoopbackOrigin(
      browserPolicyBefore.browser_url,
      "packaged browser CDP",
    );
    const cdpPort = Number(new URL(cdpBaseUrl).port);
    assert(
      cdpPort >= 49_152 && cdpPort <= 65_535,
      "Packaged browser CDP port is outside the randomized range",
    );
    const targets = await listTargets(cdpBaseUrl);
    const appTarget = targets.find((target) =>
      target.type === "page"
      && target.url.startsWith("agencyai-internal://renderer"));
    assert(appTarget?.webSocketDebuggerUrl, "Packaged internal renderer CDP target is missing");
    client = await connect(debuggerUrlFor(cdpBaseUrl, appTarget));

    const rendererState = await evaluate(
      client,
      `({
        origin: location.origin,
        protocol: location.protocol,
        hasDesktopBridge: typeof window.__OPENWORK_ELECTRON__?.invokeDesktop === "function",
        remoteResources: performance.getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((url) => /^https?:/i.test(url) && !/^https?:\\/\\/127\\.0\\.0\\.1(?::|\\/)/i.test(url)),
      })`,
    );
    assert(
      rendererState?.origin === "agencyai-internal://renderer",
      `Unexpected packaged renderer origin: ${rendererState?.origin}`,
    );
    assert(rendererState?.hasDesktopBridge === true, "Packaged desktop bridge is unavailable");
    assert(
      Array.isArray(rendererState?.remoteResources)
      && rendererState.remoteResources.length === 0,
      `Packaged renderer loaded remote resources: ${JSON.stringify(rendererState?.remoteResources)}`,
    );

    const buildInfo = await evaluate(
      client,
      runtimeExpression("appBuildInfo"),
      { awaitPromise: true },
    );
    assert(
      buildInfo?.productProfile?.profile === "local-mvp",
      "Packaged build profile is not local-mvp",
    );
    assert(
      buildInfo?.productProfile?.brand?.name === "AgencyAI",
      "Packaged app name is not AgencyAI",
    );
    assert(buildInfo?.arch === "arm64", "Packaged app reported the wrong architecture");

    const initialEngine = await evaluate(
      client,
      runtimeExpression(
        "engineStart",
        workspacePath,
        {
          runtime: "direct",
          workspacePaths: [workspacePath],
        },
      ),
      { awaitPromise: true },
    );
    assert(
      initialEngine?.opencodeBinSource === "bundled-patched",
      `Initial packaged runtime did not resolve bundled OpenCode: ${JSON.stringify(initialEngine)}`,
    );
    serverInfo = await evaluate(
      client,
      runtimeExpression("openworkServerInfo"),
      { awaitPromise: true },
    );
    const workspaceState = await createServerWorkspace(
      serverInfo,
      workspacePath,
    );
    const createdWorkspace = workspaceState?.workspaces?.find((workspace) =>
      path.resolve(String(workspace?.path ?? "")) === path.resolve(workspacePath));
    assert(
      createdWorkspace?.id,
      `Packaged server workspace was not created: ${JSON.stringify(workspaceState)}`,
    );
    createdWorkspaceId = createdWorkspace.id;

    const restartedEngine = await evaluate(
      client,
      runtimeExpression(
        "engineStart",
        workspacePath,
        {
          runtime: "direct",
          workspacePaths: [workspacePath],
          forceRestart: true,
        },
      ),
      { awaitPromise: true },
    );
    assert(
      restartedEngine?.running === true
      && restartedEngine?.opencodeBinSource === "bundled-patched",
      `Packaged runtime restart failed: ${JSON.stringify(restartedEngine)}`,
    );
    const runtime = await waitForRuntime(client);
    assert(
      runtime.engine?.opencodeBinSource === "bundled-patched",
      "OpenCode was not resolved from the verified bundle",
    );
    assert(
      new URL(runtime.engine.baseUrl).hostname === "127.0.0.1",
      "OpenCode did not bind to loopback",
    );
    assert(
      new URL(runtime.openworkServer.baseUrl).hostname === "127.0.0.1",
      "OpenWork server did not bind to loopback",
    );
    assert(
      runtime.openworkServer.remoteAccessEnabled === false,
      "Packaged remote access was enabled",
    );
    assert(
      runtime.storage.root
        === path.join(
          homedir(),
          "Library",
          "Application Support",
          profile.brand.appId,
        ),
      "Packaged runtime attested the wrong storage root",
    );

    const terminal = await ptySmoke(client, workspacePath);
    assert(
      terminal?.exitCode === 0
      && /agencyai-packaged-pty-ok/.test(String(terminal?.output ?? "")),
      `Packaged PTY smoke failed: ${JSON.stringify(terminal)}`,
    );

    const computerUseCommand = await evaluate(
      client,
      runtimeExpression("getComputerUseMcpCommand"),
      { awaitPromise: true },
    );
    assert(
      Array.isArray(computerUseCommand)
      && computerUseCommand[0] === layout.helper
      && computerUseCommand[1] === "mcp",
      "Packaged computer-use command did not resolve the bundled helper",
    );

    const openedBrowser = await evaluate(
      client,
      `(async () => window.__OPENWORK_ELECTRON__.browser.openUrl(${JSON.stringify(fixture.url)}, "builtin"))()`,
      { awaitPromise: true },
    );
    assert(openedBrowser?.target_id, "Packaged browser did not return an authorized target");
    const browserPolicy = await bridgeJson(bridge, "/browser/targets");
    assert(
      browserPolicy.target_ids?.includes(openedBrowser.target_id),
      "Packaged browser target was not authorized by the desktop",
    );
    assert(
      !browserPolicy.target_ids?.includes(appTarget.id),
      "Internal app renderer leaked into the browser authorization list",
    );

    process.env.OPENWORK_STORAGE_ROOT = path.join(
      homedir(),
      "Library",
      "Application Support",
      profile.brand.appId,
    );
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = discoveryPath;
    const browserBundleUrl =
      `${pathToFileURL(path.join(layout.pluginDirectory, "agencyai-browser-automation.js")).href}`
      + `?smoke=${Date.now()}`;
    const browserModule = await import(browserBundleUrl);
    assert(
      JSON.stringify(Object.keys(browserModule)) === JSON.stringify([
        "AgencyAiBrowserAutomation",
      ]),
      "Packaged browser wrapper exports an unexpected plugin surface",
    );
    const browserHooks = await browserModule.AgencyAiBrowserAutomation({});
    const toolContext = {
      sessionID: "packaged-smoke",
      messageID: "packaged-smoke",
      agent: "agencyai",
      directory: workspacePath,
      worktree: workspacePath,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    };
    const browserList = await browserHooks.tool.browser_list.execute(
      {},
      toolContext,
    );
    assert(
      browserList.includes(openedBrowser.target_id)
      && !browserList.includes(appTarget.id),
      "Packaged browser wrapper did not filter target discovery",
    );
    const browserSnapshot =
      await browserHooks.tool.browser_snapshot.execute(
        { target_id: openedBrowser.target_id },
        toolContext,
      );
    assert(
      /AgencyAI browser smoke/.test(browserSnapshot),
      "Packaged browser wrapper did not read the authorized browser page",
    );
    await browserHooks.tool.browser_eval.execute(
      { target_id: appTarget.id, expression: "document.title" },
      toolContext,
    ).then(
      () => {
        throw new Error("Packaged browser wrapper accepted the app renderer");
      },
      (error) => {
        assert(
          /not authorized/.test(String(error?.message ?? error)),
          "Packaged browser wrapper rejected the app renderer for the wrong reason",
        );
      },
    );

    serverInfo = await evaluate(
      client,
      runtimeExpression("openworkServerInfo"),
      { awaitPromise: true },
    );
    serverWorkspaceRemoved = await cleanupServerWorkspace(
      serverInfo,
      workspacePath,
    );
    assert(serverWorkspaceRemoved, "Packaged smoke workspace was not removed from the embedded server");
    createdWorkspaceId = null;
    await evaluate(
      client,
      runtimeExpression("engineStop"),
      { awaitPromise: true },
    );
    await evaluate(
      client,
      `(async () => window.__OPENWORK_ELECTRON__.browser.closeAllTabs())()`,
      { awaitPromise: true },
    );

    return {
      ok: true,
      app: "AgencyAI",
      profile: buildInfo.productProfile.profile,
      appVersion: buildInfo.version,
      architecture: process.arch,
      rendererOrigin: rendererState.origin,
      randomizedCdpPort: cdpPort,
      opencode: layout.sidecarVersion,
      opencodeSource: runtime.engine.opencodeBinSource,
      openworkLoopback: true,
      sqlite: "embedded-server-loaded",
      pty: "agencyai-packaged-pty-ok",
      browser: "authorized-target-only",
      helper: {
        architecture: "arm64",
        permissionCheckExecuted: true,
      },
      fuses: "hardened",
      packagedPlugins: EXPECTED_PLUGIN_NAMES,
      serverWorkspaceRemoved,
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n`
      + `stdout:\n${readStdout()}\n`
      + `stderr:\n${readStderr()}`,
      { cause: error },
    );
  } finally {
    if (client && createdWorkspaceId) {
      const cleanupInfo = serverInfo ?? await evaluate(
        client,
        runtimeExpression("openworkServerInfo"),
        { awaitPromise: true },
      ).catch(() => null);
      await cleanupServerWorkspace(cleanupInfo, workspacePath)
        .catch(() => false);
      await evaluate(
        client,
        runtimeExpression("engineStop"),
        { awaitPromise: true },
      ).catch(() => undefined);
    }
    client?.close();
    await stopChild(child);
    await fixture.close().catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true });
    if (bridge) {
      const currentDiscovery = await readDiscovery(discoveryPath)
        .catch(() => null);
      if (currentDiscovery?.token === bridge.token) {
        await rm(discoveryPath, { force: true });
      }
    }
    if (originalStorageRoot === undefined) {
      delete process.env.OPENWORK_STORAGE_ROOT;
    } else {
      process.env.OPENWORK_STORAGE_ROOT = originalStorageRoot;
    }
    if (originalDiscovery === undefined) {
      delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    } else {
      process.env.OPENWORK_UI_CONTROL_DISCOVERY = originalDiscovery;
    }
  }
}

function parseAppArgument(argv) {
  const index = argv.indexOf("--app");
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value) throw new Error("--app requires an AgencyAI.app path");
  return value;
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(scriptPath)
) {
  runPackagedSmoke({
    appPath: parseAppArgument(process.argv.slice(2)),
  }).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

export { runPackagedSmoke };
