import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextManifestEntry } from "./contracts.js";
import { DomainError, stableError } from "./errors.js";

const execFileAsync = promisify(execFile);
const EMPTY_DIGEST = createHash("sha256").update("").digest("hex");
const MAX_FILE_BYTES = 1_048_576;
const MAX_FILE_CHARACTERS = 60_000;
const MAX_DIFF_BYTES = 2_097_152;
const MAX_CONTEXT_ITEMS = 2_000;

/**
 * A deliberately conservative estimate for source-heavy prompts. The MCP does
 * not have a tokenizer for every configured backend, so this is a budget guard,
 * not a claim of exact tokenizer usage. Upstream usage is reported separately
 * when the backend provides it.
 */
export const CONSERVATIVE_CHARACTERS_PER_TOKEN = 2;

export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / CONSERVATIVE_CHARACTERS_PER_TOKEN);
}

const excludedDirectories = new Set([
  ".git",
  ".venv",
  "node_modules",
  "dist",
  "coverage",
  "__pycache__",
  ".cache",
  "models",
  "generated",
  "run",
]);
const excludedExtensions = new Set([
  ".safetensors",
  ".gguf",
  ".bin",
  ".dylib",
  ".so",
  ".a",
  ".o",
  ".pyc",
  ".p12",
  ".pfx",
  ".pem",
  ".key",
]);

export type ResolvedWorkspace = { root: string };

export type PackedContext = {
  manifest: ContextManifestEntry[];
  sections: { relativePath: string; content: string }[];
  truncated: boolean;
  warnings: string[];
};

type Candidate = {
  absolutePath: string;
  relativePath: string;
};

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function isSensitive(relativePath: string): boolean {
  const normalized = portablePath(relativePath);
  const parts = normalized.split("/");
  const filename = parts.at(-1)?.toLowerCase() ?? "";
  if (parts.some((part) => excludedDirectories.has(part.toLowerCase()))) return true;
  if (filename === ".env" || filename.startsWith(".env.")) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(filename)) return true;
  if (/(^|[._-])(credentials?|secrets?|tokens?)([._-]|$)/.test(filename)) return true;
  const extensionIndex = filename.lastIndexOf(".");
  const extension = extensionIndex < 0 ? "" : filename.slice(extensionIndex);
  return excludedExtensions.has(extension);
}

function omitted(relativePath: string, byteCount: number, reason: string): ContextManifestEntry {
  return {
    relative_path: portablePath(relativePath),
    byte_count: byteCount,
    sha256: EMPTY_DIGEST,
    truncated: false,
    omitted: true,
    reason,
  };
}

function throwWorkspace(
  code: "INVALID_WORKSPACE" | "PATH_OUTSIDE_WORKSPACE",
  message: string,
): never {
  throw new DomainError(stableError(code, message, { retryable: false }));
}

function enforceItemLimit(candidates: Candidate[], manifests: ContextManifestEntry[]): void {
  if (candidates.length + manifests.length >= MAX_CONTEXT_ITEMS) {
    throw new DomainError(
      stableError("INPUT_LIMIT_EXCEEDED", "The selected context contains too many items.", {
        retryable: false,
        details: { maximum_items: MAX_CONTEXT_ITEMS },
      }),
    );
  }
}

export async function resolveWorkspaceRoot(path: string | null): Promise<ResolvedWorkspace> {
  if (path === null) {
    throw new DomainError(
      stableError("INVALID_WORKSPACE", "A workspace root is required for delegation.", {
        retryable: false,
      }),
    );
  }
  try {
    const root = await realpath(path);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    await access(root, constants.R_OK);
    return { root };
  } catch {
    throw new DomainError(stableError("INVALID_WORKSPACE", undefined, { retryable: false }));
  }
}

async function resolveContainedPath(
  workspace: ResolvedWorkspace,
  base: string,
  requestedPath: string,
): Promise<string> {
  const lexical = resolve(base, requestedPath);
  if (!isAbsolute(requestedPath) && !isContained(workspace.root, lexical)) {
    throwWorkspace("PATH_OUTSIDE_WORKSPACE", "A requested path is outside the workspace.");
  }
  try {
    const canonical = await realpath(lexical);
    if (!isContained(workspace.root, canonical)) {
      throwWorkspace("PATH_OUTSIDE_WORKSPACE", "A requested path resolves outside the workspace.");
    }
    return canonical;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      stableError("INVALID_REQUEST", "A requested path does not exist or cannot be read.", {
        retryable: false,
      }),
    );
  }
}

