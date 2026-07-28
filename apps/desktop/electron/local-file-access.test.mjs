import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { authorizeLocalFileTarget } from "./local-file-access.mjs";

describe("local file IPC policy", () => {
  it("permits existing and not-yet-created targets inside an authorized root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agencyai-files-"));
    try {
      const file = path.join(root, "artifacts", "report.md");
      await mkdir(path.dirname(file));
      await writeFile(file, "report");
      assert.equal(
        await authorizeLocalFileTarget(file, { allowedRoots: [root] }),
        file,
      );
      const future = path.join(root, "artifacts", "future.pdf");
      assert.equal(
        await authorizeLocalFileTarget(future, {
          allowedRoots: [root],
          allowMissing: true,
        }),
        future,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects relative, outside, missing, and symlink-escape targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agencyai-files-"));
    const outside = await mkdtemp(path.join(tmpdir(), "agencyai-outside-"));
    try {
      const secret = path.join(outside, "secret.txt");
      await writeFile(secret, "secret");
      await symlink(outside, path.join(root, "escape"));

      await assert.rejects(
        authorizeLocalFileTarget("relative.txt", { allowedRoots: [root] }),
        /absolute path/,
      );
      await assert.rejects(
        authorizeLocalFileTarget(secret, { allowedRoots: [root] }),
        /outside the selected workspaces/,
      );
      await assert.rejects(
        authorizeLocalFileTarget(path.join(root, "missing.txt"), {
          allowedRoots: [root],
        }),
        /does not exist/,
      );
      await assert.rejects(
        authorizeLocalFileTarget(path.join(root, "escape", "secret.txt"), {
          allowedRoots: [root],
        }),
        /symbolic-link escape/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
