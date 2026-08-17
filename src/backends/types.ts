import type { BackendDefinition } from "../config.js";
import type { BackendName, ConfiguredBackendStatus } from "../contracts.js";

export type ProbeRequest = {
  backend: BackendName;
  definition: BackendDefinition;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
};

export type BackendProbe = {
  probe(request: ProbeRequest): Promise<ConfiguredBackendStatus>;
};

export type CompletionRequest = {
  backend: BackendName;
  definition: BackendDefinition;
  model: string;
  systemPrompt: string;
  prompt: string;
  maxOutputTokens: number;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  signal?: AbortSignal;
};

export type CompletionAdapter = {
  complete(request: CompletionRequest): Promise<string>;
};
