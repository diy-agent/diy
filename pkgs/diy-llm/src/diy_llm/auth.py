"""diy-llm auth — credential management.

Pure logic layer shared by CLI and GUI. No UI/print/sys.exit.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

DIYM_HOME = Path.home() / ".diy-llm"
AUTH_FILE = DIYM_HOME / "auth.json"


def load_dotenv(path: Path | None = None) -> None:
    """Load ~/.diy-llm/.env into os.environ, matching Hermes convention."""
    env_file = path or (DIYM_HOME / ".env")
    if not env_file.is_file():
        return
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value


def load_auth() -> dict[str, Any]:
    if AUTH_FILE.is_file():
        with open(AUTH_FILE) as f:
            return json.load(f)
    return {"version": 1, "credential_pool": {}}


def save_auth(auth: dict[str, Any]) -> None:
    from .core import ensure_dirs
    ensure_dirs()
    with open(AUTH_FILE, "w") as f:
        json.dump(auth, f, indent=2, ensure_ascii=False)
        f.write("\n")


def fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16]


def resolve_api_key(cred: dict[str, Any]) -> str | None:
    source = cred.get("source", "")
    if source.startswith("env:"):
        return os.environ.get(source[4:])
    return None


def get_active_credential(name: str) -> dict[str, Any] | None:
    auth = load_auth()
    pool = auth.get("credential_pool", {}).get(name, [])
    if not pool:
        return None
    ok = [c for c in pool if c.get("last_status") == "ok"]
    candidates = ok if ok else pool
    candidates.sort(key=lambda c: c.get("priority", 999))
    return candidates[0] if candidates else pool[0]
