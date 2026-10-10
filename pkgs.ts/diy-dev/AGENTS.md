# diy-dev — ref（仓库引用 / vendor 镜像）CLI

> 全仓契约见**仓库根 `AGENTS.md`**。本包是独立的 `dev` 命令，**不是** diy 应用的一部分。

## find — 包内定位

- `find.cli` — `src/cli/index.ts` 入口：**进程内 RPC**（`createMemTransportPair` + `ChannelServerBinding`），零网络零 Electron —— 只为复用 `diy-app` 同一套命令解析（zod schema + `cliArg`/`cliOption` → help / did-you-mean）
- `find.ref` — `src/ref/`：`api.ts`（RPC **纯定义**）· `impl.ts`（handler 绑定）· `git.ts`（git 调用）· `store.ts`（`diy.yaml` / `ref.lock.yaml` 读写 + URL 解析）· `render.ts`（输出）· `progress.ts`
- `find.runtime` — `src/runtime.ts` 只读 `DIY_HOME`（镜像根 `$DIY_HOME/ref`）
- `find.entry` — `bin/dev`（跑 `build/prod/cli/index.js` 产物）· `./sha.sh dev <args>`（跑源码，**不 cd**）

## rule — 硬约束

- `rule.cwd-scope` — **cwd 即作用域**：`diy.yaml` 在哪个目录就在哪操作；`bin/dev` **刻意不 cd 到包根**（`node` 必须保持调用者当前目录）
- `rule.lock-format` — `ref.lock.yaml` 本包写 **v1**：`{version:1, generated, source:{key:{url,version,dir,lastSync}}}`。⚠️ **与 `pkgs.ts/diy-app/src/main/services/ref-sync.ts` 写的 v5 格式不兼容**（v5 用 `ref.{python,node}.{scope}.{category}` 分组），两者都写仓库根的同一个 `.diy/ref.lock.yaml`，后者会覆盖前者且**互读为空、不报错**。改动任一侧的格式前先确认哪个是活的
- `rule.mirror-dir` — 镜像落 `$DIY_HOME/ref/<host>/<owner>/<repo>/<version>/`；`LockEntry.dir` 存**相对 `$DIY_HOME`** 的路径（跨 worktree 复用要拼当前 home）
- `rule.version-pin` — `@` 后是 tag / sha（`isPinnedVersion`）则 sync 只检出不 pull；`null` 视作 `main`

## tool — 命令

- `tool.dev` — `./sha.sh dev ref add|remove|sync|list`（源码）· `bin/dev ref …`（产物）
- `tool.check` — `./sha.sh check`（typecheck + lint）· `./sha.sh test`（本包全是快测，`test ≡ test-unit`）
