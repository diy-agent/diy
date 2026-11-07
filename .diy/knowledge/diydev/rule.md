---
desc: @diy-agent/dev 硬约束：cwd 即作用域 / ref.lock v1 唯一写入方 / 镜像路径 / 版本钉法
updated: 2026-10-23
---

## cwd-scope

**cwd 即作用域**：`diy.yaml` 在哪个目录就在哪操作；`bin/dev` **刻意不 cd 到包根**（`node` 必须保持调用者当前目录）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:14）

## lock-format

`ref.lock.yaml` 本包写 **v1**：`{version:1, generated, source:{key:{url,version,dir,lastSync}}}`；`@diy-agent/app` 侧的 v5 写引擎**已删（##387）**，本格式是全仓唯一写入方 —— 改动格式无需再比对另一侧

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:15）

## mirror-dir

镜像落 `$DIY_HOME/ref/<host>/<owner>/<repo>/<version>/`；`LockEntry.dir` 存**相对 `$DIY_HOME`** 的路径（跨 worktree 复用要拼当前 home）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:16）

## version-pin

`@` 后是 tag / sha（`isPinnedVersion`）则 sync 只检出不 pull；`null` 视作 `main`

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:17）
