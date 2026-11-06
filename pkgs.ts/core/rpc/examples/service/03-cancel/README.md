# 03-cancel

**推荐写法**（`defineService` + 生成器）。

## 跑

```bash
# 仓根执行
npx tsx pkgs.ts/core/rpc/examples/service/03-cancel/run.ts
```

## 生成类型（改了 src/api.ts 之后）

```bash
# 仓根执行 —— 生成所有示例（含本目录）
./pkgs.ts/core/rpc/examples/gen.sh

# 只检查是否最新（CI 同款）
./pkgs.ts/core/rpc/examples/gen.sh --check
```

生成器按约定扫 `<dir>/src/api.ts`，产物落 `<dir>/src/gen/api.generated.d.ts`。

## 目录

```
03-cancel/
├── src/api.ts                  ← 手写，唯一真源（**改了它就要重跑生成**）
├── src/gen/api.generated.d.ts  ← 生成（别手改）
└── run.ts                      ← 可执行
```
