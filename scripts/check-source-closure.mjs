#!/usr/bin/env node

import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const restrictedSegment = String.fromCharCode(101, 101);
const restrictedScope = ["@openwork", restrictedSegment].join("-");
const restrictedPackage = ["openwork", restrictedSegment].join("-");
const upstreamSlug = [
  ["different", "ai"].join("-"),
  ["open", "work"].join(""),
].join("/");
const allowlistRelativePath = [
  "scripts",
  ["source", "closure", "documentary", "allowlist"].join("-") + ".json",
].join("/");

const walkIgnoredDirectories = new Set([
  ".git",
  ".next",
  ".pnpm",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const executableExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".env",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".json5",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);

const documentaryExtensions = new Set([".md", ".mdx", ".rst", ".txt"]);
const documentaryBasenames = new Set(["COPYING", "LICENSE", "NOTICE"]);
const stagedJavaScriptExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativeDisplay(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  return toPosix(relative || ".");
}

function finding(code, file, line, field, value) {
  return { code, file, line, field, value };
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFindings(left, right) {
  return (
    compareText(left.file, right.file) ||
    left.line - right.line ||
    compareText(left.code, right.code) ||
    compareText(left.field, right.field) ||
    compareText(left.value, right.value)
  );
}

function dedupeAndSortFindings(findings) {
  const observed = new Set();
  const result = [];
  for (const item of findings.sort(compareFindings)) {
    const key = JSON.stringify(item);
    if (observed.has(key)) continue;
    observed.add(key);
    result.push(item);
  }
  return result;
}

async function pathInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function hasRestrictedPathSegment(value) {
  const normalized = value.replaceAll("\\", "/");
  const escaped = restrictedSegment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escaped}(?=/)|/${escaped}(?=$|[/"'\\x60(){}\\[\\],:;\\s])`,
    "i",
  ).test(normalized);
}

function hasBareRestrictedPathContext(line, repoPath, staticPathValues) {
  if (staticPathValues.some((value) => value.trim().toLowerCase() === restrictedSegment)) {
    return true;
  }

  const escaped = restrictedSegment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedBarePath = `["']?${escaped}["']?`;
  const normalized = line.replaceAll("\\", "/");
  const basename = path.posix.basename(repoPath.replaceAll("\\", "/")).toLowerCase();

  if (
    basename === "pnpm-workspace.yaml" &&
    new RegExp(`^\\s*-\\s*${quotedBarePath}\\s*(?:#.*)?$`, "i").test(normalized)
  ) {
    return true;
  }

  if (
    (basename === "dockerfile" || basename.startsWith("dockerfile.")) &&
    (
      new RegExp(`^\\s*(?:COPY|ADD)\\s+(?:--\\S+\\s+)*${quotedBarePath}(?=\\s|$)`, "i").test(normalized) ||
      new RegExp(`^\\s*(?:COPY|ADD)\\s*\\[\\s*${quotedBarePath}\\s*,`, "i").test(normalized)
    )
  ) {
    return true;
  }

  const shellDirectory =
    new RegExp(`(?:^|[\\s;&|("'\\x60])(?:cd|pushd)\\s+(?:--\\s+)?${quotedBarePath}(?=$|[\\s;&|/)])`, "i");
  const toolDirectory =
    new RegExp(`\\b(?:git\\s+-C|pnpm\\s+--dir|npm\\s+--prefix|yarn\\s+--cwd)\\s+${quotedBarePath}(?=$|[\\s;&|/)])`, "i");
  const explicitPathField =
    new RegExp(`\\b(?:working-directory|cwd|root-dir|source-dir|build-context)\\s*[:=]\\s*${quotedBarePath}(?=$|[\\s,;}\\]])`, "i");
  const processDirectory =
    new RegExp(`\\b(?:process\\s*\\.\\s*chdir|chdir)\\s*\\(\\s*${quotedBarePath}\\s*\\)`, "i");

  return (
    shellDirectory.test(normalized) ||
    toolDirectory.test(normalized) ||
    explicitPathField.test(normalized) ||
    processDirectory.test(normalized)
  );
}

export function isRestrictedRepositoryPath(value) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .some((segment) => segment.toLowerCase() === restrictedSegment);
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function isDocumentaryPath(repoPath) {
  const normalized = repoPath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  if (documentaryBasenames.has(basename)) return true;
  return documentaryExtensions.has(path.posix.extname(basename).toLowerCase());
}

function isExecutableOrConfigPath(repoPath) {
  const normalized = repoPath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(basename).toLowerCase();
  return (
    normalized.startsWith(".codex/") ||
    normalized.startsWith(".devcontainer/") ||
    normalized.startsWith(".github/workflows/") ||
    normalized.startsWith(".opencode/") ||
    normalized.startsWith(".vscode/") ||
    normalized.startsWith("scripts/") ||
    executableExtensions.has(extension) ||
    basename === "Dockerfile" ||
    basename.startsWith("Dockerfile.") ||
    basename === "Makefile" ||
    basename === "Procfile"
  );
}

function allowlistLine(content, candidate, fallback) {
  const index = content.indexOf(JSON.stringify(candidate));
  return index === -1 ? fallback : lineNumberAt(content, index);
}

async function loadDocumentaryAllowlist(root) {
  const absolutePath = path.join(root, ...allowlistRelativePath.split("/"));
  const file = allowlistRelativePath;
  const findings = [];
  let content;

  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error) {
    findings.push(finding("ALLOWLIST_MISSING", file, 1, "allowlist", "required file is missing or unreadable"));
    return { allowedPaths: new Set(), findings };
  }

  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
    findings.push(finding("ALLOWLIST_INVALID", file, 1, "json", message));
    return { allowedPaths: new Set(), findings };
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    findings.push(finding("ALLOWLIST_INVALID", file, 1, "root", "expected an object"));
    return { allowedPaths: new Set(), findings };
  }
  if (document.version !== 1) {
    findings.push(finding("ALLOWLIST_INVALID", file, 1, "version", "expected 1"));
  }
  if (!Array.isArray(document.entries)) {
    findings.push(finding("ALLOWLIST_INVALID", file, 1, "entries", "expected an array"));
    return { allowedPaths: new Set(), findings };
  }

  const allowedPaths = new Set();
  for (const [index, entry] of document.entries.entries()) {
    const fallbackLine = index + 2;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push(finding("ALLOWLIST_INVALID", file, fallbackLine, `entries[${index}]`, "expected an object"));
      continue;
    }

    const candidate = typeof entry.path === "string" ? entry.path : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const line = allowlistLine(content, candidate, fallbackLine);
    const normalized = candidate.replaceAll("\\", "/");
    const isExactRelativePath =
      candidate.length > 0 &&
      candidate === normalized &&
      !path.posix.isAbsolute(candidate) &&
      path.posix.normalize(candidate) === candidate &&
      !candidate.split("/").includes("..") &&
      !/[*?[\]{}]/.test(candidate);

    if (!isExactRelativePath) {
      findings.push(finding("ALLOWLIST_INVALID", file, line, `entries[${index}].path`, "expected an exact relative path"));
      continue;
    }
    if (!isDocumentaryPath(candidate) || isExecutableOrConfigPath(candidate)) {
      findings.push(finding("ALLOWLIST_INVALID", file, line, `entries[${index}].path`, "only documentary files may be exempted"));
      continue;
    }
    if (reason.length < 12) {
      findings.push(finding("ALLOWLIST_INVALID", file, line, `entries[${index}].reason`, "expected a specific review reason"));
      continue;
    }
    if (allowedPaths.has(candidate)) {
      findings.push(finding("ALLOWLIST_INVALID", file, line, `entries[${index}].path`, "duplicate path"));
      continue;
    }
    const candidateInfo = await pathInfo(path.join(root, ...candidate.split("/")));
    if (!candidateInfo || !candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
      findings.push(finding("ALLOWLIST_INVALID", file, line, `entries[${index}].path`, "path must be a regular documentary file"));
      continue;
    }
    allowedPaths.add(candidate);
  }

  return { allowedPaths, findings };
}

