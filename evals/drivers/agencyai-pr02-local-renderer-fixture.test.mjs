import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalRendererFixture,
  verifyLocalRendererFixture,
} from "./agencyai-pr02-local-renderer-fixture.mjs";

test("creates and verifies a fresh PR02 renderer fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agencyai-pr02-"));
  try {
    const manifest = await createLocalRendererFixture(root);
    assert.equal(manifest.root, root);
    assert.match(manifest.workspace, /agencyai-pr02-/);
    assert.equal((await verifyLocalRendererFixture(root)).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects fixture roots outside the dedicated temporary prefix", async () => {
  await assert.rejects(
    createLocalRendererFixture(path.join(tmpdir(), "not-agencyai-pr02")),
    /agencyai-pr02-/,
  );
});
