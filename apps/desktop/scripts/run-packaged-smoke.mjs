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
import {
  MEMORY_SYSTEM_TEMPLATE_FILES,
} from "../electron/memory-system.mjs";
import {
  AGENCYAI_DOC_FILES,
  validateAgencyAiDocs,
} from "./stage-agencyai-docs.mjs";

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

async function assertMissing(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} must be absent`);
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

function descendantProcessIds(rootPid) {
  const output = commandOutput("ps", ["-axo", "pid=,ppid="]);
  const children = new Map();
  for (const line of output.split("\n")) {
    const [pidValue, parentValue] = line.trim().split(/\s+/);
    const pid = Number(pidValue);
    const parent = Number(parentValue);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const values = children.get(parent) ?? [];
    values.push(pid);
    children.set(parent, values);
  }
  const result = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent) ?? []) {
      if (result.has(child)) continue;
      result.add(child);
      queue.push(child);
    }
  }
  return [...result].sort((left, right) => left - right);
}

function loopbackEndpoint(value) {
  const endpoint = value.trim().replace(/\s+\(.+\)$/, "");
  const host = endpoint.startsWith("[")
    ? endpoint.slice(1, endpoint.indexOf("]"))
    : endpoint.slice(0, endpoint.lastIndexOf(":"));
  if (!host) return false;
  if (host === "::1" || host.toLowerCase() === "localhost") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(
    ipv4
    && Number(ipv4[1]) === 127
    && ipv4.slice(1).every((part) => Number(part) <= 255),
  );
}

export function parseLsofNetworkEndpoints(output) {
  const endpoints = [];
  let processId = null;
  let commandName = null;
  let protocol = null;
  for (const line of output.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") processId = Number(value);
    else if (field === "c") commandName = value;
    else if (field === "P") protocol = value;
    else if (field === "n") {
      const peers = value.split("->");
      endpoints.push({
        processId,
        command: commandName,
        protocol,
        endpoint: value,
        loopback: peers.every(loopbackEndpoint),
      });
    }
  }
  return endpoints;
}

function sampleProcessTreeNetwork(child, stage) {
  assert(child?.pid, `Cannot sample process tree at ${stage}`);
  const processIds = descendantProcessIds(child.pid);
  const result = spawnSync(
    "lsof",
    [
      "-nP",
      "-a",
      "-p",
      processIds.join(","),
      "-iTCP",
      "-iUDP",
      "-FpcPn",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof failed at ${stage}: ${String(result.stderr ?? "").trim()}`);
  }
  const endpoints = parseLsofNetworkEndpoints(String(result.stdout ?? ""));
  const nonLoopback = endpoints.filter((entry) => !entry.loopback);
  assert(
    nonLoopback.length === 0,
    `Non-loopback socket observed at ${stage}: ${JSON.stringify(nonLoopback)}`,
  );
  return { stage, processIds, endpoints };
}

async function readNetworkAudit(auditPath) {
  const source = await readFile(auditPath, "utf8");
  const records = source
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(records.length > 0, "Packaged network audit did not record traffic");
  const unexpected = records.filter(
    (record) => record.loopback !== true || record.decision !== "allow",
  );
  assert(
    unexpected.length === 0,
    `Packaged app attempted non-loopback traffic: ${JSON.stringify(unexpected)}`,
  );
  return records;
}

