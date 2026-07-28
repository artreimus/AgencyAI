import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_FEATURES,
  type ProductProfile,
} from "../../packages/product-config/src/contract.ts";
import { projectRendererProductProfile } from "../../apps/app/src/app/lib/product-profile.ts";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "agencyai-pr00-baseline-profile";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = join(ROOT, "evals", "baselines", "agencyai-pr00-upstream.json");
const CLOSURE_GUARD_PATH = join(ROOT, "scripts", "check-source-closure.mjs");
const PRODUCT_CONFIG_TSX_CLI = join(
  ROOT,
  "packages",
  "product-config",
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);
const DOCUMENTARY_ALLOWLIST = "source-closure-documentary-allowlist.json";
const BASELINE_COMMIT = "1f41a52070cbc400b17b05136533e8d3737e25da";
const MESSAGE = "Reply with exactly: core-flow ok";
const REPLY = "core-flow ok";
const RESTRICTED_SEGMENT = String.fromCharCode(101, 101);

const EXPECTED_FEATURES = Object.freeze({
  openworkCloud: false,
  cloudBootstrap: false,
  connectLinks: false,
  dynamicOrgBranding: false,
  analytics: false,
  automaticUpdates: false,
  runtimeDownloads: false,
  runtimePluginInstall: false,
  remoteAssetFetches: false,
  hostedWebSearch: false,
  remoteWorkspaces: false,
  remoteAccess: false,
  workspaceSharing: false,
  legacyOpenWorkImport: false,
  freshStart: false,
  openworkModels: false,
  voice: false,
  googleWorkspace: false,
  browserAutomation: true,
  computerUse: true,
}) satisfies ProductProfile["features"];

const EXCLUDED_FEATURES = PRODUCT_FEATURES.filter(
  (feature) => !EXPECTED_FEATURES[feature],
);

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
  liveProfile: ProductProfile | null;
  liveBuildProbe: unknown;
  projectionProbe: unknown;
  projectedProfile: ProductProfile | null;
}

const state: FlowState = {
  liveProfile: null,
  liveBuildProbe: null,
  projectionProbe: null,
  projectedProfile: null,
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
  const output: string[] = [];
  if (result.stdout.trim()) output.push(result.stdout.trim());
  if (result.stderr.trim()) output.push(result.stderr.trim());
  if (result.error) output.push(result.error.message);
  return output.join("\n");
}

function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.trim().split(/\n\n+/)) {
    let path = "";
    let head = "";
    let branch = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    if (path) entries.push({ path, head, branch });
  }
  return entries;
}

function captureCheckout(path: string): CheckoutSnapshot {
  const branch = run("git", ["branch", "--show-current"], path);
  const head = run("git", ["rev-parse", "HEAD"], path);
  const status = run(
    "git",
    ["status", "--short", "--branch", "--untracked-files=all"],
    path,
  );
  const failure = [branch, head, status].find((result) => result.status !== 0);
  if (failure) {
    return {
      path,
      branch: null,
      head: null,
      status: null,
      error: commandOutput(failure),
    };
  }
  return {
    path,
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
  const snapshot = captureCheckout(dev.path);
  if (snapshot.head !== dev.head) {
    return {
      ...snapshot,
      error: `Worktree-list HEAD ${dev.head} did not match checkout HEAD ${snapshot.head ?? "missing"}.`,
    };
  }
  return snapshot;
}

// This is intentionally captured at module load, before the runner starts the
// flow, so the last frame can prove the user's primary checkout stayed inert.
const PRIMARY_DEV_BEFORE = capturePrimaryDevCheckout();

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProductProfile(value: unknown): value is ProductProfile {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.profile !== "local-mvp" && value.profile !== "upstream") return false;
  if (value.networkPolicy !== "user-authorized" && value.networkPolicy !== "air-gapped") {
    return false;
  }
  if (!isRecord(value.brand) || !isRecord(value.features)) return false;
  if (
    typeof value.brand.name !== "string"
    || typeof value.brand.slug !== "string"
    || typeof value.brand.companyName !== "string"
    || typeof value.brand.appId !== "string"
    || typeof value.brand.devAppId !== "string"
    || typeof value.brand.executableName !== "string"
    || typeof value.brand.artifactPrefix !== "string"
    || typeof value.brand.rendererScheme !== "string"
    || (typeof value.brand.protocol !== "string" && value.brand.protocol !== null)
    || typeof value.brand.nsisGuid !== "string"
    || typeof value.brand.linuxDesktopName !== "string"
    || (typeof value.brand.supportEmail !== "string" && value.brand.supportEmail !== null)
    || (typeof value.brand.docsUrl !== "string" && value.brand.docsUrl !== null)
    || (typeof value.brand.feedbackUrl !== "string" && value.brand.feedbackUrl !== null)
    || (typeof value.brand.issueUrl !== "string" && value.brand.issueUrl !== null)
    || !isRecord(value.brand.computerUse)
    || typeof value.brand.computerUse.displayName !== "string"
    || typeof value.brand.computerUse.bundleName !== "string"
    || typeof value.brand.computerUse.bundleId !== "string"
  ) {
    return false;
  }
  if (
    value.brand.repository !== null
    && (
      !isRecord(value.brand.repository)
      || typeof value.brand.repository.owner !== "string"
      || typeof value.brand.repository.name !== "string"
    )
  ) {
    return false;
  }
  const features = value.features;
  return (
    Object.keys(features).length === PRODUCT_FEATURES.length
    && PRODUCT_FEATURES.every((feature) => typeof features[feature] === "boolean")
  );
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
    ctx.assert(false, `${assertion}${actual === undefined ? "" : ` (actual: ${stable(actual)})`}`);
  }
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion,
    actual,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseJson(source: string): unknown {
  return JSON.parse(source);
}