async function collectDirectory(
  workspace: ResolvedWorkspace,
  directory: string,
  candidates: Candidate[],
  manifests: ContextManifestEntry[],
  visited: Set<string>,
): Promise<void> {
  if (visited.has(directory)) return;
  visited.add(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const lexical = resolve(directory, entry.name);
    const relativePath = portablePath(relative(workspace.root, lexical));
    if (isSensitive(relativePath)) {
      enforceItemLimit(candidates, manifests);
      manifests.push(omitted(relativePath, 0, "sensitive_or_excluded_path"));
      continue;
    }
    const canonical = await resolveContainedPath(workspace, directory, entry.name);
    const metadata = await stat(canonical);
    if (metadata.isDirectory()) {
      await collectDirectory(workspace, canonical, candidates, manifests, visited);
    } else if (metadata.isFile()) {
      enforceItemLimit(candidates, manifests);
      candidates.push({ absolutePath: canonical, relativePath });
    }
  }
}

async function collectCandidates(
  workspace: ResolvedWorkspace,
  cwd: string,
  paths: string[],
): Promise<{ candidates: Candidate[]; manifests: ContextManifestEntry[] }> {
  const candidates: Candidate[] = [];
  const manifests: ContextManifestEntry[] = [];
  const visited = new Set<string>();
  for (const requestedPath of paths) {
    const canonical = await resolveContainedPath(workspace, cwd, requestedPath);
    const relativePath = portablePath(relative(workspace.root, canonical));
    if (isSensitive(relativePath)) {
      throw new DomainError(
        stableError("SENSITIVE_PATH", "An explicitly requested path is sensitive or excluded.", {
          retryable: false,
        }),
      );
    }
    const metadata = await stat(canonical);
    if (metadata.isDirectory()) {
      await collectDirectory(workspace, canonical, candidates, manifests, visited);
    } else if (metadata.isFile()) {
      enforceItemLimit(candidates, manifests);
      candidates.push({ absolutePath: canonical, relativePath });
    } else {
      throw new DomainError(
        stableError("INVALID_REQUEST", "A requested path is not a regular file or directory.", {
          retryable: false,
        }),
      );
    }
  }
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) unique.set(candidate.absolutePath, candidate);
  return {
    candidates: [...unique.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    manifests,
  };
}

