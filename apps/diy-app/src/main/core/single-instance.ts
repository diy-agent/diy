// single-instance.ts —— 已搬到 `@diy-agent/workbench`（##518：dev 与 diy-app 同构）。
//
// 为什么搬：dev 与 diy-app 都跑 Electron、都可能有「关窗后常驻 / 陈旧锁 / 跨机锁」三种处境，
// 判定与文案是**同一套**。放在 workbench（共用的壳）里，两个 app 与 CLI 都从一处取。
//
// 这里保留转发，避免一次性改动所有调用点（CLI / main / 测试都 import 这个路径）。
export * from "@diy-agent/workbench/single-instance";
