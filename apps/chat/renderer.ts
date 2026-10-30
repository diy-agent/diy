// renderer.ts — renderer 入口：注册页面实现，然后挂骨架。
//
// 页面实现是**构建期**装进来的（renderer 侧不做动态 import）：装配层知道装了哪个页面，
// 骨架只通过注册表按 id 找实现。

import { mountWorkbench, registerPage, type WorkbenchGateway } from "@diy-agent/workbench-ui";
// ##468：渲染层两版并存（同包两个入口，wire 协议同一份）。
// 换这一行 + 重新 build 就在「裸 DOM 版 / diyui 版」之间切：
//   @diy-agent/chat-page/renderer        ← 裸 DOM（最小依赖对照组）
//   @diy-agent/chat-page/renderer-diui   ← diyui 版（不闪 / 滚动不跳 / 焦点不丢）
import { chatPageView } from "@diy-agent/chat-page/renderer-diui";
// ##467：模型配置页（独立插件，删掉这行就没有配置入口）
import { modelConfigPageView } from "@diy-agent/model-config-page/renderer";
import { TITLE } from "./title.js";

declare global {
    interface Window {
        workbench?: WorkbenchGateway;
    }
}

async function main(): Promise<void> {
    const host = document.getElementById("app");
    if (!host) throw new Error("index.html 缺 #app 挂载点");
    const gateway = window.workbench;
    if (!gateway) throw new Error("preload 桥没注入 window.workbench");
    registerPage(chatPageView);
    // ##467：配置页的 view 也在这里注册；但**有没有入口由主进程插件清单决定**（见 index.ts）
    registerPage(modelConfigPageView);
    await mountWorkbench(host, gateway, { title: TITLE });
}

void main();
