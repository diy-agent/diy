// src/main/services/agent-guard.ts
// ⚠️ 实现已迁到 `@diy-agent/tools/shell/guard`（2026-11-05，D2）。
//
// 为什么搬：护栏的判据是「这条命令会不会把宿主自己干掉」——**宿主才该决定**。
// 公共包只留钩子位（`ShellToolHost.beforeRun`），判据由宿主注入
// （`apps/chat` 用 `judgeSelfKill(command, collectSelfInfo(home, os.hopSync))`）。
//
// 这里只做转发，保住 diy-app 里既有的调用点与单测（那 6 条里还有 4 条依赖
// agent-audit / runtime-context，属 app 特有，留在原地）。
export * from "@diy-agent/tools/shell/guard";
