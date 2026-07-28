import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;

function archivePolicyError(message) {
  return new Error(`Unsafe sidecar archive: ${message}`);
}

function normalizedArchivePath(name) {
  if (typeof name !== "string" || !name || name.includes("\0")) {
    throw archivePolicyError("entry has an invalid name");
  }
  const normalized = name.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("//")
    || /^[A-Za-z]:/.test(normalized)
  ) {
    throw archivePolicyError(`entry is absolute: ${name}`);
  }
  const parts = normalized.split("/");
  const contentParts = normalized.endsWith("/") ? parts.slice(0, -1) : parts;
  if (
    contentParts.length === 0
    || contentParts.some((part) => !part || part === "." || part === "..")
  ) {
    throw archivePolicyError(`entry escapes or aliases its destination: ${name}`);
  }
  return contentParts.join("/");
}

export function assertSafeArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw archivePolicyError("contains no entries");
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw archivePolicyError(`contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
  }
  const seen = new Set();
  let expandedBytes = 0;
  for (const entry of entries) {
    const name = normalizedArchivePath(entry?.name);
    if (seen.has(name)) {
      throw archivePolicyError(`contains duplicate entry ${name}`);
    }
    seen.add(name);
    if (entry.type !== "file" && entry.type !== "directory") {
      throw archivePolicyError(`entry ${name} has forbidden type ${entry.type ?? "unknown"}`);
    }
    const size = Number(entry.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw archivePolicyError(`entry ${name} has an invalid size`);
    }
    expandedBytes += size;
    if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw archivePolicyError("expanded content exceeds the reviewed size limit");
    }
  }
  return entries;
}

function findZipEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw archivePolicyError("ZIP end-of-central-directory record is missing");
}

export function parseZipArchiveBuffer(buffer) {
  const eocd = findZipEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || centralOffset + centralSize > eocd
  ) {
    throw archivePolicyError("ZIP64, split, or inconsistent ZIP metadata is not allowed");
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > buffer.length
      || buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw archivePolicyError("ZIP central-directory entry is malformed");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (
      flags & 0x1
      || ![0, 8].includes(method)
      || size === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || end > buffer.length
    ) {
      throw archivePolicyError("encrypted, unsupported, ZIP64, or truncated entry");
    }
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    const type = name.endsWith("/") || fileType === 0x4000
      ? "directory"
      : fileType === 0 || fileType === 0x8000
        ? "file"
        : "special";
    entries.push({ name, size, type });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw archivePolicyError("ZIP central-directory length is inconsistent");
  }
  return assertSafeArchiveEntries(entries);
}

function readTarText(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero >= 0 ? zero : field.length).toString("utf8");
}

function readTarOctal(buffer, start, length) {
  const value = readTarText(buffer, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw archivePolicyError("tar entry has a non-octal size");
  }
  return Number.parseInt(value, 8);
}

export function parseTarArchiveBuffer(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const type = typeFlag === "\0" || typeFlag === "0"
      ? "file"
      : typeFlag === "5"
        ? "directory"
        : "special";
    entries.push({ name: fullName, size, type });
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > buffer.length) {
      throw archivePolicyError("tar entry extends beyond the archive");
    }
  }
  return assertSafeArchiveEntries(entries);
}

export function preflightSidecarArchiveSync(archivePath) {
  const bytes = readFileSync(archivePath);
  if (archivePath.endsWith(".zip")) {
    return parseZipArchiveBuffer(bytes);
  }
  if (archivePath.endsWith(".tar.gz")) {
    const expanded = gunzipSync(bytes, {
      maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES,
    });
    return parseTarArchiveBuffer(expanded);
  }
  throw new Error(`Unsupported verified archive type: ${archivePath}`);
}

export function assertExtractedTreeSafeSync(root) {
  const resolvedRoot = realpathSync(resolve(root));
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const candidate = resolve(directory, name);
      const candidateRelative = relative(resolvedRoot, candidate);
      if (
        !candidateRelative
        || candidateRelative.startsWith("..")
        || candidateRelative.includes("\0")
      ) {
        throw archivePolicyError(`extracted path escapes its destination: ${candidate}`);
      }
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw archivePolicyError(`extracted path is a symlink: ${candidateRelative}`);
      }
      if (stat.isDirectory()) {
        visit(candidate);
      } else if (!stat.isFile()) {
        throw archivePolicyError(`extracted path is not a regular file: ${candidateRelative}`);
      }
    }
  };
  visit(resolvedRoot);
}
