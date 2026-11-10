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
export type {
  FrondBriefResponse,
  SearchResult,
  StatusResponse,
  TreeFrond,
  TreeResponse,
} from "./handlers";
export {
  OllamaLlmClient,
  type OllamaLlmClientOptions,
} from "./ollama-llm-client";
export type {
  PendingExchange,
  PendingSuggestion,
  ProjectState,
} from "./project-registry";
export { closeAllProjects, getOrOpenProject } from "./project-registry";
export type { RecentProject } from "./project-registry-file";
export {
  clearRecentProjects,
  listRecentProjects,
  projectsFilePath,
  resolveProjectPath,
  touchRecentProject,
} from "./project-registry-file";
export type { PromptResult, Suggestion } from "./prompt-handler";
export { DaemonError } from "./prompt-util";
export { SESSION_COOKIE_NAME } from "./protocol";
export type { DaemonHandle, StartDaemonOptions } from "./server";
export { startDaemon, TOKEN_HEADER } from "./server";
export {
  TimeoutRetryLlmClient,
  type TimeoutRetryLlmClientOptions,
} from "./timeout-retry-llm-client";
export { UiSessionStore } from "./ui-session";
