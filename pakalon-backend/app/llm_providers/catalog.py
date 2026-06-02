"""Provider + model catalog.

Static catalog (no network needed) describing 40+ LLM providers and
their models with capability tags so the CLI can auto-select.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Flag, auto
from typing import Any


class ModelCapability(Flag):
    CHAT = auto()
    TOOLS = auto()
    VISION = auto()
    JSON = auto()
    STREAM = auto()
    REASONING = auto()
    LONG_CONTEXT = auto()
    IMAGE_IN = auto()
    IMAGE_OUT = auto()
    AUDIO = auto()


@dataclass(slots=True)
class ProviderModel:
    id: str
    name: str
    context: int = 8000
    capabilities: ModelCapability = ModelCapability.CHAT | ModelCapability.STREAM
    cost_input: float = 0.0   # USD / 1M tokens
    cost_output: float = 0.0  # USD / 1M tokens


@dataclass(slots=True)
class Provider:
    id: str
    name: str
    base_url: str = ""
    api_style: str = "openai"  # openai | anthropic | google | cohere | mistral | ollama
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    models: list[ProviderModel] = field(default_factory=list)
    api_key_env: str = ""


def _cap(*flags: ModelCapability) -> ModelCapability:
    out = ModelCapability(0)
    for f in flags:
        out |= f
    return out


PROVIDERS: list[Provider] = [
    Provider("openai", "OpenAI", "https://api.openai.com/v1", "openai", api_key_env="OPENAI_API_KEY", models=[
        ProviderModel("gpt-5.5", "GPT-5.5", 2_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN, ModelCapability.AUDIO)),
        ProviderModel("gpt-5.4", "GPT-5.4", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("gpt-5.4-mini", "GPT-5.4 mini", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("gpt-5.2", "GPT-5.2", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("gpt-5.2-codex", "GPT-5.2 Codex", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("gpt-5.3-codex", "GPT-5.3 Codex", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("gpt-5-mini", "GPT-5 mini", 500_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("gpt-4.1", "GPT-4.1", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT)),
        ProviderModel("gpt-4o", "GPT-4o", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.IMAGE_IN, ModelCapability.AUDIO)),
        ProviderModel("gpt-4o-mini", "GPT-4o mini", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("gpt-3.5-turbo", "GPT-3.5 Turbo", 16_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("anthropic", "Anthropic", "https://api.anthropic.com/v1", "anthropic", api_key_env="ANTHROPIC_API_KEY", models=[
        ProviderModel("claude-opus-4.8", "Claude Opus 4.8", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("claude-opus-4.7", "Claude Opus 4.7", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("claude-opus-4.5", "Claude Opus 4.5", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("claude-sonnet-4.6", "Claude Sonnet 4.6", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("claude-sonnet-4.5", "Claude Sonnet 4.5", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("claude-haiku-4.5", "Claude Haiku 4.5", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("google", "Google AI", "https://generativelanguage.googleapis.com/v1beta", "google", api_key_env="GOOGLE_API_KEY", models=[
        ProviderModel("gemini-3.5-flash", "Gemini 3.5 Flash", 2_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN, ModelCapability.AUDIO)),
        ProviderModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", 2_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN, ModelCapability.AUDIO)),
        ProviderModel("gemini-3-flash-preview", "Gemini 3 Flash Preview", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN, ModelCapability.AUDIO)),
        ProviderModel("gemini-2.5-pro", "Gemini 2.5 Pro", 2_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN, ModelCapability.AUDIO)),
    ]),
    Provider("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openai", api_key_env="OPENROUTER_API_KEY", models=[
        ProviderModel("openrouter/auto", "OpenRouter Auto", 2_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
    ]),
    Provider("together", "Together AI", "https://api.together.xyz/v1", "openai", api_key_env="TOGETHER_API_KEY", models=[
        ProviderModel("together/llama-3-70b", "Llama 3 70B (Together)", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("together/mixtral-8x22b", "Mixtral 8x22B (Together)", 65_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("groq", "Groq", "https://api.groq.com/openai/v1", "openai", api_key_env="GROQ_API_KEY", models=[
        ProviderModel("groq/llama-3.3-70b", "Llama 3.3 70B (Groq)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("groq/mixtral-8x7b", "Mixtral 8x7B (Groq)", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("fireworks", "Fireworks", "https://api.fireworks.ai/inference/v1", "openai", api_key_env="FIREWORKS_API_KEY", models=[
        ProviderModel("fireworks/llama-3-70b", "Llama 3 70B (Fireworks)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("mistral", "Mistral AI", "https://api.mistral.ai/v1", "openai", api_key_env="MISTRAL_API_KEY", models=[
        ProviderModel("mistral-large-2", "Mistral Large 2", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("mistral-medium", "Mistral Medium", 32_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("mistral-small", "Mistral Small", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("codestral", "Codestral", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
    ]),
    Provider("cohere", "Cohere", "https://api.cohere.com/v1", "cohere", api_key_env="COHERE_API_KEY", models=[
        ProviderModel("command-r-plus", "Command R+", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("command-r", "Command R", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("perplexity", "Perplexity", "https://api.perplexity.ai", "openai", api_key_env="PERPLEXITY_API_KEY", models=[
        ProviderModel("pplx/sonar-pro", "Sonar Pro", 200_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT)),
        ProviderModel("pplx/sonar", "Sonar", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "openai", api_key_env="DEEPSEEK_API_KEY", models=[
        ProviderModel("deepseek-chat", "DeepSeek Chat", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("deepseek-coder", "DeepSeek Coder", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("deepseek-reasoner", "DeepSeek Reasoner", 128_000, _cap(ModelCapability.CHAT, ModelCapability.STREAM, ModelCapability.REASONING)),
    ]),
    Provider("xai", "xAI (Grok)", "https://api.x.ai/v1", "openai", api_key_env="XAI_API_KEY", models=[
        ProviderModel("grok-3", "Grok 3", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.VISION, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT, ModelCapability.IMAGE_IN)),
        ProviderModel("grok-3-mini", "Grok 3 mini", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
    ]),
    Provider("meta", "Meta (Llama API)", "https://api.meta.ai/v1", "openai", api_key_env="META_API_KEY", models=[
        ProviderModel("llama-3.3-70b", "Llama 3.3 70B", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1", "openai", api_key_env="NVIDIA_API_KEY", models=[
        ProviderModel("nvidia/llama-3.1-70b", "Llama 3.1 70B (NVIDIA)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("nvidia/mistral-large", "Mistral Large (NVIDIA)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("alibaba", "Alibaba DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai", api_key_env="DASHSCOPE_API_KEY", models=[
        ProviderModel("qwen-max", "Qwen Max", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
        ProviderModel("qwen-plus", "Qwen Plus", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("qwen-coder", "Qwen Coder", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
    ]),
    Provider("moonshot", "Moonshot Kimi", "https://api.moonshot.cn/v1", "openai", api_key_env="MOONSHOT_API_KEY", models=[
        ProviderModel("moonshot-v1-128k", "Moonshot v1 128K", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT)),
    ]),
    Provider("zhipu", "Zhipu GLM", "https://open.bigmodel.cn/api/paas/v4", "openai", api_key_env="ZHIPU_API_KEY", models=[
        ProviderModel("glm-4-plus", "GLM-4 Plus", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING)),
    ]),
    Provider("baichuan", "Baichuan", "https://api.baichuan-ai.com/v1", "openai", api_key_env="BAICHUAN_API_KEY", models=[
        ProviderModel("baichuan4", "Baichuan 4", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("minimax", "MiniMax", "https://api.minimax.chat/v1", "openai", api_key_env="MINIMAX_API_KEY", models=[
        ProviderModel("MiniMax-Text-01", "MiniMax-Text-01", 1_000_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.REASONING, ModelCapability.LONG_CONTEXT)),
    ]),
    Provider("stepfun", "StepFun", "https://api.stepfun.com/v1", "openai", api_key_env="STEPFUN_API_KEY", models=[
        ProviderModel("step-2-16k", "Step-2 16K", 16_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("yi", "01.AI Yi", "https://api.lingyiwanwu.com/v1", "openai", api_key_env="YI_API_KEY", models=[
        ProviderModel("yi-large", "Yi Large", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("databricks", "Databricks", "https://<workspace>.databricks.com/serving-endpoints", "openai", api_key_env="DATABRICKS_TOKEN", models=[
        ProviderModel("databricks-dbrx-instruct", "DBRX Instruct", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("replicate", "Replicate", "https://api.replicate.com/v1", "openai", api_key_env="REPLICATE_API_TOKEN", models=[
        ProviderModel("replicate/meta-llama-3-70b", "Llama 3 70B (Replicate)", 8_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("ai21", "AI21", "https://api.ai21.com/studio/v1", "openai", api_key_env="AI21_API_KEY", models=[
        ProviderModel("jamba-1.5-large", "Jamba 1.5 Large", 256_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM, ModelCapability.LONG_CONTEXT)),
    ]),
    Provider("writer", "Writer", "https://api.writer.com/v1", "openai", api_key_env="WRITER_API_KEY", models=[
        ProviderModel("palmyra-x-004", "Palmyra X 004", 128_000, _cap(ModelCapability.CHAT, ModelCapability.TOOLS, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("novita", "Novita AI", "https://api.novita.ai/v3/openai", "openai", api_key_env="NOVITA_API_KEY", models=[
        ProviderModel("novita/llama-3.1-70b", "Llama 3.1 70B (Novita)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("lepton", "Lepton AI", "https://api.lepton.ai/v1", "openai", api_key_env="LEPTON_API_KEY", models=[
        ProviderModel("lepton/llama-3-70b", "Llama 3 70B (Lepton)", 8_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("octoai", "OctoAI", "https://text.octoai.run/v1", "openai", api_key_env="OCTOAI_API_KEY", models=[
        ProviderModel("octoai/llama-3-70b", "Llama 3 70B (OctoAI)", 8_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("anyscale", "Anyscale", "https://api.endpoints.anyscale.com/v1", "openai", api_key_env="ANYSCALE_API_KEY", models=[
        ProviderModel("anyscale/llama-3-70b", "Llama 3 70B (Anyscale)", 16_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("venice", "Venice", "https://api.venice.ai/api/v1", "openai", api_key_env="VENICE_API_KEY", models=[
        ProviderModel("venice/llama-3-70b", "Llama 3 70B (Venice)", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "openai", api_key_env="CEREBRAS_API_KEY", models=[
        ProviderModel("cerebras/llama-3.1-70b", "Llama 3.1 70B (Cerebras)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("sambanova", "SambaNova", "https://api.sambanova.ai/v1", "openai", api_key_env="SAMBANOVA_API_KEY", models=[
        ProviderModel("sambanova/llama-3.1-70b", "Llama 3.1 70B (SambaNova)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("hyperbolic", "Hyperbolic", "https://api.hyperbolic.xyz/v1", "openai", api_key_env="HYPERBOLIC_API_KEY", models=[
        ProviderModel("hyperbolic/llama-3-70b", "Llama 3 70B (Hyperbolic)", 8_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", "openai", api_key_env="DEEPINFRA_API_KEY", models=[
        ProviderModel("deepinfra/llama-3.1-70b", "Llama 3.1 70B (DeepInfra)", 128_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("voyage", "Voyage AI", "https://api.voyageai.com/v1", "openai", api_key_env="VOYAGE_API_KEY", models=[
        ProviderModel("voyage-large-2", "Voyage Large 2 (embeddings)", 32_000, _cap(ModelCapability.STREAM)),
    ]),
    Provider("jina", "Jina AI", "https://api.jina.ai/v1", "openai", api_key_env="JINA_API_KEY", models=[
        ProviderModel("jina-embeddings-v3", "Jina Embeddings v3", 8_000, _cap(ModelCapability.STREAM)),
    ]),
    Provider("lmstudio", "LM Studio", "http://localhost:1234/v1", "openai", auth_header="Authorization", api_key_env="LMSTUDIO_API_KEY", models=[
        ProviderModel("lmstudio/auto", "LM Studio (local)", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("ollama", "Ollama", "http://localhost:11434/v1", "openai", auth_header="Authorization", api_key_env="", models=[
        ProviderModel("ollama/llama3", "Ollama Llama 3", 8_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
        ProviderModel("ollama/qwen2.5-coder", "Ollama Qwen 2.5 Coder", 32_000, _cap(ModelCapability.CHAT, ModelCapability.JSON, ModelCapability.STREAM)),
    ]),
    Provider("custom", "Custom OpenAI-compatible", "http://localhost:8000/v1", "openai", api_key_env="CUSTOM_API_KEY", models=[]),
]


def list_providers() -> list[dict[str, Any]]:
    return [
        {
            "id": p.id,
            "name": p.name,
            "base_url": p.base_url,
            "api_style": p.api_style,
            "api_key_env": p.api_key_env,
            "models": [
                {
                    "id": m.id,
                    "name": m.name,
                    "context": m.context,
                    "capabilities": [c.name for c in ModelCapability if c in m.capabilities],
                }
                for m in p.models
            ],
        }
        for p in PROVIDERS
    ]


def list_models(provider: str | None = None) -> list[dict[str, Any]]:
    if provider is None:
        return [
            {"provider": p.id, **m.__dict__}
            for p in PROVIDERS
            for m in p.models
        ]
    p = next((x for x in PROVIDERS if x.id == provider), None)
    if not p:
        return []
    return [{"provider": p.id, **m.__dict__} for m in p.models]


def get_provider(provider_id: str) -> Provider | None:
    return next((p for p in PROVIDERS if p.id == provider_id), None)


def get_model(provider_id: str, model_id: str) -> ProviderModel | None:
    p = get_provider(provider_id)
    if not p:
        return None
    return next((m for m in p.models if m.id == model_id), None)
