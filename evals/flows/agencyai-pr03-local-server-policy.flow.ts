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

const FLOW_ID = "agencyai-pr03-local-server-policy";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = join(
  ROOT,
  "evals",
  "drivers",
  "agencyai-pr03-local-server-policy-fixture.mjs",
);
const RESULT_MARKER = "AGENCYAI_PR03_RESULT ";
const RUN_TIMEOUT_MS = 120_000;

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

function runDriver(frame: number, fixtureRoot: string): SpawnSyncReturns<string> {
  return spawnSync("bun", [DRIVER, String(frame), fixtureRoot], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: RUN_TIMEOUT_MS,
  });
}

function diagnosticOutput(run: SpawnSyncReturns<string>): string {
  const output = [
    run.stdout.trim(),
    run.stderr.trim(),
    run.error?.message ?? "",
  ].filter(Boolean);
  return output.join("\n");
}

function parseDriverResult(run: SpawnSyncReturns<string>): DriverResult {
  const line = run.stdout
    .split("\n")
    .findLast((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) {
    throw new Error("PR03 fixture did not print its result marker");
  }
  const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length));
  if (
    !isRecord(parsed)
    || parsed.passed !== true
    || typeof parsed.frame !== "number"
    || !Array.isArray(parsed.checks)
  ) {
    throw new Error("PR03 fixture printed an invalid result");
  }
  const checks = parsed.checks.map((entry): DriverCheck => {
    if (
      !isRecord(entry)
      || entry.passed !== true
      || typeof entry.label !== "string"
    ) {
      throw new Error("PR03 fixture printed an invalid check");
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
      const fixtureRoot = await mkdtemp(join(tmpdir(), "agencyai-pr03-"));
      let run: SpawnSyncReturns<string> | null = null;
      let result: DriverResult | null = null;
      try {
        await ctx.prove(claim, {
          voiceover: narration[frame - 1],
          action: () => {
            run = runDriver(frame, fixtureRoot);
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
            result = parseDriverResult(run);
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
              `$ bun evals/drivers/agencyai-pr03-local-server-policy-fixture.mjs ${frame} <isolated-pr03-temp-root>`,
            );
            ctx.output(
              "sanitized acceptance evidence",
              JSON.stringify(result.evidence, null, 2),
            );
          },
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  };
}

export default defineFlow({
  id: FLOW_ID,
  title: "AgencyAI local server policy is fail-closed and desktop trust stays scoped",
  kind: "internal",
  requiresApp: false,
  steps: [
    acceptanceStep(
      1,
      "Read the authenticated non-secret local readiness contract",
      "Authenticated readiness reports local-mvp and loopback bindings without secrets or local coordinates",
    ),
    acceptanceStep(
      2,
      "Call disabled product routes and ordinary local APIs",
      "Cloud, remote, voice, and upgrade routes fail closed while ordinary local APIs remain available",
    ),
    acceptanceStep(
      3,
      "Restart with persisted cloud and ordinary MCP records",
      "Openwork-cloud is reversibly quarantined and never registered while ordinary MCP synchronizes",
    ),
    acceptanceStep(
      4,
      "Exercise the strict OpenCode proxy allowlist",
      "Reviewed local methods reach only the loopback engine and denied methods never reach it",
    ),
    acceptanceStep(
      5,
      "Compare desktop wrapper approval with OpenCode permission",
      "Desktop approval is exact-origin, one-use, and workspace-scoped while OpenCode permission remains explicit",
    ),
    acceptanceStep(
      6,
      "Inspect local guidance and run a local task",
      "Local prompts and plugins omit hosted steering and a local task completes with zero unexpected egress",
    ),
  ],
});
