import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLocalProfileEnvironment,
  resolveLocalProfileAction,
  runLocalProfile,
} from "./run-local-profile.mjs";

test("constructs a local-only environment without mutating the parent", () => {
  const parent = {
    PATH: "/bin",
    openwork_product_profile: "upstream",
    VITE_OPENWORK_PRODUCT_PROFILE: "upstream",
    VITE_OPENWORK_POSTHOG_KEY: "renderer-secret",
    NEXT_PUBLIC_POSTHOG_KEY: "web-secret",
    POSTHOG_HOST: "https://telemetry.example",
  };
  const before = structuredClone(parent);

  const environment = createLocalProfileEnvironment(parent);

  assert.deepEqual(parent, before);
  assert.deepEqual(environment, {
    PATH: "/bin",
    OPENWORK_PRODUCT_PROFILE: "local-mvp",
    VITE_OPENWORK_PRODUCT_PROFILE: "local-mvp",
  });
  assert.equal(Object.isFrozen(environment), true);
});

test("resolves cross-platform commands and always prefixes closure and profile builds", () => {
  const unix = resolveLocalProfileAction("build", {
    platform: "darwin",
    execPath: "/node",
    repoRoot: "/repo",
  });
  const windows = resolveLocalProfileAction("package-dir", {
    platform: "win32",
    execPath: "C:\\node.exe",
    repoRoot: "C:\\repo",
  });

  assert.deepEqual(unix.commands, [
    {
      command: "/node",
      args: ["/repo/scripts/check-source-closure.mjs"],
    },
    {
      command: "pnpm",
      args: ["--filter", "@openwork/product-config", "build"],
    },
    {
      command: "pnpm",
      args: ["--filter", "@openwork/desktop", "build"],
    },
  ]);
  assert.equal(windows.commands[1]?.command, "pnpm.cmd");
  assert.deepEqual(windows.commands.at(-1)?.args, [
    "--filter",
    "@openwork/desktop",
    "package:electron:dir",
  ]);
  assert.throws(() => resolveLocalProfileAction("release"), /Unknown local profile action/);
});

test("runs commands sequentially with inherited stdio and propagates failure", () => {
  const calls = [];
  const statuses = [0, 0, 23];
  const status = runLocalProfile("dev", {
    inputEnv: {
      PATH: "/bin",
      VITE_OPENWORK_POSTHOG_KEY: "must-disappear",
    },
    platform: "linux",
    execPath: "/node",
    repoRoot: "/repo",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: statuses.shift() };
    },
  });

  assert.equal(status, 23);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.options.cwd, "/repo");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.stdio, "inherit");
    assert.equal(call.options.env.OPENWORK_PRODUCT_PROFILE, "local-mvp");
    assert.equal(call.options.env.VITE_OPENWORK_PRODUCT_PROFILE, "local-mvp");
    assert.equal("VITE_OPENWORK_POSTHOG_KEY" in call.options.env, false);
  }
});

test("uses the Windows command shell only for pnpm.cmd", () => {
  const calls = [];
  const status = runLocalProfile("build", {
    inputEnv: { PATH: "C:\\Windows\\System32" },
    platform: "win32",
    execPath: "C:\\Node\\node.exe",
    repoRoot: "C:\\repo",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0]?.command, "C:\\Node\\node.exe");
  assert.equal(calls[0]?.options.shell, false);
  assert.equal(calls[1]?.command, "pnpm.cmd");
  assert.equal(calls[1]?.options.shell, true);
  assert.equal(calls[2]?.command, "pnpm.cmd");
  assert.equal(calls[2]?.options.shell, true);
});

test("the test action contains the complete fast verification matrix", () => {
  const resolved = resolveLocalProfileAction("test", {
    platform: "linux",
    execPath: "/node",
    repoRoot: "/repo",
  });

  assert.deepEqual(
    resolved.commands.slice(2).map(({ command, args }) => [command, ...args].join(" ")),
    [
      "/node --test /repo/scripts/check-source-closure.test.mjs /repo/scripts/check-local-profile.test.mjs /repo/scripts/release/local-release-policy.test.mjs /repo/scripts/release/stage-macos-release-assets.test.mjs",
      "pnpm --filter @openwork/product-config typecheck",
      "pnpm --filter @openwork/product-config test",
      "pnpm --filter @openwork/app typecheck",
      "pnpm --filter @openwork/app test",
      "pnpm --filter openwork-server typecheck",
      "pnpm --filter openwork-server test",
      "pnpm --filter @openwork/desktop typecheck:electron",
      "pnpm --filter @openwork/desktop test",
      "pnpm run evals:typecheck",
      "pnpm run test:eval-runner",
      "pnpm --filter openwork-server build",
      "pnpm --filter @openwork/app build",
      "pnpm --filter @openwork/desktop exec node ./scripts/stage-agencyai-docs.mjs",
      "pnpm --filter @openwork/desktop check:electron",
      "pnpm run check:outbound-access",
      "pnpm run check:local-profile",
    ],
  );
});
