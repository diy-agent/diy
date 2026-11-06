# 04-group-root

**用 `RpcSchema.group` 当根**（2026-11-06 起支持）。

## 跑

```bash
npx tsx pkgs.ts/core/rpc/examples/service/04-group-root/run.ts
# 2 + 3 = 5
# version = 2.0.0
```

## 与 01-basic 的差别

| | 01-basic | 04-group-root |
|---|---|---|
| 根 | `RpcSchema.router(...)` | **`RpcSchema.group({ desc, children })`** |
| 中间层 | `RpcSchema.router(...)`（无 desc）| **`RpcSchema.group({ desc, children })`** |
| CLI help 分层说明 | 缺 | **每层都有** |

**为什么推荐这个**：`demo --help` 里的「数学运算」这行说明，**只有 group 的 desc 能给**。
叶子命令的 desc 由 `unary({ desc })` 给。

## 生成

```bash
./pkgs.ts/core/rpc/examples/gen.sh

# 只检查
./pkgs.ts/core/rpc/examples/gen.sh --check
```
