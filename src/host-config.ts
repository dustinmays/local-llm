import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { StableErrorSchema } from "./contracts.js";

export const HOST_SERVER_NAME = "local-mlx-delegate";
const MAX_CONFIGURATION_BYTES = 1_048_576;

export const HostNameSchema = z.enum(["codex", "claude", "copilot-cli", "vscode"]);
export type HostName = z.infer<typeof HostNameSchema>;

export const HostConfigurationResultSchema = z
  .object({
    request_id: z.uuid(),
    ok: z.boolean(),
    host: HostNameSchema,
    applied: z.boolean(),
    changed: z.boolean(),
    target_path: z.string().min(1),
    backup_path: z.string().min(1).nullable(),
    content: z.string(),
    warnings: z.array(z.string().max(1_024)),
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type HostConfigurationResult = z.infer<typeof HostConfigurationResultSchema>;

export type HostConfigurationInspection = {
  host: HostName;
  targetPath: string;
  exists: boolean;
  configured: boolean;
  message: string;
};

type HostDefinition = {
  relativePath: string;
  format: "codex-toml" | "mcp-json" | "vscode-json";
};

const HOSTS: Record<HostName, HostDefinition> = {
  codex: { relativePath: ".codex/config.toml", format: "codex-toml" },
  claude: { relativePath: ".mcp.json", format: "mcp-json" },
  "copilot-cli": { relativePath: ".mcp.json", format: "mcp-json" },
  vscode: { relativePath: ".vscode/mcp.json", format: "vscode-json" },
};

const HOST_EXECUTABLES: Record<HostName, string> = {
  codex: "codex",
  claude: "claude",
  "copilot-cli": "copilot",
  vscode: "code",
};

export class HostConfigurationError extends Error {
  override name = "HostConfigurationError";
}

export async function discoverHostExecutable(host: HostName): Promise<string | null> {
  const pathValue = process.env.PATH;
  if (pathValue === undefined) return null;
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, HOST_EXECUTABLES[host]);
    try {
      const metadata = await stat(candidate);
      if (!metadata.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH without exposing candidate paths.
    }
  }
  return null;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function safeDate(date: Date): string {
  return date.toISOString().replaceAll(":", "").replaceAll("-", "");
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function canonicalWorkspace(workspaceRoot: string, writable: boolean): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(workspaceRoot));
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    await access(canonical, writable ? constants.R_OK | constants.W_OK : constants.R_OK);
  } catch {
    throw new HostConfigurationError(
      writable
        ? "Workspace root must be a readable, writable directory."
        : "Workspace root must be a readable directory.",
    );
  }
  return canonical;
}

async function existingMetadata(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function ensureSafeTarget(root: string, target: string): Promise<void> {
  if (!within(root, target)) throw new HostConfigurationError("Configuration target is unsafe.");
  const components = relative(root, target).split(sep);
  let cursor = root;
  for (const component of components) {
    cursor = join(cursor, component);
    const metadata = await existingMetadata(cursor);
    if (metadata?.isSymbolicLink()) {
      throw new HostConfigurationError("Configuration paths may not contain symbolic links.");
    }
    if (metadata && cursor !== target && !metadata.isDirectory()) {
      throw new HostConfigurationError("A configuration parent path is not a directory.");
    }
    if (metadata && cursor === target && !metadata.isFile()) {
      throw new HostConfigurationError("The configuration target is not a regular file.");
    }
  }
}

async function compiledEntrypoint(root: string): Promise<string> {
  const candidate = join(root, "dist", "cli.js");
  try {
    const canonical = await realpath(candidate);
    if (!within(root, canonical)) throw new Error("outside workspace");
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error("not a file");
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch {
    throw new HostConfigurationError(
      "The compiled executable is missing or unreadable; run mise run delegate:build.",
    );
  }
}

function serverEntry(entrypoint: string, root: string): Record<string, unknown> {
  return {
    type: "stdio",
    command: entrypoint,
    args: ["serve", "--workspace-root", root],
    env: {},
  };
}

function jsonWithoutComments(content: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
    } else output += character;
  }
  if (blockComment || inString) {
    throw new HostConfigurationError("The host configuration is invalid JSON/JSONC.");
  }
  let normalized = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index] ?? "";
    if (inString) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(output[lookahead] ?? "")) lookahead += 1;
      const nextSignificant = output[lookahead];
      if (nextSignificant === "}" || nextSignificant === "]") continue;
    }
    normalized += character;
  }
  return normalized;
}

