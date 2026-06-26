"""跨进程 + 跨线程安全的文件锁。

═══════════════════════════════════════════════════════════
背景 / 为什么需要这个工具
═══════════════════════════════════════════════════════════

diy 生态需要跨进程互斥：多个 diy/dai 进程可能同时操作计数器、
state.yaml 等共享资源。标准做法是 fcntl.flock 做文件锁。

但 flock 的线程互斥性因 OS 而异：

  macOS (BSD)  → 锁绑定文件 inode
                 同进程多线程各自 open() + flock(EX) 互斥 ✅

  Linux        → 锁绑定 open file description
                 不同 open() 产生独立 struct file
                 flock 的 fl_owner 不同 → 冲突判定为不同锁
                 POSIX 标准未保证 100% 互斥
                 实测 4.19 互斥，但未来内核/drv 可能不同 ❌

因此所有 flock 用法必须包一层 threading.Lock 兜底，
这才是跨平台安全的写法。

═══════════════════════════════════════════════════════════
用法
═══════════════════════════════════════════════════════════

    from diy.core._lock import locked_file

    with locked_file("/tmp/my.lock"):
        # 临界区：线程安全 + 进程安全
        data = Path("/tmp/shared").read_text()
        ...

═══════════════════════════════════════════════════════════
参考
═══════════════════════════════════════════════════════════

- man 2 flock — POSIX 文件锁
- Linux 内核 fs/locks.c — flock_to_posix_lock / flock_locks_conflict
- _doctor.py L4 _check_flock_integrity — 当前系统 flock 行为检测
"""

from __future__ import annotations

import fcntl
import threading
from pathlib import Path

# ═══════════════════════════════════════════════════════
# 每个锁文件路径对应一个 threading.Lock
# 用类变量 + init 锁保护，确保同一路径用同一锁实例
# ═══════════════════════════════════════════════════════

_locks: dict[Path, threading.Lock] = {}
_locks_init_lock = threading.Lock()


class locked_file:  # noqa: N801  # 上下文管理器惯例 snake_case
    """跨进程 + 跨线程安全的文件锁上下文管理器。

    两层锁策略：
    1. threading.Lock — 同进程线程互斥（所有 OS 生效）
    2. fcntl.flock    — 跨进程互斥（POSIX 系统）

    同一锁文件路径的所有调用者共享同一个 threading.Lock 实例。

    获取锁（阻塞模式）:
        with locked_file("/tmp/my.lock"):
            ...

    获取锁（超时模式）:
        lf = locked_file.try_lock("/tmp/my.lock", timeout=3.0)
        if lf is not None:
            with lf:
                ...
    """

    __slots__ = ("_path", "_fd", "_thread_lock")

    def __init__(self, path: str | Path) -> None:
        p = Path(path)
        self._path = p
        # 确保同一路径所有实例用同一个 threading.Lock
        with _locks_init_lock:
            if p not in _locks:
                _locks[p] = threading.Lock()
        self._thread_lock = _locks[p]

    # ── 上下文管理器 ──

    def __enter__(self) -> locked_file:
        """获取线程锁 → 打开文件 → 获取文件锁。"""
        self._thread_lock.acquire()
        try:
            self._fd = open(self._path, "w")  # noqa: SIM115  # with 会释放 fcntl.flock，需保持 fd 打开
            fcntl.flock(self._fd.fileno(), fcntl.LOCK_EX)
        except BaseException:
            self._thread_lock.release()
            raise
        return self

    def __exit__(self, *exc: object) -> None:
        """释放文件锁 → 关闭文件 → 释放线程锁。"""
        try:
            try:
                fcntl.flock(self._fd.fileno(), fcntl.LOCK_UN)
            finally:
                self._fd.close()
        finally:
            self._thread_lock.release()

    # ── 工厂方法 ──

    @classmethod
    def try_lock(cls, path: str | Path, timeout: float = 3.0) -> locked_file | None:
        """尝试在超时内获取锁。成功返回 locked_file 实例，超时返回 None。

        用于需要非阻塞+重试的场景（如 _forward.py 的 app 启动锁）。
        内部用 LOCK_NB + 指数退避轮询（flock 无事件可监听）。
        """
        from diy.core._backoff import Backoff

        self = cls(path)
        self._thread_lock.acquire()
        try:
            self._fd = open(self._path, "w")  # noqa: SIM115  # 同上：fcntl.flock 需要手动 fd 生命周期
        except BaseException:
            self._thread_lock.release()
            raise

        for _ in Backoff(timeout=timeout, initial=0.05, max_delay=0.3):
            try:
                fcntl.flock(self._fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self  # 获锁成功，调用方自己 release
            except BlockingIOError:
                continue

        # 超时
        self._fd.close()
        self._thread_lock.release()
        return None

    # ── 属性 ──

    @property
    def path(self) -> Path:
        """锁文件路径。"""
        return self._path

    @property
    def fileno(self) -> int:
        """文件描述符编号（需要 Direct I/O 等高级操作时用）。"""
        return self._fd.fileno()
