/**
 * Provider catalog CLI: 40+ LLM providers, models, capabilities.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const listProviders = tool({
  description: "List all available LLM providers.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/llm-providers"));
  },
});

export const getProvider = tool({
  description: "Get details of a specific provider.",
  args: { provider_id: tool.schema.string() },
  async execute({ provider_id }) {
    return JSON.stringify(await backendFetch(`/llm-providers/${provider_id}`));
  },
});

export const getModel = tool({
  description: "Get details of a specific model.",
  args: {
    provider_id: tool.schema.string(),
    model_id: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch(`/llm-providers/${args.provider_id}/models/${args.model_id}`),
    );
  },
});

export const listAllModels = tool({
  description: "List all models across all providers.",
  args: { provider: tool.schema.string().optional() },
  async execute({ provider }) {
    const q = provider ? `?provider=${provider}` : "";
    return JSON.stringify(await backendFetch(`/llm-providers/models/all${q}`));
  },
});

export const listImageModels = tool({
  description: "List available image generation models.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/image-models"));
  },
});
