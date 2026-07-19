# diy ref — 重设计 + TypeScript 重写计划（v2）

**设计决策：2026-07-10** | **源码参考**: `diy/pkgs/diy-cli/src/diy/cli/ref.py` (700L) + `_sync.py` (1643L)

---

## 一、核心简化：diy.yaml 不再是项目边界

### 旧设计（v1）

```
diy.yaml  = 项目边界标记 + ref 配置
    └── find_project_boundary() → 向上找 diy.yaml
    └── find_project_root()      → 向上找 diy.yaml
    └── .git 是硬边界（遇到 .git 还没有 diy.yaml → 报错）
```

问题：
- `diy.yaml` 身兼两职（边界 + 配置），概念混淆
- 没有 `diy.yaml` 就无法执行 ref 操作
- monorepo 子项目需要额外的 scope 检测逻辑

### 新设计（v2）

```
uv.lock / package-lock.json  = 项目边界（决定 mono vs standalone）
diy.yaml                     = 纯 ref 配置（在 py/node 项目下是依附信息；
                               仅在无 py/node 项目时作为项目边界）
```

**项目边界检测**（三级优先级）：

```
从 cwd 向上遍历，命中第一个即停：

  情况 A — 有 py/node 项目：
    第一个 uv.lock 或 package-lock.json → 项目根
    diy.yaml 只是附在同目录（或父目录）的配置，不参与边界判定
    ├── lock 文件包含 workspace → monorepo
    └── lock 文件无 workspace   → standalone

  情况 B — 无 py/node 项目（纯 diy 项目）：
    向上遇到第一个 diy.yaml → 项目根
    .git 是硬边界（遇到 .git 还没 diy.yaml → 报错）
    diy.yaml 无 workspace 概念 → 第一个就是 root
    子目录的 diy.yaml 不搜索、不聚合

  情况 C — 都没有：
    报错，不是项目目录
```

**关键规则**：
- 有 lock 文件时，diy.yaml 不参与边界判定。同级 diy.yaml 仅读其 ref 配置。
- 子目录的 diy.yaml 永不搜索/聚合（diy.yaml 没有 workspace 语义，也不应有）。
- 旧代码里 `_collect_sources_from_all_boundaries()` 的递归扫描逻辑删除。

**diy.yaml 的角色**：

```yaml
# diy.yaml 是纯配置，可选文件。不存在 = 全部默认行为。
ref:
  source:                          # 人工指定的外部仓库（总是 clone）
    - https://github.com/org/repo
  python:                          # Python 依赖过滤（仅对本级项目生效）
    include: ['rich', 'typer']     # 白名单 glob，空 = 全部
    exclude: ['pytest-*']          # 黑名单 glob，空 = 不跳过
  node:                            # Node.js 依赖过滤
    include: ['@acme/*']
    exclude: ['eslint-*']
```

**diy.yaml 查找规则**：
- 情况 A（有 lock 文件）：从项目根向上查，取第一个 diy.yaml 的 ref 配置。
  子项目可以有独立的 diy.yaml 放自己的 include/exclude（在子项目 cwd 的 lock 文件同级）。
- 情况 B（纯 diy 项目）：diy.yaml 本身就是项目边界。
- 不存在 = 默认行为：下载所有依赖的源码。

---

## 二、Monorepo 与 Scope

### Monorepo 检测

| 技术栈 | 标记 | 数据源 |
|--------|------|--------|
| Python | `uv.lock` 含 workspace members | `[tool.uv.workspace] members` |
| Node.js | `package-lock.json` + root `package.json` workspaces | `package.json` → `workspaces: ["pkgs/*"]` |

### `diy ref sync` scope 规则

```
cwd = monorepo 根目录
  → 默认 sync 所有子项目 + 根自身的依赖
  → --scope <name> 只 sync 指定子项目

cwd = monorepo 子项目目录（如 pkgs/diy-desktop2）
  → 默认只 sync 当前子项目的依赖
  → --all sync 整个 monorepo 的所有依赖
  → 不递归到子项目的子项目

cwd = standalone 项目
  → sync 该项目全部依赖
```

### 依赖归属

每个依赖归属到它被声明的子项目：
```
diy.ts/pkgs/diy-desktop2/package.json
  → dependencies: { react, zod, ... }
  → devDependencies: { vite, electron, ... }
  → ref.lock.yaml 中 scope = "diy-desktop2"
```

---

## 三、数据流

```
diy ref sync
  │
  ├── 1. 检测项目边界
  │     ├── 向上找 uv.lock / package-lock.json / .git
  │     └── 确定 monorepo root
  │
  ├── 2. 确定 scope（当前子项目 or 全部）
  │     └── cwd 在子项目内 → 默认只当前 scope
  │
  ├── 3. 收集依赖
  │     ├── Python: 读 pyproject.toml → [project] dependencies / optional-deps / dependency-groups
  │     │          精确版本从 uv.lock（TOML 格式）解析
  │     ├── Node:   读 package.json → dependencies / devDependencies
  │     │          精确版本从 package-lock.json 解析
  │     └── 应用 diy.yaml 中的 include/exclude 过滤（按 python/node 分别配置）
  │
  ├── 4. 解析 git URL（简化版）
  │     ├── 优先：预置映射表（已知常用包的 github URL）
  │     ├── 兜底：PyPI JSON API / npm registry API（按需，不预取全部）
  │     └── 无 git URL → 跳过 + 输出提示
  │
  ├── 5. clone 到 ~/.diy/ref/<host>/<owner>/<repo>/<version>/
  │     └── 并发控制（默认 4 并发）
  │
  └── 6. 写 ref.lock.yaml
       └── refs → python / node / source → scope → category → {pkg: path}
```

