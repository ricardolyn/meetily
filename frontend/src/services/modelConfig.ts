/**
 * Model settings for the in-meeting LLM features (live notes, chat, coach).
 * Mirrors the Rust `live_llm::LlmModelConfig` struct.
 */

import { invoke } from '@tauri-apps/api/core';

export interface LlmModelConfig {
  provider: string;
  model: string;
  api_key?: string;
  ollama_endpoint?: string;
  custom_openai_endpoint?: string;
}

interface SummaryModelConfig {
  provider?: string;
  model?: string;
  apiKey?: string | null;
  ollamaEndpoint?: string | null;
}

interface CustomOpenAIConfig {
  endpoint?: string;
  model?: string;
  apiKey?: string | null;
}

/**
 * Resolve the model configured for saved summaries.
 *
 * @returns The config to send to the LLM commands, or null when no model is
 *   set up yet.
 */
export async function resolveSummaryModelConfig(): Promise<LlmModelConfig | null> {
  const config = await invoke<SummaryModelConfig | null>('api_get_model_config').catch(
    () => null
  );
  if (!config?.provider || !config.model) return null;

  // For custom-openai the endpoint + API key + model live in a separate
  // JSON row, not in api_get_model_config's response.
  if (config.provider === 'custom-openai') {
    const custom = await invoke<CustomOpenAIConfig | null>('api_get_custom_openai_config').catch(
      () => null
    );
    if (!custom?.endpoint || !custom.model) return null;
    return {
      provider: 'custom-openai',
      model: custom.model,
      api_key: custom.apiKey ?? undefined,
      custom_openai_endpoint: custom.endpoint,
    };
  }

  return {
    provider: config.provider,
    model: config.model,
    api_key: config.apiKey ?? undefined,
    ollama_endpoint: config.ollamaEndpoint ?? undefined,
  };
}
