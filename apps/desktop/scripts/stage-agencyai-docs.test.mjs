import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENCYAI_DOC_FILES,
  stageAgencyAiDocs,
  validateAgencyAiDocs,
} from "./stage-agencyai-docs.mjs";

const sourceDocs = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/agencyai-docs",
);

test("stages the exact curated AgencyAI local docs closure", () => {
  const root = mkdtempSync(resolve(tmpdir(), "agencyai-docs-"));
  const outputRoot = resolve(root, "staged");
  try {
    const staged = stageAgencyAiDocs({
      sourceRoot: sourceDocs,
      outputRoot,
    });
    assert.deepEqual(staged.files, AGENCYAI_DOC_FILES);
    assert.doesNotThrow(() => validateAgencyAiDocs(outputRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects hosted-product steering before packaging", () => {
  const root = mkdtempSync(resolve(tmpdir(), "agencyai-docs-"));
  const sourceRoot = resolve(root, "source");
  try {
    cpSync(sourceDocs, sourceRoot, { recursive: true });
    writeFileSync(
      resolve(sourceRoot, "getting-started.mdx"),
      "# Setup\nSign in to OpenWork Cloud.",
      "utf8",
    );
    assert.throws(
      () => stageAgencyAiDocs({
        sourceRoot,
        outputRoot: resolve(root, "staged"),
      }),
      /forbidden guidance/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
