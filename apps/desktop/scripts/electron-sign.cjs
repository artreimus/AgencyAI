const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const afterPack = require("./electron-after-pack.cjs");

function runCodesign(args, label) {
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign failed for ${label} with status ${result.status}`);
  }
}

function signingArgs(options) {
  return options.keychain ? ["--keychain", options.keychain] : [];
}

function resolvePackagedTarget(resourcesPath) {
  const sidecarsPath = path.join(resourcesPath, "sidecars");
  const targets = fs
    .readdirSync(sidecarsPath)
    .map((name) =>
      /^opencode-((?:aarch64|x86_64)-apple-darwin)$/.exec(name)?.[1] ?? null)
    .filter(Boolean);
  if (targets.length !== 1) {
    throw new Error(
      `AgencyAI macOS signing requires exactly one packaged OpenCode target; received ${targets.join(", ") || "none"}`,
    );
  }
  return targets[0];
}

function canonicalExactIgnore(exactPaths, inheritedIgnore = null) {
  const exact = new Set(
    exactPaths.map((filePath) => fs.realpathSync(path.resolve(filePath))),
  );
  return (filePath) => {
    let canonical = path.resolve(filePath);
    try {
      canonical = fs.realpathSync(canonical);
    } catch {
      // Let the signer report missing or invalid paths.
    }
    return exact.has(canonical)
      || (typeof inheritedIgnore === "function"
        && inheritedIgnore(filePath) === true);
  };
}

function assertDirectoryWithinRoot(directoryPath, rootPath, label) {
  const root = path.resolve(rootPath);
  const directory = path.resolve(directoryPath);
  const relative = path.relative(root, directory);
  if (
    !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be a descendant of packaged resources`);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${label} must not traverse symbolic links`);
    }
  }
  const canonicalRoot = fs.realpathSync(root);
  const canonicalDirectory = fs.realpathSync(directory);
  if (!canonicalDirectory.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${label} resolves outside packaged resources`);
  }
}

function signRuntimeExecutable(filePath, options, entitlementsPath) {
  const identity = options.identity || "-";
  const args = [
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    entitlementsPath,
    ...signingArgs(options),
    "--sign",
    identity,
  ];
  if (identity !== "-") args.push("--timestamp");
  args.push(filePath);
  runCodesign(args, `packaged runtime executable ${filePath}`);
}

function signComputerUseHelper(helperPath, options) {
  assertDirectoryWithinRoot(
    helperPath,
    path.resolve(helperPath, "..", ".."),
    "Computer Use helper app",
  );
  const identity = options.identity || "-";
  const args = [
    "--force",
    "--deep",
    "--options",
    "runtime",
    ...signingArgs(options),
    "--sign",
    identity,
  ];
  if (identity !== "-") args.push("--timestamp");
  args.push(helperPath);
  runCodesign(args, "Computer Use helper app");
}

async function electronSign(options) {
  if (options.platform !== "darwin") {
    const { sign } = await import("@electron/osx-sign");
    return sign(options);
  }

  const appPath = path.resolve(options.app);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const target = resolvePackagedTarget(resourcesPath);
  const {
    assertRegularFileWithinRootSync,
    packagedRuntimeIntegrityRelativePaths,
  } = await import("../electron/opencode-distribution.mjs");
  const relativePaths = packagedRuntimeIntegrityRelativePaths(target);
  const executablePaths = relativePaths
    .filter((relativePath) => !relativePath.endsWith("LICENSE-ripgrep"))
    .map((relativePath) => {
      const filePath = path.resolve(
        resourcesPath,
        ...relativePath.split("/"),
      );
      assertRegularFileWithinRootSync(
        filePath,
        resourcesPath,
        `Packaged runtime executable ${relativePath}`,
      );
      return filePath;
    });

  const entitlementsPath = path.join(
    __dirname,
    "..",
    "build",
    "entitlements.mac.plist",
  );
  for (const filePath of executablePaths) {
    signRuntimeExecutable(filePath, options, entitlementsPath);
  }

  const { getBuildProductProfile } = await import("@openwork/product-config");
  const profile = getBuildProductProfile();
  const helperPath = path.join(
    resourcesPath,
    "helpers",
    profile.brand.computerUse.bundleName,
  );
  signComputerUseHelper(helperPath, options);

  await afterPack.writePackagedRuntimeIntegrity(
    {
      electronPlatformName: "darwin",
      appOutDir: path.dirname(appPath),
      packager: {
        appInfo: { productFilename: path.basename(appPath, ".app") },
      },
    },
    target,
  );

  const ignore = canonicalExactIgnore(executablePaths, options.ignore);
  const { sign } = await import("@electron/osx-sign");
  return sign({
    ...options,
    ignore,
  });
}

module.exports = electronSign;
module.exports.default = electronSign;
module.exports.canonicalExactIgnore = canonicalExactIgnore;
module.exports.resolvePackagedTarget = resolvePackagedTarget;
