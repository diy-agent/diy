"""diy llm — Cyclopts sub-app: provider model sync → PI agent / Hermes."""

from __future__ import annotations

import json
import os
import sys
from typing import Annotated, Any

from cyclopts import App, Parameter

from . import auth, core, export


def _die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


# ═══════════════════════════════════════════════════════════════════════
# llm App
# ═══════════════════════════════════════════════════════════════════════

llm_app = App(
    name="llm",
    help="LLM provider config sync",
)


# ── sync group ─────────────────────────────────────────────────────────

sync_app = App(name="sync", help="Sync models from provider, export to downstream tools")


@sync_app.command(name="diy")
def sync_diy(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all configured", negative=False)] = None,
):
    """Fetch models from provider, update state file."""
    providers_with_auth = auth.list_providers_with_auth()

    if provider:
        target_names = [provider]
    else:
        target_names = list(providers_with_auth.keys())

    if not target_names:
        _die("No providers with credentials. Run: diy llm auth set <provider> --key $ENV_VAR")

    for name in target_names:
        prov_auth = providers_with_auth.get(name)
        if not prov_auth:
            print(f"⚠  No credential for '{name}'", file=sys.stderr)
            continue

        api_key = auth.resolve_api_key(prov_auth["source"])
        if not api_key:
            print(f"⚠  Cannot resolve {prov_auth['source']} for '{name}'", file=sys.stderr)
            continue

        api_base = prov_auth.get("api_base", "")
        if not api_base:
            ptype_def = core.load_provider_type(name)
            api_base = (ptype_def or {}).get("api", {}).get("default_base", "")

        try:
            state, srcl = core.ensure_state(name, api_base, api_key, name)
            core.save_state(name, state)
            enabled = sum(1 for m in state["models"].values() if m.get("editable", {}).get("enabled", m.get("enabled", True)) and not m.get("stale"))
            total = len(state["models"])
            print(f"✓  {name} ({srcl}): {enabled}/{total} enabled  →  {core.state_path(name)}")
        except RuntimeError as e:
            print(f"✗  {name}: {e}", file=sys.stderr)


@sync_app.command(name="pi")
def sync_pi(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all", negative=False)] = None,
):
    """Sync diy-llm providers to PI agent config (~/.pi/agent/models.json).

    Removes all existing ``diy-*`` provider entries, then writes fresh
    from diy-llm state. PI agent manual edits under ``diy-*`` are lost.
    """
    pi_path = export._find_pi_config()
    config = export.read_pi_config(pi_path)
    old_providers = config.get("providers", {})
    old_diy_count = sum(1 for k in old_providers if k.startswith("diy-"))

    providers_to_sync: list[str] | None = [provider] if provider else None
    new_diy = export.build_pi_providers(providers_to_sync)

    if not new_diy:
        print("No providers to sync. Check credentials and model states.", file=sys.stderr)
        return

    for key in list(config.get("providers", {}).keys()):
        if key.startswith("diy-"):
            del config["providers"][key]
    config["providers"].update(new_diy)

    written = export.write_pi_config(config, pi_path)

    added = len(new_diy)
    print(f"✓  Synced {added} provider(s) to PI agent:")
    for pname in new_diy:
        pdef = new_diy[pname]
        model_count = len(pdef.get("models", []))
        print(f"     {pname:35s}  {pdef['baseUrl']:55s}  {model_count} models")
    if old_diy_count:
        print(f"   (removed {old_diy_count} stale diy-* provider(s))")
    print(f"   →  {written}")


