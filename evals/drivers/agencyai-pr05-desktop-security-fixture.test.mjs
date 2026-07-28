import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAME_DEFINITIONS,
} from "./agencyai-pr05-desktop-security-fixture.mjs";

test("defines the exact six PR05 desktop-security acceptance frames", () => {
  assert.deepEqual(
    FRAME_DEFINITIONS.map(({ frame, id }) => ({ frame, id })),
    [
      { frame: 1, id: "internal-renderer" },
      { frame: 2, id: "privileged-ipc-and-files" },
      { frame: 3, id: "permissions-and-browser-sandbox" },
      { frame: 4, id: "authenticated-browser-wrapper" },
      { frame: 5, id: "electron-native-package" },
      { frame: 6, id: "packaged-runtime-smoke" },
    ],
  );
});
