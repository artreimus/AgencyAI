import {
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineFlow,
  type FlowContext,
  type FlowStep,
} from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "agencyai-pr04-opencode-distribution";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = join(
  ROOT,
  "evals",
  "drivers",
  "agencyai-pr04-opencode-distribution-fixture.mjs",
);
const FORK_ROOT =
  process.env.AGENCYAI_OPENCODE_SOURCE_ROOT
  ?? join(ROOT, "..", "AgencyAI-OpenCode");
const RESULT_MARKER = "AGENCYAI_PR04_RESULT ";
const RUN_TIMEOUT_MS = 180_000;

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) {
  throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);
}
if (vo.length !== 6) {
  throw new Error(`Expected exactly six approved voice-over frames for ${FLOW_ID}.`);
}
const narration = [...vo];

type DriverCheck = {
  label: string;
  passed: true;
  actual?: unknown;
};

type DriverResult = {
  passed: true;
  frame: number;
  checks: DriverCheck[];
  evidence: unknown;
};

let sharedFixtureRoot: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    ctx.assert(false, assertion);
  }
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion,
    actual,
  });
}

async function fixtureRoot(): Promise<string> {
  if (!sharedFixtureRoot) {
    sharedFixtureRoot = await mkdtemp(
      join(tmpdir(), "agencyai-pr04-"),
    );
  }
  return sharedFixtureRoot;
}

async function cleanupFixture(): Promise<void> {
  if (!sharedFixtureRoot) return;
  const root = sharedFixtureRoot;
  sharedFixtureRoot = null;
  await rm(root, { recursive: true, force: true });
}

function runDriver(
  frame: number,
  fixture: string,
): SpawnSyncReturns<string> {
  return spawnSync(
    "bun",
    [DRIVER, String(frame), fixture, ROOT, FORK_ROOT],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      timeout: RUN_TIMEOUT_MS,
    },
  );
}

function diagnosticOutput(run: SpawnSyncReturns<string>): string {
  return [
    run.stdout.trim(),
    run.stderr.trim(),
    run.error?.message ?? "",
  ].filter(Boolean).join("\n");
}

function parseDriverResult(run: SpawnSyncReturns<string>): DriverResult {
  const line = run.stdout
    .split("\n")
    .findLast((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) {
    throw new Error("PR04 fixture did not print its result marker");
  }
  const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length));
  if (
    !isRecord(parsed)
    || parsed.passed !== true
    || typeof parsed.frame !== "number"
    || !Array.isArray(parsed.checks)
  ) {
    throw new Error("PR04 fixture printed an invalid result");
  }
  const checks = parsed.checks.map((entry): DriverCheck => {
    if (
      !isRecord(entry)
      || entry.passed !== true
      || typeof entry.label !== "string"
    ) {
      throw new Error("PR04 fixture printed an invalid check");
    }
    return {
      label: entry.label,
      passed: true,
      ...(Object.hasOwn(entry, "actual") ? { actual: entry.actual } : {}),
    };
  });
  return {
    passed: true,
    frame: parsed.frame,
    checks,
    evidence: parsed.evidence,
  };
}

function acceptanceStep(
  frame: number,
  name: string,
  claim: string,
): FlowStep {
  return {
    name,
    run: async (ctx) => {
      const fixture = await fixtureRoot();
      let run: SpawnSyncReturns<string> | null = null;
      try {
        await ctx.prove(claim, {
          voiceover: narration[frame - 1],
          action: () => {
            run = runDriver(frame, fixture);
          },
          assert: () => {
            if (!run) throw new Error(`Frame ${frame} driver did not run`);
            if (run.status !== 0) {
              ctx.output("fixture diagnostics", diagnosticOutput(run));
            }
            witness(
              ctx,
              run.status === 0,
              `Frame ${frame} isolated fixture exits successfully`,
              run.status,
            );
            const result = parseDriverResult(run);
            witness(
              ctx,
              result.frame === frame,
              `Frame ${frame} result is bound to the requested acceptance frame`,
              result.frame,
            );
            for (const check of result.checks) {
              witness(ctx, check.passed, check.label, check.actual);
            }
            ctx.output(
              "driver",
              `$ bun evals/drivers/agencyai-pr04-opencode-distribution-fixture.mjs ${frame} <isolated-pr04-temp-root> <openwork-root> <exact-fork-root>`,
            );
            ctx.output(
              "sanitized acceptance evidence",
              JSON.stringify(result.evidence, null, 2),
            );
          },
        });
      } catch (error) {
        await cleanupFixture();
        throw error;
      }
      if (frame === 6) await cleanupFixture();
    },
  };
}

export default defineFlow({
  id: FLOW_ID,
  title: "AgencyAI ships one verified no-download OpenCode distribution",
  kind: "internal",
  spec: "PLAN_AGENCYAI_DESKTOP_MVP.md",
  requiresApp: false,
  steps: [
    acceptanceStep(
      1,
      "Bind the immutable manifest to exact source and SDK versions",
      "The distribution manifest, fork checkout, binary version, and all SDK consumers agree exactly",
    ),
    acceptanceStep(
      2,
      "Verify the real arm64 artifacts and packaged ripgrep",
      "The archive, extracted binary, provenance, SBOMs, and ripgrep match reviewed hashes and execute",
    ),
    acceptanceStep(
      3,
      "Attempt bundled, custom, global, PATH, and installer resolution",
      "Production accepts only the verified bundled engine and toolchain while every fallback fails closed",
    ),
    acceptanceStep(
      4,
      "Construct the explicit OpenCode child environment",
      "AgencyAI preserves intentional local values, scrubs inherited policy overrides, and forces no-download flags",
    ),
    acceptanceStep(
      5,
      "Run empty-cache fallbacks behind a monitored registry",
      "Plugin, provider, formatter, LSP, and executable fallbacks make zero requests and no package mutation",
    ),
    acceptanceStep(
      6,
      "Read authenticated provenance readiness and local engine APIs",
      "Secret-free readiness proves the bundled source and hash while providers, sessions, tools, and MCP work",
    ),
  ],
});
