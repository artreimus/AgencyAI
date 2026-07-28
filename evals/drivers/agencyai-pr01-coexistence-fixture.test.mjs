import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createCoexistenceFixture,
  snapshotProtectedState,
  verifyCoexistenceFixture,
} from "./agencyai-pr01-coexistence-fixture.mjs";

describe("AgencyAI PR01 coexistence fixture", () => {
  it("captures and verifies all seeded upstream state byte-for-byte", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agencyai-pr01-"));
    try {
      const manifest = await createCoexistenceFixture(root);
      const snapshot = await snapshotProtectedState(manifest.home);
      assert.deepEqual(snapshot, manifest.protectedState);

      const report = await verifyCoexistenceFixture(root);
      assert.equal(report.passed, true);
      assert.equal(report.beforeSha256, report.afterSha256);
      assert.equal(report.beforeEntries.length > 15, true);
      assert.deepEqual(report.protectedRoots.slice(0, 5), [
        ".config/openwork",
        ".config/opencode",
        ".cache/opencode",
        ".local/share/opencode",
        ".local/state/opencode",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when a protected global OpenCode file is modified", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agencyai-pr01-"));
    try {
      const manifest = await createCoexistenceFixture(root);
      await appendFile(
        path.join(manifest.home, ".config", "opencode", "opencode.json"),
        "\nchanged\n",
        "utf8",
      );
      await assert.rejects(
        verifyCoexistenceFixture(root),
        /protected upstream state changed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects roots outside a purpose-named temporary fixture", async () => {
    await assert.rejects(
      createCoexistenceFixture(path.join(tmpdir(), "wrong-prefix")),
      /agencyai-pr01-/,
    );
    await assert.rejects(
      createCoexistenceFixture(path.resolve(tmpdir(), "..", "agencyai-pr01-escape")),
      /inside/,
    );
  });
});
