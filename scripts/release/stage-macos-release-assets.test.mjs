import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { stageMacosReleaseAssets } from "./stage-macos-release-assets.mjs";

const metadataFiles = [
  "release-manifest.json",
  "agencyai-desktop.spdx.json",
  "agencyai-desktop.cdx.json",
  "THIRD_PARTY_NOTICES.txt",
  "OPENWORK-LICENSE.txt",
  "OPENCODE-LICENSE.txt",
  "ELECTRON-LICENSE.txt",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("AgencyAI macOS release asset staging", () => {
  it("stages only the signed release closure and writes verifiable checksums", () => {
    const root = mkdtempSync(join(tmpdir(), "agencyai-release-assets-test-"));
    try {
      const distRoot = join(root, "dist-electron");
      const appPath = join(distRoot, "mac-arm64", "agencyai.app");
      const metadataRoot = join(
        appPath,
        "Contents",
        "Resources",
        "release-metadata",
      );
      mkdirSync(metadataRoot, { recursive: true });
      const version = "0.1.0-beta.1";
      const prefix = `agencyai-mac-arm64-${version}`;
      writeFileSync(join(distRoot, `${prefix}.dmg`), "signed-dmg");
      writeFileSync(join(distRoot, `${prefix}.zip`), "signed-zip");
      for (const name of metadataFiles) {
        const value = name === "release-manifest.json"
          ? JSON.stringify({
            product: "AgencyAI Desktop",
            profile: "local-mvp",
            target: "aarch64-apple-darwin",
            source: { commit: "a".repeat(40) },
            generatedAt: "2026-07-29T00:00:00.000Z",
          })
          : name;
        writeFileSync(join(metadataRoot, name), value);
      }

      const result = stageMacosReleaseAssets({
        distRoot,
        appPath,
        version,
        tag: `agencyai-desktop-v${version}`,
      });
      assert.equal(result.ok, true);
      assert.equal(result.files.length, 11);
      const checksums = readFileSync(
        join(result.stagingRoot, "SHA256SUMS.txt"),
        "utf8",
      );
      assert.match(
        checksums,
        new RegExp(`${sha256("signed-dmg")}  ${prefix}\\.dmg`),
      );
      assert.match(
        checksums,
        new RegExp(`${sha256("signed-zip")}  ${prefix}\\.zip`),
      );
      const provenance = JSON.parse(
        readFileSync(
          join(result.stagingRoot, `${prefix}.release-provenance.json`),
          "utf8",
        ),
      );
      assert.equal(provenance.sourceCommit, "a".repeat(40));
      assert.deepEqual(
        provenance.distributables.map(({ file }) => file),
        [`${prefix}.dmg`, `${prefix}.zip`],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a tag that does not exactly match the package version", () => {
    assert.throws(
      () => stageMacosReleaseAssets({
        distRoot: "/does/not/matter",
        version: "0.1.0-beta.1",
        tag: "agencyai-desktop-v0.1.0-beta.2",
      }),
      /Expected exact release tag/,
    );
  });
});
