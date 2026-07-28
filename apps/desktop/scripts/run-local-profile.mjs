import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const defaultRepoRoot = resolve(scriptDir, "../../..");
const profileSelectors = new Set([
  "OPENWORK_PRODUCT_PROFILE",
  "VITE_OPENWORK_PRODUCT_PROFILE",
]);

const actionCommands = Object.freeze({
  dev: [["--filter", "@openwork/desktop", "dev"]],
  build: [["--filter", "@openwork/desktop", "build"]],
  "package-dir": [["--filter", "@openwork/desktop", "package:electron:dir"]],
  "package-installer": [["--filter", "@openwork/desktop", "package:electron"]],
  test: [
    ["--filter", "@openwork/product-config", "typecheck"],
    ["--filter", "@openwork/product-config", "test"],
    ["--filter", "@openwork/app", "typecheck"],
    ["--filter", "@openwork/app", "test"],
    ["--filter", "openwork-server", "typecheck"],
    ["--filter", "openwork-server", "test"],
    ["--filter", "@openwork/desktop", "typecheck:electron"],
    ["--filter", "@openwork/desktop", "test"],
    ["--filter", "openwork-server", "build"],
    ["--filter", "@openwork/app", "build"],
    ["--filter", "@openwork/desktop", "check:electron"],
    ["run", "check:outbound-access"],
  ],
});

function needsShell(command, platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export function createLocalProfileEnvironment(input = process.env) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toUpperCase();
    if (profileSelectors.has(normalized) || normalized.includes("POSTHOG")) {
      continue;
    }
    if (typeof value === "string") {
      output[key] = value;
    }
  }

  output.OPENWORK_PRODUCT_PROFILE = "local-mvp";
  output.VITE_OPENWORK_PRODUCT_PROFILE = "local-mvp";
  return Object.freeze(output);
}

export function resolveLocalProfileAction(
  action,
  {
    platform = process.platform,
    execPath = process.execPath,
    repoRoot = defaultRepoRoot,
  } = {},
) {
  const selected = actionCommands[action];
  if (!selected) {
    throw new Error(
      `Unknown local profile action "${action ?? ""}". Expected one of: ${Object.keys(actionCommands).join(", ")}.`,
    );
  }

  const pnpmCommand = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const commands = [
    {
      command: execPath,
      args: [resolve(repoRoot, "scripts/check-source-closure.mjs")],
    },
    {
      command: pnpmCommand,
      args: ["--filter", "@openwork/product-config", "build"],
    },
    ...(action === "test"
      ? [{
          command: execPath,
          args: [
            "--test",
            resolve(repoRoot, "scripts/check-source-closure.test.mjs"),
          ],
        }]
      : []),
    ...selected.map((args) => ({
      command: pnpmCommand,
      args: [...args],
    })),
  ];

  return Object.freeze({
    action,
    repoRoot,
    commands: Object.freeze(
      commands.map((command) =>
        Object.freeze({
          ...command,
          args: Object.freeze(command.args),
        })),
    ),
  });
}

export function runLocalProfile(
  action,
  {
    inputEnv = process.env,
    platform = process.platform,
    execPath = process.execPath,
    repoRoot = defaultRepoRoot,
    spawnSyncImpl = spawnSync,
  } = {},
) {
  const environment = createLocalProfileEnvironment(inputEnv);
  const resolved = resolveLocalProfileAction(action, {
    platform,
    execPath,
    repoRoot,
  });

  for (const command of resolved.commands) {
    const result = spawnSyncImpl(command.command, command.args, {
      cwd: repoRoot,
      env: environment,
      shell: needsShell(command.command, platform),
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  return 0;
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    process.exitCode = runLocalProfile(process.argv[2]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[local-profile] ${message}\n`);
    process.exitCode = 1;
  }
}