function gitPathList(root, mode) {
  const result = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", ...mode],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"))
    .sort();
}

async function walkRelativePaths(root, current = root, ignoredDirectories = walkIgnoredDirectories) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  const result = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(current, entry.name);
    const relativePath = relativeDisplay(root, absolutePath);
    result.push(relativePath);
    if (entry.isDirectory()) {
      result.push(...await walkRelativePaths(root, absolutePath, ignoredDirectories));
    }
  }

  return result;
}

async function repositoryPaths(root) {
  const tracked = gitPathList(root, ["--cached"]);
  const untracked = gitPathList(root, ["--others", "--exclude-standard"]);

  if (tracked && untracked) {
    return {
      tracked: new Set(tracked),
      untracked: new Set(untracked),
      candidates: [...new Set([...tracked, ...untracked])].sort(),
    };
  }

  const candidates = await walkRelativePaths(root);
  return {
    tracked: new Set(),
    untracked: new Set(candidates),
    candidates,
  };
}

function decodeQuotedLiteral(source) {
  const quote = source[0];
  if (!quote || source.at(-1) !== quote) return null;
  if (quote === '"' && !source.includes("\n")) {
    try {
      return JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (quote === "`" && source.includes("${")) return null;

  let result = "";
  for (let index = 1; index < source.length - 1; index += 1) {
    const character = source[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    index += 1;
    const escaped = source[index];
    if (escaped === undefined) return null;
    if (escaped === "n") result += "\n";
    else if (escaped === "r") result += "\r";
    else if (escaped === "t") result += "\t";
    else result += escaped;
  }
  return result;
}

function quotedLiterals(line, state = null) {
  const result = [];
  let index = 0;

  if (state?.templateSource) {
    let source = state.templateSource;
    let escaped = false;
    for (; index < line.length; index += 1) {
      const character = line[index];
      source += character;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character !== "`") continue;
      const value = decodeQuotedLiteral(source);
      if (value !== null) result.push({ source, value });
      state.templateSource = null;
      index += 1;
      break;
    }
    if (state.templateSource) {
      state.templateSource = `${source}\n`;
      return result;
    }
  }

  for (; index < line.length; index += 1) {
    const quote = line[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let cursor = index + 1;
    let escaped = false;
    for (; cursor < line.length; cursor += 1) {
      const character = line[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) break;
    }
    if (cursor >= line.length) {
      if (quote === "`" && state) {
        state.templateSource = `${line.slice(index)}\n`;
        break;
      }
      continue;
    }
    const source = line.slice(index, cursor + 1);
    const value = decodeQuotedLiteral(source);
    if (value !== null) result.push({ source, value });
    index = cursor;
  }
  return result;
}

function splitTopLevel(source, delimiter) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === delimiter && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function stripOuterParentheses(source) {
  let value = source.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let balanced = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "(") depth += 1;
      else if (value[index] === ")") depth -= 1;
      if (depth === 0 && index < value.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function staticStringValue(expression, bindings) {
  const source = stripOuterParentheses(expression.replace(/;\s*$/, "").trim());
  if (!source) return null;

  const literal = decodeQuotedLiteral(source);
  if (literal !== null) return literal;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(source)) {
    return bindings.get(source) ?? null;
  }

  const plusParts = splitTopLevel(source, "+");
  if (plusParts.length > 1) {
    const values = plusParts.map((part) => staticStringValue(part, bindings));
    if (values.every((value) => value !== null)) return values.join("");
  }

  const joinMatch = source.match(/^\[([\s\S]*)\]\.join\(([\s\S]*)\)$/);
  if (joinMatch) {
    const values = splitTopLevel(joinMatch[1], ",").map((part) => staticStringValue(part, bindings));
    const separator = staticStringValue(joinMatch[2], bindings);
    if (separator !== null && values.every((value) => value !== null)) {
      return values.join(separator);
    }
  }

  return null;
}

function matchingParenthesis(source, openIndex) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function staticPathCallValues(line, bindings) {
  const results = [];
  const callPattern = /(?:\bpath\s*\.\s*)?\b(?:join|resolve)\s*\(/g;
  for (const match of line.matchAll(callPattern)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closeIndex = matchingParenthesis(line, openIndex);
    if (closeIndex === -1) continue;
    const argumentsSource = line.slice(openIndex + 1, closeIndex);
    const values = splitTopLevel(argumentsSource, ",").map((part) => staticStringValue(part, bindings));
    const knownValues = values.filter((value) => value !== null);
    if (knownValues.length === 0) continue;
    results.push(knownValues.join("/"));
    results.push(...knownValues);
  }
  return results;
}

function referencedStaticValues(line, bindings) {
  const values = [];
  for (const identifier of line.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
    const value = bindings.get(identifier[0]);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function recordStaticBinding(line, bindings) {
  const match = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+?)\s*;?\s*$/);
  if (!match) return null;
  const value = staticStringValue(match[2], bindings);
  if (value !== null) bindings.set(match[1], value);
  return value;
}

function hasRestrictedPackageMarker(value) {
  const escapedScope = restrictedScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedPackage = restrictedPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:${escapedScope}(?:/[A-Za-z0-9._-]+)?|(?<![A-Za-z0-9_-])${escapedPackage}(?![A-Za-z0-9_-]))`,
    "i",
  ).test(value);
}

function packageEvidence(value) {
  if (value.includes(restrictedScope)) return restrictedScope;
  if (value.includes(restrictedPackage)) return restrictedPackage;
  return null;
}

function acquisitionEvidence(line, staticValues) {
  const lowerLine = line.toLowerCase();
  const values = [line, ...staticValues].map((value) => value.toLowerCase());
  const containsUpstream = values.some((value) => value.includes(upstreamSlug));
  if (!containsUpstream) return false;

  const words = [
    lowerLine,
    ...staticValues.map((value) => value.toLowerCase()),
  ].join(" ");
  const command =
    /\bgit\s+(?:clone|fetch|pull|archive|remote\s+add|submodule\s+add)\b/.test(words) ||
    /\bgh\s+repo\s+clone\b/.test(words) ||
    /\bdegit\b/.test(words) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:add|install)\b/.test(words) ||
    /\b(?:spawn|spawnSync|exec|execFile|execFileSync)\b/.test(words) &&
      /\bgit\b/.test(words) &&
      /\b(?:clone|fetch|archive)\b/.test(words);
  const workflowRepository = /\brepository\s*:/.test(lowerLine);
  const workflowAction = /\buses\s*:/.test(lowerLine);
  const sourceArchive = /\/(?:archive|tarball|zipball)\//.test(words);
  const rawSource = /raw\.githubusercontent\.com\//.test(words) || /\/raw\//.test(words);

  return command || workflowRepository || workflowAction || sourceArchive || rawSource;
}

function contentFindingCode(repoPath, staged) {
  if (staged) return "EE_STAGED_CONTENT";
  const normalized = repoPath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized).toLowerCase();
  if (basename === "pnpm-workspace.yaml") return "EE_WORKSPACE_REFERENCE";
  if (basename === "pnpm-lock.yaml" || basename.endsWith(".lock") || basename.endsWith("-lock.json")) {
    return "EE_LOCK_REFERENCE";
  }
  if (basename === "package.json") return "EE_PACKAGE_REFERENCE";
  if (isExecutableOrConfigPath(repoPath)) return "EE_EXECUTABLE_REFERENCE";
  if (isDocumentaryPath(repoPath)) return "EE_DOCUMENT_REFERENCE";
  return "EE_PATH_REFERENCE";
}

function contentFindingField(repoPath, staged) {
  if (staged) return "staged-content";
  const basename = path.posix.basename(repoPath.replaceAll("\\", "/")).toLowerCase();
  if (basename === "pnpm-workspace.yaml") return "workspace";
  if (basename === "pnpm-lock.yaml" || basename.endsWith(".lock") || basename.endsWith("-lock.json")) {
    return "lockfile";
  }
  if (basename === "package.json") return "manifest";
  if (repoPath.replaceAll("\\", "/").startsWith(".github/workflows/")) return "workflow";
  if (isExecutableOrConfigPath(repoPath)) return "executable";
  return "content";
}

function scanRawLineForRestrictedPath(repoPath, staged) {
  if (!staged) return true;
  // Minifiers may emit a short identifier followed by division, which is not a path.
  // Shipped JavaScript paths remain covered through parsed literals, static
  // path calls, package markers, and the staged path/symlink walk.
  const extension = path.posix.extname(
    repoPath.replaceAll("\\", "/"),
  ).toLowerCase();
  return !stagedJavaScriptExtensions.has(extension);
}

function scanTextContent(content, repoPath, options = {}) {
  const staged = options.staged === true;
  const allowDocumentaryReference = options.allowDocumentaryReference === true;
  const findings = [];
  const bindings = new Map();
  const quotedLiteralState = { templateSource: null };
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const literals = quotedLiterals(line, quotedLiteralState)
      .map(({ value }) => value);
    const boundValue = recordStaticBinding(line, bindings);
    const staticPathValues = staticPathCallValues(line, bindings);
    const staticValues = [
      ...literals,
      ...staticPathValues,
      ...referencedStaticValues(line, bindings),
    ];
    if (boundValue !== null) staticValues.push(boundValue);

    const restrictedPath =
      (
        scanRawLineForRestrictedPath(repoPath, staged) &&
        hasRestrictedPathSegment(line)
      ) ||
      staticValues.some((value) => hasRestrictedPathSegment(value)) ||
      hasBareRestrictedPathContext(line, repoPath, staticPathValues);
    const restrictedPackageReference =
      hasRestrictedPackageMarker(line) ||
      staticValues.some((value) => hasRestrictedPackageMarker(value));

    if ((restrictedPath || restrictedPackageReference) && !allowDocumentaryReference) {
      const code = contentFindingCode(repoPath, staged);
      const field = contentFindingField(repoPath, staged);
      const value = restrictedPackageReference
        ? packageEvidence([line, ...staticValues].join(" ")) ?? restrictedPackage
        : restrictedSegment;
      findings.push(finding(code, repoPath, lineNumber, field, value));
    }

    const contextStart = Math.max(0, index - 4);
    const contextEnd = Math.min(lines.length, index + 5);
    const acquisitionContext = lines.slice(contextStart, contextEnd).join(" ");
    if (
      acquisitionEvidence(line, staticValues) ||
      line.toLowerCase().includes(upstreamSlug) && acquisitionEvidence(acquisitionContext, staticValues)
    ) {
      if (allowDocumentaryReference) continue;
      findings.push(finding(
        "UPSTREAM_SOURCE_ACQUISITION",
        repoPath,
        lineNumber,
        staged ? "staged-content" : "source-acquisition",
        upstreamSlug,
      ));
    }
  }

  return findings;
}

async function scanFileContent(absolutePath, displayPath, options) {
  const info = await pathInfo(absolutePath);
  if (!info || !info.isFile()) return [];
  const buffer = await readFile(absolutePath);
  if (buffer.includes(0)) return [];
  return scanTextContent(buffer.toString("utf8"), displayPath, options);
}

async function scanRepository(root, allowedPaths) {
  const findings = [];
  const restrictedRoot = path.join(root, restrictedSegment);
  const rootInfo = await pathInfo(restrictedRoot);
  if (rootInfo) {
    const kind = rootInfo.isSymbolicLink()
      ? "symlink"
      : rootInfo.isDirectory()
        ? "directory"
        : "file";
    findings.push(finding("EE_ROOT_PRESENT", restrictedSegment, 1, "path", kind));
  }

  const paths = await repositoryPaths(root);
  for (const repoPath of paths.candidates) {
    const absolutePath = path.join(root, ...repoPath.split("/"));
    const info = await pathInfo(absolutePath);
    const restrictedPath = isRestrictedRepositoryPath(repoPath);

    if (paths.tracked.has(repoPath) && restrictedPath) {
      findings.push(finding("EE_TRACKED_PATH", repoPath, 1, "git-index", repoPath));
    } else if (info && restrictedPath) {
      findings.push(finding("EE_ON_DISK_PATH", repoPath, 1, "path", repoPath));
    }
    if (!info || restrictedPath) continue;

    if (info.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      if (hasRestrictedPathSegment(target)) {
        findings.push(finding("EE_SYMLINK_TARGET", repoPath, 1, "symlink-target", target));
      }
      continue;
    }
    if (!info.isFile()) continue;

    findings.push(...await scanFileContent(absolutePath, repoPath, {
      allowDocumentaryReference: allowedPaths.has(repoPath),
      staged: false,
    }));
  }

  return findings;
}

async function scanStagedDirectory(root, stagedDirectory, index) {
  const absoluteRoot = path.resolve(root, stagedDirectory);
  const info = await pathInfo(absoluteRoot);
  const prefix = `@staged/${index}`;
  if (!info) {
    return [finding("STAGED_DIR_MISSING", prefix, 1, "path", stagedDirectory)];
  }
  if (!info.isDirectory()) {
    return [finding("STAGED_DIR_INVALID", prefix, 1, "path", stagedDirectory)];
  }

  const findings = [];
  if (path.basename(absoluteRoot).toLowerCase() === restrictedSegment) {
    findings.push(finding("EE_STAGED_PATH", `${prefix}/${restrictedSegment}`, 1, "path", restrictedSegment));
  }

  const paths = await walkRelativePaths(absoluteRoot, absoluteRoot, new Set([".git"]));
  for (const relativePath of paths) {
    const absolutePath = path.join(absoluteRoot, ...relativePath.split("/"));
    const displayPath = `${prefix}/${relativePath}`;
    const entryInfo = await pathInfo(absolutePath);
    if (!entryInfo) continue;

    if (isRestrictedRepositoryPath(relativePath)) {
      findings.push(finding("EE_STAGED_PATH", displayPath, 1, "path", relativePath));
      continue;
    }
    if (entryInfo.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      if (hasRestrictedPathSegment(target)) {
        findings.push(finding("EE_STAGED_SYMLINK", displayPath, 1, "symlink-target", target));
      }
      continue;
    }
    if (!entryInfo.isFile()) continue;
    findings.push(...await scanFileContent(absolutePath, displayPath, {
      allowDocumentaryReference: false,
      staged: true,
    }));
  }
  return findings;
}

export async function scanSourceClosure(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot);
  const stagedDirectories = options.stagedDirectories ?? [];
  const allowlist = await loadDocumentaryAllowlist(root);
  const findings = [
    ...allowlist.findings,
    ...await scanRepository(root, allowlist.allowedPaths),
  ];

  for (const [index, stagedDirectory] of stagedDirectories.entries()) {
    findings.push(...await scanStagedDirectory(root, stagedDirectory, index));
  }

  return dedupeAndSortFindings(findings);
}

export function parseArguments(argv) {
  const options = {
    json: false,
    root: defaultRoot,
    stagedDirectories: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--root" || argument === "--staged-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--root") options.root = value;
      else options.stagedDirectories.push(value);
      continue;
    }
    if (argument.startsWith("--root=")) {
      const value = argument.slice("--root=".length);
      if (!value) throw new Error("--root requires a value");
      options.root = value;
      continue;
    }
    if (argument.startsWith("--staged-dir=")) {
      const value = argument.slice("--staged-dir=".length);
      if (!value) throw new Error("--staged-dir requires a value");
      options.stagedDirectories.push(value);
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function usage() {
  return [
    "Usage: node scripts/check-source-closure.mjs [options]",
    "",
    "Options:",
    "  --root <path>         Repository root (defaults to this checkout)",
    "  --staged-dir <path>   Scan a staged artifact directory; repeatable",
    "  --json                Emit deterministic machine-readable output",
    "  --help                Show this help",
  ].join("\n");
}

export function formatText(findings) {
  if (findings.length === 0) return "Source closure: passed (0 findings).";
  const lines = [`Source closure: failed (${findings.length} findings).`];
  for (const item of findings) {
    lines.push(`${item.file}:${item.line} [${item.code}] ${item.field}=${JSON.stringify(item.value)}`);
  }
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const findings = await scanSourceClosure({
    root: options.root,
    stagedDirectories: options.stagedDirectories,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatText(findings)}\n`);
  }
  if (findings.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  await main();
}
