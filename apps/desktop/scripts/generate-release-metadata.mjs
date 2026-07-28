import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import { downloadArtifact } from "@electron/get";
import { isRestrictedRepositoryPath } from "../../../scripts/check-source-closure.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const desktopRoot = resolve(scriptDirectory, "..");
const repoRoot = resolve(desktopRoot, "../..");
const releaseInputsRoot = resolve(desktopRoot, ".generated", "release-inputs");
const policyPath = resolve(desktopRoot, "release-component-policy.json");
const distributionPath = resolve(repoRoot, "opencode-distribution.json");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SPDX_ID_PATTERN = /^[A-Za-z0-9.-]+$/;
const RELEASE_METADATA_DIRECTORY = "release-metadata";
const RELEASE_MANIFEST_FILE = "release-manifest.json";
const FORBIDDEN_ELECTRON_DOWNLOAD_ENV = Object.freeze([
  "ELECTRON_MIRROR",
  "ELECTRON_CUSTOM_DIR",
  "ELECTRON_CUSTOM_FILENAME",
  "NPM_CONFIG_ELECTRON_MIRROR",
  "npm_config_electron_mirror",
]);
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i;
const NOTICE_FILE_PATTERN = /^notice(?:[._-].*)?$/i;
const pnpmPackageRootCache = new Map();
let pnpmStoreEntries = null;

const MIT_TEMPLATE = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArg(name) {
  const args = process.argv.slice(2);
  const direct = args.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function sha256FileSync(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function posixRelative(root, filePath) {
  return relative(root, filePath).split(sep).join("/");
}

function stableTimestamp() {
  const sourceDateEpoch = Number.parseInt(
    process.env.SOURCE_DATE_EPOCH ?? "",
    10,
  );
  const seconds = Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch >= 0
    ? sourceDateEpoch
    : Number.parseInt(
      execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
      10,
    );
  return new Date(seconds * 1000).toISOString();
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function isWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertRegularFile(filePath, label) {
  const stats = lstatSync(filePath);
  invariant(stats.isFile(), `${label} must be a regular file`);
  invariant(!stats.isSymbolicLink(), `${label} cannot be a symbolic link`);
}

export function inventoryTree(root, current = root) {
  const output = [];
  for (const entry of readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = join(current, entry.name);
    const rel = posixRelative(root, filePath);
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(filePath);
      const resolvedTarget = realpathSync(filePath);
      invariant(
        isWithin(resolvedTarget, root),
        `Packaged resource symlink escapes its root: ${rel}`,
      );
      output.push({ path: rel, type: "symlink", target });
    } else if (stats.isDirectory()) {
      output.push(...inventoryTree(root, filePath));
    } else if (stats.isFile()) {
      output.push({
        path: rel,
        type: "file",
        size: stats.size,
        mode: stats.mode & 0o777,
        sha256: sha256FileSync(filePath),
      });
    } else {
      throw new Error(`Unsupported packaged resource type: ${rel}`);
    }
  }
  return output;
}

function packageRootForFile(filePath) {
  let current = existsSync(filePath) && statSync(filePath).isDirectory()
    ? filePath
    : dirname(filePath);
  while (isWithin(current, repoRoot)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath) && lstatSync(manifestPath).isFile()) {
      return current;
    }
    if (current === repoRoot) break;
    current = dirname(current);
  }
  return null;
}

function inputPathsFromManifest(filePath) {
  const value = readJson(filePath);
  if (Array.isArray(value.modules)) return value.modules;
  if (value.inputs && typeof value.inputs === "object") {
    return Object.keys(value.inputs);
  }
  throw new Error(`Unknown release input manifest shape: ${filePath}`);
}

function manifestBase(fileName) {
  if (fileName === "renderer-modules.json") return repoRoot;
  if (fileName.startsWith("server-")) return resolve(repoRoot, "apps/server");
  if (fileName.startsWith("orchestrator-")) {
    return resolve(repoRoot, "apps/orchestrator");
  }
  throw new Error(`Unreviewed release input manifest: ${fileName}`);
}

