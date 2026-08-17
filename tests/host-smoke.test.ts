import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { StatusResultSchema } from "../src/contracts.js";
import {
  discoverHostExecutable,
  inspectHostConfiguration,
  type HostName,
} from "../src/host-config.js";
import { STATUS_TOOL_NAME } from "../src/mcp/server.js";

const run = promisify(execFile);
const enabled = process.env.LOCAL_MLX_DELEGATE_HOST_SMOKE === "1";
const workspaceRoot = process.cwd();

async function nativeDiscovery(host: HostName): Promise<void> {
  const executable = await discoverHostExecutable(host);
  if (executable === null) {
    process.stderr.write(`SKIP ${host}: executable is not installed.\n`);
    return;
  }
  if (host === "vscode") return;
  const arguments_ =
    host === "codex"
      ? ["mcp", "list", "--json"]
      : host === "claude"
        ? ["mcp", "get", "local-mlx-delegate"]
        : ["mcp", "get", "local-mlx-delegate", "--json"];
  const result = await run(executable, arguments_, {
    cwd: workspaceRoot,
    timeout: 20_000,
    maxBuffer: 1_048_576,
  });
  expect(`${result.stdout}${result.stderr}`).toContain("local-mlx-delegate");
}

describe.skipIf(!enabled)("installed host smoke", () => {
  it("is discoverable in each installed host's native project configuration", async () => {
    for (const host of ["codex", "claude", "copilot-cli", "vscode"] as const) {
      const inspection = await inspectHostConfiguration(host, workspaceRoot);
      const executable = await discoverHostExecutable(host);
      if (executable === null) continue;
      expect(inspection.configured, `${host}: ${inspection.message}`).toBe(true);
      await nativeDiscovery(host);
    }
  }, 90_000);

  it("starts the configured stdio command and invokes status without stdout contamination", async () => {
    const transport = new StdioClientTransport({
      command: `${workspaceRoot}/dist/cli.js`,
      args: ["serve", "--workspace-root", workspaceRoot],
      cwd: workspaceRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "local-mlx-host-smoke", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(STATUS_TOOL_NAME);
      const response = await client.callTool({ name: STATUS_TOOL_NAME, arguments: {} });
      StatusResultSchema.parse(response.structuredContent);
    } finally {
      await client.close();
    }
  }, 30_000);
});
