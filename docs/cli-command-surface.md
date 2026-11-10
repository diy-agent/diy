# 命令面整理（CLI / sha.sh 的模块化）

> 2026-11-10 · 任务 ##518 · 现状：**84 个命令**（根 23 / `apps/diy-app` 35 / `_diy` 根 10 / `_diy/apps/dev` 16），
> 同一件事有多种叫法（`build` / `build-pkgs` / `dist-*` / `release` / `publish`），
> 帮助里看不出「我该用哪个」。本文定**目标命令树**与**落地方式**（与 rpc 的域拆分同思路）。

## 1. 根因（三条，都是结构性的）

1. **CLI 树直接由 rpc 路由树摊平而来**：`apps/diy-app/src/cli/index.ts` 把 `apiDef.diy` 整个交给 `CliApp`，
   于是每个 api-domain 的名字都变成顶层命令（`task` / `agent` / `flow` / `ui` / `traffic` …），
   域的内部命名（`query` / `snapshot` / `recent`）直接暴露给用户。
2. **sha.sh 的命令是手写 bash**，与 rpc 树**两套体系**：`build` 在两边都有、语义不同（顶层是全仓构建，
   app 内是本包构建）；`lab` / `staging` / `preview` / `serve` 是同族但四个名字。
3. **没有别名/弃用机制**：改名就等于破坏所有脚本与文档，所以越不敢改，命令越多。

## 2. 目标命令树（每个仓 ≤ 8 个顶层命令）

**统一动词**：`run`（长活：dev 实例 / 服务）、`build`（产物）、`test`（分层）、`check`（只读校验）、
`fix`（可写修复）、`clean`、`sync`（依赖/数据根）、`release`（版本与发布）。**列表类一律 `ls`**。

### 根（23 → 9）

| 命令 | 子命令 | 吞并 |
|---|---|---|
| `build` | `pkgs` / `apps` / `all` | `build-pkgs` |
| `check` | `[--fix]` | `typecheck` / `lint` |
| `test` | `unit` / `os` / `core` / `ui` / `e2e` | `test-unit` |
| `sync` | `deps` / `dev-home` / `status` | `ensure-sync` / `sync-deps` / `sync-status` |
| `release` | `status` / `bump` / `publish` | `publish` |
| `run` | `<variant>` | `lab` / `preview` |
| `exec` · `fix` · `clean` · `ci` | — | `link` / `unlink` / `submodule` / `vendor` / `github-actions-cicd`（低频，收进 `exec` 或删） |

### `apps/diy-app`（35 → 8）

`build [cli|renderer|runtime]` · `dist <mac|win|linux>` · `test [unit|os|core|ui|e2e|watch]` ·
`run [lab|staging|preview|serve]` · `check` · `fix` · `clean` · `icon`
（`fmt`/`fmt-fix`/`lint`/`lint-fix` → `fix`；`models-sync` → `sync models`；`start` → `run preview`）

### `_diy/apps/dev`（16 → 7）

`run [lab|staging]`（吞 `lab`/`staging`/`run.lab`/`run.staging`）· `app [new|list|stop]` · `build` ·
`check` · `test` · `fix` · `clean`

## 3. 落地方式（与 rpc 域拆分同思路）

### 3.1 rpc 侧：每个域自带 CLI 声明

现在 CLI 的暴露方式集中在 `cli/index.ts` 的字面量（`cliRootPath`）。改成**域自己声明**：

```
api-domains/traffic/cli.ts
  export const cli = {
    root: 'diy.traffic',            // 顶层命令名
    aliases: { query: 'ls', recent: 'tail' },   // 方法 → 更短的动词
    deprecated: {},                  // 老名 → 新名（打印一次提示后转发）
  }
```

`api-domains/index.ts` 汇总成一张表交给 `CliApp`。这样「加一个域 = 加一个目录」，
和 `api-domains/*/api.ts|impl.ts` 的形状一致，help 的分组也由它生成。

### 3.2 `CliApp` 增加两个能力（小改动）

1. `aliases`：`diy.traffic.ls` 与 `diy.traffic.query` 指同一个方法（help 只显示别名）。
2. `deprecated`：老命令可用，但**打印一次**「`diy publish` 已改名为 `diy release publish`」再转发。

### 3.3 sha.sh 侧：命令分组文件

`sha.d/` 目录按组拆（`build.sh` / `dev.sh` / `test.sh` / `release.sh`），`sha.sh` 只负责 source + 分发；
每个命令用同一套注释头（`#: 一句话` + `#: 用法:`），help 由注释生成 —— 与 rpc 的 `desc` 同源思路。

## 4. 迁移规则（不能一次全改）

1. **先加不删**：新名字生效，老名字保留「打印一次改名提示后转发」；
2. `-h` 只列新名（老名不进 help，避免继续被学走）；
3. 每改一组（根 → dev → diy-app），跑一次 `./sha.sh -h` 与 `diy -h` 的快照测试，防止命令消失；
4. `dist-*` / `publish` 这些**涉及发版**的命令最后动，且改名后要同步 `scripts/*.mjs` 与 CI 配置。

## 5. 验收

- 每个仓顶层命令 ≤ 8，`-h` 一屏能读完；
- 同名命令在不同仓语义一致（`build` / `test` / `run` 三件套）；
- 老命令仍可用（有提示），文档与脚本里的老命令在一个版本内替换完。
