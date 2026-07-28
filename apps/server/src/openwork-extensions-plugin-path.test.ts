import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agencyAiLocalPluginUrls,
  isAllowedAgencyAiLocalPluginSpec,
  openworkPluginPath,
} from "./openwork-extensions-plugin-path.js";

function withPluginDir(value: string | undefined, fn: () => void) {
  const previous = process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  if (value === undefined) {
    delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  } else {
    process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
    } else {
      process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = previous;
    }
  }
}

function restoreResourcesPath(previous: string | undefined) {
  if (previous === undefined) {
    delete process.resourcesPath;
  } else {
    process.resourcesPath = previous;
  }
}

describe("openworkPluginPath", () => {
  test("prefers OPENWORK_EXTENSIONS_PLUGIN_DIR", () => {
    withPluginDir("/opt/openwork/opencode-plugins", () => {
      const resourcesPath = join("/Applications", "OpenWork.app", "Contents", "Resources");
      const previousResourcesPath = process.resourcesPath;
      process.resourcesPath = resourcesPath;
      try {
        expect(openworkPluginPath("openwork-extensions-preview", join(resourcesPath, "app.asar", "server", "dist")))
          .toBe(join("/opt/openwork/opencode-plugins", "openwork-extensions-preview.js"));
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses external resources plugin path in packaged Electron when env is unset", () => {
    withPluginDir(undefined, () => {
      const previousResourcesPath = process.resourcesPath;
      const resourcesPath = join("/Applications", "OpenWork.app", "Contents", "Resources");
      process.resourcesPath = resourcesPath;
      try {
        const pluginPath = openworkPluginPath(
          "openwork-extensions-preview",
          join(resourcesPath, "app.asar", "server", "dist"),
        );

        expect(pluginPath).toBe(join(resourcesPath, "opencode-plugins", "openwork-extensions-preview.js"));
        expect(pluginPath).not.toContain("app.asar");
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses source plugin path in development when env is unset", () => {
    withPluginDir(undefined, () => {
      const here = join("/repo", "apps", "server", "src");
      expect(openworkPluginPath("openwork-extensions-preview", here))
        .toBe(join(here, "opencode-plugins", "openwork-extensions-preview.ts"));
    });
  });
});

describe("AgencyAI packaged plugin policy", () => {
  test("emits only allowlisted local file URLs", () => {
    withPluginDir("/tmp/untrusted-plugins", () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const root = join(here, "opencode-plugins");
      const specs = agencyAiLocalPluginUrls(here);

      expect(specs).toHaveLength(6);
      expect(specs.every((spec) =>
        isAllowedAgencyAiLocalPluginSpec(spec, root))).toBe(true);
      expect(specs.some((spec) => spec.includes("opencode-chrome-devtools"))).toBe(false);
      expect(specs.some((spec) => spec.includes("/tmp/untrusted-plugins"))).toBe(false);
    });
  });

  test("rejects package, remote, relative, outside, missing, and symlink specs", () => {
    const temp = mkdtempSync(join(tmpdir(), "agencyai-plugin-policy-"));
    const root = join(temp, "opencode-plugins");
    const outsidePath = join(temp, "agencyai-local-policy.js");
    const allowedPath = join(root, "agencyai-local-capabilities.js");
    const symlinkPath = join(root, "agencyai-local-policy.js");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(outsidePath, "export default {};\n");
      writeFileSync(allowedPath, "export default {};\n");
      symlinkSync(outsidePath, symlinkPath);

      expect(isAllowedAgencyAiLocalPluginSpec(
        pathToFileURL(allowedPath).href,
        root,
      )).toBe(true);
      expect(isAllowedAgencyAiLocalPluginSpec("opencode-chrome-devtools", root)).toBe(false);
      expect(isAllowedAgencyAiLocalPluginSpec("https://plugins.invalid/plugin.js", root)).toBe(false);
      expect(isAllowedAgencyAiLocalPluginSpec("./agencyai-local-policy.js", root)).toBe(false);
      expect(isAllowedAgencyAiLocalPluginSpec(
        pathToFileURL(outsidePath).href,
        root,
      )).toBe(false);
      expect(isAllowedAgencyAiLocalPluginSpec(
        pathToFileURL(join(root, "unreviewed.js")).href,
        root,
      )).toBe(false);
      expect(isAllowedAgencyAiLocalPluginSpec(
        pathToFileURL(symlinkPath).href,
        root,
      )).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
