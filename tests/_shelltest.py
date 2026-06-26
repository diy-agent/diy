"""ShellTest — PTY-based shell session factory and session engine.

ShellTest is a factory/builder — it holds configuration but does NOT
open a bash process until you call .session() or .assert_session().

Usage:
    # One-shot intent test (auto open/close)
    sh = ShellTest(cwd="/tmp")
    sh.assert_session("! echo hello\\nhello")

    # Stateful multi-command session
    with ShellTest(cwd="/tmp").session() as s:
        s.run("export X=1")
        s.run("echo $X")

    # Fixture pattern
    #   @pytest.fixture
    #   def sh():
    #       return ShellTest(cwd="/tmp")
    #   def test_xxx(sh):
    #       sh.assert_session("...")
"""

from __future__ import annotations

import os
import re
import select
import subprocess
import time
from collections.abc import Callable

_log = __import__("logging").getLogger("shelltest")

# ── Session: the actual bash process ──


class Session:
    """持久 bash 进程（PTY + stderr pipe），退出码捕获，实时 cwd 查询。

    不要直接构造——通过 ShellTest().session() 获取。

    >>> s = ShellTest(cwd="/tmp").session()
    >>> s.cwd
    '/private/tmp'
    >>> code, out, err = s.run("echo hello")
    >>> code
    0
    >>> out
    'hello'
    >>> s.close()
    """

    def __init__(
        self,
        shell: str = "bash",
        cwd: str | None = None,
        ps1_prefix: str = "",
        fast_commands: dict[str, Callable[[str], tuple[int, str, str] | None]]
        | None = None,
    ):
        self._marker = f"__ST_{os.urandom(4).hex()}__"
        # 不锚定行首——ps1_prefix 可能出现 marker 前面
        self._pat = re.compile(rf"{re.escape(self._marker)}\((\d+)\)__")
        self._fast_commands = fast_commands or {}
        self._cwd_init = cwd
        master_fd, slave_fd = os.openpty()
        self._master_fd = master_fd

        err_r, err_w = os.pipe()
        self._err_fd = err_r

        # --norc: 不加载 ~/.bashrc，防止用户密钥/env 泄露到测试输出
        args = [shell]
        if os.path.basename(shell) in ("bash", "sh"):
            args.append("--norc")
        args.append("-i")

        self._proc = subprocess.Popen(
            args,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=err_w,
            cwd=cwd,
            close_fds=True,
        )
        os.close(slave_fd)
        os.close(err_w)

        # Write setup commands immediately, so the first _read sees the PS1 marker.
        # This avoids a quiet-timeout fallback — marker detection exits in ~0.05 s.
        ps1 = f"{ps1_prefix}{self._marker}($?)__ "
        self._write(f"PS1='{ps1}'")
        self._write('bind "set enable-bracketed-paste off" 2>/dev/null')
        self._write("readonly PS1")

        # Single _read: eats bash startup output + setup echo + first PS1 (marker)
        self._read()

    # ── 底层 IO ──

    def _write(self, cmd: str) -> None:
        try:
            os.write(self._master_fd, (cmd + "\n").encode())
        except (OSError, ValueError):
            _log.debug("_write 异常（子进程已退出）", exc_info=True)

    def _read(self, timeout: float = 12.0, quiet: float = 0.3) -> tuple[str, str]:
        out_buf = b""
        err_buf = b""
        last_data = time.time()
        end = time.time() + timeout
        fds = [self._master_fd, self._err_fd]
        marker_found = False

        while time.time() < end:
            now = time.time()

            # Marker in stderr (PS1) → command done, drain remaining stdout
            if marker_found and now - last_data >= 0.05:
                break
            # No marker → wait for quiet silence, then give up
            if not marker_found and now - last_data >= quiet:
                break

            r, _, _ = select.select(fds, [], [], 0.02)

            if not r:
                continue

            got_data = False
            for fd in r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    continue
                if not data:
                    continue
                got_data = True
                if fd == self._master_fd:
                    out_buf += data
                else:
                    err_buf += data
                    if not marker_found and self._pat.search(
                        err_buf.decode("utf-8", errors="replace")
                    ):
                        marker_found = True

            if got_data:
                last_data = time.time()
            else:
                break  # all fds EOF → bash 已退出

        return (
            out_buf.decode("utf-8", errors="replace"),
            err_buf.decode("utf-8", errors="replace"),
        )

    # ── 命令执行 ──

    # Shell syntax that disqualifies fast-path execution
    _SHELL_SYNTAX = re.compile(r"[;&|<>]|\$[a-zA-Z_({]|`")

    def run(
        self, cmd: str, timeout: float = 12.0, quiet: float = 0.3
    ) -> tuple[int, str, str]:
        # Try registered fast commands before spawning a process
        for prefix, handler in self._fast_commands.items():
            if cmd == prefix or cmd.startswith(prefix + " "):
                args_str = cmd[len(prefix) :].strip()
                if not self._SHELL_SYNTAX.search(args_str):
                    result = handler(args_str)
                    if result is not None:
                        return result
                break  # prefix matched; cannot fast-path (shell syntax or None)

        self._write(cmd)
        stdout_raw, stderr_raw = self._read(timeout=timeout, quiet=quiet)

        out = stdout_raw.replace("\r\n", "\n").replace("\r", "").strip()

        err_lines = stderr_raw.split("\n")
        err_parts: list[str] = []
        exit_code = -1
        found_marker = False

        for line in err_lines[1:]:
            stripped = line.strip()
            m = self._pat.search(stripped)
            if m:
                exit_code = int(m.group(1))
                found_marker = True
                break
            err_parts.append(line.rstrip("\r"))

        proc_exit = self._proc.poll()
        if not found_marker and proc_exit is not None:
            exit_code = proc_exit

        if not found_marker and exit_code == -1:
            raise RuntimeError(
                f"Shell marker not found in command output.\n"
                f"  cmd: {cmd!r}\n"
                f"  stdout: {out!r}\n"
                f"  stderr: {stderr_raw[-200:]!r}\n"
                "This usually means PS1 was overwritten or bash crashed."
            )

        err = "\n".join(err_parts).strip()
        return exit_code, out, err

    @property
    def cwd(self) -> str:
        _, out, _ = self.run("pwd")
        return out

    # ── 多行意图测试 transcript ──

    _RE_ANY = re.compile(r"\{\{\*\}\}")
    _RE_REGEX = re.compile(r"\{\{regex:(.*?)\}\}")

    def _find_regex_closing(self, line: str, start: int) -> int:
        i = start
        while i < len(line):
            if line[i : i + 2] == "}}":
                if i >= 2 and line[i - 1].isdigit():
                    j = i - 1
                    while j >= start and line[j].isdigit():
                        j -= 1
                    if j >= start and line[j] == "{":
                        i += 1
                        continue
                return i
            i += 1
        raise ValueError(f"未闭合的 {{regex: 标记: {line!r}")

    def _tokenize(self, line: str) -> list[tuple[str, bool]]:
        tokens: list[tuple[str, bool]] = []
        i = 0
        while i < len(line):
            if line[i : i + 5] == "{{*}}":
                tokens.append(("{{*}}", True))
                i += 5
            elif line[i : i + 8] == "{{regex:":
                end = self._find_regex_closing(line, i + 8)
                tokens.append((line[i : end + 2], True))
                i = end + 2
            else:
                j = i
                while j < len(line) and not (
                    line[j : j + 5] == "{{*}}" or line[j : j + 8] == "{{regex:"
                ):
                    j += 1
                tokens.append((line[i:j], False))
                i = j
        return tokens

    def _line_matches(self, expected: str, actual: str) -> bool:
        if expected == actual:
            return True

        # {{*}} / {{regex:...}} 标记（向后兼容）
        if "{{" in expected:
            parts: list[str] = []
            for text, is_sentinel in self._tokenize(expected):
                if is_sentinel:
                    if text == "{{*}}":
                        parts.append("(?s:.*?)")
                    elif text.startswith("{{regex:") and text.endswith("}}"):
                        parts.append("(?:" + text[8:-2] + ")")
                else:
                    # 非标记段: * 作为 glob 通配符
                    if "*" in text:
                        segs = [re.escape(s) for s in text.split("*")]
                        parts.append("(?s:" + ".*?".join(segs) + ")")
                    else:
                        parts.append(re.escape(text))
            pat = "^" + "".join(parts) + "$"
            return bool(re.fullmatch(pat, actual))

        # glob 式 * 通配符（推荐，无 f-string 冲突）
        if "*" in expected:
            parts = [re.escape(seg) for seg in expected.split("*")]
            pat = "^(?s:" + ".*?".join(parts) + ")$"
            return bool(re.fullmatch(pat, actual))

        return False

    def _match_block(self, expected: list[str], actual: str, label: str) -> None:
        actual_lines = [l.strip() for l in actual.split("\n")] if actual else []  # noqa: E741  # l 作循环变量，非数字 1
        expected_clean = [l for l in expected if l.strip()]  # noqa: E741  # 同上

        for exp in expected_clean:
            # * 通配符：匹配任意输出（含空输出）
            if exp == "*":
                continue
            if not any(self._line_matches(exp, act) for act in actual_lines):
                raise AssertionError(
                    f"[{label}] 未找到匹配行: {exp!r}\n  实际输出: {actual!r}"
                )

    def _parse_session(
        self, session: str
    ) -> list[tuple[str, list[str], list[str], bool]]:
        blocks: list[tuple[str, list[str], list[str], bool]] = []
        lines = session.split("\n")

        cmd = ""
        stdout_expected: list[str] = []
        stderr_expected: list[str] = []
        expect_fail = False
        target = stdout_expected

        for line in lines:
            stripped = line.strip()
            if stripped.startswith("$! "):
                if cmd:
                    blocks.append((cmd, stdout_expected, stderr_expected, expect_fail))
                cmd = stripped[3:].strip()
                stdout_expected = []
                stderr_expected = []
                expect_fail = True
                target = stdout_expected
                continue
            if stripped.startswith("$ "):
                if cmd:
                    blocks.append((cmd, stdout_expected, stderr_expected, expect_fail))
                cmd = stripped[2:].strip()
                stdout_expected = []
                stderr_expected = []
                expect_fail = False
                target = stdout_expected
                continue
            if stripped == "---":
                target = stderr_expected
                continue
            if not stripped or stripped.startswith("#"):
                continue
            target.append(stripped)

        if cmd:
            blocks.append((cmd, stdout_expected, stderr_expected, expect_fail))
        return blocks

    def assert_session(self, session: str) -> None:
        blocks = self._parse_session(session)
        for cmd, stdout_exp, stderr_exp, expect_fail in blocks:
            code, out, err = self.run(cmd)
            if expect_fail:
                assert code != 0, (
                    f"$! {cmd}\nexit={code}（期望非零）\nstdout: {out}\nstderr: {err}"
                )
                if not stdout_exp and not stderr_exp:
                    continue
            self._match_block(stdout_exp, out, f"stdout: $ {cmd}")
            if stderr_exp:
                self._match_block(stderr_exp, err, f"stderr: $ {cmd}")

    # ── 资源管理 ──

    def close(self) -> None:
        if not hasattr(self, "_master_fd") or self._master_fd < 0:
            return
        try:
            self._write("exit")
            self._read(timeout=1.0)
        finally:
            try:
                os.close(self._master_fd)
            except OSError:
                _log.debug("close master fd 异常（清理阶段）")
            self._master_fd = -1
            if self._err_fd is not None:
                try:
                    os.close(self._err_fd)
                except OSError:
                    _log.debug("close err fd 异常（清理阶段）")
                self._err_fd = -1
            try:
                self._proc.wait(timeout=3)
            except (subprocess.TimeoutExpired, AttributeError):
                try:
                    self._proc.kill()
                    self._proc.wait()
                except Exception:
                    pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __del__(self):
        try:
            self.close()
        except Exception:
            _log.debug("__del__ cleanup 异常", exc_info=True)


