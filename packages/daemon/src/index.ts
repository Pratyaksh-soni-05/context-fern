export const PACKAGE_NAME = "daemon";

export {
  type DaemonInfo,
  daemonInfoPath,
  deleteDaemonInfo,
  readDaemonInfo,
  writeDaemonInfo,
} from "./daemon-info";
export { createWarmEmbedder } from "./embedder";
export {
  type FakeLlmCall,
  FakeLlmClient,
  type FakeLlmResponder,
} from "./fake-llm-client";
export type { StatusResponse, TreeFrond, TreeResponse } from "./handlers";
export {
  OllamaLlmClient,
  type OllamaLlmClientOptions,
} from "./ollama-llm-client";
export type {
  PendingExchange,
  PendingSuggestion,
  ProjectState,
} from "./project-registry";
export { closeAllProjects } from "./project-registry";
export type { PromptResult, Suggestion } from "./prompt-handler";
export { DaemonError } from "./prompt-util";
export type { DaemonHandle, StartDaemonOptions } from "./server";
export { startDaemon, TOKEN_HEADER } from "./server";
export {
  TimeoutRetryLlmClient,
  type TimeoutRetryLlmClientOptions,
} from "./timeout-retry-llm-client";
