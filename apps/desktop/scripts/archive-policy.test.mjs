import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExtractedTreeSafeSync,
  assertSafeArchiveEntries,
} from "./archive-policy.mjs";

test("archive entry policy allows only bounded regular relative paths", () => {
  assert.deepEqual(
    assertSafeArchiveEntries([
      { name: "bundle/", type: "directory", size: 0 },
      { name: "bundle/opencode", type: "file", size: 1024 },
    ]),
    [
      { name: "bundle/", type: "directory", size: 0 },
      { name: "bundle/opencode", type: "file", size: 1024 },
    ],
  );

  for (const entry of [
    { name: "../escape", type: "file", size: 1 },
    { name: "/absolute", type: "file", size: 1 },
    { name: "C:\\absolute.exe", type: "file", size: 1 },
    { name: "bundle//alias", type: "file", size: 1 },
    { name: "bundle/link", type: "special", size: 0 },
  ]) {
    assert.throws(
      () => assertSafeArchiveEntries([entry]),
      /Unsafe sidecar archive/,
    );
  }
});

test("post-extraction policy rejects symlinks and accepts regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agencyai-archive-policy-"));
  const outside = join(root, "..", `agencyai-archive-outside-${process.pid}`);
  try {
    await mkdir(join(root, "bundle"));
    await writeFile(join(root, "bundle", "opencode"), "binary");
    assert.doesNotThrow(() => assertExtractedTreeSafeSync(root));

    await writeFile(outside, "outside");
    await symlink(outside, join(root, "bundle", "link"));
    assert.throws(
      () => assertExtractedTreeSafeSync(root),
      /is a symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
