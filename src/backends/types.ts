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

export type CompletionUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type CompletionResult = {
  answer: string;
  usage: CompletionUsage;
};

export type CompletionAdapter = {
  complete(request: CompletionRequest): Promise<CompletionResult>;
};
