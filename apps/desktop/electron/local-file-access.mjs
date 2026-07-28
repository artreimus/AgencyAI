import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export async function authorizeLocalFileTarget(
  value,
  {
    allowedRoots,
    allowMissing = false,
  },
) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error("Local file access denied: an absolute path is required");
  }
  const candidate = path.resolve(raw);
  const canonicalRoots = [];
  for (const rootValue of allowedRoots ?? []) {
    if (typeof rootValue !== "string" || !rootValue.trim()) continue;
    const root = path.resolve(rootValue);
    try {
      canonicalRoots.push({
        lexical: root,
        canonical: await realpath(root),
      });
    } catch {
      // A stale or deleted workspace is not an authorization root.
    }
  }
  if (canonicalRoots.length === 0) {
    throw new Error("Local file access denied: no authorized roots are available");
  }

  const lexicalRoot = canonicalRoots.find(({ lexical }) =>
    isPathInside(lexical, candidate));
  if (!lexicalRoot) {
    throw new Error("Local file access denied: path is outside the selected workspaces");
  }

  let existingPath;
  try {
    await lstat(candidate);
    existingPath = candidate;
  } catch {
    if (!allowMissing) {
      throw new Error("Local file access denied: path does not exist");
    }
    existingPath = await nearestExistingAncestor(candidate);
  }
  if (!existingPath) {
    throw new Error("Local file access denied: path cannot be resolved");
  }

  const canonicalExisting = await realpath(existingPath);
  if (!isPathInside(lexicalRoot.canonical, canonicalExisting)) {
    throw new Error("Local file access denied: symbolic-link escape");
  }
  return candidate;
}
