---
desc: 事实库的写入口本身（agent 只经 CLI，不碰 YAML）
updated: 2026-10-21
---

## entry

diy facts status · get <claim> [--env] · submit --file <json|-> [--dry-run] · affected --files a,b —— **agent 只走 CLI，不碰 YAML**（整批事务：一条不过整批拒）

（见 scripts/facts-index.mts:1）
