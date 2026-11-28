---
desc: 项目构建脚本 sha.sh 的机制、改法与 vendor/sha 同步
updated: 2026-11-28
---

## entry

`./sha.sh` 的链路只有三跳：`sha.sh` → `source sha.common.sh`（颜色 / 公共 shell 工具）→ 它再 `source vendor/sha/sha.bash`（**函数名即命令的自注册分发器**）→ `sha.sh` 里定义的每个函数就是一个命令（`build` / `test` / `lab`…）→ 末尾 `sha "$@"` 分发。所以「有哪些命令」不必读代码：`./sha.sh --help`（新版库见 `sha#help`）；「某命令怎么实现」直接 grep 同名函数即可 —— 没有注册表、没有插件扫描，函数存在就是命令存在。

（见 sha.sh:37）

## help

**帮助是写出来的（bed317f 起）**：紧贴函数上方的 `#:` 注释块就是帮助 —— 首行进命令列表，`#: 用法: …` 行进 usage，其余进 detail；`_` 开头的函数是内部实现，不进列表。选项/位置参数靠 `sha.def` 注册、`sha.parse` 解析（见 `sha#new`）。判据：改命令说明就改注释，不要另写文档；`./sha.sh -h` 一层、`-hh` 整棵树、`./sha.sh <cmd> -h` 看单条（含 options/arguments，自动生成）。

## new

**加命令/参数的最小动作**：① 写函数（函数名即命令；`.` 是父子分隔符，`run.lab()` → `./sha.sh run lab` 或 `./sha.sh run.lab`）；② 要选项/位置参数就在顶层写一行 `sha.def "run.lab" --opt "--slot:string=1:说明" --arg "TARGET!:说明" --desc "一句话"`（`--opt`/`--arg` 在前，`--desc` 最后；`名字!` = 必填，`名字...` = 变长）；③ 函数体内 `local slot TARGET` + `sha.parse "$@" || return $?` —— 解析结果写回同名 `local`，漏 `local` 会当场报错。`sha.parse`/`sha.def` 在 `vendor/sha/sha_opt.bash`（`sha.common.sh` 只 source 了 `sha.bash`，用到时自己补 source）。

## vendor

`vendor/sha/` 是上游 `~/git/sha`（`git@github.com:diy-agent/sha.git`）的整目录拷贝，**2026-11-28 起是 git subtree（不再是 submodule，##44）**。**本仓已升到 `bed317f`（412 行版）**：有 `#:` 注释帮助、`sha.def`/`sha.parse`、父子命令、`-hh` 全树、bash 4.3 门禁；`sha_opt.bash` 是新增的独立文件（老版本没有）。

为什么换：submodule 每次新 worktree 都要 `git submodule update --init` 走一遍网络（弱网下挂几十秒到失败），而内容本就该随 checkout 一起下来。换 subtree 后实测 `git worktree add` 4.1s 完成、零网络动作、无 `.gitmodules`、无指针要更新（`sha.common.sh` 也不再自动 init，缺了直接报怎么补）。

维护方式：
- **升级上游**：`./sha.sh vendor pull`（= `git subtree pull --prefix=vendor/sha git@github.com:diy-agent/sha.git main --squash`）—— 只在想升级时跑，需要网络
- **改 vendor 代码**：当普通文件改 → 随本仓提交；要回推上游才用 `git subtree push --prefix=vendor/sha <url> main`
- **首次导入（留档）**：`git subtree add --prefix=vendor/sha git@github.com:diy-agent/sha.git main --squash`
- `vendor/` 不进本仓的 `check-exec-bit.sh`：上游自己就有 644 的 `.bash`（`sha.bash` / `examples/*`，被 source 或显式 bash 跑），已加例外
- 弱网想从另一份 checkout 补：直接 `rsync -a --exclude .git` 覆盖 `vendor/sha/` 再正常提交

## where

改命令逻辑只动 `sha.sh` 的 `app script` 段**以下**（脚本自己写着「此位置以上的全都是 bake 工具脚本，copy 走可以直接用，之下的为项目特定 cmd」）；段以上是工具层 —— `_pick_workspaces` / `_ws_run` / `exec` 这类是全 workspace 公共行为，改它们先想影响面。workspace 内部命令写在各包自己的 `sha.sh`（`pkgs.ts/*/sha.sh`、`apps/*/sha.sh`），它们同样 source 上级 `sha.common.sh`，所以包内 `./sha.sh build` 与根命令同名不同实现是常态。

（见 sha.sh:46）
