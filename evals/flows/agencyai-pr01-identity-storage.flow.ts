import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { access, readFile, stat } from "node:fs/promises";
import path, { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  resolveStorageLayout,
  storageLayoutEnvironment,
  type StorageLayout,
} from "../../apps/desktop/electron/storage-layout.mjs";
import {
  snapshotProtectedState,
  verifyCoexistenceFixture,
} from "../drivers/agencyai-pr01-coexistence-fixture.mjs";
import { listTargets } from "../runner/cdp.ts";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "agencyai-pr01-identity-storage";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILDER_CONFIG_PATH = join(ROOT, "apps", "desktop", "electron-builder.config.cjs");
const DESKTOP_PACKAGE_PATH = join(ROOT, "apps", "desktop", "package.json");
const BASE_COMMIT = "f33bb51e7930ec5acd2c3ff6fb5721aebee7c354";
const MESSAGE = "Reply with exactly: core-flow ok";
const REPLY = "core-flow ok";
const MODEL_LABEL = process.env.AGENCYAI_PR01_MODEL_LABEL?.trim()
  || "AgencyAI Baseline Mock";
const MODEL_ID = process.env.AGENCYAI_PR01_MODEL_ID?.trim()
  || "agencyai-baseline";
const require = createRequire(import.meta.url);

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

interface FixtureManifest {
  schemaVersion: number;
  root: string;
  home: string;
  appData: string;
  workspace: string;
  storageRoot: string;
  manifestPath: string;
  protectedState: Awaited<ReturnType<typeof snapshotProtectedState>>;
}

interface CheckoutSnapshot {
  path: string | null;
  branch: string | null;
  head: string | null;
  status: string | null;
  error: string | null;
}

interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
}

interface FlowState {
  fixture: FixtureManifest | null;
  layout: StorageLayout | null;
  buildInfo: Record<string, unknown> | null;
  builderConfig: Record<string, unknown> | null;
  runtimeStatus: Record<string, unknown> | null;
  homeDir: string | null;
}

const state: FlowState = {
  fixture: null,
  layout: null,
  buildInfo: null,
  builderConfig: null,
  runtimeStatus: null,
  homeDir: null,
};

function run(
  command: string,
  args: string[],
  cwd: string = ROOT,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr, result.error?.message]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function witness(
  ctx: FlowContext,
  condition: unknown,
  assertion: string,
  actual?: unknown,
): void {
  if (!condition) {
    ctx.recordEvidence({
      type: "assertion",
      status: "failed",
      assertion,
      actual,
    });
    ctx.assert(
      false,
      `${assertion}${actual === undefined ? "" : ` (actual: ${stable(actual)})`}`,
    );
  }
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion,
    actual,
  });
}

function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.trim().split(/\n\n+/)) {
    let worktreePath = "";
    let head = "";
    let branch = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
      if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    if (worktreePath) entries.push({ path: worktreePath, head, branch });
  }
  return entries;
}

function captureCheckout(worktreePath: string): CheckoutSnapshot {
  const branch = run("git", ["branch", "--show-current"], worktreePath);
  const head = run("git", ["rev-parse", "HEAD"], worktreePath);
  const status = run(
    "git",
    ["status", "--short", "--branch", "--untracked-files=all"],
    worktreePath,
  );
  const failure = [branch, head, status].find((result) => result.status !== 0);
  if (failure) {
    return {
      path: worktreePath,
      branch: null,
      head: null,
      status: null,
      error: commandOutput(failure),
    };
  }
  return {
    path: worktreePath,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    status: status.stdout.trim(),
    error: null,
  };
}

function capturePrimaryDevCheckout(): CheckoutSnapshot {
  const listed = run("git", ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) {
    return {
      path: null,
      branch: null,
      head: null,
      status: null,
      error: commandOutput(listed),
    };
  }
  const dev = parseWorktrees(listed.stdout).find(
    (entry) => entry.branch === "refs/heads/dev",
  );
  if (!dev) {
    return {
      path: null,
      branch: null,
      head: null,
      status: null,
      error: "No worktree owns refs/heads/dev.",
    };
  }
  return captureCheckout(dev.path);
}