---

## 四、ref.lock.yaml 格式（v5 保持）

```yaml
version: 5
refs:
  python:
    "diy-research":           # scope = 项目名（来自 pyproject.toml name）
      dependencies:
        rich: ~/.diy/ref/github.com/Textualize/rich/v14.0.0/
      dependency-groups:
        dev:
          pytest: ~/.diy/ref/github.com/pytest-dev/pytest/v9.0.3/
  node:
    "diy-desktop2":           # scope = 子项目名（来自 package.json name）
      dependencies:
        react: ~/.diy/ref/github.com/facebook/react/v19.2.7/
        zod: ~/.diy/ref/github.com/colinhacks/zod/v4.4.3/
      dev-dependencies:
        vite: ~/.diy/ref/github.com/vitejs/vite/v8.1.3/
  source:
    "diy-research":           # source 也按 scope 分组
      TanStack/router: ~/.diy/ref/github.com/TanStack/router/main/
```

Scope 名就是 `pyproject.toml` 的 `[project] name` 或 `package.json` 的 `name`。

---

## 五、命令清单

| 命令 | 说明 |
|------|------|
| `diy2 ref add <url>` | 注册外部仓库到 `diy.yaml`，验证 git URL |
| `diy2 ref remove <name>` | 从 `diy.yaml` 移除 source |
| `diy2 ref sync` | 扫描 lock 文件 + clone 到 `~/.diy/ref/`，写 `ref.lock.yaml` |
| `diy2 ref sync --all` | 强制 sync 所有 scope（在子项目内也 sync 全 monorepo） |
| `diy2 ref sync --scope <name>` | 只 sync 指定 scope |
| `diy2 ref list` | 查看 `ref.lock.yaml`（scope 感知，当前子项目优先） |
| `diy2 ref list --all` | 显示所有 scope |
| `diy2 ref status` | 检查本地路径是否存在 |

---

## 六、取舍分析

| 模块 | 保留? | 理由 |
|------|-------|------|
| ref add/remove | ✅ | 核心功能 |
| ref sync（依赖收集） | ✅ 简化 | 从 lock 文件读，不做 PyPI/npm registry 全量查询 |
| ref sync（git clone） | ✅ | 多线程并发 |
| ref list | ✅ | scope 感知 |
| ref status | ✅ | 路径检查 |
| PyPI/npm registry 全量查询 | ❌ | 太重，改为按需 + 预置映射表 |
| update_tsconfig/pyright | ❌ | IDE 配置由项目自己的工具管理 |
| manage_agent_symlinks | ❌ | 非 ref 职责 |
| 旧的 `find_project_boundary`（diy.yaml 驱动） | ❌ 重写 | 改为 lock file 驱动 |

---

## 七、文件结构

```
diy-desktop2/src/main/
  ├── core/
  │     └── ref.ts            # RefLock v5 解析 + 路径查找
  ├── services/
  │     ├── ref-sync.ts       # 依赖收集 + git clone 并发
  │     ├── ref-project.ts    # 项目边界检测（lock file 驱动）
  │     └── api.ts            # 新增 ref 组 procedure
  └── cli/
        └── index.ts          # diy2 ref add/sync/list/status
```

## 八、api.ts 新增 procedure

```ts
export const api = router({
  // ... existing ...

  ref: router({
    sync: rpc.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "sync 所有 scope" }),
        scope: z.string().optional().cliOption({ desc: "指定 scope 名称" }),
        concurrency: z.number().default(4).optional().cliOption({ desc: "并发克隆数" }),
      },
      call: async ({ input }) => syncRefs(input),
    }),

    list: rpc.unary({
      input: {
        all: z.boolean().optional().cliOption({ short: "a", desc: "显示所有 scope" }),
      },
      call: async ({ input }) => {
        const tree = loadRefLock();
        return input.all ? tree : filterByCurrentScope(tree);
      },
    }),

    status: rpc.unary({
      input: {},
      call: async () => checkRefPaths(),
    }),

    add: rpc.unary({
      input: {
        url: z.string().cliArg({ desc: "Git 仓库 URL" }),
      },
      call: async ({ input }) => addSource(input.url),
    }),

    remove: rpc.unary({
      input: {
        name: z.string().cliArg({ desc: "仓库名（diy.yaml 中注册的名字）" }),
      },
      call: async ({ input }) => removeSource(input.name),
    }),
  }),
});
```

## 九、实施步骤

| Step | 内容 | 预计 |
|------|------|------|
| 1 | `core/ref-project.ts` — 三级项目边界检测（lock files → diy.yaml → 报错）+ workspace 解析 + scope 判定 | ~80L |
| 2 | `core/ref.ts` — ref.lock.yaml v5 解析 + scope 过滤 | ~100L |
| 3 | `services/ref-sync.ts` — 从 lock 文件收集依赖（pyproject.toml / package.json）+ git clone 并发 | ~150L |
| 4 | `api.ts` 新增 `ref` 组 + CLI 命令 | ~100L |
| 5 | `ref add/remove` → diy.yaml 读写（仅编辑 ref 配置，不参与边界） | ~60L |
| 6 | 测试 | ~80L |
| **总计** | | **~570L** |
