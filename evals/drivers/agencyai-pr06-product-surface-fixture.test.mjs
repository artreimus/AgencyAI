import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAME_DEFINITIONS,
  runFrame,
} from "./agencyai-pr06-product-surface-fixture.mjs";

test("defines the exact six PR06 product-surface acceptance frames", () => {
  assert.deepEqual(
    FRAME_DEFINITIONS.map(({ frame, id }) => ({ frame, id })),
    [
      { frame: 1, id: "brand-and-build-composition" },
      { frame: 2, id: "local-welcome-and-settings" },
      { frame: 3, id: "curated-docs-and-prompts" },
      { frame: 4, id: "local-docs-tools" },
      { frame: 5, id: "about-licenses-and-artifact-scan" },
      { frame: 6, id: "packaged-product-surface" },
    ],
  );
});

test("rejects a frame outside the approved PR06 acceptance set", async () => {
  await assert.rejects(
    runFrame(7),
    /frame must be an integer from 1 through 6/,
  );
});
