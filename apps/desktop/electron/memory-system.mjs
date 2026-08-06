import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";

export const MEMORY_SYSTEM_TEMPLATE_FILES = Object.freeze([
  "AGENTS.md",
  "MEMORY.md",
  "NOTES.md",
  "notes/README.md",
  "notes/TEMPLATE.md",
  "notes/projects/README.md",
]);

const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyTemplateIfMissing(templateRoot, configRoot, relativePath) {
  const sourcePath = path.join(templateRoot, relativePath);
  const targetPath = path.join(configRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    return "created";
  } catch (error) {
    if (error?.code === "EEXIST") return "preserved";
    throw error;
  }
}

async function writeFileAtomically(targetPath, content) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function invalidConfigResult(configPath, errors) {
  const details = errors.length
    ? errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ")
    : "OpenCode config must be a JSON object";
  return {
    path: configPath,
    status: "invalid",
    error: `Cannot activate MEMORY.md because ${configPath} is invalid: ${details}`,
  };
}

export function createInitialOpencodeConfig(memoryPath) {
  return `${JSON.stringify({
    $schema: OPENCODE_SCHEMA_URL,
    instructions: [memoryPath],
  }, null, 2)}\n`;
}

function mergeMemoryInstruction(content, configPath, memoryPath) {
  const errors = [];
  const parsed = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !isRecord(parsed)) {
    return { content, result: invalidConfigResult(configPath, errors) };
  }

  const instructions = parsed.instructions;
  if (
    instructions !== undefined
    && (!Array.isArray(instructions) || instructions.some((entry) => typeof entry !== "string"))
  ) {
    return {
      content,
      result: {
        path: configPath,
        status: "invalid",
        error: `Cannot activate MEMORY.md because ${configPath} has a non-string instructions value`,
      },
    };
  }

  const currentInstructions = instructions ?? [];
  if (currentInstructions.includes(memoryPath)) {
    return {
      content,
      result: { path: configPath, status: "unchanged", error: null },
    };
  }

  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
  const jsonPath = instructions === undefined
    ? ["instructions"]
    : ["instructions", currentInstructions.length];
  const value = instructions === undefined ? [memoryPath] : memoryPath;
  const updated = applyEdits(
    content,
    modify(content, jsonPath, value, { formattingOptions }),
  );
  return {
    content: updated,
    result: { path: configPath, status: "updated", error: null },
  };
}

async function activateMemoryFile(opencodeConfigDir) {
  const memoryPath = path.join(opencodeConfigDir, "MEMORY.md");
  const jsoncPath = path.join(opencodeConfigDir, "opencode.jsonc");
  const jsonPath = path.join(opencodeConfigDir, "opencode.json");
  const configPath = await pathExists(jsoncPath)
    ? jsoncPath
    : await pathExists(jsonPath)
      ? jsonPath
      : jsoncPath;

  if (!(await pathExists(configPath))) {
    try {
      await writeFile(configPath, createInitialOpencodeConfig(memoryPath), {
        encoding: "utf8",
        flag: "wx",
      });
      return { path: configPath, status: "created", error: null };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  const content = await readFile(configPath, "utf8");
  const merged = mergeMemoryInstruction(content, configPath, memoryPath);
  if (merged.result.status !== "updated") return merged.result;
  await writeFileAtomically(configPath, merged.content);
  return merged.result;
}

/**
 * Seed AgencyAI's local memory system without overwriting user-owned files.
 * The installer carries portable templates; paths are derived on the user's
 * machine from the active StorageLayout.
 */
export async function ensureAgencyAiMemorySystem({
  opencodeConfigDir,
  templateRoot,
}) {
  if (!path.isAbsolute(opencodeConfigDir)) {
    throw new Error("opencodeConfigDir must be an absolute path");
  }
  if (!path.isAbsolute(templateRoot)) {
    throw new Error("templateRoot must be an absolute path");
  }

  await mkdir(opencodeConfigDir, { recursive: true });
  const createdFiles = [];
  const preservedFiles = [];
  for (const relativePath of MEMORY_SYSTEM_TEMPLATE_FILES) {
    const status = await copyTemplateIfMissing(
      templateRoot,
      opencodeConfigDir,
      relativePath,
    );
    (status === "created" ? createdFiles : preservedFiles).push(relativePath);
  }

  return {
    createdFiles,
    preservedFiles,
    config: await activateMemoryFile(opencodeConfigDir),
  };
}
