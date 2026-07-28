import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  currentTargetTriple,
  assertRegularFileWithinRootSync,
  distributionTarget,
  loadOpencodeDistributionSync,
  loadPackagedRuntimeIntegritySync,
  packagedRuntimeIntegrityRelativePaths,
  resolveVerifiedBundledOpencodeSync,
  sha256FileSync,
  validateOpencodeDistribution,
  verifyOpencodeBinarySync,
  verifyRipgrepBinarySync,
} from "./opencode-distribution.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const temporaryDirectories = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

async function executableFixture(output) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agencyai-distribution-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "fixture");
  await writeFile(filePath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

describe("OpenCode distribution manifest", () => {
  test("pins one exact OpenCode compatibility set across every SDK consumer", async () => {
    const { path: manifestPath, manifest } = loadOpencodeDistributionSync({
      desktopRoot,
      isPackaged: false,
    });
    const constants = JSON.parse(
      await readFile(path.join(repositoryRoot, "constants.json"), "utf8"),
    );

    assert.equal(
      manifestPath,
      path.join(repositoryRoot, "opencode-distribution.json"),
    );
    assert.equal(constants.opencodeVersion.replace(/^v/, ""), manifest.binaryVersion);
    assert.equal(manifest.sdkVersion, manifest.binaryVersion);
    assert.equal(manifest.upstreamCommit, "67aec2212010d67775c35e696d8b8b54902eb338");
    assert.equal(manifest.forkCommit, "b424e670490d6241dca6f7fbcb3d6608af69aa41");
    assert.equal(manifest.forkTag, "product-opencode-v1.17.11-p2");
    assert.equal(manifest.capabilities.runtimeDownloadsDenied, true);
    assert.equal(manifest.capabilities.remoteConfigDenied, true);
    assert.equal(Object.isFrozen(manifest), true);

    for (const consumer of manifest.sdkConsumers) {
      const packageJson = JSON.parse(
        await readFile(path.join(repositoryRoot, consumer, "package.json"), "utf8"),
      );
      assert.equal(
        packageJson.dependencies["@opencode-ai/sdk"],
        manifest.sdkVersion,
        `${consumer} must use the exact manifest SDK version`,
      );
    }
  });

  test("rejects a hash sentinel or a widened SDK version", async () => {
    const raw = JSON.parse(
      await readFile(path.join(repositoryRoot, "opencode-distribution.json"), "utf8"),
    );
    raw.sdkVersion = "^1.17.11";
    raw.targetAssets["aarch64-apple-darwin"].sourceBinarySha256 =
      "SET_TO_PR_04_SIGNED_BINARY_SHA256";

    assert.throws(
      () => validateOpencodeDistribution(raw),
      /sdkVersion has an invalid format/,
    );
  });

  test("contains both OpenCode and ripgrep evidence for the MVP target", () => {
    const { manifest } = loadOpencodeDistributionSync({
      desktopRoot,
      isPackaged: false,
    });
    const target = distributionTarget(manifest, "aarch64-apple-darwin");

    assert.equal(target.opencode.sourceArchiveSha256.length, 64);
    assert.equal(target.opencode.sourceBinarySha256.length, 64);
    assert.equal(target.opencode.version, "1.17.11");
    assert.equal(target.ripgrep.version, "15.1.0");
    assert.equal(
      target.ripgrep.url,
      "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
    );
  });

  test("maps supported runtime platforms to manifest target triples", () => {
    assert.equal(
      currentTargetTriple({ platform: "darwin", arch: "arm64" }),
      "aarch64-apple-darwin",
    );
    assert.equal(
      currentTargetTriple({ platform: "linux", arch: "x64" }),
      "x86_64-unknown-linux-gnu",
    );
    assert.equal(
      currentTargetTriple({ platform: "win32", arch: "arm64" }),
      "aarch64-pc-windows-msvc",
    );
    assert.equal(
      currentTargetTriple({ platform: "freebsd", arch: "x64" }),
      null,
    );
  });

  test("separates reviewed source hashes from post-signing packaged hashes", async () => {
    const target = "aarch64-apple-darwin";
    const resources = await mkdtemp(
      path.join(os.tmpdir(), "agencyai-packaged-integrity-"),
    );
    temporaryDirectories.push(resources);
    const distributionManifestPath = path.join(
      resources,
      "opencode-distribution.json",
    );
    await writeFile(distributionManifestPath, '{"schemaVersion":1}\n', "utf8");

    const files = [];
    for (const [index, relativePath] of packagedRuntimeIntegrityRelativePaths(
      target,
    ).entries()) {
      const filePath = path.join(resources, ...relativePath.split("/"));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `packaged-byte-phase-${index}\n`, "utf8");
      files.push({ path: relativePath, sha256: sha256FileSync(filePath) });
    }
    await writeFile(
      path.join(resources, "packaged-runtime-integrity.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        hashPhase: "post-nested-signing",
        target,
        distributionManifestSha256: sha256FileSync(distributionManifestPath),
        files,
      }, null, 2)}\n`,
      "utf8",
    );

    const integrity = loadPackagedRuntimeIntegritySync({
      resourcesPath: resources,
      target,
      distributionManifestPath,
    });
    assert.equal(integrity.manifest.hashPhase, "post-nested-signing");
    assert.equal(
      integrity.hashesByAbsolutePath[
        path.join(resources, "sidecars", `opencode-${target}`)
      ],
      files[1].sha256,
    );

    await writeFile(
      path.join(resources, "sidecars", `opencode-${target}`),
      "post-manifest-mutation\n",
      "utf8",
    );
    assert.throws(
      () =>
        loadPackagedRuntimeIntegritySync({
          resourcesPath: resources,
          target,
          distributionManifestPath,
        }),
      /Packaged runtime hash mismatch/,
    );
  });

  test("rejects packaged files through symlinked parent directories", async () => {
    const resources = await mkdtemp(
      path.join(os.tmpdir(), "agencyai-integrity-symlink-"),
    );
    temporaryDirectories.push(resources);
    const actual = path.join(resources, "actual");
    const linked = path.join(resources, "linked");
    await mkdir(actual);
    await writeFile(path.join(actual, "opencode"), "binary\n", "utf8");
    await symlink(actual, linked, "dir");

    assert.throws(
      () =>
        assertRegularFileWithinRootSync(
          path.join(linked, "opencode"),
          resources,
          "Packaged OpenCode",
        ),
      /must not traverse symbolic links/,
    );
  });
});

describe("verified distribution binaries", () => {
  test("accepts only the exact OpenCode hash and version", async () => {
    const binary = await executableFixture("1.17.11");
    const asset = {
      version: "1.17.11",
      sourceBinarySha256: sha256FileSync(binary),
    };

    assert.deepEqual(
      verifyOpencodeBinarySync(binary, asset),
      {
        path: binary,
        source: "bundled-patched",
        version: "1.17.11",
        binarySha256: asset.sourceBinarySha256,
      },
    );

    await writeFile(binary, "#!/bin/sh\nprintf '%s\\n' '1.17.12'\n", "utf8");
    await assert.rejects(
      async () => verifyOpencodeBinarySync(binary, asset),
      /hash mismatch/,
    );
  });

  test("accepts only the exact packaged ripgrep hash and version", async () => {
    const binary = await executableFixture("ripgrep 15.1.0");
    const asset = {
      version: "15.1.0",
      sourceBinarySha256: sha256FileSync(binary),
    };

    assert.deepEqual(
      verifyRipgrepBinarySync(binary, asset),
      {
        path: binary,
        version: "15.1.0",
        binarySha256: asset.sourceBinarySha256,
      },
    );
  });

  test("never falls back to source hashes for an unlisted packaged path", async () => {
    const binary = await executableFixture("1.17.11");
    const asset = {
      version: "1.17.11",
      sourceBinarySha256: sha256FileSync(binary),
    };
    const target = "aarch64-apple-darwin";
    const targetPath = path.join(path.dirname(binary), `opencode-${target}`);
    await writeFile(
      targetPath,
      "#!/bin/sh\nprintf '%s\\n' '1.17.11'\n",
      "utf8",
    );
    await chmod(targetPath, 0o755);

    assert.throws(
      () =>
        resolveVerifiedBundledOpencodeSync({
          sidecarDirs: [path.dirname(binary)],
          asset,
          target,
          packagedIntegrity: { hashesByAbsolutePath: {} },
        }),
      /absent from runtime integrity/,
    );
  });
});