function collectBundledPackageRoots() {
  invariant(
    existsSync(releaseInputsRoot),
    `Missing release inputs directory: ${releaseInputsRoot}`,
  );
  const manifests = readdirSync(releaseInputsRoot)
    .filter((name) => name.endsWith(".json") && name !== "evidence-inventory.json")
    .sort();
  invariant(
    manifests.includes("renderer-modules.json"),
    "Renderer release input manifest is missing",
  );
  invariant(
    manifests.includes("server-plugins.metafile.json"),
    "Server plugin release input manifest is missing",
  );
  invariant(
    manifests.some((name) => name.startsWith("orchestrator-")),
    "Orchestrator release input manifest is missing",
  );

  const packageRoots = new Map();
  for (const manifestName of manifests) {
    if (manifestName.startsWith("opencode")) continue;
    const manifestPath = join(releaseInputsRoot, manifestName);
    const base = manifestBase(manifestName);
    for (const input of inputPathsFromManifest(manifestPath)) {
      if (typeof input !== "string" || input.startsWith("\0")) continue;
      const withoutQuery = input.split("?")[0];
      const filePath = isAbsolute(withoutQuery)
        ? withoutQuery
        : resolve(base, withoutQuery);
      if (!existsSync(filePath) || !isWithin(realpathSync(filePath), repoRoot)) {
        continue;
      }
      const packageRoot = packageRootForFile(filePath);
      if (!packageRoot) continue;
      const manifest = readJson(join(packageRoot, "package.json"));
      if (
        typeof manifest.name !== "string"
        || typeof manifest.version !== "string"
      ) {
        continue;
      }
      const key = `${manifest.name}@${manifest.version}`;
      const existing = packageRoots.get(key) ?? {
        name: manifest.name,
        version: manifest.version,
        roots: new Set(),
        scopes: new Set(),
      };
      existing.roots.add(packageRoot);
      existing.scopes.add(
        manifestName === "renderer-modules.json"
          ? "renderer"
          : manifestName.startsWith("server-")
            ? "server-plugin"
            : "orchestrator",
      );
      packageRoots.set(key, existing);
    }
  }
  return packageRoots;
}