const PRIMARY_DEV_BEFORE = capturePrimaryDevCheckout();

function isInside(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === ""
    || (
      pathRelative !== ".."
      && !pathRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(pathRelative)
    );
}

async function readFixture(): Promise<FixtureManifest> {
  const fixtureRoot = process.env.AGENCYAI_PR01_FIXTURE_ROOT?.trim();
  if (!fixtureRoot) {
    throw new Error("AGENCYAI_PR01_FIXTURE_ROOT is required");
  }
  const source = await readFile(join(fixtureRoot, "manifest-before.json"), "utf8");
  const manifest = JSON.parse(source) as FixtureManifest;
  if (
    manifest.schemaVersion !== 1
    || manifest.root !== fixtureRoot
    || !path.isAbsolute(manifest.home)
    || !path.isAbsolute(manifest.appData)
    || !path.isAbsolute(manifest.workspace)
    || !path.isAbsolute(manifest.storageRoot)
  ) {
    throw new Error("invalid AgencyAI PR01 coexistence manifest");
  }
  return manifest;
}

async function invokeDesktop(
  ctx: FlowContext,
  command: string,
  ...args: unknown[]
): Promise<unknown> {
  return ctx.eval(
    `window.__OPENWORK_ELECTRON__.invokeDesktop(
      ${JSON.stringify(command)},
      ...${JSON.stringify(args)}
    )`,
    { awaitPromise: true },
  );
}

async function waitForRuntime(
  ctx: FlowContext,
  timeoutMs = 120_000,
  requirement: "healthy" | "running" = "healthy",
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const candidate = await invokeDesktop(ctx, "runtimeStatus");
      last = candidate;
      const serverRunning = field(
        field(candidate, "openworkServer"),
        "running",
      ) === true;
      const engineRunning = field(field(candidate, "engine"), "running") === true;
      if (
        isRecord(candidate)
        && serverRunning
        && (
          requirement === "running"
            ? engineRunning
            : candidate.lifecycleState === "healthy"
        )
      ) {
        return candidate;
      }
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`runtime did not become ${requirement}: ${stable(last)}`);
}

async function waitForReplacementAppTarget(
  ctx: FlowContext,
  previousTargetIds: ReadonlySet<string>,
  timeoutMs = 120_000,
): Promise<void> {
  if (!ctx.cdpBaseUrl) {
    throw new Error("CDP base URL is required for relaunch proof");
  }
  const startedAt = Date.now();
  let endpointWasUnavailable = false;
  let last: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await listTargets(ctx.cdpBaseUrl);
      last = targets;
      const appPages = targets.filter(
        (target) =>
          target.type === "page"
          && Boolean(target.webSocketDebuggerUrl)
          && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(
            target.url,
          ),
      );
      if (
        appPages.some((target) => !previousTargetIds.has(target.id))
        || (endpointWasUnavailable && appPages.length > 0)
      ) {
        return;
      }
    } catch (error) {
      endpointWasUnavailable = true;
      last = error;
    }
    await sleep(250);
  }
  throw new Error(
    `replacement Electron target did not appear: ${stable(last)}`,
  );
}

async function loadBuilderConfig(): Promise<Record<string, unknown>> {
  const module = require(BUILDER_CONFIG_PATH) as (() => Promise<unknown>);
  const candidate = await module();
  if (!isRecord(candidate)) {
    throw new Error("Electron Builder config did not return an object");
  }
  return candidate;
}

