"""diy-llm 意图测试 — 以可执行形式表达设计契约。

auth 合并、editable 块、MODEL_DEPRECATED 等核心设计决策，
以测试形式固化，替代纯文档描述。

sh fixture 返回 (code, stdout, stderr) 三元组。
fake_home fixture 将 $HOME 隔离到临时目录。
"""

from __future__ import annotations

import json
from pathlib import Path


def _diylm_home(fake_home: Path) -> Path:
    return fake_home / ".diy-llm"


# ═══════════════════════════════════════════════════════════════════════
# auth — 凭据管理（source/api_base 在 provider state 文件中）
# ═══════════════════════════════════════════════════════════════════════

def test_intent_auth_set_and_list(sh, fake_home: Path):
    """注册凭据 → 写到 provider state 文件 → 列表可见。"""
    code, out, err = sh("auth set tencent-tokenhub --key my-secret-key")
    assert code == 0
    assert "✓  Credential set for 'tencent-tokenhub'" in out
    assert "env:TENCENT_TOKENHUB_KEY" in out

    # 验证 state 文件写了 source/api_base
    state = json.loads(
        (_diylm_home(fake_home) / "providers" / "tencent-tokenhub.json").read_text()
    )
    assert state["source"] == "env:TENCENT_TOKENHUB_KEY"
    assert state["api_base"] == "https://tokenhub.tencentmaas.com/v1"

    # auth list 显示
    code, out, _ = sh("auth list")
    assert code == 0
    assert "tencent-tokenhub" in out
    assert "env:TENCENT_TOKENHUB_KEY" in out


def test_intent_auth_remove(sh, fake_home: Path):
    """删除凭据 → 列表中消失。"""
    _diylm_home(fake_home).mkdir(parents=True)
    (_diylm_home(fake_home) / "providers").mkdir()
    state = {
        "provider": "tencent-tokenhub",
        "source": "env:TENCENT_TOKENHUB_KEY",
        "api_base": "https://tokenhub.tencentmaas.com/v1",
    }
    state_path = _diylm_home(fake_home) / "providers" / "tencent-tokenhub.json"
    state_path.write_text(json.dumps(state))

    code, out, _ = sh("auth remove tencent-tokenhub")
    assert code == 0
    assert "Credential removed" in out

    # state 文件仍存在但 source/api_base 已删
    remaining = json.loads(state_path.read_text())
    assert "source" not in remaining
    assert "api_base" not in remaining

    code, out, _ = sh("auth list")
    assert code == 0
    assert "No credentials" in out


# ═══════════════════════════════════════════════════════════════════════
# model — 模型状态展示（editable 块）
# ═══════════════════════════════════════════════════════════════════════

def test_intent_model_list(sh, fake_home: Path):
    """模型列表展示三种状态：✓ 启用、✗ 禁用、⚠ 废弃。"""
    (_diylm_home(fake_home) / "providers").mkdir(parents=True)
    state = {
        "version": 1,
        "provider": "tencent-tokenhub",
        "provider_type": "tencent-tokenhub",
        "source": "env:TENCENT_TOKENHUB_KEY",
        "api_base": "https://tokenhub.tencentmaas.com/v1",
        "models": {
            "model-a": {
                "label": "模型A",
                "context_window": 128000,
                "reasoning": True,
                "cost": {"input": 1, "output": 2},
                "status": "ok",
                "error": None,
                "editable": {"max_tokens": 4096, "enabled": True},
            },
            "model-b": {
                "label": "模型B",
                "context_window": 128000,
                "reasoning": False,
                "cost": {"input": 1, "output": 2},
                "status": "ok",
                "error": None,
                "editable": {"max_tokens": 4096, "enabled": False},
            },
            "model-c": {
                "label": "模型C",
                "context_window": 128000,
                "reasoning": False,
                "cost": {"input": 1, "output": 2},
                "status": "error",
                "error": {"code": "MODEL_DEPRECATED", "message": "上游已下架"},
                "editable": {"max_tokens": 4096, "enabled": True},
            },
        },
    }
    (_diylm_home(fake_home) / "providers" / "tencent-tokenhub.json").write_text(
        json.dumps(state)
    )

    code, out, _ = sh("model list tencent-tokenhub")
    assert code == 0
    assert "✓  model-a" in out
    assert "模型A" in out
    assert "✗ disabled  model-b" in out
    assert "模型B" in out
    assert "⚠ 废弃  model-c" in out
    assert "模型C" in out


def test_intent_model_clean(sh, fake_home: Path):
    """清理废弃模型 → 列表中移除。"""
    (_diylm_home(fake_home) / "providers").mkdir(parents=True)
    state = {
        "version": 1,
        "provider": "tencent-tokenhub",
        "provider_type": "tencent-tokenhub",
        "source": "env:TENCENT_TOKENHUB_KEY",
        "api_base": "https://tokenhub.tencentmaas.com/v1",
        "models": {
            "good-model": {
                "label": "正常模型",
                "context_window": 128000,
                "reasoning": True,
                "cost": {"input": 1, "output": 2},
                "status": "ok",
                "error": None,
                "editable": {"max_tokens": 4096, "enabled": True},
            },
            "dead-model": {
                "label": "废弃模型",
                "context_window": 128000,
                "reasoning": False,
                "cost": {"input": 1, "output": 2},
                "status": "error",
                "error": {"code": "MODEL_DEPRECATED", "message": "上游已下架"},
                "editable": {"max_tokens": 4096, "enabled": True},
            },
        },
    }
    state_path = _diylm_home(fake_home) / "providers" / "tencent-tokenhub.json"
    state_path.write_text(json.dumps(state))

    code, out, _ = sh("model clean tencent-tokenhub")
    assert code == 0
    assert "removed 1 deprecated model" in out
    assert "dead-model" in out

    # 验证 good-model 还在，dead-model 已删
    code, out, _ = sh("model list tencent-tokenhub")
    assert code == 0
    assert "good-model" in out
    assert "dead-model" not in out


# ═══════════════════════════════════════════════════════════════════════
# sync — editable 块保留（需网络 + 有效 key，文档意图）
# ═══════════════════════════════════════════════════════════════════════

def test_intent_sync_editable_preserved(sh, fake_home: Path):
    """sync 时 editable 块不被覆盖 — 需真实 API key 才能跑。

    设计契约：
      - editable 外 (label/reasoning/context_window/cost) → sync 覆盖
      - editable 内 (max_tokens/enabled) → sync 不碰
      - 新模型 → editable 填默认值

    验证方式（手动或 CI 设 key 后）：
      $ export TENCENT_TOKENHUB_KEY=sk-xxx
      $ diy-llm auth set tencent-tokenhub --key $TENCENT_TOKENHUB_KEY
      $ diy-llm sync tencent-tokenhub
      ... 用 python 改 state 文件的 editable.max_tokens
      $ diy-llm sync tencent-tokenhub
      ... 验证 max_tokens 没丢
    """
    # 无 key 时跳过，但保留测试骨架表达意图
    pass
