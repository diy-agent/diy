---
desc: 环境变量开关（README 里最容易漏写的一档）
updated: 2026-10-21
---

## auto-sync

DIY_AUTO_SYNC=0：关掉 build/check/test/lab 入口的自动 sync，改为报错停下（默认会自动 sync 后继续）

（见 sha.sh:103）

## no-launch

DIY_NO_LAUNCH=1：CLI 只允许复用已运行实例，探测不到即报错（测试用它防实例泄露：CLI 另起的 detached 实例回收不到）

（见 apps/diy-app/src/runtime.ts:80）
