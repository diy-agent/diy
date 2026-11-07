---
desc: @diy-agent/dev 的命令入口与自检方式
updated: 2026-10-23
---

## check

`./sha.sh check`（typecheck + lint）· `./sha.sh test`（本包全是快测，`test ≡ test-unit`）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:22）

## dev-cmd

`./sha.sh dev ref add|remove|sync|list`（源码）· `bin/dev ref …`（产物）—— 本包是独立的 `dev` 命令，**不是** diy 应用的一部分

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:21）
