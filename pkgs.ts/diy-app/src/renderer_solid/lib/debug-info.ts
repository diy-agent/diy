// lib/debug-info.ts — 「复制调试信息」的正文组装（纯函数，可单测）
//
// 定位：别的 agent 要接手调试**这个实例**，得先知道三件事 ——
//   ① 怎么连上 CDP（attach 命令里的 ws 地址**每次启动都变**，抄上一次的是错的）；
//   ② 这是哪个实例（数据根 / 环境 / 分支 / 端口 / PID）；
//   ③ 人现在在看哪（活动 tab / 选中任务），免得它对着别的页面瞎猜。
// 这三段散在界面各处，人肉拼既慢又易错 ⇒ 一键复制成型。
//
// 纯函数（入参即全部数据源）：组件只管取数 + 调它，判据在这里被单测钉住。

/** 数据源：`getAppInfo` 的结构子集（`AppInfoData` 是它的超集，直接传得进来） */
export interface DebugInfoApp {
    /** CDP 连接地址（`ws://...`）；未启用 / serve 模式为空 */
    cdp?: string;
    env?: string;
    diyHome: string;
    port: number;
    pid: number;
    branch?: string;
    repoDisplay?: string;
    userData: string;
}

/** 当前页面态（renderer 侧现取） */
export interface DebugInfoPage {
    active: string;
    tabs: { key: string }[];
    selectedUri: string | null;
}

/** CDP attach 命令（供别的 agent 直接粘；空 `cdp` 时给出可读的"为什么没有"） */
export function cdpAttachCommand(cdp: string | undefined): string {
    return cdp ? `playwright-cli attach --cdp=${cdp}` : "（CDP 未启用：serve 模式，或非 --remote-debugging-port 启动）";
}

export function debugInfoText(info: DebugInfoApp, page: DebugInfoPage): string {
    const lines: string[] = [];
    lines.push("# diy 实例调试信息");
    lines.push("");
    lines.push("## CDP（驱动真实窗口）");
    lines.push(cdpAttachCommand(info.cdp));
    lines.push("");
    lines.push("## app");
    lines.push(`env: ${info.env ?? "?"}`);
    lines.push(`diyHome: ${info.diyHome}`);
    lines.push(`port: ${info.port}`);
    lines.push(`pid: ${info.pid}`);
    lines.push(`branch: ${info.branch || "—（非 git 仓库）"}`);
    lines.push(`repo: ${info.repoDisplay ?? "—"}`);
    lines.push(`userData: ${info.userData}`);
    lines.push("");
    lines.push("## page");
    lines.push(`active: ${page.active || "—"}`);
    lines.push(`selectedTask: ${page.selectedUri ?? "—"}`);
    lines.push(`tabs: ${page.tabs.map((t) => t.key).join(", ") || "—"}`);
    return lines.join("\n");
}