export function packagedMacAppCandidates(
  root = desktopRoot,
) {
  return [
    path.join(root, "dist-electron", "mac-arm64", "agencyai.app"),
    path.join(root, "dist-electron", "mac", "agencyai.app"),
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
  for (const releaseFile of [
    "THIRD_PARTY_NOTICES.txt",
    "ELECTRON-LICENSE.txt",
    "LICENSES.chromium.html",
    "agencyai-desktop.spdx.json",
    "agencyai-desktop.cdx.json",
    "release-manifest.json",
  ]) {
    await regularNonSymlinkFile(
      path.join(resources, "release-metadata", releaseFile),
      `release metadata ${releaseFile}`,
    );
  }

  const docsDirectory = path.join(resources, "agencyai-docs");
  validateAgencyAiDocs(docsDirectory);
  const docsFiles = (await readdir(docsDirectory)).sort();
  assert(
    JSON.stringify(docsFiles) === JSON.stringify([...AGENCYAI_DOC_FILES]),
    `Packaged AgencyAI docs closure mismatch: ${docsFiles.join(", ")}`,
  );
  await assertMissing(
    path.join(resources, "openwork-docs"),
    "raw upstream docs tree",
  );
  await regularNonSymlinkFile(
    path.join(resources, "licenses", "OPENWORK-LICENSE.txt"),
    "OpenWork MIT license",
  );
  await regularNonSymlinkFile(
    path.join(resources, "licenses", "OPENCODE-LICENSE.txt"),
    "OpenCode MIT license",
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
  const localCapabilitiesModule = await import(
    pathToFileURL(
      path.join(pluginDirectory, "agencyai-local-capabilities.js"),
    ).href
  );
  assert(
    typeof localCapabilitiesModule.AgencyAiLocalCapabilities === "function",
    "Packaged AgencyAI local capabilities plugin has no factory export",
  );
  const localCapabilities =
    await localCapabilitiesModule.AgencyAiLocalCapabilities();
  const docsSearch = JSON.parse(
    await localCapabilities.tool.agencyai_docs_search.execute({
      query: "configure provider API key",
    }),
  );
  assert(
    docsSearch.matches?.[0]?.path === "providers.mdx",
    "Packaged AgencyAI docs search did not resolve providers.mdx",
  );
  const docsRead = JSON.parse(
    await localCapabilities.tool.agencyai_docs_read.execute({
      path: "providers.mdx",
    }),
  );
  assert(
    typeof docsRead.content === "string"
      && docsRead.content.includes("Settings → AI Providers"),
    "Packaged AgencyAI docs read did not return the curated provider guide",
  );
  const hostedDocsSearch = JSON.parse(
    await localCapabilities.tool.agencyai_docs_search.execute({
      query: "OpenWork Cloud Den organization team",
    }),
  );
  assert(
    Array.isArray(hostedDocsSearch.matches)
      && hostedDocsSearch.matches.length === 0,
    "Packaged AgencyAI docs exposed hosted-product guidance",
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
    docsFiles,
    docsSearch,
    docsRead,
    hostedDocsSearch,
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
        name: "AgencyAI packaged smoke",
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
    throw new Error("AgencyAI packaged smoke requires macOS arm64");
  }
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const appPath = await resolvePackagedMacApp(requestedAppPath);
  const layout = await inspectPackagedLayout(appPath, profile);
  const fixtureHome = await realpath(await mkdtemp(
    path.join(tmpdir(), "agencyai-packaged-home-"),
  ));
  const expectedStorageRoot = path.join(
    fixtureHome,
    "Library",
    "Application Support",
    profile.brand.appId,
  );
  const discoveryPath = packagedUiControlDiscoveryPath(profile, fixtureHome);
  const networkAuditPath = path.join(
    expectedStorageRoot,
    "logs",
    "network-audit.jsonl",
  );
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
    path.join(tmpdir(), "agencyai-packaged-"),
  ));
  let child = null;
  let client = null;
  let bridge = null;
  let createdWorkspaceId = null;
  let serverInfo = null;
  let serverWorkspaceRemoved = false;
  let readStdout = () => "";
  let readStderr = () => "";
  const networkSamples = [];
  const originalStorageRoot = process.env.OPENWORK_STORAGE_ROOT;
  const originalDiscovery = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  try {
    child = spawn(layout.executable, packagedSmokeLaunchArguments(), {
      cwd: desktopRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: fixtureHome,
        USERPROFILE: fixtureHome,
        // Electron resolves appData through macOS Foundation APIs, which do
        // not consistently honor HOME for GUI processes. This standard
        // Foundation test override keeps the packaged run inside the same
        // disposable home without adding a production-only storage bypass.
        CFFIXED_USER_HOME: fixtureHome,
        AGENCYAI_NETWORK_AUDIT_MODE: "deny-non-loopback",
        AGENCYAI_NETWORK_AUDIT_FILE: networkAuditPath,
      },
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
    networkSamples.push(sampleProcessTreeNetwork(child, "bridge-ready"));
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
    const notices = await evaluate(
      client,
      runtimeExpression("releaseMetadataRead", "THIRD_PARTY_NOTICES.txt"),
      { awaitPromise: true },
    );
    assert(
      notices?.available === true
      && notices?.content?.includes("OpenWork attribution and license")
      && notices?.content?.includes("OpenCode attribution and license"),
      "Packaged About notices are unavailable",
    );
    const sbom = await evaluate(
      client,
      runtimeExpression("releaseMetadataRead", "agencyai-desktop.spdx.json"),
      { awaitPromise: true },
    );
    assert(
      sbom?.available === true
      && JSON.parse(sbom.content).spdxVersion === "SPDX-2.3",
      "Packaged About SPDX document is unavailable",
    );

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
      await realpath(runtime.storage.root)
        === await realpath(expectedStorageRoot),
      "Packaged runtime attested the wrong storage root",
    );
    networkSamples.push(sampleProcessTreeNetwork(child, "runtime-ready"));

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
    networkSamples.push(sampleProcessTreeNetwork(child, "browser-fixture"));

    process.env.OPENWORK_STORAGE_ROOT = expectedStorageRoot;
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
    const networkAudit = await readNetworkAudit(networkAuditPath);
    const memoryConfigDir = path.join(
      expectedStorageRoot,
      "config",
      "opencode",
    );
    const memoryFiles = [];
    for (const relativePath of MEMORY_SYSTEM_TEMPLATE_FILES) {
      const content = await readFile(
        path.join(memoryConfigDir, relativePath),
        "utf8",
      );
      assert(
        content.trim().length > 0,
        `Packaged memory template is empty: ${relativePath}`,
      );
      memoryFiles.push(relativePath);
    }
    const opencodeConfig = JSON.parse(await readFile(
      path.join(memoryConfigDir, "opencode.jsonc"),
      "utf8",
    ));
    const expectedMemoryInstruction = path.join(memoryConfigDir, "MEMORY.md");
    const canonicalMemoryInstruction = await realpath(expectedMemoryInstruction);
    let memoryInstruction = null;
    for (const instruction of opencodeConfig.instructions ?? []) {
      if (typeof instruction !== "string") continue;
      const canonicalInstruction = await realpath(instruction).catch(() => null);
      if (canonicalInstruction === canonicalMemoryInstruction) {
        memoryInstruction = instruction;
        break;
      }
    }
    assert(
      memoryInstruction !== null,
      "Packaged first launch did not activate its runtime-derived MEMORY.md path",
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
      docs: {
        files: layout.docsFiles,
        search: layout.docsSearch.matches[0].path,
        read: layout.docsRead.path,
        hostedMatches: layout.hostedDocsSearch.matches.length,
      },
      licenses: [
        "OPENWORK-LICENSE.txt",
        "OPENCODE-LICENSE.txt",
        "THIRD_PARTY_NOTICES.txt",
        "ELECTRON-LICENSE.txt",
        "LICENSES.chromium.html",
      ],
      sboms: [
        "agencyai-desktop.spdx.json",
        "agencyai-desktop.cdx.json",
      ],
      network: {
        auditRecords: networkAudit.length,
        samples: networkSamples.map((sample) => ({
          stage: sample.stage,
          processes: sample.processIds.length,
          endpoints: sample.endpoints.length,
        })),
        unexpectedNonLoopback: 0,
      },
      memorySystem: {
        files: memoryFiles,
        instruction: memoryInstruction,
      },
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
    await rm(fixtureHome, { recursive: true, force: true });
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
