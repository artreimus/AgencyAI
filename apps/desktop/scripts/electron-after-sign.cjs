const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

async function runWithRetry(command, args, attempts, baseDelayMs = 30_000) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status === 0) return;
    if (attempt >= attempts) {
      throw new Error(`${command} ${args.join(" ")} failed with status ${result.status} after ${attempts} attempts`);
    }
    const delayMs = baseDelayMs * attempt;
    console.warn(
      `[electron-after-sign] ${command} ${args.join(" ")} failed with status ${result.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to notarize the Electron macOS app`);
  }
  return value;
}

function computerUseHelperPath(appPath, computerUseHelperAppName) {
  return path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
}

function parseSignatureMetadata(
  output,
  label,
  requireDistributionSignature,
) {
  if (requireDistributionSignature && output.includes("Signature=adhoc")) {
    throw new Error(`${label} is ad-hoc signed; notarized builds require a Developer ID signature.`);
  }
  if (
    requireDistributionSignature
    && !/^Authority=Developer ID Application:/m.test(output)
  ) {
    throw new Error(
      `${label} is not signed by a Developer ID Application authority.`,
    );
  }
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  if (requireDistributionSignature && !teamIdentifier) {
    throw new Error(`${label} does not report a signing TeamIdentifier.`);
  }
  return { teamIdentifier };
}

function signatureMetadata(filePath, label, requireDistributionSignature) {
  const result = spawnSync(
    "codesign",
    ["--display", "--verbose=4", filePath],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign --display failed for ${label} with status ${result.status}`);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return parseSignatureMetadata(
    output,
    label,
    requireDistributionSignature,
  );
}

function verifySignedPath(filePath, label, requireDistributionSignature, deep = false) {
  run(
    "codesign",
    ["--verify", ...(deep ? ["--deep"] : []), "--strict", "--verbose=2", filePath],
  );
  return signatureMetadata(filePath, label, requireDistributionSignature);
}

function verifyComputerUseHelper(appPath, computerUseHelperAppName, requireDistributionSignature) {
  const helperPath = computerUseHelperPath(appPath, computerUseHelperAppName);
  if (!existsSync(helperPath)) {
    throw new Error(`Computer Use helper app is missing from packaged app: ${helperPath}`);
  }
  return verifySignedPath(
    helperPath,
    "Computer Use helper app",
    requireDistributionSignature,
    true,
  );
}

function targetTriple(arch) {
  if (arch === 3 || arch === "arm64") return "aarch64-apple-darwin";
  if (arch === 1 || arch === "x64") return "x86_64-apple-darwin";
  throw new Error(`Unsupported macOS packaging architecture: ${String(arch)}`);
}

async function verifyPackagedRuntime(appPath, arch, requireDistributionSignature) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const {
    loadPackagedRuntimeIntegritySync,
  } = await import("../electron/opencode-distribution.mjs");
  const integrity = loadPackagedRuntimeIntegritySync({
    resourcesPath,
    target: targetTriple(arch),
  });
  const teamIdentifiers = [];
  for (const entry of integrity.manifest.files) {
    if (entry.path.endsWith("LICENSE-ripgrep")) continue;
    const filePath = path.resolve(resourcesPath, ...entry.path.split("/"));
    const metadata = verifySignedPath(
      filePath,
      `packaged runtime executable ${entry.path}`,
      requireDistributionSignature,
    );
    if (metadata.teamIdentifier) teamIdentifiers.push(metadata.teamIdentifier);
  }
  if (
    requireDistributionSignature
    && new Set(teamIdentifiers).size !== 1
  ) {
    throw new Error(
      "Packaged runtime executables do not share one signing TeamIdentifier.",
    );
  }
  return {
    integrity,
    teamIdentifier: teamIdentifiers[0] ?? null,
  };
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const { getBuildProductProfile } = await import("@openwork/product-config");
  const productProfile = getBuildProductProfile();
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const requireDistributionSignature = process.env.MACOS_NOTARIZE === "true";
  const expectedTeamIdentifier = requireDistributionSignature
    ? requireEnv("AGENCYAI_EXPECTED_APPLE_TEAM_ID")
    : null;
  if (
    expectedTeamIdentifier
    && !/^[A-Z0-9]{10}$/.test(expectedTeamIdentifier)
  ) {
    throw new Error(
      "AGENCYAI_EXPECTED_APPLE_TEAM_ID must be a 10-character Apple Team ID",
    );
  }
  const appSignature = verifySignedPath(
    appPath,
    "AgencyAI app",
    requireDistributionSignature,
    true,
  );
  const helperSignature = verifyComputerUseHelper(
    appPath,
    productProfile.brand.computerUse.bundleName,
    requireDistributionSignature,
  );
  const runtimeSignature = await verifyPackagedRuntime(
    appPath,
    context.arch,
    requireDistributionSignature,
  );
  if (
    requireDistributionSignature
    && (
      appSignature.teamIdentifier !== helperSignature.teamIdentifier
      || appSignature.teamIdentifier !== runtimeSignature.teamIdentifier
      || appSignature.teamIdentifier !== expectedTeamIdentifier
    )
  ) {
    throw new Error(
      "AgencyAI app, Computer Use helper, and runtime executables must share one signing TeamIdentifier.",
    );
  }

  if (!requireDistributionSignature) {
    console.warn("[electron-after-sign] MACOS_NOTARIZE is not true; skipping notarization.");
    return;
  }

  const notaryTempDir = mkdtempSync(
    path.join(tmpdir(), `${productProfile.brand.artifactPrefix}-electron-notary-`),
  );
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  const keyPath = requireEnv("APPLE_API_KEY_PATH");
  const keyId = requireEnv("APPLE_API_KEY");
  const issuer = requireEnv("APPLE_API_ISSUER");

  try {
    run("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    run("xcrun", [
      "notarytool",
      "submit",
      notaryZipPath,
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
    ]);
    // Notarization tickets can take minutes to propagate to Apple's CDN after acceptance; stapler can transiently fail with status 65 ("CloudKit query failed").
    await runWithRetry("xcrun", ["stapler", "staple", appPath], 5);
    run("xcrun", ["stapler", "validate", appPath]);
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.parseSignatureMetadata = parseSignatureMetadata;
module.exports.runWithRetry = runWithRetry;
module.exports.targetTriple = targetTriple;
module.exports.verifyPackagedRuntime = verifyPackagedRuntime;