@sync_app.command(name="all")
def sync_all(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all configured", negative=False)] = None,
):
    """Full pipeline: fetch models → sync state → export to PI agent + Hermes.

    Equivalent to running ``diy llm sync diy`` + ``diy llm sync pi`` + Hermes export
    in one pass.
    """
    # ── 1. State sync ──
    providers_with_auth = auth.list_providers_with_auth()

    if provider:
        target_names = [provider]
    else:
        target_names = list(providers_with_auth.keys())

    if not target_names:
        _die("No providers with credentials. Run: diy llm auth set <provider> --key $ENV_VAR")

    synced: list[str] = []
    for name in target_names:
        prov_auth = providers_with_auth.get(name)
        if not prov_auth:
            print(f"⚠  No credential for '{name}'", file=sys.stderr)
            continue

        api_key = auth.resolve_api_key(prov_auth["source"])
        if not api_key:
            print(f"⚠  Cannot resolve {prov_auth['source']} for '{name}'", file=sys.stderr)
            continue

        api_base = prov_auth.get("api_base", "")
        if not api_base:
            ptype_def = core.load_provider_type(name)
            api_base = (ptype_def or {}).get("api", {}).get("default_base", "")

        try:
            state, srcl = core.ensure_state(name, api_base, api_key, name)
            core.save_state(name, state)
            enabled = sum(1 for m in state["models"].values() if m.get("editable", {}).get("enabled", m.get("enabled", True)) and not m.get("stale"))
            total = len(state["models"])
            print(f"✓  {name} ({srcl}): {enabled}/{total} enabled  →  {core.state_path(name)}")
            synced.append(name)
        except RuntimeError as e:
            print(f"✗  {name}: {e}", file=sys.stderr)

    if not synced:
        return

    # ── 2. PI agent export ──
    new_pi = export.build_pi_providers(synced)
    if new_pi:
        pi_path = export._find_pi_config()
        pi_config = export.read_pi_config(pi_path)
        for key in list(pi_config.get("providers", {}).keys()):
            if key.startswith("diy-"):
                del pi_config["providers"][key]
        pi_config["providers"].update(new_pi)
        written_pi = export.write_pi_config(pi_config, pi_path)
        pi_count = len(new_pi)
        print(f"✓  PI agent: {pi_count} provider(s)  →  {written_pi}")
    else:
        print("   PI agent: no providers to export", file=sys.stderr)

    # ── 3. Hermes export ──
    new_hermes = export.build_hermes_providers(synced)
    if new_hermes:
        merged = export.merge_hermes_custom_providers(new_hermes)
        written_hermes = export.write_hermes_config(merged)
        hermes_count = len(new_hermes)
        print(f"✓  Hermes: {hermes_count} provider(s)  →  {written_hermes}")
    else:
        print("   Hermes: no providers to export", file=sys.stderr)


llm_app.command(sync_app)


# ── auth group ────────────────────────────────────────────────────────

auth_app = App(name="auth", help="Manage credentials")


@auth_app.command(name="set")
def set_cred(
    provider: Annotated[str, Parameter(help="Provider name (e.g. tencent-tokenhub)")],
    key: Annotated[str, Parameter(help="API key value or $ENV_VAR")],
    base_url: Annotated[str | None, Parameter(help="Override default api_base")] = None,
):
    """Register a credential (idempotent) and sync models immediately."""
    ptype_def = core.load_provider_type(provider)
    if not ptype_def:
        available = ", ".join(sorted(core.discover_provider_types()))
        _die(f"Unknown provider '{provider}'. Available: {available}")

    if not key:
        _die(f"Missing --key. Usage: diy llm auth set {provider} --key $ENV_VAR")

    if key.startswith("$"):
        env_name = key[1:]
        source = f"env:{env_name}"
        actual_key = os.environ.get(env_name, "")
        if not actual_key:
            _die(f"Environment variable {env_name} is not set")
    else:
        env_name = f"{provider.upper().replace('-','_')}_KEY"
        source = f"env:{env_name}"
        actual_key = key
        # ── read-modify-write .env to preserve existing keys ──
        env_path = core.DIYM_HOME / ".env"
        env_path.parent.mkdir(parents=True, exist_ok=True)
        entries: dict[str, str] = {}
        if env_path.is_file():
            for line in env_path.read_text().splitlines():
                line_stripped = line.strip()
                if "=" in line_stripped and not line_stripped.startswith("#"):
                    k, _, v = line_stripped.partition("=")
                    entries[k.strip()] = v.strip()
        entries[env_name] = actual_key
        content = "\n".join(f"{k}={v}" for k, v in sorted(entries.items()))
        if content:
            content += "\n"
        env_path.write_text(content)
        os.environ[env_name] = actual_key

    api_base = base_url or (ptype_def.get("api", {}).get("default_base", ""))

    auth.set_provider_auth(provider, source, api_base)

    print(f"✓  Credential set for '{provider}'")
    print(f"   source:  {source}")
    print(f"   base:    {api_base}")

    print()
    try:
        state, srcl = core.ensure_state(provider, api_base, actual_key, provider)
        core.save_state(provider, state)
        enabled = sum(1 for m in state["models"].values() if m.get("editable", {}).get("enabled", m.get("enabled", True)) and not m.get("stale"))
        print(f"✓  Initial sync ({srcl}): {enabled} models enabled")
    except RuntimeError as e:
        print(f"⚠  Sync failed: {e}", file=sys.stderr)
        print(f"   Credential saved. Run 'diy llm sync {provider}' when ready.", file=sys.stderr)


