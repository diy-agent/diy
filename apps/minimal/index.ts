// index.ts — profile：这份 app 装哪些页面，只由这一份 TS 决定（不用 json 配置）。
//
// ##458 的裁决：插件引用 = **直接 import**，不是字符串包名。
//   现在：`import * as chatPageMain from "@diy/chat-page/main"` → tsc 检查包存在、
//        导出类型也一起进来；包名写错一个字母就是编译错，不必等到起窗口。
//   以前：`{ id, name: "@diy/chat-page/main" }` + 运行时 dynamic import → 只有运行时才知道。
//
// 外壳（@diy/workbench）+ 骨架（@diy/ui-workbench）都不认识具体页面，页面由这里带进来。

import * as chatPageMain from "@diy/chat-page/main";
import type { PluginEntry } from "@diy/workbench";
import { TITLE } from "./title.js";

export interface Assembly {
    /** 窗口标题 */
    readonly title: string;
    /** 主进程侧插件清单（按 inject 排序后装配） */
    readonly plugins: readonly PluginEntry[];
}

export const ASSEMBLY: Assembly = {
    title: TITLE,
    plugins: [{ id: "chat-page", type: "module", data: { module: chatPageMain } }],
};
