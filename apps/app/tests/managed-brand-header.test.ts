import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const sidebarPath = fileURLToPath(
  new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url),
);
const cloudBrandPath = fileURLToPath(
  new URL(
    "../src/react-app/domains/session/sidebar/cloud-sidebar-brand-logo.tsx",
    import.meta.url,
  ),
);

describe("managed brand header", () => {
  test("shows the brand header only when a wordmark is supplied", () => {
    const sidebarSource = readFileSync(sidebarPath, "utf8");
    const cloudBrandSource = readFileSync(cloudBrandPath, "utf8");

    expect(sidebarSource).toMatch(
      /PRODUCT\.features\.dynamicOrgBranding[\s\S]*?<CloudSidebarBrandLogo \/>/,
    );
    expect(cloudBrandSource).toMatch(
      /if \(!brandLogoUrl\) return null;[\s\S]*?data-testid="brand-logo"[\s\S]*?<img/,
    );
    expect(sidebarSource).not.toContain("brand-app-name");
    expect(sidebarSource).not.toContain("useBrandAppName");
    expect(cloudBrandSource).toMatch(/className="flex h-14 shrink-0 items-center/);
    expect(cloudBrandSource).toMatch(
      /className="max-h-9 w-auto max-w-\[140px\] object-contain object-left"/,
    );
  });
});
