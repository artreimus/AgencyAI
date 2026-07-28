import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "../..");

export const AGENCYAI_DOC_FILES = Object.freeze([
  "browser-and-computer-use.mdx",
  "docs.json",
  "getting-started.mdx",
  "mcp-and-skills.mdx",
  "privacy-and-security.mdx",
  "providers.mdx",
  "troubleshooting.mdx",
]);

const FORBIDDEN_DOC_PATTERNS = Object.freeze([
  /OpenWork/i,
  /openworklabs\.com/i,
  /different-ai/i,
  /Den sign-in/i,
  /Memory Bank/i,
  /search_capabilities/i,
  /execute_capability/i,
  /shared workspace/i,
  /organization policy/i,
]);

function sortedFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        throw new Error(`AgencyAI docs must stay flat: ${entry.name}`);
      }
      return entry.isFile() ? [entry.name] : [];
    })
    .sort();
}

function assertExactFiles(root) {
  const actual = sortedFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(AGENCYAI_DOC_FILES)) {
    throw new Error(
      `AgencyAI docs closure mismatch: ${actual.join(", ")}`,
    );
  }
}

function navigationPages(value) {
  if (!value || typeof value !== "object") return [];
  const navigation = Reflect.get(value, "navigation");
  if (!Array.isArray(navigation)) return [];
  return navigation.flatMap((section) => {
    if (!section || typeof section !== "object") return [];
    const pages = Reflect.get(section, "pages");
    return Array.isArray(pages)
      ? pages.filter((page) => typeof page === "string")
      : [];
  });
}

export function validateAgencyAiDocs(root) {
  assertExactFiles(root);
  for (const file of AGENCYAI_DOC_FILES) {
    const content = readFileSync(resolve(root, file), "utf8");
    for (const pattern of FORBIDDEN_DOC_PATTERNS) {
      if (pattern.test(content)) {
        throw new Error(
          `AgencyAI local docs contain forbidden guidance in ${file}: ${pattern}`,
        );
      }
    }
  }
  const navigation = JSON.parse(
    readFileSync(resolve(root, "docs.json"), "utf8"),
  );
  const expectedPages = AGENCYAI_DOC_FILES.filter(
    (file) => file !== "docs.json",
  );
  const actualPages = navigationPages(navigation).sort();
  if (JSON.stringify(actualPages) !== JSON.stringify(expectedPages)) {
    throw new Error(
      `AgencyAI docs navigation mismatch: ${actualPages.join(", ")}`,
    );
  }
}

export function stageAgencyAiDocs({
  sourceRoot = resolve(repoRoot, "packages/agencyai-docs"),
  outputRoot = resolve(desktopRoot, ".generated/agencyai-docs"),
} = {}) {
  validateAgencyAiDocs(sourceRoot);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  for (const file of AGENCYAI_DOC_FILES) {
    cpSync(resolve(sourceRoot, file), resolve(outputRoot, file));
  }
  validateAgencyAiDocs(outputRoot);
  return Object.freeze({
    sourceRoot,
    outputRoot,
    files: AGENCYAI_DOC_FILES,
  });
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const staged = stageAgencyAiDocs();
    process.stdout.write(
      `${JSON.stringify({ ok: true, outputRoot: staged.outputRoot, files: staged.files }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[agencyai-docs] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