function asarPackages(asarPath) {
  assertRegularFile(asarPath, "Packaged ASAR");
  const packages = [];
  for (const entry of listPackage(asarPath)
    .filter((name) => name.endsWith("/package.json"))
    .sort()) {
    let manifest;
    try {
      manifest = JSON.parse(
        extractFile(asarPath, entry.replace(/^\/+/, "")).toString("utf8"),
      );
    } catch (error) {
      throw new Error(
        `Invalid package manifest in ASAR ${entry}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      typeof manifest.name === "string"
      && typeof manifest.version === "string"
    ) {
      packages.push({
        name: manifest.name,
        version: manifest.version,
        declaredLicense: manifest.license ?? null,
        asarPath: entry,
      });
    }
  }
  return packages;
}

function locatePnpmStorePackageRoot(name, version) {
  const key = `${name}@${version}`;
  if (pnpmPackageRootCache.has(key)) {
    return pnpmPackageRootCache.get(key);
  }

  const storeRoot = resolve(repoRoot, "node_modules/.pnpm");
  if (!existsSync(storeRoot)) {
    pnpmPackageRootCache.set(key, null);
    return null;
  }
  pnpmStoreEntries ??= readdirSync(storeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const entry of pnpmStoreEntries) {
    const candidate = join(storeRoot, entry, "node_modules", ...name.split("/"));
    const manifestPath = join(candidate, "package.json");
    if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) continue;
    const resolvedCandidate = realpathSync(candidate);
    invariant(
      isWithin(resolvedCandidate, repoRoot),
      `pnpm package root escapes the repository: ${name}@${version}`,
    );
    const manifest = readJson(manifestPath);
    if (manifest.name === name && manifest.version === version) {
      pnpmPackageRootCache.set(key, resolvedCandidate);
      return resolvedCandidate;
    }
  }

  pnpmPackageRootCache.set(key, null);
  return null;
}

function locatePackageRoot(name, version, asarPath, knownRoots) {
  const existing = knownRoots.get(`${name}@${version}`);
  if (existing) {
    for (const root of existing.roots) {
      if (existsSync(join(root, "package.json"))) return root;
    }
  }
  const candidates = [
    resolve(desktopRoot, "node_modules", name),
    resolve(repoRoot, "node_modules", name),
    resolve(repoRoot, "apps/app/node_modules", name),
    resolve(repoRoot, "apps/server/node_modules", name),
    resolve(repoRoot, "apps/orchestrator/node_modules", name),
  ];
  for (const candidate of candidates) {
    const manifestPath = join(candidate, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (manifest.name === name && manifest.version === version) return candidate;
  }
  const pnpmPackageRoot = locatePnpmStorePackageRoot(name, version);
  if (pnpmPackageRoot) return pnpmPackageRoot;
  throw new Error(
    `Cannot locate source package ${name}@${version} shipped at ${asarPath}`,
  );
}

function internalPackage(name, policy) {
  return policy.internalPackagePrefixes.some((prefix) => name.startsWith(prefix));
}

export function selectPackageLicense(name, declared, policy) {
  if (internalPackage(name, policy)) return "NOASSERTION";
  const normalized = typeof declared === "string" ? declared.trim() : "";
  const selection = policy.licenseSelections[name];
  if (selection) {
    invariant(
      selection.declared === normalized,
      `${name} license declaration changed from the reviewed value`,
    );
    invariant(
      policy.allowedLicenses.includes(selection.selected),
      `${name} selected license is not allowed`,
    );
    return selection.selected;
  }
  invariant(normalized, `${name} has no declared license`);
  invariant(
    policy.allowedLicenses.includes(normalized),
    `${name} has an unreviewed license: ${normalized}`,
  );
  return normalized;
}

function packageLicenseFiles(packageRoot) {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile()
        && (LICENSE_FILE_PATTERN.test(entry.name)
          || NOTICE_FILE_PATTERN.test(entry.name)),
    )
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(join(packageRoot, entry.name), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function reviewedFallbackText(component, policy, referenceTexts) {
  const fallback = policy.licenseFallbacks[component.name];
  invariant(
    fallback && fallback.selected === component.license,
    `${component.name}@${component.version} is missing reviewed license text`,
  );
  if (fallback.source === "opencode") {
    return readFileSync(
      resolve(desktopRoot, "resources/licenses/OPENCODE-LICENSE.txt"),
      "utf8",
    );
  }
  if (fallback.source === "mit-template") {
    invariant(
      typeof fallback.copyright === "string" && fallback.copyright.trim(),
      `${component.name} MIT fallback requires reviewed copyright`,
    );
    return `${fallback.copyright.trim()}\n\n${MIT_TEMPLATE}`;
  }
  if (fallback.source === "same-license-component") {
    const reference = referenceTexts.get(component.license);
    invariant(
      typeof reference === "string" && reference.trim(),
      `${component.name} has no same-license reference text`,
    );
    return reference;
  }
  throw new Error(`Unknown license fallback for ${component.name}`);
}

function collectPackageComponents(asarPath, policy) {
  const roots = collectBundledPackageRoots();
  for (const entry of asarPackages(asarPath)) {
    const key = `${entry.name}@${entry.version}`;
    const existing = roots.get(key) ?? {
      name: entry.name,
      version: entry.version,
      roots: new Set(),
      scopes: new Set(),
    };
    existing.scopes.add("asar");
    if (!internalPackage(entry.name, policy)) {
      existing.roots.add(
        locatePackageRoot(
          entry.name,
          entry.version,
          entry.asarPath,
          roots,
        ),
      );
    }
    existing.declaredLicense ??= entry.declaredLicense;
    roots.set(key, existing);
  }

  const components = [];
  for (const entry of [...roots.values()]
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    if (internalPackage(entry.name, policy)) continue;
    const packageRoot = [...entry.roots][0];
    invariant(packageRoot, `Missing source package root for ${entry.name}`);
    const manifest = readJson(join(packageRoot, "package.json"));
    const license = selectPackageLicense(
      entry.name,
      entry.declaredLicense ?? manifest.license,
      policy,
    );
    components.push({
      type: "library",
      name: entry.name,
      version: entry.version,
      license,
      declaredLicense: entry.declaredLicense ?? manifest.license,
      scopes: [...entry.scopes].sort(),
      sourcePackagePath: posixRelative(repoRoot, packageRoot),
      licenseFiles: packageLicenseFiles(packageRoot),
      homepage:
        typeof manifest.homepage === "string" ? manifest.homepage : null,
    });
  }

  const referenceTexts = new Map();
  for (const component of components) {
    const licenseFile = component.licenseFiles.find((file) =>
      LICENSE_FILE_PATTERN.test(file.name));
    if (licenseFile && !referenceTexts.has(component.license)) {
      referenceTexts.set(component.license, licenseFile.text);
    }
  }
  for (const component of components) {
    if (
      !component.licenseFiles.some((file) =>
        LICENSE_FILE_PATTERN.test(file.name))
    ) {
      component.licenseFiles.unshift({
        name: "LICENSE.generated-from-reviewed-policy",
        text: reviewedFallbackText(component, policy, referenceTexts),
      });
    }
  }
  return components;
}

function copyVerifiedOpenCodeEvidence(target, outputDirectory) {
  const sourceDirectory = resolve(releaseInputsRoot, "opencode", target);
  invariant(
    existsSync(sourceDirectory),
    `Missing verified OpenCode evidence for ${target}`,
  );
  const inventory = readJson(
    join(sourceDirectory, "evidence-inventory.json"),
    "OpenCode evidence inventory",
  );
  invariant(
    inventory.target === target,
    "OpenCode evidence target does not match the packaged target",
  );
  invariant(
    inventory.excludedArchive
      && SHA256_PATTERN.test(inventory.excludedArchive.sha256),
    "OpenCode excluded archive hash is invalid",
  );
  const actualNames = readdirSync(sourceDirectory).sort();
  const expectedNames = [
    ...Object.keys(inventory.files),
    "evidence-inventory.json",
  ].sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    "OpenCode evidence directory has an unexpected file closure",
  );
  invariant(
    !actualNames.includes(inventory.excludedArchive.file),
    "OpenCode source archive must not be duplicated in the desktop artifact",
  );
  for (const [fileName, expectedHash] of Object.entries(inventory.files)) {
    invariant(
      SHA256_PATTERN.test(expectedHash)
        && sha256FileSync(join(sourceDirectory, fileName)) === expectedHash,
      `OpenCode evidence hash mismatch: ${fileName}`,
    );
  }
  cpSync(sourceDirectory, outputDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return inventory;
}

async function extractElectronLicenses(policy, outputDirectory) {
  for (const name of FORBIDDEN_ELECTRON_DOWNLOAD_ENV) {
    invariant(
      !process.env[name]?.trim(),
      `${name} is forbidden for release metadata generation`,
    );
  }
  const version = policy.electronRuntime.electron;
  const archivePath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: "darwin",
    arch: "arm64",
  });
  const licenseFiles = [
    ["LICENSE", "ELECTRON-LICENSE.txt"],
    ["LICENSES.chromium.html", "LICENSES.chromium.html"],
  ];
  const hashes = {};
  for (const [archiveName, outputName] of licenseFiles) {
    const content = execFileSync("unzip", ["-p", archivePath, archiveName], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    invariant(content.length > 0, `Electron archive is missing ${archiveName}`);
    const outputPath = join(outputDirectory, outputName);
    writeFileSync(outputPath, content);
    hashes[outputName] = sha256FileSync(outputPath);
  }
  return {
    archiveSha256: sha256FileSync(archivePath),
    files: hashes,
    source: policy.electronRuntime.source,
  };
}

function staticComponents({
  appVersion,
  distribution,
  target,
  policy,
  resourcesPath,
}) {
  const opencodeAsset = distribution.targetAssets?.[target];
  invariant(opencodeAsset, `OpenCode distribution does not define ${target}`);
  const ripgrepDistribution = distribution.toolchain?.ripgrep;
  const ripgrepAsset = ripgrepDistribution?.targetAssets?.[target];
  invariant(ripgrepAsset, `ripgrep distribution does not define ${target}`);
  const packagedOpenCodePath = resolve(
    resourcesPath,
    "sidecars",
    `opencode-${target}`,
  );
  const packagedRipgrepPath = resolve(
    resourcesPath,
    "toolchain",
    target,
    target.endsWith("windows-msvc") ? "rg.exe" : "rg",
  );
  assertRegularFile(packagedOpenCodePath, "Packaged OpenCode binary");
  assertRegularFile(packagedRipgrepPath, "Packaged ripgrep binary");
  const helperPath = resolve(
    resourcesPath,
    "helpers",
    "AgencyAI Computer Use.app",
  );
  const helperExists = existsSync(helperPath);
  return [
    {
      type: "application",
      name: "AgencyAI Desktop",
      version: appVersion,
      license: "MIT",
      scopes: ["application"],
    },
    {
      type: "framework",
      name: "Electron",
      version: policy.electronRuntime.electron,
      license: policy.reviewedComponentLicenses.electron,
      scopes: ["runtime"],
    },
    {
      type: "framework",
      name: "Chromium",
      version: policy.electronRuntime.chromium,
      license: policy.reviewedComponentLicenses.chromium,
      scopes: ["runtime"],
    },
    {
      type: "application",
      name: "OpenCode",
      version: distribution.binaryVersion,
      license: policy.reviewedComponentLicenses.opencode,
      scopes: ["sidecar"],
      hashes: [{
        alg: "SHA-256",
        content: sha256FileSync(packagedOpenCodePath),
      }],
      source: distribution.sourceRepository,
    },
    {
      type: "data",
      name: "Models.dev catalog",
      version: distribution.upstreamTag,
      license: policy.reviewedComponentLicenses["models.dev"],
      scopes: ["embedded-in-opencode"],
    },
    {
      type: "application",
      name: "ripgrep",
      version: ripgrepDistribution.version,
      license: policy.reviewedComponentLicenses.ripgrep,
      scopes: ["toolchain"],
      hashes: [{
        alg: "SHA-256",
        content: sha256FileSync(packagedRipgrepPath),
      }],
      source: ripgrepDistribution.sourceRepository,
    },
    {
      type: "library",
      name: "SQLite",
      version: "bundled-by-better-sqlite3",
      license: policy.reviewedComponentLicenses.sqlite,
      scopes: ["native-module"],
    },
    ...(helperExists
      ? [{
          type: "application",
          name: "AgencyAI Computer Use helper",
          version: appVersion,
          license: policy.reviewedComponentLicenses["computer-use-helper"],
          scopes: ["helper"],
        }]
      : []),
  ];
}

function noticeGroups(packageComponents) {
  const groups = new Map();
  for (const component of packageComponents) {
    for (const file of component.licenseFiles) {
      const normalized = file.text.trimEnd();
      const hash = sha256Text(normalized);
      const existing = groups.get(hash) ?? {
        hash,
        text: normalized,
        components: [],
      };
      existing.components.push(
        `${component.name}@${component.version} (${component.license}; ${file.name})`,
      );
      groups.set(hash, existing);
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.components[0].localeCompare(b.components[0]));
}

function thirdPartyNotices({
  appVersion,
  packageComponents,
  openworkLicense,
  opencodeLicense,
}) {
  const sections = [
    `AgencyAI Desktop ${appVersion} third-party notices`,
    "",
    "Includes software derived from the OpenWork project under the MIT License.",
    "Includes OpenCode under the MIT License.",
    "",
    "OpenWork attribution and license",
    "================================",
    openworkLicense.trimEnd(),
    "",
    "OpenCode attribution and license",
    "================================",
    opencodeLicense.trimEnd(),
  ];
  for (const group of noticeGroups(packageComponents)) {
    sections.push(
      "",
      group.components.join("\n"),
      "-".repeat(Math.min(78, Math.max(3, group.components[0].length))),
      group.text,
    );
  }
  sections.push(
    "",
    "SQLite",
    "------",
    "SQLite is in the public domain. See https://www.sqlite.org/copyright.html.",
    "",
    "Electron and Chromium",
    "---------------------",
    "The complete Electron license and Chromium third-party license bundle are shipped beside this file.",
    "",
  );
  return sections.join("\n");
}

function spdxId(name, version) {
  return `SPDXRef-${`${name}-${version}`
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

function packagePurl(component) {
  if (
    component.type !== "library"
    || component.name === "SQLite"
    || component.name.startsWith("AgencyAI")
  ) {
    return null;
  }
  const encodedName = component.name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(component.version)}`;
}

function createSpdx({ appVersion, timestamp, components, documentSeed }) {
  const packages = components.map((component) => {
    const externalRefs = [];
    const purl = packagePurl(component);
    if (purl) {
      externalRefs.push({
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purl,
      });
    }
    return {
      name: component.name,
      SPDXID: spdxId(component.name, component.version),
      versionInfo: component.version,
      downloadLocation: component.source ?? "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: component.license,
      licenseDeclared: component.license,
      copyrightText: "NOASSERTION",
      ...(component.hashes
        ? {
            checksums: component.hashes.map((hash) => ({
              algorithm: hash.alg.replace("-", ""),
              checksumValue: hash.content,
            })),
          }
        : {}),
      ...(externalRefs.length ? { externalRefs } : {}),
      comment: `Shipped scopes: ${component.scopes.join(", ")}`,
    };
  });
  const ids = new Set();
  for (const entry of packages) {
    invariant(!ids.has(entry.SPDXID), `Duplicate SPDX ID ${entry.SPDXID}`);
    ids.add(entry.SPDXID);
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `AgencyAI Desktop ${appVersion}`,
    documentNamespace:
      `https://agencyai.local/spdx/${appVersion}/${documentSeed}`,
    creationInfo: {
      created: timestamp,
      creators: ["Organization: AgencyAI"],
      licenseListVersion: "3.27.0",
    },
    packages,
    relationships: packages.map((entry) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: entry.SPDXID,
    })),
  };
}

function deterministicUuid(seed) {
  const hex = sha256Text(seed).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function cycloneDxLicense(license) {
  return SPDX_ID_PATTERN.test(license) && license !== "NOASSERTION"
    ? { id: license }
    : { name: license };
}

function createCycloneDx({
  appVersion,
  timestamp,
  components,
  documentSeed,
}) {
  const rootBomRef = `pkg:generic/agencyai-desktop@${appVersion}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    serialNumber: `urn:uuid:${deterministicUuid(documentSeed)}`,
    version: 1,
    metadata: {
      timestamp,
      component: {
        type: "application",
        "bom-ref": rootBomRef,
        name: "AgencyAI Desktop",
        version: appVersion,
      },
      tools: {
        components: [{
          type: "application",
          name: "AgencyAI release metadata generator",
          version: "1",
        }],
      },
    },
    components: components.map((component) => {
      const purl = packagePurl(component);
      return {
        type: component.type,
        "bom-ref": purl ?? `${component.type}:${component.name}@${component.version}`,
        name: component.name,
        version: component.version,
        licenses: [{ license: cycloneDxLicense(component.license) }],
        properties: [{
          name: "agencyai:shipped-scopes",
          value: component.scopes.join(","),
        }],
        ...(purl ? { purl } : {}),
        ...(component.hashes
          ? { hashes: component.hashes }
          : {}),
      };
    }),
  };
}

export async function generateReleaseMetadata({
  appPath,
  target,
} = {}) {
  invariant(appPath, "--app is required");
  invariant(target, "--target is required");
  const resolvedAppPath = resolve(appPath);
  invariant(
    resolvedAppPath.endsWith(".app")
      && existsSync(resolve(resolvedAppPath, "Contents/Resources")),
    `Not a packaged macOS application: ${resolvedAppPath}`,
  );
  const resourcesPath = resolve(resolvedAppPath, "Contents/Resources");
  const asarPath = resolve(resourcesPath, "app.asar");
  const outputDirectory = resolve(
    resourcesPath,
    RELEASE_METADATA_DIRECTORY,
  );
  const policy = readJson(policyPath, "release component policy");
  invariant(policy.schemaVersion === 1, "Unsupported release component policy");
  const desktopPackage = readJson(
    resolve(desktopRoot, "package.json"),
    "desktop package",
  );
  const distribution = readJson(
    distributionPath,
    "OpenCode distribution manifest",
  );
  const sourceCommit = gitHead();
  const timestamp = stableTimestamp();
  const appVersion = desktopPackage.version;
  const packageComponents = collectPackageComponents(asarPath, policy);
  const staticInventory = staticComponents({
    appVersion,
    distribution,
    target,
    policy,
    resourcesPath,
  });
  const components = [...staticInventory, ...packageComponents];
  const componentKeys = new Set();
  for (const component of components) {
    const key = `${component.name}@${component.version}`;
    invariant(!componentKeys.has(key), `Duplicate component record: ${key}`);
    componentKeys.add(key);
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const electron = await extractElectronLicenses(policy, outputDirectory);
  const openCodeEvidence = copyVerifiedOpenCodeEvidence(
    target,
    join(outputDirectory, "opencode"),
  );
  const openworkLicense = readFileSync(
    resolve(desktopRoot, "resources/licenses/OPENWORK-LICENSE.txt"),
    "utf8",
  );
  const opencodeLicense = readFileSync(
    resolve(desktopRoot, "resources/licenses/OPENCODE-LICENSE.txt"),
    "utf8",
  );
  writeFileSync(
    join(outputDirectory, "THIRD_PARTY_NOTICES.txt"),
    thirdPartyNotices({
      appVersion,
      packageComponents,
      openworkLicense,
      opencodeLicense,
    }),
    "utf8",
  );
  writeFileSync(
    join(outputDirectory, "OPENWORK-LICENSE.txt"),
    openworkLicense,
    "utf8",
  );
  writeFileSync(
    join(outputDirectory, "OPENCODE-LICENSE.txt"),
    opencodeLicense,
    "utf8",
  );

  const documentSeed = sha256Text(
    `${sourceCommit}:${appVersion}:${target}:${sha256FileSync(asarPath)}`,
  );
  const spdx = createSpdx({
    appVersion,
    timestamp,
    components,
    documentSeed,
  });
  const cycloneDx = createCycloneDx({
    appVersion,
    timestamp,
    components,
    documentSeed,
  });
  writeJson(join(outputDirectory, "agencyai-desktop.spdx.json"), spdx);
  writeJson(join(outputDirectory, "agencyai-desktop.cdx.json"), cycloneDx);

  const resources = inventoryTree(resourcesPath).filter(
    (entry) =>
      entry.path
      !== `${RELEASE_METADATA_DIRECTORY}/${RELEASE_MANIFEST_FILE}`,
  );
  invariant(
    !resources.some((entry) => isRestrictedRepositoryPath(entry.path)),
    "Packaged resources contain a restricted enterprise path",
  );
  const metadataFiles = resources
    .filter((entry) =>
      entry.path.startsWith(`${RELEASE_METADATA_DIRECTORY}/`))
    .map((entry) => ({
      ...entry,
      path: entry.path.slice(RELEASE_METADATA_DIRECTORY.length + 1),
    }));
  const manifest = {
    schemaVersion: 1,
    product: "AgencyAI Desktop",
    productVersion: appVersion,
    profile: "local-mvp",
    target,
    generatedAt: timestamp,
    source: {
      repository: "https://github.com/artreimus/AgencyAI",
      commit: sourceCommit,
      lockfileSha256: sha256FileSync(resolve(repoRoot, "pnpm-lock.yaml")),
      plan: "PLAN_AGENCYAI_DESKTOP_MVP.md",
    },
    electron: {
      ...policy.electronRuntime,
      ...electron,
    },
    openCode: {
      upstreamTag: distribution.upstreamTag,
      upstreamCommit: distribution.upstreamCommit,
      forkRepository: distribution.sourceRepository,
      forkTag: distribution.forkTag,
      forkCommit: distribution.forkCommit,
      binaryVersion: distribution.binaryVersion,
      evidence: openCodeEvidence,
    },
    application: {
      asarSha256: sha256FileSync(asarPath),
      componentCount: components.length,
      packageComponentCount: packageComponents.length,
    },
    resources: {
      manifestExcludesSelf: true,
      count: resources.length,
      files: resources,
    },
    releaseMetadata: {
      count: metadataFiles.length,
      files: metadataFiles,
    },
  };
  writeJson(join(outputDirectory, RELEASE_MANIFEST_FILE), manifest);
  return {
    outputDirectory,
    manifest,
  };
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const result = await generateReleaseMetadata({
      appPath: parseArg("--app"),
      target: parseArg("--target"),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          outputDirectory: result.outputDirectory,
          resourceCount: result.manifest.resources.count,
          componentCount: result.manifest.application.componentCount,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[release-metadata] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
