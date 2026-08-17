import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArguments } from "../src/cli.js";
import {
  configureHost,
  HostConfigurationError,
  HostConfigurationResultSchema,
  inspectHostConfiguration,
} from "../src/host-config.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-mlx-host-config-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(join(root, "dist", "cli.js"), 0o755);
  return await realpath(root);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("host configuration", () => {
  it("renders, applies, and reapplies Codex TOML idempotently", async () => {
    const root = await workspace();
    const preview = HostConfigurationResultSchema.parse(
      await configureHost({
        host: "codex",
        workspaceRoot: root,
        apply: false,
        requestId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    expect(preview).toMatchObject({ applied: false, changed: true, backup_path: null });
    expect(preview.content).toContain("[mcp_servers.local-mlx-delegate]");
    expect(preview.content).toContain(`"${root}/dist/cli.js"`);
    expect(preview.content.replaceAll(root, "$ROOT")).toMatchSnapshot();
    await expect(access(preview.target_path, constants.F_OK)).rejects.toThrow();

    const applied = await configureHost({ host: "codex", workspaceRoot: root, apply: true });
    expect(applied).toMatchObject({ applied: true, changed: true, backup_path: null });
    expect(await readFile(applied.target_path, "utf8")).toBe(preview.content);

    const second = await configureHost({ host: "codex", workspaceRoot: root, apply: true });
    expect(second).toMatchObject({ applied: true, changed: false, backup_path: null });
    expect((await inspectHostConfiguration("codex", root)).configured).toBe(true);
  });

  it("preserves unrelated Codex tables and backs up only a changed file", async () => {
    const root = await workspace();
    const target = join(root, ".codex", "config.toml");
    await mkdir(join(root, ".codex"));
    const original = [
      "# keep this comment",
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      '[mcp_servers."local-mlx-delegate"] # stale entry',
      'command = "stale"',
      "args = []",
      "",
    ].join("\n");
    await writeFile(target, original);
    const applied = await configureHost({
      host: "codex",
      workspaceRoot: root,
      apply: true,
      now: new Date("2026-08-16T12:34:56.789Z"),
    });
    expect(applied.backup_path).toBe(`${target}.backup-20260816T123456.789Z`);
    expect(await readFile(applied.backup_path ?? "", "utf8")).toBe(original);
    expect(applied.content).toContain("# keep this comment");
    expect(applied.content).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(applied.content.match(/\[mcp_servers\.local-mlx-delegate\]/gu)).toHaveLength(1);
  });

  it("accepts JSONC and shares one compatible entry between Claude and Copilot CLI", async () => {
    const root = await workspace();
    const target = join(root, ".mcp.json");
    await writeFile(
      target,
      '{\n  // existing project server\n  "mcpServers": {\n    "other": { "type": "stdio", "command": "other", "args": [] },\n  },\n}\n',
    );
    const claude = await configureHost({ host: "claude", workspaceRoot: root, apply: true });
    expect(claude.changed).toBe(true);
    const parsed = JSON.parse(claude.content) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(parsed.mcpServers.other?.command).toBe("other");
    expect(parsed.mcpServers["local-mlx-delegate"]).toEqual({
      type: "stdio",
      command: `${root}/dist/cli.js`,
      args: ["serve", "--workspace-root", root],
      env: {},
    });

    const copilot = await configureHost({
      host: "copilot-cli",
      workspaceRoot: root,
      apply: true,
    });
    expect(copilot).toMatchObject({ changed: false, backup_path: null });
    expect((await inspectHostConfiguration("claude", root)).configured).toBe(true);
    expect((await inspectHostConfiguration("copilot-cli", root)).configured).toBe(true);
  });

  it("uses VS Code's servers root without disturbing unrelated entries", async () => {
    const root = await workspace();
    await mkdir(join(root, ".vscode"));
    await writeFile(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({ inputs: [], servers: { other: { type: "stdio", command: "other" } } }),
    );
    const applied = await configureHost({ host: "vscode", workspaceRoot: root, apply: true });
    const parsed = JSON.parse(applied.content) as {
      inputs: unknown[];
      servers: Record<string, { type: string; command: string }>;
    };
    expect(parsed.inputs).toEqual([]);
    expect(parsed.servers.other?.command).toBe("other");
    expect(parsed.servers["local-mlx-delegate"]?.type).toBe("stdio");
    expect((await inspectHostConfiguration("vscode", root)).configured).toBe(true);
  });

  it("rejects malformed, oversized, and symlinked targets without replacing them", async () => {
    const malformedRoot = await workspace();
    await writeFile(join(malformedRoot, ".mcp.json"), "{ nope");
    await expect(
      configureHost({ host: "claude", workspaceRoot: malformedRoot, apply: true }),
    ).rejects.toBeInstanceOf(HostConfigurationError);
    expect(await readFile(join(malformedRoot, ".mcp.json"), "utf8")).toBe("{ nope");

    const oversizedRoot = await workspace();
    await writeFile(join(oversizedRoot, ".mcp.json"), `{"padding":"${"x".repeat(1_048_576)}"}`);
    await expect(
      configureHost({ host: "claude", workspaceRoot: oversizedRoot, apply: false }),
    ).rejects.toThrow("1 MiB");

    const symlinkRoot = await workspace();
    const outside = join(await workspace(), "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, join(symlinkRoot, ".mcp.json"));
    await expect(
      configureHost({ host: "claude", workspaceRoot: symlinkRoot, apply: true }),
    ).rejects.toThrow("symbolic links");
    expect(await readFile(outside, "utf8")).toBe("{}\n");
  });
});

describe("configure argument parsing", () => {
  it("requires a host and workspace and remains review-first", () => {
    expect(parseArguments(["configure", "codex", "--workspace-root", "/repo"])).toMatchObject({
      command: "configure",
      host: "codex",
      workspaceRoot: "/repo",
      apply: false,
    });
    expect(
      parseArguments(["configure", "vscode", "--workspace-root", "/repo", "--apply", "--json"]),
    ).toMatchObject({ host: "vscode", apply: true, json: true });
    expect(() => parseArguments(["configure", "codex"])).toThrow("--workspace-root");
    expect(() => parseArguments(["configure", "unknown", "--workspace-root", "/repo"])).toThrow(
      "requires codex",
    );
  });
});
