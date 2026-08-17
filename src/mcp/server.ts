import { McpServer } from "@modelcontextprotocol/server";
import {
  DelegateInputSchema,
  DelegateResultSchema,
  StatusInputSchema,
  StatusResultSchema,
} from "../contracts.js";
import { DelegationService } from "../delegation.js";
import { StatusService } from "../service.js";

export const STATUS_TOOL_NAME = "local_llm_status";
export const DELEGATE_TOOL_NAME = "local_llm_delegate";

function statusText(ok: boolean, selectedBackend: string | null, model: string | null): string {
  if (!ok)
    return "No requested local LLM backend is ready. See the structured error and startup hint.";
  return `Local LLM backend ${selectedBackend ?? "unknown"} is ready${model ? ` with ${model}` : ""}.`;
}

export function createMcpServer(service: StatusService, delegation?: DelegationService): McpServer {
  const server = new McpServer(
    { name: "local-mlx-delegate", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only local LLM consultation. Status is diagnostic-only. Delegation reads only explicitly requested workspace paths or an explicitly requested tracked Git diff, treats repository text as untrusted data, and returns advisory output for verification. This server never edits files or starts, stops, loads, unloads, or otherwise changes backend/model lifecycle state.",
    },
  );

  server.registerTool(
    STATUS_TOOL_NAME,
    {
      title: "Local LLM Status",
      description:
        "Probe configured local controller, worker tunnel, and cluster endpoints without changing model lifecycle state.",
      inputSchema: StatusInputSchema,
      outputSchema: StatusResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ backend }) => {
      const status = await service.status({ backend, command: STATUS_TOOL_NAME });
      return {
        content: [
          {
            type: "text",
            text: statusText(status.ok, status.selected_backend, status.model?.id ?? null),
          },
        ],
        structuredContent: status,
        isError: !status.ok,
      };
    },
  );

  if (delegation !== undefined) {
    server.registerTool(
      DELEGATE_TOOL_NAME,
      {
        title: "Delegate to Local LLM",
        description:
          "Send a bounded advisory task and explicitly selected repository context to an already-running local model. The tool is read-only and never performs lifecycle actions.",
        inputSchema: DelegateInputSchema,
        outputSchema: DelegateResultSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input, context) => {
        const result = await delegation.delegate(input, {
          command: DELEGATE_TOOL_NAME,
          signal: context.mcpReq.signal,
        });
        return {
          content: [
            {
              type: "text",
              text: result.ok
                ? `Local advisory result from ${result.backend ?? "unknown"}/${result.model?.id ?? "unknown"}:\n${result.answer ?? ""}`
                : `Local delegation failed: ${result.error?.message ?? "Unknown error."}`,
            },
          ],
          structuredContent: result,
          isError: !result.ok,
        };
      },
    );
  }

  return server;
}
