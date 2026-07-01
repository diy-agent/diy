"""意图测试共享引擎 — ShellTest 会话 + fake_home 隔离。

ShellTest fixture `sh`：
  - 持久 bash 子进程（PTY）
  - dai 命令通过 _dai_runner 在进程内执行（快，不 spawn uv run）
  - 已激活项目 .venv

fake_home fixture：
  - 独立 $HOME + $DIY_HOME，隔离 ~/.diy/ 数据
  - 自动 symlink 系统目录（.config/.local/.ssh/.cache）
"""

import io
import os
import shlex
import sys
import tempfile
from pathlib import Path

import pytest
from diy.test import ShellTest

_PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def fake_home(monkeypatch):
    """独立 $HOME 目录——需要隔离的测试显式声明。

    ∼ 展开到此目录，dai 数据也存于此。
    自动 symlink .config/.local/.ssh/.cache/.gitconfig 并设 GH_TOKEN。

    ⚠️ 不做 teardown cleanup：fake_home 是 tempfile.mkdtemp，
    即使没有 cleanup 也不会影响真实用户数据。不做 cleanup 是安全策略——
    如果 cleanup 用 '~' 展开路径，在 $HOME 被 monkeypatch 后可能指向
    临时目录，但如果某处代码硬编码了 os.path.expanduser("~") 并在
    teardown 时调 shutil.rmtree，而 $HOME 已被其他 fixture 恢复，就会
    删除真实 HOME 数据。所以 fake_home 故意不 teardown，让 OS 自动清理
    /tmp 下的临时目录。
    """
    tmp = Path(tempfile.mkdtemp(prefix="diy-test-state-"))

    # ════════════════════════════════════════════════════════════════
    # ⚠️ WARNING — 绝对不要在此 fixture 或其使用者里做 teardown cleanup
    #
    # fake_home 用 mkdtemp 创建临时目录，$HOME 被 monkeypatch 指向它。
    # 测试结束后 monkeypatch 恢复 $HOME 到真实用户目录。
    # 如果 teardown 里用 os.path.expanduser("~") 拼路径再 rmtree，
    # 此时 $HOME 已被恢复，rmtree 删的是真实 HOME 数据！
    #
    # 即使 teardown 里用 self._tmp_dir 闭包引用也不行——哪天有个 agent
    # 不小心写了 shutil.rmtree(self._tmp_dir) 但闭包变量名拼错，
    # fallback 到 '' 或 '/' 就完了。
    #
    # 正确做法：不做 teardown。临时目录在 /tmp 下，OS 定期清理。
    # 测试用 fake_home 后直接换新目录，旧目录自然回收。
    # ════════════════════════════════════════════════════════════════

    real = Path.home()

    # symlink 系统目录
    for d in [".config", ".local", ".ssh", ".cache"]:
        src = real / d
        if src.exists():
            (tmp / d).symlink_to(src)
    for f in [".gitconfig"]:
        src = real / f
        if src.exists():
            (tmp / f).symlink_to(src)

    # gh token: 必须设 HOME 之前拿（Keychain 依赖真实 HOME）
    try:
        import subprocess as _sp

        r = _sp.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            monkeypatch.setenv("GH_TOKEN", r.stdout.strip())
    except Exception:
        pass

    monkeypatch.setenv("HOME", str(tmp))
    monkeypatch.setenv("DIY_HOME", str(tmp))

    return tmp


def _dai_runner(args_str: str) -> tuple[int, str, str]:
    """Execute dai CLI in-process, avoiding subprocess overhead.

    Captures stdout/stderr via sys redirection.

    **_HOME 刷新说明（2026-06-23：不再需要）：**

    `_norm()` 已迁移到 `_state.py`，运行时计算 `os.path.expanduser("~")`，
    不缓存模块级 `_HOME`。`_dai_cli.py` 的模块级 `_HOME` 已移除。
    以下刷新仅作兼容保留，后续可删除。
    """
    from diy.cli._dai_cli import app as _dai_app

    # 兼容保留：之前在 _dai_cli.py 的模块级 _HOME 刷新
    # _norm() 迁到 _state.py 后不再需要，但保留几行无害

    args = shlex.split(args_str)
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out_buf, err_buf
    exit_code = 0
    try:
        _dai_app(args)
    except SystemExit as e:
        code = e.code
        exit_code = code if isinstance(code, int) else (0 if code is None else 1)
    finally:
        sys.stdout, sys.stderr = old_out, old_err

    return exit_code, out_buf.getvalue(), err_buf.getvalue()


@pytest.fixture
def sh(monkeypatch):
    """ShellTest 实例，已激活项目 .venv，dai 直接可用。

    Teardown 时自动终止 forward_to_app 启动的 app 子进程（Qt 窗口）。
    """
    import subprocess as _sp_mod

    _app_procs: list[_sp_mod.Popen] = []

    # 拦截 subprocess.Popen 追踪 diy.app.main 启动
    _orig_popen = _sp_mod.Popen

    def _tracked_popen(*args, **kwargs):
        proc = _orig_popen(*args, **kwargs)
        cmd = args[0] if args else kwargs.get("args", [])
        if isinstance(cmd, (list, tuple)) and "diy.app.main" in " ".join(cmd):
            _app_procs.append(proc)
        return proc

    monkeypatch.setattr(_sp_mod, "Popen", _tracked_popen)

    st = ShellTest(
        cwd=_PROJECT,
        init_commands=["source .venv/bin/activate"],
        fast_commands={"dai": _dai_runner},
    )
    yield st

    # ── Teardown：终止测试期间启动的 app 进程 ──
    for proc in _app_procs:
        if proc.poll() is not None:
            continue  # 已自然退出
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass  # 尽力清理
