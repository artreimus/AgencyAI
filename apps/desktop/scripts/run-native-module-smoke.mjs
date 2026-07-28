import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const packageMetadata = JSON.parse(
  await readFile(path.join(desktopRoot, "package.json"), "utf8"),
);

async function packageRoot(packageName, resolver = require) {
  let current = path.dirname(resolver.resolve(packageName));
  while (true) {
    const packagePath = path.join(current, "package.json");
    const packageStat = await stat(packagePath).catch(() => null);
    if (packageStat?.isFile()) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    current = parent;
  }
}

async function copyRuntimePackage(
  packageName,
  nodeModulesRoot,
  destinationName = packageName,
  resolver = require,
) {
  const sourceRoot = await packageRoot(packageName, resolver);
  const destinationRoot = path.join(
    nodeModulesRoot,
    ...destinationName.split("/"),
  );
  await mkdir(path.dirname(destinationRoot), { recursive: true });
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    dereference: true,
  });
}

const smokeRoot = await mkdtemp(
  path.join(tmpdir(), "agencyai-native-smoke-"),
);
try {
  const nodeModulesRoot = path.join(smokeRoot, "node_modules");
  await mkdir(nodeModulesRoot, { recursive: true });
  const nodePtyRoot = await packageRoot("node-pty");
  const nodePtyRequire = createRequire(
    path.join(nodePtyRoot, "package.json"),
  );
  await Promise.all([
    copyRuntimePackage(
      "better-sqlite3/package.json",
      nodeModulesRoot,
      "better-sqlite3",
    ),
    copyRuntimePackage("node-pty", nodeModulesRoot, "node-pty"),
    copyRuntimePackage(
      "@lydell/node-pty-darwin-arm64",
      nodeModulesRoot,
      "@lydell/node-pty-darwin-arm64",
      nodePtyRequire,
    ),
  ]);
  await writeFile(
    path.join(smokeRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      dependencies: {
        "better-sqlite3":
          packageMetadata.dependencies["better-sqlite3"],
        "node-pty": packageMetadata.dependencies["node-pty"],
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const { rebuild } = await import("@electron/rebuild");
  await rebuild({
    buildPath: smokeRoot,
    projectRootPath: smokeRoot,
    electronVersion: packageMetadata.devDependencies.electron,
    arch: process.arch,
    platform: process.platform,
    onlyModules: ["better-sqlite3"],
    force: true,
    mode: "sequential",
  });

  const scriptPath = path.join(smokeRoot, "native-module-smoke.cjs");
  await copyFile(
    path.join(scriptDirectory, "native-module-smoke.cjs"),
    scriptPath,
  );
  const result = spawnSync(electronPath, [scriptPath], {
    cwd: smokeRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron native-module smoke exited ${result.status}`);
  }
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
