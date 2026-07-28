import { describe, expect, test } from "bun:test";

const source = async (relativePath: string) =>
  Bun.file(new URL(`../src/react-app/shell/${relativePath}`, import.meta.url)).text();

describe("local renderer composition", () => {
  test("keeps local providers outside the Den and cloud provider graph", async () => {
    const providers = await source("providers-local.tsx");
    expect(providers).not.toContain("/domains/cloud/");
    expect(providers).not.toContain("DenAuthProvider");
    expect(providers).not.toContain("DesktopConfigProvider");
    expect(providers).not.toContain("BrandTheme");
    expect(providers).not.toContain("CloudProviders");
  });

  test("keeps local settings independent from the upstream cloud settings route", async () => {
    const settings = await source("settings-route-local.tsx");
    expect(settings).not.toContain("/domains/cloud/");
    expect(settings).not.toMatch(/from\s+["']\.\/settings-route["']/);
    expect(settings).not.toContain("readDenSettings");
    expect(settings).not.toContain("createDenClient");
  });

  test("selects the local root before cloud startup code executes", async () => {
    const entry = await Bun.file(
      new URL("../src/index.react.tsx", import.meta.url),
    ).text();
    const profileBranch = entry.indexOf("if (product.features.openworkCloud)");
    const denBootstrap = entry.indexOf("initializeDenBootstrapConfig");
    const localProviders = entry.indexOf("providers-local");

    expect(profileBranch).toBeGreaterThan(-1);
    expect(denBootstrap).toBeGreaterThan(profileBranch);
    expect(localProviders).toBeGreaterThan(profileBranch);
    expect(entry).not.toMatch(/^import\s+.*shell\/providers["'];?$/m);
    expect(entry).not.toMatch(/^import\s+.*shell\/app-root["'];?$/m);
    expect(entry).not.toMatch(/^import\s+.*startup-deep-links["'];?$/m);
  });
});
