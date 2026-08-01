import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
const defaultDistRoot = resolve(desktopRoot, "dist-electron");
const metadataFiles = Object.freeze([
  ["release-manifest.json", "release-manifest.json"],
  ["agencyai-desktop.spdx.json", "spdx.json"],
  ["agencyai-desktop.cdx.json", "cyclonedx.json"],
  ["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
  ["OPENWORK-LICENSE.txt", "OPENWORK-LICENSE.txt"],
  ["OPENCODE-LICENSE.txt", "OPENCODE-LICENSE.txt"],
  ["ELECTRON-LICENSE.txt", "ELECTRON-LICENSE.txt"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function regularFile(filePath, label) {
  invariant(existsSync(filePath), `${label} is missing: ${filePath}`);
  const stats = lstatSync(filePath);
  invariant(
    stats.isFile() && !stats.isSymbolicLink() && stats.size > 0,
    `${label} must be a non-empty regular file`,
  );
  return stats;
}

function safeVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/, "");
  invariant(
    /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "AgencyAI release version must be a 0.x semantic version",
  );
  return version;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const direct = args.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

export function stageMacosReleaseAssets({
  distRoot = defaultDistRoot,
  appPath = join(distRoot, "mac-arm64", "agencyai.app"),
  version: inputVersion,
  tag: inputTag,
} = {}) {
  const version = safeVersion(
    inputVersion
      ?? JSON.parse(
        readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
      ).version,
  );
  const tag = inputTag ?? `agencyai-desktop-v${version}`;
  invariant(
    tag === `agencyai-desktop-v${version}`,
    `Expected exact release tag agencyai-desktop-v${version}`,
  );

  const resolvedDistRoot = resolve(distRoot);
  const resolvedAppPath = resolve(appPath);
  const metadataRoot = join(
    resolvedAppPath,
    "Contents",
    "Resources",
    "release-metadata",
  );
  const artifactPrefix = `agencyai-mac-arm64-${version}`;
  const sourceArtifacts = [
    join(resolvedDistRoot, `${artifactPrefix}.dmg`),
    join(resolvedDistRoot, `${artifactPrefix}.zip`),
  ];
  for (const artifact of sourceArtifacts) {
    regularFile(artifact, basename(artifact));
  }

  const releaseManifestPath = join(metadataRoot, "release-manifest.json");
  regularFile(releaseManifestPath, "Embedded release manifest");
  const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  invariant(
    releaseManifest.product === "AgencyAI Desktop"
      && releaseManifest.profile === "local-mvp"
      && releaseManifest.target === "aarch64-apple-darwin",
    "Embedded release manifest does not describe the AgencyAI macOS local MVP",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(releaseManifest.source?.commit ?? ""),
    "Embedded release manifest source commit is invalid",
  );

  const stagingRoot = join(resolvedDistRoot, "release-assets");
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const staged = [];
  for (const sourcePath of sourceArtifacts) {
    const targetPath = join(stagingRoot, basename(sourcePath));
    copyFileSync(sourcePath, targetPath);
    staged.push(targetPath);
  }
  for (const [sourceName, suffix] of metadataFiles) {
    const sourcePath = join(metadataRoot, sourceName);
    regularFile(sourcePath, `Release metadata ${sourceName}`);
    const targetPath = join(
      stagingRoot,
      `${artifactPrefix}.${suffix}`,
    );
    copyFileSync(sourcePath, targetPath);
    staged.push(targetPath);
  }

  const distributables = staged
    .slice(0, sourceArtifacts.length)
    .map((filePath) => {
      const stats = regularFile(filePath, basename(filePath));
      return {
        file: basename(filePath),
        sha256: sha256(filePath),
        size: stats.size,
      };
    });
  const provenancePath = join(
    stagingRoot,
    `${artifactPrefix}.release-provenance.json`,
  );
  writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "AgencyAI Desktop",
        version,
        tag,
        target: "aarch64-apple-darwin",
        sourceCommit: releaseManifest.source.commit,
        generatedAt: releaseManifest.generatedAt,
        distributables,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  staged.push(provenancePath);

  const checksums = staged
    .map((filePath) => `${sha256(filePath)}  ${basename(filePath)}`)
    .sort();
  const checksumsPath = join(stagingRoot, "SHA256SUMS.txt");
  writeFileSync(checksumsPath, `${checksums.join("\n")}\n`, "utf8");

  return {
    ok: true,
    version,
    tag,
    sourceCommit: releaseManifest.source.commit,
    stagingRoot,
    files: [
      ...staged.map((filePath) => basename(filePath)),
      basename(checksumsPath),
    ].sort(),
  };
}

if (process.argv[1] === scriptPath) {
  try {
    const result = stageMacosReleaseAssets({
      distRoot: readArg("--dist") ?? defaultDistRoot,
      appPath: readArg("--app") ?? undefined,
      version: readArg("--version") ?? undefined,
      tag: readArg("--tag") ?? undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `[agencyai-release-assets] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
