import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FRAME_DEFINITIONS,
  resolveFixtureRoot,
} from "./agencyai-pr04-opencode-distribution-fixture.mjs";

test("defines the exact six PR04 distribution acceptance frames", () => {
  assert.deepEqual(
    FRAME_DEFINITIONS.map(({ frame, id }) => ({ frame, id })),
    [
      { frame: 1, id: "manifest-compatibility" },
      { frame: 2, id: "artifact-provenance" },
      { frame: 3, id: "bundled-only-runtime" },
      { frame: 4, id: "child-environment" },
      { frame: 5, id: "empty-cache" },
      { frame: 6, id: "readiness-and-local-surfaces" },
    ],
  );
});

test("accepts only a dedicated PR04 temporary fixture root", () => {
  const expected = join(tmpdir(), "agencyai-pr04-safe");
  assert.equal(resolveFixtureRoot(expected), expected);
  assert.throws(
    () => resolveFixtureRoot(join(tmpdir(), "not-agencyai-pr04")),
    /agencyai-pr04-/,
  );
  assert.throws(
    () => resolveFixtureRoot(process.cwd()),
    /agencyai-pr04-/,
  );
});
