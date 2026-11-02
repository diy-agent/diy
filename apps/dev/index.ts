// index.ts — profile：这份 app 装哪些页面，只由这一份 TS 决定（见 ##458 的裁决）。
//
// 本 app 只有一个页面（dev 启动器）。外壳（@diy-agent/workbench）负责窗口 + `page:invoke` 通道，
// 页面实现与 renderer 的落点由这里带进来。

import type { PluginEntry } from "@diy-agent/workbench";
import * as devPage from "./dev-page.js";
import { TITLE } from "./title.js";

export interface Assembly {
    readonly title: string;
    readonly plugins: readonly PluginEntry[];
}

export const ASSEMBLY: Assembly = {
    title: TITLE,
    plugins: [{ id: "dev", type: "module", data: { module: devPage } }],
};
