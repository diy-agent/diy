"""diy-llm -- Tencent Cloud LLM via LiteLLM.

Provides a Python API and CLI for calling Tencent Cloud's tokenhub
(endpoint: https://tokenhub.tencentmaas.com/v1/chat/completions).

Quick start:
    export TENCENTCLOUD_LLM_SECRET_ID="your-api-key"

    # Python API
    from diy_llm import get_completion
    resp = get_completion("deepseek-v4-pro", [
        {"role": "user", "content": "你好"}
    ])
    print(resp.choices[0].message.content)

    # CLI
    diy-llm chat deepseek-v4-pro "你好"
"""

from __future__ import annotations

from .client import get_api_key, get_completion, get_completion_async

__all__ = [
    "get_api_key",
    "get_completion",
    "get_completion_async",
]
