import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_ROOT, "../../..");

export const EXPECTED_DOC_FILES = Object.freeze([
  "browser-and-computer-use.mdx",
  "docs.json",
  "getting-started.mdx",
  "mcp-and-skills.mdx",
  "privacy-and-security.mdx",
  "providers.mdx",
  "troubleshooting.mdx",
]);

export const FORBIDDEN_VENDOR_VALUES = Object.freeze([
  "openworklabs.com",
  "openwork.dev",
  "us.i.posthog.com",
  "support@openworklabs.com",
  "team@openworklabs.com",
  "founders@openworklabs.com",
]);
const FORBIDDEN_VENDOR_MATCHERS = Object.freeze([
  ["openworklabs.com", /openworklabs\.com/i],
  ["openwork.dev", /(?:https?:\/\/|\/\/)openwork\.dev(?:[/:]|$)/i],
  ["us.i.posthog.com", /us\.i\.posthog\.com/i],
  ["support@openworklabs.com", /support@openworklabs\.com/i],
  ["team@openworklabs.com", /team@openworklabs\.com/i],
  ["founders@openworklabs.com", /founders@openworklabs\.com/i],
]);

export const ALLOWED_UPSTREAM_LITERALS = Object.freeze([
  "OpenWork",
  "X-OpenWork-Host-Token",
  "legacyOpenWorkImport",
]);
export const ALLOWED_UPSTREAM_LEGAL_LITERALS = Object.freeze([
  "Includes software derived from the OpenWork project under the MIT License. Includes OpenCode under the MIT License. AgencyAI is not endorsed by either upstream project.",
]);
const ALLOWED_UPSTREAM_LITERAL_PREFIXES = Object.freeze([
  "(^[ \t]*)// OpenWork Cloud import:",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function filesBelow(root) {
  assert(existsSync(root), `Required product-surface directory is missing: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

function normalizedRelative(root, file) {
  return relative(root, file).split("\\").join("/");
}

function readUtf8(file) {
  return readFileSync(file, "utf8");
}

function textFilesBelow(root) {
  const textExtensions = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mdx",
    ".svg",
    ".txt",
  ]);
  return filesBelow(root).filter((file) => textExtensions.has(extname(file)));
}

export function forbiddenVendorFindings(source, label = "text") {
  return FORBIDDEN_VENDOR_MATCHERS
    .filter(([, matcher]) => matcher.test(source))
    .map(([value]) => value)
    .map((value) => `${label}: ${value}`);
}

export function upstreamStringLiterals(source, fileName = "renderer.js") {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const values = new Set();
  const visit = (node) => {
    if (
      (
        ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node)
      )
      && node.text.includes("OpenWork")
    ) {
      values.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...values].sort();
}

export function isAllowedUpstreamStringLiteral(value) {
  return (
    ALLOWED_UPSTREAM_LITERALS.includes(value)
    || ALLOWED_UPSTREAM_LEGAL_LITERALS.includes(value)
    || ALLOWED_UPSTREAM_LITERAL_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function verifyRenderer(rendererRoot) {
  const files = filesBelow(rendererRoot);
  const relativeFiles = files.map((file) => normalizedRelative(rendererRoot, file));
  const index = readUtf8(join(rendererRoot, "index.html"));
  const overlay = readUtf8(join(rendererRoot, "overlay.html"));

  assert(index.includes("<title>AgencyAI</title>"), "Renderer index title is not AgencyAI");
  assert(overlay.includes("<title>AgencyAI Overlay</title>"), "Renderer overlay title is not AgencyAI");
  assert(
    existsSync(join(rendererRoot, "agencyai-mark.svg"))
      && statSync(join(rendererRoot, "agencyai-mark.svg")).size > 0,
    "Renderer is missing the AgencyAI mark",
  );
  assert(
    !relativeFiles.some((file) => /openwork-(?:logo|mark)/i.test(file)),
    "Renderer still contains an upstream logo or mark filename",
  );
  assert(
    !relativeFiles.some((file) =>
      /(?:^|\/)(?:account-status-menu|cloud-sidebar-brand-logo)-[^/]+\.js$/i.test(file)),
    "Local renderer still emits a cloud account or cloud brand chunk",
  );

  const vendorFindings = textFilesBelow(rendererRoot).flatMap((file) =>
    forbiddenVendorFindings(
      readUtf8(file),
      normalizedRelative(rendererRoot, file),
    ));
  assert(
    vendorFindings.length === 0,
    `Local renderer contains forbidden vendor destinations:\n${vendorFindings.join("\n")}`,
  );

  const unexpectedLiterals = textFilesBelow(rendererRoot)
    .filter((file) => extname(file) === ".js")
    .flatMap((file) =>
      upstreamStringLiterals(readUtf8(file), file)
        .filter((value) => !isAllowedUpstreamStringLiteral(value))
        .map((value) => `${normalizedRelative(rendererRoot, file)}: ${JSON.stringify(value)}`),
    );
  assert(
    unexpectedLiterals.length === 0,
    `Local renderer contains upstream user-visible string literals:\n${unexpectedLiterals.join("\n")}`,
  );

  const legalSourceOccurrences = textFilesBelow(rendererRoot)
    .filter((file) => readUtf8(file).includes("https://github.com/different-ai/openwork"));
  assert(
    legalSourceOccurrences.length === 1,
    "The OpenWork upstream source link must appear exactly once in the renderer's legal surface",
  );

  return {
    files: relativeFiles.length,
    legalSource: normalizedRelative(rendererRoot, legalSourceOccurrences[0]),
    upstreamCompatibilityLiterals: ALLOWED_UPSTREAM_LITERALS,
  };
}

function verifyDocs(docsRoot) {
  const files = filesBelow(docsRoot).map((file) => normalizedRelative(docsRoot, file));
  assert(
    JSON.stringify(files) === JSON.stringify(EXPECTED_DOC_FILES),
    `Curated docs closure changed: ${JSON.stringify(files)}`,
  );
  const findings = textFilesBelow(docsRoot).flatMap((file) => {
    const source = readUtf8(file);
    const relativeFile = normalizedRelative(docsRoot, file);
    return [
      ...forbiddenVendorFindings(source, relativeFile),
      ...[
        "OpenWork Cloud",
        "search_capabilities",
        "execute_capability",
        "organization marketplace",
      ]
        .filter((value) => source.toLowerCase().includes(value.toLowerCase()))
        .map((value) => `${relativeFile}: ${value}`),
    ];
  });
  assert(
    findings.length === 0,
    `Curated docs contain hosted or upstream guidance:\n${findings.join("\n")}`,
  );
  return { files };
}

function verifySourceSurfaces(repositoryRoot) {
  const prompts = [
    "apps/app/src/app/data/commands/browser-setup.md",
    "apps/app/src/app/data/skill-creator.md",
  ];
  for (const relativePath of prompts) {
    const source = readUtf8(join(repositoryRoot, relativePath));
    assert(!source.includes("OpenWork"), `${relativePath} contains upstream product copy`);
    assert(
      !/search_capabilities|execute_capability|OpenWork Cloud/i.test(source),
      `${relativePath} contains hosted capability guidance`,
    );
  }

  const localeRoot = join(repositoryRoot, "apps/app/src/i18n/locales");
  for (const file of filesBelow(localeRoot).filter((candidate) => extname(candidate) === ".ts")) {
    assert(
      !readUtf8(file).includes("OpenWork"),
      `${normalizedRelative(repositoryRoot, file)} contains upstream product copy`,
    );
  }

  const about = readUtf8(
    join(repositoryRoot, "apps/app/src/react-app/shell/local-about-view.tsx"),
  );
  assert(
    about.includes('name: "OpenWork"')
      && about.includes("https://github.com/different-ai/openwork")
      && about.includes("OPENWORK-LICENSE.txt?raw")
      && about.includes("OPENCODE-LICENSE.txt?raw"),
    "About & Licenses is missing reviewed legal attribution",
  );

  return { prompts, locales: readdirSync(localeRoot).filter((file) => file.endsWith(".ts")).length };
}

export function verifyAgencyAiProductSurface(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const rendererRoot = resolve(
    options.rendererRoot ?? join(repositoryRoot, "apps/app/dist"),
  );
  const docsRoot = resolve(
    options.docsRoot
      ?? join(repositoryRoot, "apps/desktop/.generated/agencyai-docs"),
  );
  const result = {
    ok: true,
    renderer: verifyRenderer(rendererRoot),
    docs: verifyDocs(docsRoot),
    source: verifySourceSurfaces(repositoryRoot),
  };
  return result;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.stdout.write(`${JSON.stringify(verifyAgencyAiProductSurface(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
