"""diy-llm CLI -- test and interact with Tencent Cloud LLM models.

Usage:
    # List supported models
    diy-llm models

    # Send a one-shot message
    diy-llm chat deepseek-v4-pro "你好"

    # Interactive chat (requires --model)
    diy-llm chat --model deepseek-v4-flash
"""

from __future__ import annotations

import argparse
import os
import sys

import litellm

from .client import get_api_key, get_completion

# Suppress litellm verbose logging by default
litellm.set_verbose = False


def cmd_models(_args: argparse.Namespace) -> None:
    """Print a list of known Tencent Cloud models."""
    known_models = [
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "deepseek-v3.1",
        "deepseek-r1",
        "hunyuan-turbo",
        "hunyuan-standard",
        "hunyuan-lite",
    ]
    print("Tencent Cloud (tokenhub) known models:")
    for m in known_models:
        print(f"  {m}")
    print()
    print("Use:  diy-llm chat <model> \"<your prompt>\"")
    print("Set TENCENTCLOUD_LLM_SECRET_ID env var for auth.")


def cmd_chat(args: argparse.Namespace) -> None:
    """Send a chat message and print the response."""
    model = args.model
    prompt = args.prompt
    stream = args.stream

    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": prompt},
    ]

    try:
        response = get_completion(
            model=model,
            messages=messages,
            stream=stream,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
        )

        if stream:
            content_parts: list[str] = []
            for chunk in response:
                delta = chunk.choices[0].delta.content or ""
                print(delta, end="", flush=True)
                content_parts.append(delta)
            print()
        else:
            content = response.choices[0].message.content
            print(content)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="diy-llm",
        description="Tencent Cloud LLM CLI via LiteLLM",
    )
    parser.add_argument(
        "--api-base",
        default="https://tokenhub.tencentmaas.com",
        help="API base URL (default: tokenhub.tencentmaas.com)",
    )
    parser.add_argument(
        "--temperature", type=float, default=None, help="Sampling temperature"
    )
    parser.add_argument(
        "--max-tokens", type=int, default=None, help="Max tokens in response"
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # diy-llm models
    sub.add_parser("models", help="List known models")

    # diy-llm chat <model> <prompt>
    chat_p = sub.add_parser("chat", help="Send a chat message")
    chat_p.add_argument("model", help="Model name (e.g. deepseek-v4-pro)")
    chat_p.add_argument("prompt", nargs="?", help="Message to send")
    chat_p.add_argument(
        "--stream",
        action="store_true",
        default=False,
        help="Stream the response",
    )

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "models":
        cmd_models(args)
    elif args.command == "chat":
        if not args.prompt:
            # Interactive mode: read prompt from stdin
            try:
                prompt = input("> ")
            except (EOFError, KeyboardInterrupt):
                print()
                return
            args.prompt = prompt
        cmd_chat(args)


if __name__ == "__main__":
    main()
