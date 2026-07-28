import { readdir, readFile, stat } from "node:fs/promises";
import {
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";

export type BundledDocsEntry = Readonly<{
  path: string;
  title: string | null;
  description: string | null;
  content: string;
}>;

export type BundledDocsMatch = Readonly<{
  path: string;
  title: string | null;
  description: string | null;
  excerpt: string;
}>;

type BundledDocsOptions = Readonly<{
  candidateDirectories: readonly string[];
  missingPageLabel: string;
}>;

async function existingDirectory(
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return resolve(candidate);
    } catch {
      // Try the next reviewed application-owned layout.
    }
  }
  return null;
}

async function documentationFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "images" || entry.name === "logo") continue;
      files.push(...await documentationFiles(root, candidate));
      continue;
    }
    if (
      entry.isFile()
      && /\.(?:md|mdx|json)$/i.test(entry.name)
      && entry.name !== "openapi.json"
    ) {
      files.push(candidate);
    }
  }
  return files;
}

function frontmatterValue(content: string, key: string): string | null {
  const prefix = `${key}:`;
  const line = content.split("\n").find((entry) => entry.startsWith(prefix));
  const raw = line?.slice(prefix.length).trim();
  if (!raw) return null;
  if (
    (raw.startsWith("\"") && raw.endsWith("\""))
    || (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

async function loadEntries(
  candidates: readonly string[],
): Promise<BundledDocsEntry[]> {
  const root = await existingDirectory(candidates);
  if (!root) return [];
  const files = await documentationFiles(root);
  const entries = await Promise.all(files.map(async (file) => {
    const content = await readFile(file, "utf8");
    return Object.freeze({
      path: relative(root, file).replaceAll("\\", "/"),
      title: frontmatterValue(content, "title"),
      description: frontmatterValue(content, "description"),
      content,
    });
  }));
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fieldContainsTerm(value: string, term: string): boolean {
  if (term.length > 3) return value.includes(term);
  const tokens = value.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.includes(term);
}

function scoreEntry(entry: BundledDocsEntry, query: string): number {
  const terms = queryTerms(query);
  const path = entry.path.toLowerCase();
  const title = entry.title?.toLowerCase() ?? "";
  const description = entry.description?.toLowerCase() ?? "";
  const content = entry.content.toLowerCase();
  return terms.reduce((score, term) => {
    if (fieldContainsTerm(path, term)) score += 8;
    if (fieldContainsTerm(title, term)) score += 6;
    if (fieldContainsTerm(description, term)) score += 4;
    if (fieldContainsTerm(content, term)) score += 1;
    return score;
  }, 0);
}

function excerpt(content: string, query: string): string {
  const lower = content.toLowerCase();
  const indexes = queryTerms(query)
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const matchIndex = indexes.length > 0 ? Math.min(...indexes) : 0;
  const start = Math.max(0, matchIndex - 160);
  return content.slice(start, start + 500).replace(/\s+/g, " ").trim();
}

function normalizeReadPath(value: string): string {
  const requested = value.trim();
  if (
    !requested
    || requested.includes("\\")
    || posix.isAbsolute(requested)
    || win32.isAbsolute(requested)
  ) {
    throw new Error("Invalid docs path");
  }
  const segments = requested.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Invalid docs path");
  }
  return segments.join("/");
}

export function createBundledDocsIndex(options: BundledDocsOptions) {
  const candidates = Object.freeze(
    options.candidateDirectories.map((candidate) => resolve(candidate)),
  );
  let cache: Promise<BundledDocsEntry[]> | null = null;
  const entries = () => {
    cache ??= loadEntries(candidates);
    return cache;
  };

  return Object.freeze({
    async search(query: string, limit = 5): Promise<BundledDocsMatch[]> {
      const docs = await entries();
      return docs
        .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score
            || left.entry.path.localeCompare(right.entry.path),
        )
        .slice(0, limit)
        .map(({ entry }) => Object.freeze({
          path: entry.path,
          title: entry.title,
          description: entry.description,
          excerpt: excerpt(entry.content, query),
        }));
    },
    async read(requestedPath: string): Promise<BundledDocsEntry> {
      const normalized = normalizeReadPath(requestedPath);
      const docs = await entries();
      const entry = docs.find((candidate) => candidate.path === normalized);
      if (!entry) {
        throw new Error(`${options.missingPageLabel} not found: ${normalized}`);
      }
      return entry;
    },
  });
}
