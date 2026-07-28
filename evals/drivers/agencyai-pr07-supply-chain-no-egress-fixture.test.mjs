import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAME_DEFINITIONS,
  runFrame,
} from "./agencyai-pr07-supply-chain-no-egress-fixture.mjs";

test("defines the exact six PR07 supply-chain acceptance frames", () => {
  assert.deepEqual(
    FRAME_DEFINITIONS.map(({ frame, id }) => ({ frame, id })),
    [
      { frame: 1, id: "release-input-provenance" },
      { frame: 2, id: "sbom-license-and-notice-closure" },
      { frame: 3, id: "dmg-zip-and-native-inspection" },
      { frame: 4, id: "about-release-documents" },
      { frame: 5, id: "unsigned-ci-boundary" },
      { frame: 6, id: "packaged-zero-unexpected-egress" },
    ],
  );
});

test("rejects a frame outside the approved PR07 acceptance set", async () => {
  await assert.rejects(
    runFrame(7),
    /frame must be an integer from 1 through 6/,
  );
});
