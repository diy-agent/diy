// 🎯 后台进程的**呈现口径** —— 实现已搬到 `@diy-agent/jobs`（##515 第 3 步），这里只留转发。
//
// 为什么搬：这套判据（四态 / 结局 / 时长 / tail 截断 / 结束通知文案）是纯函数、零 IO，
// 但 bot / CLI 同样要用（它们的后台任务也得回答"死没死、说了什么"），只能有一份真源。
// 本文件保留是为了让既有 import 路径（`shared/run-status`）与单测不用改。
//
// ⚠️ **只能转发 `/run-status` 子路径，不能 `export * from "@diy-agent/jobs"`**：
// 这条路径会被 renderer 用到（`shared/run-view` → `JobRunsPanel` / `jobRunsStore`），
// 而包入口 barrel 还会带出 `run-registry` → `@diy-agent/tools` 的 shell 执行器，
// 后者顶层读 `process.platform` / `process.kill` ⇒ 浏览器里整份 renderer bundle
// 模块求值即抛 `ReferenceError: process is not defined`（黑屏，2026-11-04 实炸）。
// 呈现判据本身是纯函数（零 IO），跑在 renderer 完全没问题；要的是**窄入口**。
// 需要账本（spawn/list/tail/kill…）的调用方直接 `import … from "@diy-agent/jobs"`。
export * from "@diy-agent/jobs/run-status";
