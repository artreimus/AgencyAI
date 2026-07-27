import { describe, expect, test } from "bun:test";

import {
  resolveExtensionIconUrl,
  resolveRendererAssetSrc,
} from "../src/react-app/design-system/extension-icon-src";

describe("local renderer asset policy", () => {
  test("keeps bundled and in-memory image sources", () => {
    expect(resolveRendererAssetSrc("/ext-notion.svg")).toEndWith("/ext-notion.svg");
    expect(resolveRendererAssetSrc("icons/local.svg")).toBe("icons/local.svg");
    expect(resolveRendererAssetSrc("data:image/svg+xml;base64,PHN2Zy8+")).toBe(
      "data:image/svg+xml;base64,PHN2Zy8+",
    );
    expect(resolveRendererAssetSrc("blob:local-preview")).toBe("blob:local-preview");
  });

  test("quarantines remote and protocol-relative image sources", () => {
    expect(resolveRendererAssetSrc("https://assets.example/icon.svg")).toBeUndefined();
    expect(resolveRendererAssetSrc("http://assets.example/icon.svg")).toBeUndefined();
    expect(resolveRendererAssetSrc("//assets.example/icon.svg")).toBeUndefined();
    expect(resolveRendererAssetSrc("file:///tmp/icon.svg")).toBeUndefined();
  });

  test("does not synthesize Simple Icons or Google favicon requests", () => {
    expect(resolveExtensionIconUrl({ iconSlug: "notion" })).toBeUndefined();
    expect(
      resolveExtensionIconUrl({ serviceUrl: "https://mcp.notion.com" }),
    ).toBeUndefined();
    expect(
      resolveExtensionIconUrl({ iconSrc: "https://assets.example/icon.svg" }),
    ).toBeUndefined();
    expect(resolveExtensionIconUrl({ iconSrc: "/ext-notion.svg" })).toEndWith(
      "/ext-notion.svg",
    );
  });
});
