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

  test("loads settings workspaces from the live local server when the desktop store is empty", async () => {
    const settings = await source("settings-route-local.tsx");
    expect(settings).toContain("serverClient.listWorkspaces()");
    expect(settings).toContain("mergeRouteWorkspaces(");
    expect(settings).toContain("waitForOpenworkConnection({ timeoutMs: 15_000 })");
  });

  test("selects the local root before cloud startup code executes", async () => {
    const entry = await Bun.file(
      new URL("../src/index.react.tsx", import.meta.url),
    ).text();
    const localEntry = await Bun.file(
      new URL("../src/product-entry-local.tsx", import.meta.url),
    ).text();
    const vite = await Bun.file(
      new URL("../vite.config.ts", import.meta.url),
    ).text();

    expect(entry).toContain('from "virtual:product-app-entry"');
    expect(entry).not.toContain("initializeDenBootstrapConfig");
    expect(entry).not.toContain("startDeepLinkBridge");
    expect(localEntry).toContain("providers-local");
    expect(localEntry).toContain("app-root-local");
    expect(localEntry).not.toContain("/domains/cloud/");
    expect(vite).toContain("productProfile.features.openworkCloud");
    expect(vite).toContain("product-entry-local.tsx");
    expect(vite).toContain("product-entry-upstream.tsx");
    expect(entry).not.toMatch(/^import\s+.*shell\/providers["'];?$/m);
    expect(entry).not.toMatch(/^import\s+.*shell\/app-root["'];?$/m);
    expect(entry).not.toMatch(/^import\s+.*startup-deep-links["'];?$/m);
  });

  test("ships local-only browser and skill prompts", async () => {
    const browserSetup = await Bun.file(
      new URL("../src/app/data/commands/browser-setup.md", import.meta.url),
    ).text();
    const skillCreator = await Bun.file(
      new URL("../src/app/data/skill-creator.md", import.meta.url),
    ).text();

    expect(browserSetup).toContain("AgencyAI browser");
    expect(skillCreator).toContain(".opencode/skills/<skill-name>/SKILL.md");
    expect(`${browserSetup}\n${skillCreator}`).not.toContain("OpenWork");
    expect(skillCreator.toLowerCase()).not.toContain("cloud");
    expect(skillCreator).not.toContain("search_capabilities");
    expect(skillCreator).not.toContain("execute_capability");
  });

  test("exposes build, security, and legal attribution only in About", async () => {
    const settings = await source("settings-route-local.tsx");
    const about = await source("local-about-view.tsx");

    expect(settings).toContain('"about"');
    expect(settings).toContain("About & Licenses");
    expect(settings).toContain("LocalAboutView");
    expect(about).toContain('data-testid="agencyai-about-view"');
    expect(about).toContain("AgencyAI");
    expect(about).toContain("OpenWork");
    expect(about).toContain("OpenCode");
    expect(about).toContain("MIT");
    expect(about).toContain("artreimus/AgencyAI-OpenCode");
    expect(about).not.toContain("openworklabs.com");
    expect(about).not.toContain("OpenWork Cloud");
  });

  test("keeps every selectable locale free of the upstream product name", async () => {
    const localeFiles = [
      "ca.ts",
      "en.ts",
      "es.ts",
      "fr.ts",
      "ja.ts",
      "pt-BR.ts",
      "ru.ts",
      "th.ts",
      "vi.ts",
      "zh.ts",
    ];
    for (const localeFile of localeFiles) {
      const locale = await Bun.file(
        new URL(`../src/i18n/locales/${localeFile}`, import.meta.url),
      ).text();
      expect(locale).not.toContain("OpenWork");
    }
  });
});
