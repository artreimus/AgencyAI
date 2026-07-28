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

const FLOW_ID = "agencyai-pr05-desktop-security";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = join(
  ROOT,
  "evals",
  "drivers",
  "agencyai-pr05-desktop-security-fixture.mjs",
);
const RESULT_MARKER = "AGENCYAI_PR05_RESULT ";

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
      timeout: frame === 6 ? 300_000 : 180_000,
      maxBuffer: 32 * 1024 * 1024,
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
    throw new Error("PR05 fixture did not print its result marker");
  }
  const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length));
  if (
    !isRecord(parsed)
    || parsed.passed !== true
    || typeof parsed.frame !== "number"
    || !Array.isArray(parsed.checks)
  ) {
    throw new Error("PR05 fixture printed an invalid result");
  }
  const checks = parsed.checks.map((entry): DriverCheck => {
    if (
      !isRecord(entry)
      || entry.passed !== true
      || typeof entry.label !== "string"
    ) {
      throw new Error("PR05 fixture printed an invalid check");
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
            `$ node evals/drivers/agencyai-pr05-desktop-security-fixture.mjs ${frame} <agencyai-root>`,
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
  title: "AgencyAI packages a sandboxed authenticated local desktop runtime",
  kind: "internal",
  spec: "PLAN_AGENCYAI_DESKTOP_MVP.md",
  requiresApp: false,
  steps: [
    acceptanceStep(
      1,
      "Inspect the internal renderer and production CSP",
      "The packaged renderer has one sandboxed internal origin and no unsafe-eval script path",
    ),
    acceptanceStep(
      2,
      "Exercise privileged IPC, local-file, and external-URL policies",
      "Only the exact main renderer reaches privileged IPC and file or URL operations stay narrowly scoped",
    ),
    acceptanceStep(
      3,
      "Exercise permission and browser sandbox policies",
      "Permissions default to deny and remote browser tabs never inherit the AgencyAI desktop bridge",
    ),
    acceptanceStep(
      4,
      "Build and exercise the authenticated browser wrapper",
      "Model-visible browser tools receive neither CDP coordinates nor access to the app renderer",
    ),
    acceptanceStep(
      5,
      "Run native modules and validate the package contract",
      "The pinned arm64 Electron ABI executes SQLite and PTY while hardened fuses and exact resources remain configured",
    ),
    acceptanceStep(
      6,
      "Launch and exercise the actual packaged application",
      "The packaged app proves internal rendering, verified loopback runtime, native modules, helper, and isolated browser automation",
    ),
  ],
});