async function readBounded(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeText(buffer: Buffer): string | null {
  if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function readCandidate(
  candidate: Candidate,
  remainingCharacters: number,
): Promise<{ manifest: ContextManifestEntry; content: string | null }> {
  const metadata = await stat(candidate.absolutePath);
  const buffer = await readBounded(candidate.absolutePath, MAX_FILE_BYTES);
  const text = decodeText(buffer);
  if (text === null) {
    return {
      manifest: omitted(candidate.relativePath, metadata.size, "binary_or_invalid_utf8"),
      content: null,
    };
  }
  const fileLimited = text.slice(0, MAX_FILE_CHARACTERS);
  const included = fileLimited.slice(0, Math.max(0, remainingCharacters));
  const truncated =
    buffer.length > MAX_FILE_BYTES ||
    text.length > MAX_FILE_CHARACTERS ||
    included.length < fileLimited.length;
  if (included.length === 0 && text.length > 0) {
    return {
      manifest: omitted(candidate.relativePath, metadata.size, "aggregate_input_limit"),
      content: null,
    };
  }
  return {
    manifest: {
      relative_path: portablePath(candidate.relativePath),
      byte_count: metadata.size,
      sha256: digest(included),
      truncated,
      omitted: false,
      reason: truncated ? "file_or_aggregate_input_limit" : null,
    },
    content: included,
  };
}

async function gitDiff(
  workspace: ResolvedWorkspace,
  cwd: string,
  maximumCharacters: number,
  signal?: AbortSignal,
): Promise<{
  manifests: ContextManifestEntry[];
  section: { relativePath: string; content: string } | null;
}> {
  try {
    const options = {
      cwd,
      encoding: "utf8" as const,
      maxBuffer: MAX_DIFF_BYTES,
      timeout: 5_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      ...(signal === undefined ? {} : { signal }),
    };
    const namesResult = await execFileAsync(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ".",
      ],
      options,
    );
    const names = namesResult.stdout.split("\0").filter(Boolean).sort();
    const safeNames = names.filter((name) => !isSensitive(name));
    const cwdRelative = portablePath(relative(workspace.root, cwd));
    const excludedManifests = names
      .filter((name) => isSensitive(name))
      .map((name) =>
        omitted(
          cwdRelative.length === 0 ? name : `${cwdRelative}/${name}`,
          0,
          "sensitive_or_excluded_diff_path",
        ),
      );
    if (safeNames.length === 0) {
      return {
        manifests: [
          ...excludedManifests,
          {
            relative_path: ".git-diff",
            byte_count: 0,
            sha256: EMPTY_DIGEST,
            truncated: false,
            omitted: false,
            reason: null,
          },
        ],
        section: { relativePath: ".git-diff", content: "" },
      };
    }
    const diffResult = await execFileAsync(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "HEAD",
        "--",
        ...safeNames,
      ],
      options,
    );
    const full = diffResult.stdout;
    const content = full.slice(0, Math.max(0, maximumCharacters));
    if (content.length === 0 && full.length > 0) {
      return {
        manifests: [
          ...excludedManifests,
          omitted(".git-diff", Buffer.byteLength(full), "aggregate_input_limit"),
        ],
        section: null,
      };
    }
    return {
      manifests: [
        ...excludedManifests,
        {
          relative_path: ".git-diff",
          byte_count: Buffer.byteLength(full),
          sha256: digest(content),
          truncated: content.length < full.length,
          omitted: false,
          reason: content.length < full.length ? "aggregate_input_limit" : null,
        },
      ],
      section: { relativePath: ".git-diff", content },
    };
  } catch {
    throw new DomainError(
      stableError("INVALID_REQUEST", "The requested tracked Git diff could not be collected.", {
        retryable: false,
      }),
    );
  }
}

export async function collectContext(options: {
  workspace: ResolvedWorkspace;
  cwd: string;
  paths: string[];
  includeDiff: boolean;
  maximumCharacters: number;
  signal?: AbortSignal;
}): Promise<PackedContext> {
  const cwd = await validateContextSelection({
    workspace: options.workspace,
    cwd: options.cwd,
    paths: options.paths,
  });
  const { candidates, manifests } = await collectCandidates(options.workspace, cwd, options.paths);
  const sections: { relativePath: string; content: string }[] = [];
  let remaining = options.maximumCharacters;
  for (const candidate of candidates) {
    if (options.signal?.aborted) {
      throw new DomainError(stableError("UPSTREAM_TIMEOUT", "The request was cancelled."));
    }
    const item = await readCandidate(candidate, remaining);
    manifests.push(item.manifest);
    if (item.content !== null) {
      sections.push({ relativePath: item.manifest.relative_path, content: item.content });
      remaining -= item.content.length;
    }
  }
  if (options.includeDiff) {
    const item = await gitDiff(options.workspace, cwd, remaining, options.signal);
    manifests.push(...item.manifests);
    if (item.section !== null) sections.push(item.section);
  }
  manifests.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  sections.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    manifest: manifests,
    sections,
    truncated: manifests.some((entry) => entry.truncated || entry.omitted),
    warnings: manifests
      .filter((entry) => entry.truncated || entry.omitted)
      .map((entry) => `Context item ${entry.relative_path} was truncated or omitted.`),
  };
}

export async function validateContextSelection(options: {
  workspace: ResolvedWorkspace;
  cwd: string;
  paths: string[];
}): Promise<string> {
  if (!isAbsolute(options.cwd)) {
    throw new DomainError(
      stableError("INVALID_WORKSPACE", "The delegation cwd must be absolute.", {
        retryable: false,
      }),
    );
  }
  const cwd = await resolveContainedPath(options.workspace, options.workspace.root, options.cwd);
  const cwdMetadata = await stat(cwd);
  if (!cwdMetadata.isDirectory()) {
    throw new DomainError(
      stableError("INVALID_WORKSPACE", "The delegation cwd must be a directory.", {
        retryable: false,
      }),
    );
  }
  await collectCandidates(options.workspace, cwd, options.paths);
  return cwd;
}