# ── ShellTest: factory / builder ──


class ShellTest:
    """Shell 会话工厂。不开进程，只记配置。

    通过 .session() 获取 Session，或 .assert_session() 一锤子交易。
    .with_options() 返回新实例，不影响原配置。
    """

    def __init__(
        self,
        shell: str = "bash",
        cwd: str | None = None,
        init_commands: list[str] | None = None,
        ps1_prefix: str = "",
        fast_commands: dict[str, Callable[[str], tuple[int, str, str] | None]]
        | None = None,
    ):
        self._shell = shell
        self._cwd = cwd
        self._init_commands = list(init_commands or [])
        self._ps1_prefix = ps1_prefix
        self._fast_commands = fast_commands or {}

    @property
    def cwd(self) -> str | None:
        return self._cwd

    def with_options(
        self,
        shell: str | None = None,
        cwd: str | None = None,
        init_commands: list[str] | None = None,
        ps1_prefix: str | None = None,
    ) -> ShellTest:
        """返回新实例，覆盖部分参数，原实例不变。

        适合 fixture 中微调：
            shared = ShellTest(cwd="/tmp")
            shared.with_options(cwd="/var").assert_session("...")
        """
        return ShellTest(
            shell=shell if shell is not None else self._shell,
            cwd=cwd if cwd is not None else self._cwd,
            init_commands=init_commands
            if init_commands is not None
            else self._init_commands.copy()
            if self._init_commands
            else None,
            ps1_prefix=ps1_prefix if ps1_prefix is not None else self._ps1_prefix,
        )

    def session(self) -> Session:
        s = Session(
            shell=self._shell,
            cwd=self._cwd,
            ps1_prefix=self._ps1_prefix,
            fast_commands=self._fast_commands,
        )
        for cmd in self._init_commands:
            s.run(cmd)
        return s

    def run(self, cmd: str, **kwargs) -> tuple[int, str, str]:
        with self.session() as s:
            return s.run(cmd, **kwargs)

    def assert_session(self, session: str) -> None:
        with self.session() as s:
            s.assert_session(session)
