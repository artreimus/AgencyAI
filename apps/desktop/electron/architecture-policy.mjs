function architectureLabel(arch) {
  if (arch === "arm64") return "ARM";
  if (arch === "x64") return "Intel";
  return arch;
}

function platformLabel(platform) {
  return platform === "win32" ? "windows" : platform;
}

/**
 * Resolve architecture mismatch state without granting disabled builds a
 * release-network side effect. Download resolvers are never evaluated unless
 * both updater and remote-asset capabilities are compiled in.
 */
export async function resolveProductArchitectureInfo({
  appArch,
  systemArch,
  platform,
  version,
  automaticUpdates,
  remoteAssetFetches,
  resolveDownloadUrl,
  fallbackDownloadUrl,
  releaseUrl,
}) {
  const downloadsEnabled =
    automaticUpdates === true && remoteAssetFetches === true;
  const targetArch =
    systemArch === "arm64" || systemArch === "x64" ? systemArch : appArch;
  const latestDownloadUrl = downloadsEnabled
    ? await resolveDownloadUrl(targetArch)
    : null;
  const downloadUrl = downloadsEnabled
    ? latestDownloadUrl || fallbackDownloadUrl(targetArch)
    : null;

  return Object.freeze({
    appArch,
    appArchLabel: architectureLabel(appArch),
    systemArch,
    systemArchLabel: architectureLabel(systemArch),
    mismatch:
      appArch !== systemArch &&
      (downloadsEnabled ? Boolean(downloadUrl) : true),
    platform: platformLabel(platform),
    version,
    downloadUrl,
    releaseUrl: downloadsEnabled ? releaseUrl : null,
  });
}