async function ensureLocalModelSelected(ctx: FlowContext): Promise<void> {
  const selected = await ctx.eval(`(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
    const action = window.__openworkControl
      ?.listActions?.()
      .find((candidate) => candidate.id === "session.create_task");
    return {
      model: (button?.textContent || "").trim(),
      ready: Boolean(action && !action.disabled),
    };
  })()`);
  if (
    field(selected, "ready") === true
    && text(field(selected, "model"))?.includes(MODEL_LABEL)
  ) {
    return;
  }

  await ctx.eval(`(() => {
    const openButton = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
    if (openButton && openButton.getAttribute("aria-expanded") !== "true") {
      openButton.click();
    }
    return Boolean(openButton);
  })()`);

  await ctx.waitFor(
    `(() => Array.from(document.querySelectorAll("button"))
      .some((candidate) => {
        const label = candidate.textContent || "";
        return label.includes(${JSON.stringify(MODEL_LABEL)})
          || label.includes(${JSON.stringify(MODEL_ID)});
      }))()`,
    { timeoutMs: 30_000, label: "AgencyAI local model provider or model" },
  );
  const selectionAction = await ctx.eval(`(() => {
    const model = Array.from(document.querySelectorAll("button"))
      .find((candidate) => (candidate.textContent || "").includes(${JSON.stringify(MODEL_ID)}));
    if (model) {
      model.click();
      return "model";
    }
    const provider = Array.from(document.querySelectorAll("button"))
      .find((candidate) => (candidate.textContent || "").includes(${JSON.stringify(MODEL_LABEL)}));
    if (!provider) return "missing";
    provider.click();
    return "provider";
  })()`);
  if (selectionAction === "missing") {
    throw new Error(`Could not find local provider ${MODEL_LABEL}`);
  }
  if (selectionAction === "provider") {
    const providerSelection = await ctx.waitFor(
      `(() => {
        const selected = Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
        if ((selected?.textContent || "").includes(${JSON.stringify(MODEL_LABEL)})) {
          return "selected";
        }
        return Array.from(document.querySelectorAll("button"))
          .some((candidate) => (candidate.textContent || "").includes(${JSON.stringify(MODEL_ID)}))
          ? "model-option"
          : null;
      })()`,
      { timeoutMs: 30_000, label: "AgencyAI local model selection" },
    );
    if (providerSelection === "selected") return;
    const modelSelected = await ctx.eval(`(() => {
      const model = Array.from(document.querySelectorAll("button"))
        .find((candidate) => (candidate.textContent || "").includes(${JSON.stringify(MODEL_ID)}));
      if (!model) return false;
      model.click();
      return true;
    })()`);
    if (modelSelected !== true) {
      throw new Error(`Could not select local model ${MODEL_ID}`);
    }
  }
  await ctx.waitFor(
    `(() => {
      const action = window.__openworkControl
        ?.listActions?.()
        .find((candidate) => candidate.id === "session.create_task");
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
      return Boolean(
        action
        && !action.disabled
        && (button?.textContent || "").includes(${JSON.stringify(MODEL_LABEL)})
      );
    })()`,
    { timeoutMs: 30_000, label: "AgencyAI local model selected" },
  );
}

async function pasteComposer(ctx: FlowContext, value: string): Promise<unknown> {
  return ctx.eval(`(() => {
    const editor =
      document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: "composer not found" };
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(value)});
    editor.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
    return { ok: true, text: editor.innerText };
  })()`);
}

