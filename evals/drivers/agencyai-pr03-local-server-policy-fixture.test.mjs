import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FRAME_DEFINITIONS,
  resolveFixtureRoot,
} from "./agencyai-pr03-local-server-policy-fixture.mjs";

test("defines the exact six PR03 acceptance frames", () => {
  assert.deepEqual(
    FRAME_DEFINITIONS.map(({ frame, id }) => ({ frame, id })),
    [
      { frame: 1, id: "readiness" },
      { frame: 2, id: "route-policy" },
      { frame: 3, id: "mcp-quarantine" },
      { frame: 4, id: "proxy-allowlist" },
      { frame: 5, id: "desktop-approval" },
      { frame: 6, id: "local-agent" },
    ],
  );
});

test("accepts only a dedicated PR03 temporary fixture root", () => {
  const expected = join(tmpdir(), "agencyai-pr03-safe");
  assert.equal(resolveFixtureRoot(expected), expected);
  assert.throws(
    () => resolveFixtureRoot(join(tmpdir(), "not-agencyai-pr03")),
    /agencyai-pr03-/,
  );
  assert.throws(
    () => resolveFixtureRoot(process.cwd()),
    /agencyai-pr03-/,
  );
});
