// index.ts — 装配清单：装哪些页面插件，只由这一份决定。
//
// 这是「profile」的最小形态：外壳（@diy/workbench）+ 骨架（@diy/ui-workbench）都不认识
// 具体页面，页面由插件清单带进来。要换一套页面 = 改这里（或者再写一份 app-* 包）。

import type { PluginEntry } from "@diy/workbench";

export interface Assembly {
    /** 窗口标题 */
    readonly title: string;
    /** 主进程侧插件清单（按 inject 排序后加载） */
    readonly plugins: readonly PluginEntry[];
}

export const ASSEMBLY: Assembly = {
    title: "最小工作台（假模型）",
    plugins: [{ id: "chat-page", name: "@diy/chat-page/main" }],
};
