import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  MEMORY_SYSTEM_TEMPLATE_FILES,
  createInitialOpencodeConfig,
  ensureAgencyAiMemorySystem,
} from "./memory-system.mjs";

const templateRoot = path.resolve(
  import.meta.dirname,
  "../resources/memory-system",
);

async function withTemporaryConfig(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agencyai-memory-system-"));
  const configDir = path.join(root, "config", "opencode");
  try {
    await run(configDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ensureAgencyAiMemorySystem", () => {
  it("seeds a fresh app-owned OpenCode directory and activates MEMORY.md", async () => {
    await withTemporaryConfig(async (configDir) => {
      const result = await ensureAgencyAiMemorySystem({
        opencodeConfigDir: configDir,
        templateRoot,
      });

      assert.deepEqual(result.createdFiles, [...MEMORY_SYSTEM_TEMPLATE_FILES]);
      assert.deepEqual(result.preservedFiles, []);
      assert.equal(result.config.status, "created");

      for (const relativePath of MEMORY_SYSTEM_TEMPLATE_FILES) {
        const content = await readFile(path.join(configDir, relativePath), "utf8");
        assert.notEqual(content.trim(), "");
      }

      const config = JSON.parse(
        await readFile(path.join(configDir, "opencode.jsonc"), "utf8"),
      );
      assert.deepEqual(config.instructions, [path.join(configDir, "MEMORY.md")]);
      assert.doesNotMatch(JSON.stringify(config), /artreimus/);
    });
  });

  it("preserves user files and JSONC comments while merging only once", async () => {
    await withTemporaryConfig(async (configDir) => {
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "AGENTS.md"), "# My rules\n", "utf8");
      await writeFile(
        path.join(configDir, "opencode.jsonc"),
        `{
  // Keep this provider configuration.
  "provider": { "example": {} },
  "instructions": ["/existing/instructions.md"]
}\n`,
        "utf8",
      );

      const first = await ensureAgencyAiMemorySystem({
        opencodeConfigDir: configDir,
        templateRoot,
      });
      const second = await ensureAgencyAiMemorySystem({
        opencodeConfigDir: configDir,
        templateRoot,
      });
      const configContent = await readFile(
        path.join(configDir, "opencode.jsonc"),
        "utf8",
      );

      assert.equal(await readFile(path.join(configDir, "AGENTS.md"), "utf8"), "# My rules\n");
      assert.equal(first.preservedFiles.includes("AGENTS.md"), true);
      assert.equal(first.config.status, "updated");
      assert.equal(second.config.status, "unchanged");
      assert.match(configContent, /Keep this provider configuration/);
      assert.equal(
        configContent.match(/MEMORY\.md/g)?.length,
        1,
      );
    });
  });

  it("fails closed without rewriting an invalid existing config", async () => {
    await withTemporaryConfig(async (configDir) => {
      await mkdir(configDir, { recursive: true });
      const invalid = "{ this is not valid JSONC\n";
      await writeFile(path.join(configDir, "opencode.jsonc"), invalid, "utf8");

      const result = await ensureAgencyAiMemorySystem({
        opencodeConfigDir: configDir,
        templateRoot,
      });

      assert.equal(result.config.status, "invalid");
      assert.match(result.config.error, /Cannot activate MEMORY\.md/);
      assert.equal(
        await readFile(path.join(configDir, "opencode.jsonc"), "utf8"),
        invalid,
      );
      assert.equal(result.createdFiles.includes("MEMORY.md"), true);
    });
  });

  it("JSON-encodes a runtime-derived Windows path without hardcoded user data", () => {
    const memoryPath = "C:\\Users\\Ada Example\\AppData\\Roaming\\AgencyAI\\config\\opencode\\MEMORY.md";
    const content = createInitialOpencodeConfig(memoryPath);

    assert.deepEqual(JSON.parse(content).instructions, [memoryPath]);
    assert.doesNotMatch(content, /artreimus|\/Users\//);
  });
});