export default defineFlow({
  id: FLOW_ID,
  title: "AgencyAI keeps its identity and state separate from OpenWork and global OpenCode",
  kind: "internal",
  requiresApp: true,
  requiredEnv: ["AGENCYAI_PR01_FIXTURE_ROOT"],
  precondition: async (ctx) => {
    state.fixture = await readFixture();
    state.layout = resolveStorageLayout({
      appDataPath: state.fixture.appData,
      appIdentifier: "com.artreimus.agencyai.dev",
      storageRootOverride: state.fixture.storageRoot,
    });
    await ctx.waitFor(
      "Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop && window.__openworkControl)",
      { timeoutMs: 60_000, label: "Electron bridge and control API" },
    );
    return null;
  },
  steps: [
    {
      name: "AgencyAI launches beside existing upstream installations",
      run: async (ctx) => {
        await ctx.prove("The live desktop identifies as AgencyAI without consuming seeded upstream state", {
          voiceover: vo[0],
          action: async () => {
            const buildInfo = await invokeDesktop(ctx, "appBuildInfo");
            witness(ctx, isRecord(buildInfo), "appBuildInfo returned an object", buildInfo);
            state.buildInfo = isRecord(buildInfo) ? buildInfo : null;
          },
          assert: async () => {
            const fixture = state.fixture;
            const profile = field(state.buildInfo, "productProfile");
            witness(ctx, fixture !== null, "The coexistence fixture is loaded");
            witness(ctx, field(profile, "profile") === "local-mvp", "The live product profile is local-mvp", field(profile, "profile"));
            witness(ctx, field(field(profile, "brand"), "name") === "AgencyAI", "The live product name is AgencyAI", field(field(profile, "brand"), "name"));
            witness(ctx, field(field(profile, "brand"), "appId") === "com.artreimus.agencyai", "The live production identity is AgencyAI-owned", field(field(profile, "brand"), "appId"));
            if (!fixture) return;
            const current = await snapshotProtectedState(fixture.home);
            witness(ctx, sameJson(current, fixture.protectedState), "Seeded OpenWork and global OpenCode state remains byte-identical after launch", {
              before: fixture.protectedState.sha256,
              after: current.sha256,
            });
            ctx.output("Live AgencyAI identity and coexistence baseline", JSON.stringify({
              profile: field(profile, "profile"),
              brand: field(profile, "brand"),
              protectedStateSha256: current.sha256,
              protectedRoots: current.protectedRoots,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Packaged metadata has stable AgencyAI identities and no feed",
      run: async (ctx) => {
        await ctx.prove("Builder metadata uses the frozen AgencyAI IDs and cannot infer a public protocol or updater provider", {
          voiceover: vo[1],
          action: async () => {
            state.builderConfig = await loadBuilderConfig();
          },
          assert: async () => {
            const config = state.builderConfig;
            witness(ctx, config !== null, "The Electron Builder config loaded");
            if (!config) return;
            const mac = field(config, "mac");
            const win = field(config, "win");
            const nsis = field(config, "nsis");
            const linux = field(config, "linux");
            const packageJson = JSON.parse(await readFile(DESKTOP_PACKAGE_PATH, "utf8"));

            witness(ctx, config.appId === "com.artreimus.agencyai", "Builder appId is stable", config.appId);
            witness(ctx, config.productName === "AgencyAI", "Builder productName is AgencyAI", config.productName);
            witness(ctx, config.executableName === "agencyai", "Builder executable is agencyai", config.executableName);
            witness(ctx, config.artifactName === "agencyai-${os}-${arch}-${version}.${ext}", "Artifact name uses the stable AgencyAI slug", config.artifactName);
            witness(ctx, field(mac, "helperBundleId") === "com.artreimus.agencyai.helper", "macOS helper identity is AgencyAI-owned", field(mac, "helperBundleId"));
            witness(ctx, field(nsis, "guid") === "866CE9A3-13BF-49B0-9D56-C9C43706CB0E", "NSIS GUID is permanent", field(nsis, "guid"));
            witness(ctx, field(linux, "executableName") === "agencyai", "Linux executable identity is AgencyAI-owned", field(linux, "executableName"));
            witness(ctx, field(field(win, "signtoolOptions"), "publisherName") === "AgencyAI", "Windows publisher metadata is in the installed builder schema location", field(win, "signtoolOptions"));
            witness(ctx, !Object.hasOwn(config, "protocols"), "No public OS protocol metadata is present", field(config, "protocols"));
            witness(ctx, config.publish === null, "Builder publishing is explicitly disabled against environment inference", config.publish);
            witness(ctx, !Object.hasOwn(packageJson, "repository"), "Desktop package metadata cannot infer a GitHub updater provider", packageJson.repository);
            ctx.output("AgencyAI Builder identity projection", JSON.stringify({
              appId: config.appId,
              productName: config.productName,
              executableName: config.executableName,
              artifactName: config.artifactName,
              macHelperBundleId: field(mac, "helperBundleId"),
              computerUse: field(field(state.buildInfo, "productProfile"), "brand")
                ? field(field(field(state.buildInfo, "productProfile"), "brand"), "computerUse")
                : null,
              nsisGuid: field(nsis, "guid"),
              linuxDesktopName: field(field(config, "extraMetadata"), "desktopName"),
              protocolsPresent: Object.hasOwn(config, "protocols"),
              publish: config.publish,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "First launch creates the complete AgencyAI storage layout",
      run: async (ctx) => {
        await ctx.prove("Every application-owned directory exists beneath the isolated AgencyAI root", {
          voiceover: vo[2],
          assert: async () => {
            const fixture = state.fixture;
            const layout = state.layout;
            witness(ctx, fixture !== null && layout !== null, "Fixture and storage layout are available");
            if (!fixture || !layout) return;
            witness(ctx, layout.root === fixture.storageRoot, "The resolved root is the explicit AgencyAI fixture root", layout.root);
            const directories = [
              layout.root,
              layout.userData,
              layout.sessionData,
              layout.logs,
              layout.crashDumps,
              layout.openworkConfig,
              layout.openworkData,
              layout.openworkCache,
              layout.opencodeConfig,
              layout.opencodeData,
              layout.opencodeCache,
              layout.opencodeState,
            ];
            const directoryProof = [];
            for (const directory of directories) {
              const info = await stat(directory);
              const contained = isInside(layout.root, directory);
              directoryProof.push({ directory, exists: info.isDirectory(), contained });
              witness(ctx, info.isDirectory(), `Storage directory exists: ${directory}`, directoryProof.at(-1));
              witness(ctx, contained, `Storage directory is contained by the AgencyAI root: ${directory}`, directoryProof.at(-1));
            }
            for (const filePath of [layout.runtimeDb, layout.bootstrap, layout.mcpAuth]) {
              witness(ctx, isInside(layout.root, path.dirname(filePath)), `File-valued storage parent is contained: ${filePath}`, filePath);
            }
            const current = await snapshotProtectedState(fixture.home);
            witness(ctx, sameJson(current, fixture.protectedState), "First-launch directory creation did not mutate upstream state", current.sha256);
            ctx.output("AgencyAI first-launch storage tree", JSON.stringify({
              root: layout.root,
              directories: directoryProof,
              filePaths: {
                runtimeDb: layout.runtimeDb,
                bootstrap: layout.bootstrap,
                mcpAuth: layout.mcpAuth,
              },
              upstreamStateSha256: current.sha256,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "The live runtime uses exact isolated child paths and preserves HOME",
      run: async (ctx) => {
        await ctx.prove("The running embedded stack receives only the AgencyAI storage projection while tools retain the fixture home", {
          voiceover: vo[3],
          action: async () => {
            state.runtimeStatus = await waitForRuntime(ctx);
            state.homeDir = text(await invokeDesktop(ctx, "__homeDir"));
          },
          assert: async () => {
            const fixture = state.fixture;
            const layout = state.layout;
            const status = state.runtimeStatus;
            witness(ctx, fixture !== null && layout !== null && status !== null, "Fixture, layout, and live runtime status are available");
            if (!fixture || !layout || !status) return;
            const expectedEnvironment = storageLayoutEnvironment(layout);
            const storage = field(status, "storage");
            witness(ctx, field(storage, "root") === layout.root, "Live runtime reports the AgencyAI storage root", storage);
            witness(ctx, sameJson(field(storage, "environment"), expectedEnvironment), "Embedded server attests the exact AgencyAI storage contract", field(storage, "environment"));
            const execution = field(status.openworkServer, "managedOpencodeExecution");
            const executionEnvironment = field(execution, "env");
            const childEnvironmentEntries = Array.isArray(executionEnvironment)
              ? executionEnvironment.filter(isRecord)
              : [];
            const childStorageEnvironment = Object.fromEntries(
              Object.keys(expectedEnvironment).map((name) => [
                name,
                field(
                  childEnvironmentEntries.find(
                    (entry) => field(entry, "name") === name,
                  ),
                  "value",
                ),
              ]),
            );
            witness(ctx, sameJson(childStorageEnvironment, expectedEnvironment), "Managed OpenCode spawn receives the exact AgencyAI storage environment", childStorageEnvironment);
            witness(
              ctx,
              childEnvironmentEntries
                .filter((entry) => {
                  const name = field(entry, "name");
                  return typeof name === "string" &&
                    Object.hasOwn(expectedEnvironment, name);
                })
                .every((entry) => field(entry, "redacted") === false),
              "Path-only child storage attestation contains no redacted or secret values",
              childEnvironmentEntries,
            );
            witness(ctx, state.homeDir === fixture.home, "Electron preserves the fixture HOME for providers and tools", state.homeDir);
            witness(ctx, process.env.HOME === fixture.home, "Fraimz harness and app share the explicit fixture HOME", process.env.HOME);
            witness(ctx, field(status, "lifecycleState") === "healthy", "Embedded runtime lifecycle is healthy", field(status, "lifecycleState"));
            witness(ctx, field(status.openworkServer, "running") === true, "Embedded OpenWork server is running", status.openworkServer);
            witness(ctx, field(status.openworkServer, "remoteAccessEnabled") === false, "Remote access remains disabled", status.openworkServer);
            witness(ctx, field(status.engine, "projectDir") === fixture.workspace, "OpenCode is scoped to the fixture workspace", status.engine);
            witness(ctx, expectedEnvironment.OPENWORK_RUNTIME_DB !== expectedEnvironment.OPENCODE_DB, "OpenWork and OpenCode databases are isolated", expectedEnvironment);
            await access(layout.runtimeDb);
            ctx.output("Live child storage projection", JSON.stringify({
              lifecycleState: status.lifecycleState,
              home: state.homeDir,
              workspace: field(status.engine, "projectDir"),
              remoteAccessEnabled: field(status.openworkServer, "remoteAccessEnabled"),
              storage,
              managedOpencodeStorage: childStorageEnvironment,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Restart leaves stale upstream state untouched",
      run: async (ctx) => {
        await ctx.prove("A real Electron relaunch restores the AgencyAI workspace without reading or rewriting protected upstream files", {
          voiceover: vo[4],
          action: async () => {
            const before = await verifyCoexistenceFixture(state.fixture?.root ?? "");
            ctx.output("Protected-state verification before restart", JSON.stringify(before, null, 2));
            if (!ctx.cdpBaseUrl) {
              throw new Error("CDP base URL is required for relaunch proof");
            }
            const previousTargetIds = new Set(
              (await listTargets(ctx.cdpBaseUrl))
                .filter((target) => target.type === "page")
                .map((target) => target.id),
            );
            try {
              await ctx.control("eval.app.relaunch");
            } catch (error) {
              ctx.log(
                `Relaunch control connection closed during app restart: ${stable(error)}`,
              );
            }
            await waitForReplacementAppTarget(ctx, previousTargetIds);
            await ctx.reconnect({ timeoutMs: 120_000 });
            await ctx.waitFor(
              "Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop && window.__openworkControl)",
              { timeoutMs: 60_000, label: "Electron bridge after relaunch" },
            );
            state.runtimeStatus = await waitForRuntime(ctx, 120_000, "running");
          },
          assert: async () => {
            const fixture = state.fixture;
            witness(ctx, fixture !== null, "The coexistence fixture remains available after restart");
            if (!fixture) return;
            const after = await verifyCoexistenceFixture(fixture.root);
            witness(ctx, after.passed === true, "Protected upstream state is byte-identical after restart", after);
            witness(ctx, after.beforeSha256 === after.afterSha256, "Protected-state digest is unchanged", after);
            witness(
              ctx,
              field(field(state.runtimeStatus, "openworkServer"), "running") === true
                && field(field(state.runtimeStatus, "engine"), "running") === true,
              "Runtime server and engine are operational after relaunch",
              state.runtimeStatus,
            );
            witness(ctx, field(field(state.runtimeStatus, "engine"), "projectDir") === fixture.workspace, "The AgencyAI workspace reopened after relaunch", field(state.runtimeStatus, "engine"));
            ctx.output("AgencyAI restart coexistence proof", JSON.stringify({
              protectedState: after,
              runtime: state.runtimeStatus,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "The canonical local task survives identity and storage isolation",
      run: async (ctx) => {
        await ctx.prove("A fresh post-restart task replies exactly core-flow ok while branch and primary-checkout invariants hold", {
          voiceover: vo[5],
          action: async () => {
            await ensureLocalModelSelected(ctx);
            await ctx.control("session.create_task");
            const sessionId = await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                const match = route.match(/ses_[A-Za-z0-9]+/);
                return match ? match[0] : null;
              })()`,
              { timeoutMs: 30_000, label: "new post-restart session id" },
            );
            witness(ctx, typeof sessionId === "string" && sessionId.startsWith("ses_"), "A fresh post-restart task became active", sessionId);

            const pasted = await pasteComposer(ctx, MESSAGE);
            witness(ctx, field(pasted, "ok") === true, "Canonical prompt was pasted", pasted);
            const submitted = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button"))
                .find((candidate) =>
                  /run task|send|run/i.test((candidate.textContent || "").trim())
                  && !candidate.disabled
                );
              if (button) {
                button.click();
                return "clicked";
              }
              const editor = document.querySelector('[contenteditable="true"]');
              if (!editor) return "none";
              editor.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
              }));
              return "enter";
            })()`);
            witness(ctx, submitted === "clicked" || submitted === "enter", "Canonical prompt was submitted", submitted);
          },
          assert: async () => {
            await ctx.waitForText(MESSAGE, { timeoutMs: 60_000 });
            await ctx.waitFor(
              `(() => Array
                .from(document.querySelectorAll('[data-message-role="assistant"]'))
                .some((element) => (element.textContent || "").trim() === ${JSON.stringify(REPLY)}))()`,
              { timeoutMs: 120_000, label: "exact assistant core-flow reply" },
            );
            await ctx.expectNoText("Something went wrong");
            witness(ctx, true, "Assistant rendered exactly core-flow ok", REPLY);

            const currentBranch = run("git", ["branch", "--show-current"]);
            const currentHead = run("git", ["rev-parse", "HEAD"]);
            witness(ctx, currentBranch.status === 0 && currentBranch.stdout.trim() === "codex/agencyai-pr01", "Current worktree is the PR01 branch", commandOutput(currentBranch));
            witness(ctx, currentHead.status === 0 && /^[a-f0-9]{40}$/.test(currentHead.stdout.trim()), "PR01 HEAD is an exact commit", commandOutput(currentHead));
            witness(ctx, currentHead.stdout.trim() !== BASE_COMMIT, "PR01 evidence runs on a commit after the PR00 base", currentHead.stdout.trim());

            witness(ctx, PRIMARY_DEV_BEFORE.error === null, "Primary dev checkout snapshot was captured", PRIMARY_DEV_BEFORE.error);
            const primaryAfter = PRIMARY_DEV_BEFORE.path
              ? captureCheckout(PRIMARY_DEV_BEFORE.path)
              : {
                  path: null,
                  branch: null,
                  head: null,
                  status: null,
                  error: "Primary dev checkout path was not captured.",
                };
            witness(ctx, primaryAfter.error === null, "Primary dev checkout is still readable", primaryAfter.error);
            witness(ctx, primaryAfter.branch === PRIMARY_DEV_BEFORE.branch, "Primary checkout branch is unchanged", primaryAfter.branch);
            witness(ctx, primaryAfter.head === PRIMARY_DEV_BEFORE.head, "Primary checkout commit is unchanged", primaryAfter.head);
            witness(ctx, primaryAfter.status === PRIMARY_DEV_BEFORE.status, "Primary checkout status is unchanged", primaryAfter.status);

            ctx.output("PR01 exact-head and primary-checkout invariants", JSON.stringify({
              prWorktree: {
                branch: currentBranch.stdout.trim(),
                head: currentHead.stdout.trim(),
                base: BASE_COMMIT,
              },
              primaryBefore: PRIMARY_DEV_BEFORE,
              primaryAfter,
              unchanged: {
                branch: primaryAfter.branch === PRIMARY_DEV_BEFORE.branch,
                head: primaryAfter.head === PRIMARY_DEV_BEFORE.head,
                status: primaryAfter.status === PRIMARY_DEV_BEFORE.status,
              },
            }, null, 2));
          },
          screenshot: {
            name: "post-restart-canonical-task",
            requireText: [REPLY],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});
