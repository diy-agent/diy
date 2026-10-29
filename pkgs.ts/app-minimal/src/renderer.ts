// renderer.ts — renderer 入口：注册页面实现，然后挂骨架。
//
// 页面实现是**构建期**装进来的（renderer 侧不做动态 import）：装配层知道装了哪个页面，
// 骨架只通过注册表按 id 找实现。

import { mountWorkbench, registerPage, type WorkbenchGateway } from "@diy/ui-workbench";
import { chatPageView } from "@diy/chat-page/renderer";
import { ASSEMBLY } from "./index.js";

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
    await mountWorkbench(host, gateway, { title: ASSEMBLY.title });
}

void main();
