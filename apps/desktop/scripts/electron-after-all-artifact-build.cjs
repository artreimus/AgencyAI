const { readdir, rm } = require("node:fs/promises");
const path = require("node:path");

async function findBlockmaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findBlockmaps(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".blockmap")) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * electron-builder 26.15.3 unconditionally writes a blockmap next to macOS
 * ZIP targets. local-mvp has no updater provider, so retaining that metadata
 * creates a misleading release surface. This hook runs after every target and
 * before publishing, removes only generated *.blockmap files below outDir,
 * then fails closed if any remain.
 */
async function afterAllArtifactBuild(buildResult) {
  const outDir = path.resolve(buildResult.outDir);
  const blockmaps = await findBlockmaps(outDir);
  await Promise.all(blockmaps.map((file) => rm(file, { force: true })));
  const remaining = await findBlockmaps(outDir);
  if (remaining.length > 0) {
    throw new Error(
      `local-mvp packaging must not retain blockmaps: ${remaining.join(", ")}`,
    );
  }
  return [];
}

module.exports = afterAllArtifactBuild;
module.exports.default = afterAllArtifactBuild;
module.exports.findBlockmaps = findBlockmaps;
