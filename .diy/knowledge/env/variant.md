---
desc: 产物/数据分根用的变体（决定 build/<v> 与 build/<v>/home）
updated: 2026-10-23
---

## values

prod | test | lab | preview（preview = 编译后运行、无 watch 的稳定实例；`scripts/electron-dev.mts` / `src/serve` 遇到它仍显式报错，因为它们不是这条路径）

（见 apps/diy-app/sha.sh:113）