function parseCommandJson(result: SpawnSyncReturns<string>): unknown {
  return parseJson(result.stdout);
}

function runProductValidation(profile: ProductProfile): SpawnSyncReturns<string> {
  const script = `import {
  parseProductProfile,
  parseProductProfileName,
} from "./packages/product-config/src/schema.ts";

const profile = JSON.parse(process.env.AGENCYAI_PROFILE_PROBE || "null");
Reflect.set(profile.features, "cloudBootstrap", true);
let invalidProfileRejected = false;
let invalidProfileError = "";
try {
  parseProductProfile(profile);
} catch (error) {
  invalidProfileRejected = true;
  invalidProfileError = error instanceof Error ? error.message : String(error);
}

const selectors = ["", "LOCAL-MVP", "../upstream", "local-mvp;upstream", true, null];
const rejectedSelectors = [];
for (const selector of selectors) {
  try {
    parseProductProfileName(selector);
  } catch {
    rejectedSelectors.push(JSON.stringify(selector));
  }
}

console.log(JSON.stringify({
  invalidProfileRejected,
  invalidProfileError,
  invalidSelectorCount: selectors.length,
  rejectedSelectors,
}));
`;
  return spawnSync(process.execPath, [PRODUCT_CONFIG_TSX_CLI, "--eval", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENCYAI_PROFILE_PROBE: JSON.stringify(profile),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function invokeAppBuildInfo(ctx: FlowContext): Promise<unknown> {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "Electron desktop bridge",
  });
  return ctx.eval(`(async () => {
    const invokeDesktop = window.__OPENWORK_ELECTRON__.invokeDesktop.bind(
      window.__OPENWORK_ELECTRON__,
    );
    const first = await invokeDesktop("appBuildInfo");
    const before = JSON.stringify(first.productProfile);
    const attempts = {
      name: Reflect.set(first.productProfile.brand, "name", "Tampered"),
      repository: Reflect.set(first.productProfile.brand.repository, "owner", "tampered"),
      cloud: Reflect.set(first.productProfile.features, "openworkCloud", true),
      browser: Reflect.set(first.productProfile.features, "browserAutomation", false),
    };
    const localAfter = JSON.stringify(first.productProfile);
    const fresh = await invokeDesktop("appBuildInfo");
    const freshSerialized = JSON.stringify(fresh.productProfile);
    return {
      command: "window.__OPENWORK_ELECTRON__.invokeDesktop('appBuildInfo')",
      attempts,
      localCloneChanged: localAfter !== before,
      freshMatchesOriginal: freshSerialized === before,
      locallyObserved: first.productProfile,
      freshResponse: fresh,
    };
  })()`, { awaitPromise: true });
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
  title: "AgencyAI PR 00 keeps the local product contract closed and the canonical task intact",
  kind: "internal",
  requiresApp: true,
  precondition: async (ctx) => {
    await ctx.waitFor(
      "Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop && window.__openworkControl)",
      { timeoutMs: 60_000, label: "Electron bridge and control API" },
    );
    const readiness = await ctx.waitFor(
      `(() => {
        const route = window.__openworkControl.snapshot().route || "";
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        const action = window.__openworkControl
          .listActions()
          .find((candidate) => candidate.id === "session.create_task");
        return action && !action.disabled ? "ready" : null;
      })()`,
      {
        timeoutMs: 30_000,
        label: "session.create_task enabled (or welcome/signin)",
      },
    );
    return readiness === "blocked"
      ? "Profile is not onboarded; this proof requires a disposable local workspace."
      : null;
  },
  steps: [
    {
      name: "The upstream baseline is durable and reproducible",
      run: async (ctx) => {
        await ctx.prove("The checked-in baseline manifest records a green canonical run at the exact upstream commit", {
          voiceover: vo[0],
          assert: async () => {
            const source = await readFile(BASELINE_PATH, "utf8");
            const manifest = parseJson(source);
            const environment = field(manifest, "environment");
            const canonical = field(manifest, "canonicalFlow");
            const summary = field(canonical, "summary");
            const primary = field(manifest, "primaryCheckout");

            witness(ctx, field(manifest, "schemaVersion") === 1, "Baseline schema version is 1", field(manifest, "schemaVersion"));
            witness(ctx, field(manifest, "baselineCommit") === BASELINE_COMMIT, "Baseline commit is the reviewed upstream SHA", field(manifest, "baselineCommit"));
            witness(ctx, field(environment, "temporaryProfile") === true, "Baseline used a temporary profile", field(environment, "temporaryProfile"));
            witness(ctx, field(environment, "temporaryWorkspace") === true, "Baseline used a temporary workspace", field(environment, "temporaryWorkspace"));
            witness(ctx, field(environment, "loopbackOnly") === true, "Baseline runtime was loopback-only", field(environment, "loopbackOnly"));
            witness(ctx, field(canonical, "id") === "core-flow", "Baseline ran the canonical core-flow", field(canonical, "id"));
            witness(ctx, field(canonical, "status") === "passed", "Baseline canonical flow passed", field(canonical, "status"));
            witness(ctx, field(canonical, "exactReply") === REPLY, "Baseline assistant reply was exact", field(canonical, "exactReply"));
            witness(ctx, sameJson(summary, { passed: 1, failed: 0, skipped: 0 }), "Baseline summary is one pass with no failures or skips", summary);
            witness(ctx, sha256(field(canonical, "sourceSha256")), "Baseline records the canonical flow source digest", field(canonical, "sourceSha256"));
            witness(ctx, sha256(field(canonical, "reportSha256")), "Baseline records the report digest", field(canonical, "reportSha256"));
            witness(ctx, sha256(field(canonical, "fraimzSha256")), "Baseline records the fraimz digest", field(canonical, "fraimzSha256"));
            witness(ctx, field(primary, "headBefore") === BASELINE_COMMIT, "Baseline primary checkout began at the upstream SHA", field(primary, "headBefore"));
            witness(ctx, field(primary, "headAfter") === BASELINE_COMMIT, "Baseline primary checkout ended at the same SHA", field(primary, "headAfter"));
            witness(ctx, field(primary, "statusBefore") === field(primary, "statusAfter"), "Baseline primary checkout status was unchanged", primary);
            ctx.output("evals/baselines/agencyai-pr00-upstream.json", source.trim());
          },
        });
      },
    },
    {
      name: "Live build information is local and immutable at its source",
      run: async (ctx) => {
        await ctx.prove("Electron returns the compiled local-mvp profile again unchanged after a renderer clone is mutated", {
          voiceover: vo[1],
          action: async () => {
            state.liveBuildProbe = await invokeAppBuildInfo(ctx);
          },
          assert: async () => {
            const freshResponse = field(state.liveBuildProbe, "freshResponse");
            const freshProfileCandidate = field(freshResponse, "productProfile");
            witness(ctx, isProductProfile(freshProfileCandidate), "Live Electron response has the complete product-profile contract", freshProfileCandidate);
            if (!isProductProfile(freshProfileCandidate)) return;
            const liveProfile = freshProfileCandidate;
            state.liveProfile = liveProfile;

            witness(ctx, field(state.liveBuildProbe, "command") === "window.__OPENWORK_ELECTRON__.invokeDesktop('appBuildInfo')", "Build info came through the live Electron invokeDesktop bridge", field(state.liveBuildProbe, "command"));
            witness(ctx, field(state.liveBuildProbe, "localCloneChanged") === true, "The renderer-side clone received the attempted nested mutation", field(state.liveBuildProbe, "locallyObserved"));
            witness(ctx, field(state.liveBuildProbe, "freshMatchesOriginal") === true, "A fresh appBuildInfo response exactly matches the original build profile", field(state.liveBuildProbe, "freshMatchesOriginal"));
            witness(ctx, liveProfile.profile === "local-mvp", "Live build profile is local-mvp", liveProfile.profile);
            witness(ctx, liveProfile.brand.name === "AgencyAI", "Live build identity remains AgencyAI", liveProfile.brand.name);
            witness(ctx, liveProfile.brand.repository?.owner === "artreimus", "Nested repository identity remains product-owned", liveProfile.brand.repository);
            witness(ctx, liveProfile.features.openworkCloud === false, "Attempted cloud broadening did not affect the fresh response", liveProfile.features.openworkCloud);
            witness(ctx, liveProfile.features.browserAutomation === true, "Attempted browser narrowing did not affect the fresh build response", liveProfile.features.browserAutomation);
            ctx.output("Live Electron build-info immutability probe", JSON.stringify({
              command: field(state.liveBuildProbe, "command"),
              attempts: field(state.liveBuildProbe, "attempts"),
              localCloneChanged: field(state.liveBuildProbe, "localCloneChanged"),
              freshMatchesOriginal: field(state.liveBuildProbe, "freshMatchesOriginal"),
              freshProfile: liveProfile,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "The live profile exposes exactly twenty capabilities",
      run: async (ctx) => {
        await ctx.prove("The live profile has the exact two-enabled and eighteen-disabled PR 00 feature matrix", {
          voiceover: vo[2],
          assert: async () => {
            const profile = state.liveProfile;
            witness(ctx, profile !== null, "A validated live profile is available from Electron");
            if (!profile) return;

            witness(ctx, PRODUCT_FEATURES.length === 20, "The product contract declares exactly 20 feature keys", PRODUCT_FEATURES);
            witness(ctx, sameJson(Object.keys(profile.features), PRODUCT_FEATURES), "Live feature keys exactly match the canonical order", Object.keys(profile.features));
            witness(ctx, sameJson(profile.features, EXPECTED_FEATURES), "Live features exactly match the local-mvp matrix", profile.features);
            witness(ctx, EXCLUDED_FEATURES.length === 18, "Exactly 18 features are build-disabled", EXCLUDED_FEATURES);
            witness(ctx, profile.features.browserAutomation === true, "browserAutomation is build-enabled", profile.features.browserAutomation);
            witness(ctx, profile.features.computerUse === true, "computerUse is build-enabled", profile.features.computerUse);
            witness(ctx, EXCLUDED_FEATURES.every((feature) => profile.features[feature] === false), "Every cloud, remote, sharing, analytics, update, hosted, voice, Google, and runtime-install capability is disabled", profile.features);
            ctx.output(
              "Exact local-mvp feature matrix",
              PRODUCT_FEATURES
                .map((feature) => `${feature}=${String(profile.features[feature])}`)
                .join("\n"),
            );
          },
        });
      },
    },
    {
      name: "Validation and projection fail closed",
      run: async (ctx) => {
        await ctx.prove("Invalid selectors and profiles are rejected, while IPC and runtime inputs can only disable features", {
          voiceover: vo[3],
          action: async () => {
            const profile = state.liveProfile;
            witness(ctx, profile !== null, "A validated live profile is available for hostile probes");
            if (!profile) return;

            const validation = runProductValidation(profile);
            witness(ctx, validation.status === 0, "Product-config validation probe exits 0", commandOutput(validation));
            const validationReport = parseCommandJson(validation);

            const hostileIpc = structuredClone(profile);
            for (const feature of PRODUCT_FEATURES) {
              Reflect.set(hostileIpc.features, feature, true);
            }
            Reflect.set(hostileIpc.features, "browserAutomation", false);

            const runtimeCandidate: Record<string, boolean> = {};
            for (const feature of PRODUCT_FEATURES) runtimeCandidate[feature] = true;
            runtimeCandidate.computerUse = false;

            const projected = projectRendererProductProfile(
              { productProfile: hostileIpc },
              runtimeCandidate,
            );
            state.projectedProfile = projected;
            state.projectionProbe = {
              ...(isRecord(validationReport) ? validationReport : {}),
              projected,
            };
          },
          assert: async () => {
            const projected = state.projectedProfile;
            witness(ctx, projected !== null, "A validated effective projection is available");
            if (!projected) return;
            const invalidProfileError = text(field(state.projectionProbe, "invalidProfileError"));
            const invalidSelectorCount = field(state.projectionProbe, "invalidSelectorCount");
            const rejectedSelectors = field(state.projectionProbe, "rejectedSelectors");

            witness(ctx, field(state.projectionProbe, "invalidProfileRejected") === true, "Schema rejects an impossible cloud subfeature combination", invalidProfileError);
            witness(ctx, invalidProfileError?.includes("requires openworkCloud") === true, "Validation explains the cloud dependency failure", invalidProfileError);
            witness(ctx, Array.isArray(rejectedSelectors) && rejectedSelectors.length === invalidSelectorCount, "Every malformed launch selector is rejected", rejectedSelectors);
            witness(ctx, EXCLUDED_FEATURES.every((feature) => projected.features[feature] === false), "No IPC or runtime candidate can enable a build-disabled feature", projected.features);
            witness(ctx, projected.features.browserAutomation === false, "IPC may disable browserAutomation", projected.features.browserAutomation);
            witness(ctx, projected.features.computerUse === false, "Runtime policy may disable computerUse", projected.features.computerUse);
            witness(ctx, Object.isFrozen(projected), "Effective profile is frozen", Object.isFrozen(projected));
            witness(ctx, Object.isFrozen(projected.features), "Effective feature matrix is frozen", Object.isFrozen(projected.features));
            witness(ctx, Reflect.set(projected.features, "openworkCloud", true) === false, "Frozen projection rejects a final mutation attempt", projected.features.openworkCloud);
            ctx.output("Fail-closed validation and projection", JSON.stringify({
              invalidProfileRejected: field(state.projectionProbe, "invalidProfileRejected"),
              invalidProfileReason: "cloudBootstrap requires openworkCloud",
              invalidSelectorsRejected: rejectedSelectors,
              effectiveFeatures: projected.features,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "The source-closure guard passes real code and rejects a hostile tree",
      run: async (ctx) => {
        const hostileRoot = await mkdtemp(join(tmpdir(), "agencyai-source-closure-hostile-"));
        try {
          await ctx.prove("The real tree has zero findings and the same guard rejects a temporary restricted source root", {
            voiceover: vo[4],
            action: async () => {
              await mkdir(join(hostileRoot, "scripts"), { recursive: true });
              await mkdir(join(hostileRoot, RESTRICTED_SEGMENT), { recursive: true });
              await writeFile(
                join(hostileRoot, "scripts", DOCUMENTARY_ALLOWLIST),
                `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
              );
              await writeFile(
                join(hostileRoot, RESTRICTED_SEGMENT, "private.js"),
                "export const privateSource = true;\n",
              );
            },
            assert: async () => {
              const real = run(process.execPath, [
                CLOSURE_GUARD_PATH,
                "--root",
                ROOT,
                "--json",
              ]);
              witness(ctx, real.status === 0, "Source-closure guard passes the real PR 00 tree", commandOutput(real));
              const realReport = parseCommandJson(real);
              witness(ctx, field(realReport, "ok") === true, "Real source-closure JSON reports ok", realReport);
              witness(ctx, sameJson(field(realReport, "findings"), []), "Real source-closure JSON has zero findings", field(realReport, "findings"));
              ctx.output("$ node scripts/check-source-closure.mjs --json", real.stdout.trim());

              const hostile = run(process.execPath, [
                CLOSURE_GUARD_PATH,
                "--root",
                hostileRoot,
                "--json",
              ]);
              witness(ctx, hostile.status === 1, "Hostile source fixture exits 1", commandOutput(hostile));
              const hostileReport = parseCommandJson(hostile);
              const findings = field(hostileReport, "findings");
              const expectedFinding = Array.isArray(findings) && findings.some(
                (finding) => field(finding, "code") === "EE_ROOT_PRESENT"
                  && field(finding, "file") === RESTRICTED_SEGMENT,
              );
              witness(ctx, field(hostileReport, "ok") === false, "Hostile source-closure JSON reports failure", hostileReport);
              witness(ctx, expectedFinding, `Hostile report contains the expected /${RESTRICTED_SEGMENT} root finding`, findings);
              ctx.output("Hostile fixture source-closure report", hostile.stdout.trim());
            },
          });
        } finally {
          await rm(hostileRoot, { recursive: true, force: true });
        }
      },
    },
    {
      name: "The canonical task still works and the primary checkout stays untouched",
      run: async (ctx) => {
        await ctx.prove("A fresh task receives exactly core-flow ok while branch and checkout invariants hold", {
          voiceover: vo[5],
          action: async () => {
            await ctx.control("session.create_task");
            const sessionId = await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                const match = route.match(/ses_[A-Za-z0-9]+/);
                return match ? match[0] : null;
              })()`,
              { timeoutMs: 30_000, label: "new active session id" },
            );
            witness(ctx, typeof sessionId === "string" && sessionId.startsWith("ses_"), "A fresh task became active", sessionId);

            const pasted = await pasteComposer(ctx, MESSAGE);
            witness(ctx, field(pasted, "ok") === true, "Canonical prompt was pasted into the composer", pasted);
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
            witness(ctx, true, "Assistant rendered exactly core-flow ok in the active task", REPLY);

            const currentBranch = run("git", ["branch", "--show-current"]);
            const currentHead = run("git", ["rev-parse", "HEAD"]);
            witness(ctx, currentBranch.status === 0, "Current PR worktree branch is readable", commandOutput(currentBranch));
            witness(ctx, currentHead.status === 0 && /^[a-f0-9]{40}$/.test(currentHead.stdout.trim()), "Current PR worktree HEAD is an exact commit", commandOutput(currentHead));

            witness(ctx, PRIMARY_DEV_BEFORE.error === null, "Primary dev checkout snapshot was captured when the flow loaded", PRIMARY_DEV_BEFORE.error);
            witness(ctx, PRIMARY_DEV_BEFORE.branch === "dev", "Primary checkout owns branch dev", PRIMARY_DEV_BEFORE.branch);
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
            witness(ctx, primaryAfter.path === PRIMARY_DEV_BEFORE.path, "Primary checkout path is unchanged");
            witness(ctx, primaryAfter.branch === PRIMARY_DEV_BEFORE.branch, "Primary checkout branch is unchanged", primaryAfter.branch);
            witness(ctx, primaryAfter.head === PRIMARY_DEV_BEFORE.head, "Primary checkout commit is unchanged", primaryAfter.head);
            witness(ctx, primaryAfter.status === PRIMARY_DEV_BEFORE.status, "Primary checkout status is unchanged", primaryAfter.status);

            ctx.output("PR 00 and primary-checkout invariants", JSON.stringify({
              prWorktree: {
                branch: currentBranch.stdout.trim(),
                head: currentHead.stdout.trim(),
              },
              primarySnapshotAtFlowLoad: {
                branch: PRIMARY_DEV_BEFORE.branch,
                head: PRIMARY_DEV_BEFORE.head,
                status: PRIMARY_DEV_BEFORE.status,
              },
              primaryAfterCanonicalTask: {
                branch: primaryAfter.branch,
                head: primaryAfter.head,
                status: primaryAfter.status,
              },
              unchanged: {
                branch: primaryAfter.branch === PRIMARY_DEV_BEFORE.branch,
                head: primaryAfter.head === PRIMARY_DEV_BEFORE.head,
                status: primaryAfter.status === PRIMARY_DEV_BEFORE.status,
              },
            }, null, 2));
          },
          screenshot: {
            name: "canonical-task-response",
            requireText: [REPLY],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});
