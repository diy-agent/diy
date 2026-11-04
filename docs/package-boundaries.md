# 包边界：barrel 只给 Node 侧用

> 2026-11-04 定。起因是一次**真事故**（窗口纯黑），不是理论洁癖。

## 规则

> **包的 `index.ts`（barrel）只给 Node 侧用；renderer 一律走具体子路径。**

```ts
// ✅ Node 侧（main / 脚本 / 测试）：可以用 barrel
import { createRun, listRuns } from "@diy-agent/jobs";

// ✅ renderer：只取它真正需要的那一块
import { stateLabel, formatDuration } from "@diy-agent/jobs/run-status";

// ❌ renderer 用 barrel
export * from "@diy-agent/jobs";   // 会把 run-registry → node:child_process 一起拖进来
```

## 为什么

**barrel 是「包的全集」**，而包必然包含 Node 侧能力（spawn / fs / 进程管理）。
renderer 只需要其中一小块纯函数时，用 barrel 等于**把整个依赖图拖进浏览器 bundle**。

而 npm 包 `exports` 只做**出入口映射**，不做依赖裁剪 —— `export *` 会真的把目标文件
及其全部 `import` 一起拉进来（ESM 静态图，没有 tree-shaking 的运行时语义）。

## 真事故（2026-11-04）

```
prod 产物 index-92oAXqGe.js:347
  ReferenceError: process is not defined   ⇒ 窗口纯黑
```

来源链：

```
shared/run-view.ts（renderer 用）
  → shared/run-status.ts  ← 这里写了 `export * from "@diy-agent/jobs"`
    → @diy-agent/jobs/index.ts
      → run-registry.ts
        → @diy-agent/tools/shell/run
          → node:child_process     ← 模块顶层读 process.platform
```

**为什么三层检查都没抓到**：

| 检查 | 为什么漏 |
|---|---|
| `tsc` | 只做类型检查，看不出「运行时会不会求值到」 |
| `oxlint` | 不分析跨包 import 图 |
| `check-os-boundary.mjs` | 是**文本正则**扫令牌；这次源码里只有一行干净的 `export *` |

⇒ 必须**真遍历 import 图**。

## 三层防护

| 层 | 实现 | 时机 | 谁能绕过 |
|---|---|---|---|
| **规范** | 本文档 | 编码/评审 | 人会忘 |
| **图分析** | `scripts/check-renderer-boundary.mjs` | `./sha.sh check`（秒级）| 动态 `import()` |
| **构建拦截** | `apps/diy-app/vite.renderer.config.ts` 的 `browserSafe` 插件 | build | 几乎不能 |

**两层都要**：插件依赖 Vite 的解析行为（版本 / 插件顺序会变），脚本是纯静态、稳定。
反过来说，脚本测不到的动态 import 由插件兜底。

## 常见误报：`import type` 是安全的

```ts
// ✅ 编译期擦除，运行时零依赖
import type { SteerItem } from "../../main/core/drafts";
```

`check-renderer-boundary.mjs` 会跳过所有 `import type` / `export type` —— 这条很重要，
否则 renderer 里一堆「从 main 拿类型」的 import 会刷出大量假阳性。

**判据**：`import type` 安全；`import { 值 }` 不安全（哪怕只用一个）。

## 转发层的正确写法

**转发层按「用途」切，不按「来源包」切**：

```ts
// ❌ 图省事：整包转发
export * from "@diy-agent/jobs";

// ✅ 只转纯呈现判据
export * from "@diy-agent/jobs/run-status";

// ✅ 或者显式列出
export { stateLabel, formatDuration, exitText } from "@diy-agent/jobs/run-status";
```

## 新增包时自查

```bash
# 1. 从 renderer 入口扫一遍（秒级）
node scripts/check-renderer-boundary.mjs

# 2. 自证脚本还能抓到问题（注入事故 → 断言报错）
node scripts/check-renderer-boundary.mjs --self-test
```

第二条**不是可选项** —— 一个从不报警的检查等于没有检查。

## 现状清单（2026-11-04 审计全仓 34 个包）

自动生成方式：从每个包的 `src/index.ts` 出发遍历 import 图，看能否到达 `node:*` / `electron`。

### ⚠️ barrel 危险（index.ts 可达 Node）—— 11 个

| 包 | 经由 | 说明 |
|---|---|---|
| `@diy-agent/workbench` | `electron` | 壳本身，只该 main 用 |
| `@diy-agent/jobs` | `run-registry` → `node:child_process` | **本次事故源头** |
| `@diy-agent/bot` | `store-fs` → `node:fs/promises` | renderer 该走 `bot/protocol` / `bot/persona` |
| `@diy-agent/bot-config-page` | `catalog` → `node:fs` | 页面本身是 renderer 用的 ⇒ **该拆子路径** |
| `@diy-agent/model-catalog` | `catalog` → `node:fs` | 同上 |
| `@diy-agent/hub` | `keychain` → `node:child_process` | |
| `@diy-agent/tools` | `file-edit` → `node:fs` | |
| `@diy-agent/os` | `fs-lock` → `node:fs` | |
| `@diy-agent/persistence` | `seek` → `node:crypto` | |
| `@diy-agent/session-store-jsonl` | `store` → `node:fs/promises` | |
| `@diy-agent/log` | `sanitize` → `node:buffer` | |

### ✅ barrel 安全（纯数据 / 纯函数）—— 23 个

`chat-page` `compaction` `context` `facts` `flow` `llm-provider` `model-config-page`
`remote` `room` `rpc` `serial-queue` `session` `session-store-memory` `store-contract`
`talk` `template` `test-llm` `time` `ui` `ui-kit` `ui-testing` `workbench-plugin` `workbench-ui`

> `@diy-agent/rpc` 是安全的 —— 它虽然有 `./http` `./ws` `./electron` 子路径，
> 但 `index.ts` **不导出它们**。这正是「子路径隔离」的正确示范。

### 待处理

- [ ] `bot-config-page` / `model-catalog`：页面是 renderer 用的，但 barrel 带 `node:fs`
      ⇒ 应该拆 `./catalog-view`（纯类型 + 格式化）与 `./catalog`（读文件）
- [ ] 其余 9 个包：确认 renderer 侧确实走了子路径（当前 `check-renderer-boundary` 报 ✓，
      说明现状安全；清单的作用是**防止未来误用**）

## 如何复现这份审计

```bash
node scripts/check-renderer-boundary.mjs          # 只看 renderer 是否越界（会阻断）
node scripts/check-renderer-boundary.mjs --list   # 看入口与统计
```