@auth_app.command(name="list")
def list_cred():
    """List all credentials."""
    providers = auth.list_providers_with_auth()
    if not providers:
        print("No credentials. Use: diy llm auth set ...")
        return
    for pname, pauth in providers.items():
        api_base = pauth.get("api_base", "?")
        print(f"  {pname:30s}  {pauth['source']}  →  {api_base}")


@auth_app.command(name="show")
def show_cred(
    provider: Annotated[str, Parameter(help="Provider name")],
):
    """Show credential details."""
    prov_auth = auth.get_provider_auth(provider)
    if not prov_auth:
        _die(f"No credential for '{provider}'")
    print(json.dumps(prov_auth, indent=2, ensure_ascii=False))


@auth_app.command(name="remove")
def remove_cred(
    provider: Annotated[str, Parameter(help="Provider name")],
):
    """Remove a credential."""
    if not auth.get_provider_auth(provider):
        _die(f"No credential for '{provider}'")
    auth.remove_provider_auth(provider)
    print(f"✓  Credential removed for '{provider}'.")


llm_app.command(auth_app)


# ── model group ───────────────────────────────────────────────────────

model_app = App(name="model", help="Manage models per provider")


@model_app.command(name="list")
def list_models(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all", negative=False)] = None,
):
    """List models and their status."""
    if provider:
        models = core.list_models(provider)
        if not models:
            print(f"No models for '{provider}'. Run sync first.")
            return
        print(f"Models for {provider}:")
        for mid, m in sorted(models.items()):
            _print_model(mid, m, provider_name=provider)
        return

    providers = auth.list_providers_with_auth()
    for pname in sorted(providers):
        models = core.list_models(pname)
        if not models:
            continue
        print(f"\n[{pname}]")
        for mid, m in sorted(models.items()):
            _print_model(mid, m, provider_name=pname)


def _print_model(mid: str, m: dict[str, Any], provider_name: str | None = None) -> None:
    editable = m.get("editable", {})
    status = m.get("status", "ok")
    stale = " (stale)" if m.get("stale") else ""
    error = m.get("error")
    if isinstance(error, dict) and error.get("code") == "MODEL_DEPRECATED":
        status_str = "⚠ 废弃"
    elif status == "error":
        status_str = "✗ error"
    elif status == "exhausted":
        status_str = "⚠ exhausted"
    elif editable.get("enabled", False) if editable else m.get("enabled", True):
        status_str = "✓"
    else:
        status_str = "✗ disabled"
    label = mid
    if provider_name:
        ptype_def = core.load_provider_type(provider_name)
        if ptype_def:
            meta = ptype_def.get("models", {}).get(mid, {})
            label = meta.get("label", mid)
    print(f"  {status_str}  {mid:35s}  {label}{stale}")


@model_app.command(name="clean")
def clean_models(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all", negative=False)] = None,
):
    """Remove MODEL_DEPRECATED models from state."""
    providers_with_auth = auth.list_providers_with_auth()
    target_names = [provider] if provider else list(providers_with_auth.keys())

    for name in target_names:
        removed = core.clean_models(name)
        if removed:
            print(f"✓  {name}: removed {len(removed)} deprecated model(s): {', '.join(removed)}")
        else:
            print(f"   {name}: no deprecated models")


llm_app.command(model_app)
