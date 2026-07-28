import { describe, expect, test } from "bun:test";

import {
  getCompiledRendererProductProfile,
  projectRendererProductProfile,
} from "../src/app/lib/product-profile";

describe("local renderer product profile", () => {
  test("uses the exact compiled local-mvp profile when IPC is absent", () => {
    const compiled = getCompiledRendererProductProfile();
    const projected = projectRendererProductProfile();

    expect(projected).toEqual(compiled);
    expect(projected.profile).toBe("local-mvp");
    expect(projected.brand.name).toBe("AgencyAI");
    expect(projected.features.browserAutomation).toBe(true);
    expect(projected.features.computerUse).toBe(true);
    expect(projected.features.openworkCloud).toBe(false);
  });

  test("ignores a hostile IPC identity and all-true capability candidate", () => {
    const compiled = getCompiledRendererProductProfile();
    const hostile = structuredClone(compiled);
    Reflect.set(hostile.brand, "name", "OpenWork");
    Reflect.set(hostile.brand, "appId", "com.differentai.openwork");
    for (const key of Object.keys(hostile.features)) {
      Reflect.set(hostile.features, key, true);
    }
    const before = structuredClone(hostile);

    const projected = projectRendererProductProfile({ productProfile: hostile });

    expect(projected.brand).toEqual(compiled.brand);
    expect(projected.features.openworkCloud).toBe(false);
    expect(projected.features.runtimeDownloads).toBe(false);
    expect(projected.features.remoteWorkspaces).toBe(false);
    expect(hostile).toEqual(before);
  });

  test("allows IPC and runtime inputs to narrow but never broaden", () => {
    const compiled = getCompiledRendererProductProfile();
    const ipc = structuredClone(compiled);
    Reflect.set(ipc.features, "browserAutomation", false);

    const projected = projectRendererProductProfile(
      { productProfile: ipc },
      {
        browserAutomation: true,
        computerUse: false,
        openworkCloud: true,
      },
    );

    expect(projected.features.browserAutomation).toBe(false);
    expect(projected.features.computerUse).toBe(false);
    expect(projected.features.openworkCloud).toBe(false);
  });

  test("rejects malformed or mismatched IPC candidates", () => {
    const compiled = getCompiledRendererProductProfile();
    const mismatched = structuredClone(compiled);
    Reflect.set(mismatched, "profile", "upstream");

    expect(projectRendererProductProfile({ productProfile: mismatched })).toEqual(compiled);
    expect(projectRendererProductProfile({ productProfile: { features: {} } })).toEqual(compiled);
    expect(projectRendererProductProfile({ productProfile: null })).toEqual(compiled);
  });

  test("does not consult localStorage and recursively freezes the projection", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage must not be read");
      },
    });

    try {
      const projected = projectRendererProductProfile();
      expect(Object.isFrozen(projected)).toBe(true);
      expect(Object.isFrozen(projected.brand)).toBe(true);
      expect(Object.isFrozen(projected.brand.repository)).toBe(true);
      expect(Object.isFrozen(projected.brand.computerUse)).toBe(true);
      expect(Object.isFrozen(projected.features)).toBe(true);
      expect(Reflect.set(projected.features, "openworkCloud", true)).toBe(false);
      expect(projected.features.openworkCloud).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});
