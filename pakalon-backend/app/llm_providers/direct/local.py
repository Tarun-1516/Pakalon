"""Local & custom OpenAI-compatible providers (Ollama, LM Studio, custom)."""
from __future__ import annotations

from typing import Optional

from .openai_compat import OpenAIDirectProvider, _make_oai_compatible


# Ollama exposes an OpenAI-compatible endpoint at /v1 by default.
_make_oai_compatible("ollama", "http://localhost:11434/v1", "ollama/llama3")

# LM Studio likewise exposes /v1.
_make_oai_compatible("lmstudio", "http://localhost:1234/v1", "lmstudio/auto")


@_make_oai_compatible
class _Custom:
    pass


# A "custom" OpenAI-compatible provider whose endpoint is user-configurable.
class CustomDirectProvider(OpenAIDirectProvider):
    id = "custom"
    default_model = "custom"
    base_url = "http://localhost:8000/v1"

    def __init__(self) -> None:
        super().__init__()
        import os
        self.base_url = os.getenv("CUSTOM_BASE_URL", self.base_url)
        self.default_model = os.getenv("CUSTOM_DEFAULT_MODEL", self.default_model)


# Register the custom provider (the factory wouldn't be able to know the
# env-var-driven base URL at import time).
from .base import register_provider  # noqa: E402
register_provider(CustomDirectProvider)
