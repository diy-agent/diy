"""
Pytest conftest 约定：
  只要 tests/ 目录下有 conftest.py（即使是空文件），pytest 就会把 tests/ 加入
  sys.path。这样 tests/ 下的模块（如 helpers.py）可以被 `from helpers import ...`
  直接引用，无需写 `from tests.helpers import ...`。

  本文件保持为空，仅用于触发 pytest 的这个隐式行为。
"""
