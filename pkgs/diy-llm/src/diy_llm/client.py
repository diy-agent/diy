"""Tencent Cloud LLM client via LiteLLM.

Connects to the Tencent Cloud tokenhub API (OpenAI-compatible endpoint)
at https://tokenhub.tencentmaas.com/v1/chat/completions.
"""

from __future__ import annotations

import os
from typing import Any

import litellm
from litellm import completion as litellm_completion
from litellm.types.utils import ModelResponse

DEFAULT_API_BASE = "https://tokenhub.tencentmaas.com"


def get_api_key() -> str:
    """Return the Tencent Cloud LLM API key from environment."""
    key = os.environ.get("TENCENTCLOUD_LLM_SECRET_ID")
    if not key:
        msg = (
            "TENCENTCLOUD_LLM_SECRET_ID is not set. "
            "Please export it or set it in .env / .secrets"
        )
        raise ValueError(msg)
    return key


def get_completion(
    model: str,
    messages: list[dict[str, str]],
    *,
    api_base: str | None = None,
    api_key: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    stream: bool = False,
    **kwargs: Any,
) -> ModelResponse:
    """Send a chat completion request to Tencent Cloud via LiteLLM.

    Args:
        model: Model name, e.g. "deepseek-v4-pro", "deepseek-v4-flash".
        messages: Chat messages in OpenAI format.
        api_base: Custom API base URL. Defaults to tokenhub.tencentmaas.com.
        api_key: API key. Defaults to TENCENTCLOUD_LLM_SECRET_ID env var.
        temperature: Sampling temperature.
        max_tokens: Max tokens in the response.
        stream: Whether to stream the response.
        **kwargs: Additional arguments passed to litellm.completion().

    Returns:
        LiteLLM ModelResponse (metadata + choices).
    """
    key = api_key or get_api_key()
    base = api_base or DEFAULT_API_BASE

    # Use custom_openai provider so LiteLLM sends requests to our base URL
    litellm_model = f"custom_openai/{model}"

    return litellm_completion(
        model=litellm_model,
        messages=messages,
        api_base=base,
        api_key=key,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=stream,
        **kwargs,
    )


async def get_completion_async(
    model: str,
    messages: list[dict[str, str]],
    *,
    api_base: str | None = None,
    api_key: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    stream: bool = False,
    **kwargs: Any,
) -> ModelResponse:
    """Async version of get_completion."""
    key = api_key or get_api_key()
    base = api_base or DEFAULT_API_BASE
    litellm_model = f"custom_openai/{model}"

    from litellm import acompletion

    return await acompletion(
        model=litellm_model,
        messages=messages,
        api_base=base,
        api_key=key,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=stream,
        **kwargs,
    )