function parseJsonConfiguration(content: string): Record<string, unknown> {
  if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) {
    throw new HostConfigurationError("The host configuration exceeds the 1 MiB safety limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonWithoutComments(content));
  } catch (error) {
    if (error instanceof HostConfigurationError) throw error;
    throw new HostConfigurationError("The host configuration is invalid JSON/JSONC.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HostConfigurationError("The host configuration must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function updateJson(
  content: string | null,
  rootKey: "mcpServers" | "servers",
  entry: Record<string, unknown>,
): string {
  const source = content ?? "{}\n";
  const parsed = parseJsonConfiguration(source);
  const existingGroup = parsed[rootKey];
  if (
    existingGroup !== undefined &&
    (typeof existingGroup !== "object" || existingGroup === null || Array.isArray(existingGroup))
  ) {
    throw new HostConfigurationError(`The ${rootKey} field must contain a JSON object.`);
  }
  const group = (existingGroup ?? {}) as Record<string, unknown>;
  if (JSON.stringify(group[HOST_SERVER_NAME]) === JSON.stringify(entry)) return source;
  group[HOST_SERVER_NAME] = entry;
  parsed[rootKey] = group;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function targetTomlHeader(line: string): boolean {
  const closingBracket = line.indexOf("]");
  if (closingBracket < 0) return false;
  const compact = line
    .slice(0, closingBracket + 1)
    .trim()
    .replaceAll('"', "")
    .replaceAll("'", "");
  return (
    compact === `[mcp_servers.${HOST_SERVER_NAME}]` ||
    compact.startsWith(`[mcp_servers.${HOST_SERVER_NAME}.`)
  );
}

function removeTargetTomlTables(content: string): string {
  const lines = content.split(/(?<=\n)/u);
  const retained: string[] = [];
  let removing = false;
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?(?:\r?\n)?$/u.test(line)) {
      removing = targetTomlHeader(line);
    }
    if (!removing) retained.push(line);
  }
  return retained.join("");
}

function renderCodexToml(content: string | null, entrypoint: string, root: string): string {
  if (content !== null && Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) {
    throw new HostConfigurationError("The host configuration exceeds the 1 MiB safety limit.");
  }
  const retained = removeTargetTomlTables(content ?? "");
  const target = [
    `[mcp_servers.${HOST_SERVER_NAME}]`,
    `command = ${tomlString(entrypoint)}`,
    `args = [${["serve", "--workspace-root", root].map(tomlString).join(", ")}]`,
  ].join("\n");
  if (retained.length === 0) return `${target}\n`;
  const separator = retained.endsWith("\n\n") ? "" : retained.endsWith("\n") ? "\n" : "\n\n";
  return `${retained}${separator}${target}\n`;
}

function configuredJson(
  content: string,
  rootKey: "mcpServers" | "servers",
  expected: Record<string, unknown>,
): boolean {
  const parsed = parseJsonConfiguration(content);
  const group = parsed[rootKey];
  if (typeof group !== "object" || group === null || Array.isArray(group)) return false;
  return (
    JSON.stringify((group as Record<string, unknown>)[HOST_SERVER_NAME]) ===
    JSON.stringify(expected)
  );
}

function configuredToml(content: string, entrypoint: string, root: string): boolean {
  const expected = renderCodexToml(content, entrypoint, root);
  return expected === (content.endsWith("\n") ? content : `${content}\n`);
}

async function readExisting(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function durableWrite(
  path: string,
  content: string,
  mode: number,
  exclusive: boolean,
): Promise<void> {
  const handle = await open(path, exclusive ? "wx" : "w", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createBackup(target: string, content: string, date: Date): Promise<string> {
  const stem = `${target}.backup-${safeDate(date)}`;
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? stem : `${stem}-${String(index)}`;
    try {
      await durableWrite(candidate, content, 0o600, true);
      return candidate;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new HostConfigurationError("Could not allocate a unique backup name.");
}

async function atomicReplace(target: string, content: string, mode: number): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${HOST_SERVER_NAME}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await durableWrite(temporary, content, mode, true);
    await rename(temporary, target);
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) throw cleanupError;
    }
    throw error;
  }
}

export type ConfigureHostOptions = {
  host: HostName;
  workspaceRoot: string;
  apply: boolean;
  requestId?: string;
  now?: Date;
};

async function configureHostInternal(
  options: ConfigureHostOptions,
): Promise<HostConfigurationResult> {
  const requestId = options.requestId ?? randomUUID();
  const root = await canonicalWorkspace(options.workspaceRoot, true);
  const entrypoint = await compiledEntrypoint(root);
  const definition = HOSTS[options.host];
  const target = join(root, definition.relativePath);
  await ensureSafeTarget(root, target);
  const existing = await readExisting(target);
  let content: string;
  if (definition.format === "codex-toml") {
    content = renderCodexToml(existing, entrypoint, root);
  } else {
    content = updateJson(
      existing,
      definition.format === "mcp-json" ? "mcpServers" : "servers",
      serverEntry(entrypoint, root),
    );
  }
  const changed = existing !== content;
  let backupPath: string | null = null;
  if (options.apply && changed) {
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await ensureSafeTarget(root, target);
    if (existing !== null)
      backupPath = await createBackup(target, existing, options.now ?? new Date());
    const metadata = await existingMetadata(target);
    await atomicReplace(target, content, metadata === null ? 0o644 : metadata.mode & 0o777);
  }
  return HostConfigurationResultSchema.parse({
    request_id: requestId,
    ok: true,
    host: options.host,
    applied: options.apply,
    changed,
    target_path: target,
    backup_path: backupPath,
    content,
    warnings: [],
    error: null,
  });
}

export async function configureHost(
  options: ConfigureHostOptions,
): Promise<HostConfigurationResult> {
  try {
    return await configureHostInternal(options);
  } catch (error) {
    if (error instanceof HostConfigurationError) throw error;
    throw new HostConfigurationError("The host configuration could not be updated safely.");
  }
}

export async function inspectHostConfiguration(
  host: HostName,
  workspaceRoot: string,
): Promise<HostConfigurationInspection> {
  const root = await canonicalWorkspace(workspaceRoot, false);
  const entrypoint = await compiledEntrypoint(root);
  const definition = HOSTS[host];
  const targetPath = join(root, definition.relativePath);
  await ensureSafeTarget(root, targetPath);
  const content = await readExisting(targetPath);
  if (content === null) {
    return {
      host,
      targetPath,
      exists: false,
      configured: false,
      message: "No project configuration file is present.",
    };
  }
  let configured: boolean;
  try {
    configured =
      definition.format === "codex-toml"
        ? configuredToml(content, entrypoint, root)
        : configuredJson(
            content,
            definition.format === "mcp-json" ? "mcpServers" : "servers",
            serverEntry(entrypoint, root),
          );
  } catch (error) {
    return {
      host,
      targetPath,
      exists: true,
      configured: false,
      message: error instanceof Error ? error.message : "The project configuration is invalid.",
    };
  }
  return {
    host,
    targetPath,
    exists: true,
    configured,
    message: configured
      ? "The project configuration contains the expected local-mlx-delegate entry."
      : "The project configuration does not contain the expected local-mlx-delegate entry.",
  };
}
