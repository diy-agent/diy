// @vitest-environment happy-dom
//
// 无窗口验证 ##457 判据 ①②：用 happy-dom 起一份真 DOM，把**真的**布局骨架与**真的**页面实现
// 接上假 gateway（只替掉 Electron 那一层），走「输入一句话 → 出现用户消息 + 固定回复」。
//
// 为什么不是起真 Electron：agent 会话里起 GUI 进程拿不到窗口（app.whenReady 不返回），
// 这是环境限制、不是链路问题；人在本机仍可用 `./sha.sh smoke`（CDP 驱动真窗口）。

import { beforeEach, describe, expect, it } from "vitest";
import { mountWorkbench, registerPage, resetPages } from "@diy-agent/workbench-ui";
import { chatPageView } from "@diy-agent/chat-page/renderer";
import { createPage, FAKE_REPLY } from "@diy-agent/chat-page";
import type { WorkbenchGateway } from "@diy-agent/workbench-ui";

const page = createPage();

const gateway: WorkbenchGateway = {
    listPages: async () => [{ id: page.id, title: page.title }],
    invoke: async (pageId, method, args) => {
        expect(pageId).toBe(page.id);
        expect(method).toBe("send");
        return page.methods!["send"]!(args);
    },
};

beforeEach(() => {
    resetPages();
    document.body.replaceChildren();
});

describe("UI 链路（happy-dom）", () => {
    it("侧栏出现页面标题，输入一句话后出现用户消息 + 固定回复", async () => {
        registerPage(chatPageView);
        const host = document.createElement("div");
        document.body.append(host);
        await mountWorkbench(host, gateway, { title: "测试工作台" });

        // ① 左侧栏有页面入口
        expect(host.querySelector(".wb-nav")?.textContent).toContain("聊天");

        // ② 输入一句话回车 ⇒ 用户消息 + 固定回复
        const input = host.querySelector<HTMLInputElement>(".chat-input");
        const form = host.querySelector<HTMLFormElement>(".chat-composer");
        expect(input).toBeTruthy();
        expect(form).toBeTruthy();
        input!.value = "你好";
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

        await waitFor(() => host.querySelectorAll(".chat-row").length >= 2);
        const rows = [...host.querySelectorAll(".chat-row")].map((row) => ({
            role: (row as HTMLElement).dataset["role"],
            text: row.querySelector(".chat-text")?.textContent,
        }));
        expect(rows).toEqual([
            { role: "user", text: "你好" },
            { role: "assistant", text: FAKE_REPLY },
        ]);
    });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > until) throw new Error("等待超时");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
