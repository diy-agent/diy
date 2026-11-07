---
desc: 应用实例的监听端口
updated: 2026-10-21
---

## default

| 范围 | 值 |
|---|---|
| development / test | 0 |
| production | 18888 |

（见 apps/diy-app/src/runtime.ts:103、apps/diy-app/src/runtime.ts:90）

## resolution

DIY_PORT > <DIY_HOME>/app.port 记录 > defaultPort(env)

（见 apps/diy-app/src/runtime.ts:116）
