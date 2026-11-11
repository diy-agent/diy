// renderer.ts — renderer 入口：注册页面实现，然后挂骨架（页面实现构建期装进，不做动态 import）。

import { installTestHooks, mountWorkbench, registerPage, type WorkbenchGateway } from "@diy-agent/workbench-ui";
// ##468 / ##526：三版并存；换这一行 + rebuild 就切「裸 DOM 版 / diyui 版 / React 版」。
// ##526 起缺省是 React 版（shadcn + M3 令牌，见 docs/ui-architecture.md）。
import { chatPageViewWith, devtoolsViewLoad, standardViewLoad } from "@diy-agent/chat-page/renderer-react";
// ##467：模型配置页（独立插件，删掉这行就没有配置入口）
import { modelConfigPageView } from "@diy-agent/model-config-page/renderer";
// ##474：Bot 配置页（同构独立插件）
import { botConfigPageView } from "@diy-agent/bot-config-page/renderer";
import { titleForMode } from "./title.js";

declare global {
    interface Window {
        workbench?: WorkbenchGateway;
        /** 内存入口的 html 里注入（##505-E / 原 ##504）；落盘版没有 ⇒ undefined */
        __DIY_CHAT_MODE__?: string;
    }
}

async function main(): Promise<void> {
    const host = document.getElementById("app");
    if (!host) throw new Error("index.html 缺 #app 挂载点");
    const gateway = window.workbench;
    if (!gateway) throw new Error("preload 桥没注入 window.workbench");
    registerPage(
    chatPageViewWith([
        // ##539：tab 插槽 —— 加一个 view 只需在这张表里加一行
        { id: "standard", label: "标准", order: 10, load: standardViewLoad },
        { id: "devtools", label: "调试", order: 90, load: devtoolsViewLoad },
    ]),
);
    // ##467：配置页的 view 也在这里注册；但**有没有入口由主进程插件清单决定**（见 index.ts）
    registerPage(modelConfigPageView);
    // ##474：注册决定「怎么画」；有没有入口仍由主进程插件清单决定（见 index.ts）
    registerPage(botConfigPageView);
    // B2：意图测试钩子（只有 DI E2E 进程会发命令；生产调了也只是挂个空 handler）
    installTestHooks();
    // 品牌条标题跟入口走：内存模式必须在界面上看得见（##504 判据 5）
    await mountWorkbench(host, gateway, { title: titleForMode(window.__DIY_CHAT_MODE__) });
}

void main();
