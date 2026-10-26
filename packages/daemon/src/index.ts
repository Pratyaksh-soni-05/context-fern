export const PACKAGE_NAME = "daemon";

export {
  type FakeLlmCall,
  FakeLlmClient,
  type FakeLlmResponder,
} from "./fake-llm-client";
export {
  OllamaLlmClient,
  type OllamaLlmClientOptions,
} from "./ollama-llm-client";
export {
  TimeoutRetryLlmClient,
  type TimeoutRetryLlmClientOptions,
} from "./timeout-retry-llm-client";
