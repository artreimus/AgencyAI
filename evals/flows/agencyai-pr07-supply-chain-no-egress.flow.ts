import {
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineFlow,
  type FlowContext,
  type FlowStep,
} from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "agencyai-pr07-supply-chain-no-egress";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = join(
  ROOT,
  "evals",
  "drivers",
  "agencyai-pr07-supply-chain-no-egress-fixture.mjs",
);
const RESULT_MARKER = "AGENCYAI_PR07_RESULT ";

const loadedVoiceover = await loadVoiceoverParagraphs(FLOW_ID);
if (!loadedVoiceover) {
  throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);
}
if (loadedVoiceover.length !== 6) {
  throw new Error(`Expected exactly six approved voice-over frames for ${FLOW_ID}.`);
}
const voiceover = [...loadedVoiceover];

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

function runDriver(frame: number): SpawnSyncReturns<string> {
  return spawnSync(
    "node",
    [DRIVER, String(frame), ROOT],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      timeout: frame === 3 || frame === 6 ? 600_000 : 240_000,
      maxBuffer: 64 * 1024 * 1024,
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
    throw new Error("PR07 fixture did not print its result marker");
  }
  const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length));
  if (
    !isRecord(parsed)
    || parsed.passed !== true
    || typeof parsed.frame !== "number"
    || !Array.isArray(parsed.checks)
  ) {
    throw new Error("PR07 fixture printed an invalid result");
  }
  const checks = parsed.checks.map((entry): DriverCheck => {
    if (
      !isRecord(entry)
      || entry.passed !== true
      || typeof entry.label !== "string"
    ) {
      throw new Error("PR07 fixture printed an invalid check");
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
      let run: SpawnSyncReturns<string> | null = null;
      await ctx.prove(claim, {
        voiceover: voiceover[frame - 1],
        action: () => {
          run = runDriver(frame);
        },
        assert: () => {
          if (!run) throw new Error(`Frame ${frame} driver did not run`);
          if (run.status !== 0) {
            ctx.output("fixture diagnostics", diagnosticOutput(run));
          }
          witness(
            ctx,
            run.status === 0,
            `Frame ${frame} acceptance driver exits successfully`,
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
            `$ node evals/drivers/agencyai-pr07-supply-chain-no-egress-fixture.mjs ${frame} <agencyai-root>`,
          );
          ctx.output(
            "sanitized acceptance evidence",
            JSON.stringify(result.evidence, null, 2),
          );
        },
      });
    },
  };
}

export default defineFlow({
  id: FLOW_ID,
  title: "AgencyAI proves a closed local desktop supply chain with no unexpected egress",
  kind: "internal",
  spec: "PLAN_AGENCYAI_DESKTOP_MVP.md",
  requiresApp: false,
  steps: [
    acceptanceStep(
      1,
      "Record every release input before packaging",
      "Renderer, font, server, orchestrator, and verified OpenCode inputs have an exact provenance record",
    ),
    acceptanceStep(
      2,
      "Generate complete SBOMs and notices",
      "The signed manifest, SPDX, CycloneDX, policy, and notices agree on the shipped component closure",
    ),
    acceptanceStep(
      3,
      "Inspect the app, DMG, ZIP, and native payload",
      "Every candidate contains the identical arm64 AgencyAI app and no updater metadata",
    ),
    acceptanceStep(
      4,
      "Read release evidence from About",
      "Users can inspect notices, runtime licenses, and SBOMs through a narrow packaged-file reader",
    ),
    acceptanceStep(
      5,
      "Enforce the unsigned PR07 CI boundary",
      "Hosted arm64 CI uploads proof only and cannot sign, notarize, or publish a release",
    ),
    acceptanceStep(
      6,
      "Exercise the packaged app under deny-non-loopback auditing",
      "The local runtime, native modules, browser wrapper, and docs work with zero unexpected non-loopback traffic",
    ),
  ],
});
