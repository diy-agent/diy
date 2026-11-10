// @vitest-environment happy-dom
//
// 无窗口验证 ##457 判据 ①②：用 happy-dom 起一份真 DOM，把**真的**布局骨架与**真的**页面实现
// 接上假 gateway（只替掉 Electron 那一层），走「输入一句话 → 出现用户消息 + 固定回复」。
//
// 为什么不是起真 Electron：agent 会话里起 GUI 进程拿不到窗口（app.whenReady 不返回），
// 这是环境限制、不是链路问题；人在本机仍可用 `./sha.sh smoke`（CDP 驱动真窗口）。

import { beforeEach, describe, expect, it } from "vitest";
import { mountWorkbench, registerPage, resetPages } from "@diy-agent/workbench-ui";
import { chatPageView, registerBlockRenderer, renderBlock } from "@diy-agent/chat-page/renderer-react";
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

/**
 * 往受控输入框里「打字」。
 * ##526：输入框是 React 受控组件 —— 直接赋 `input.value` 不会让 React 的 state 跟着变
 * （提交时读到的是空串）。必须走原生 setter + `input` 事件，跟真用户敲键同一条路。
 */
function typeInto(input: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

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
        // 侧栏只有一份菜单（窄态图标 / 宽态图标+文字），文字始终在 DOM 里（##用户裁：不再有抽屉）
        expect(host.querySelector(".wb-side")?.textContent).toContain("聊天");

        // ② 输入一句话回车 ⇒ 用户消息 + 固定回复
        const input = host.querySelector<HTMLInputElement>(".chat-input");
        const form = host.querySelector<HTMLFormElement>(".chat-composer");
        expect(input).toBeTruthy();
        expect(form).toBeTruthy();
        typeInto(input!, "你好");
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

    it("侧栏是**一份**菜单：每个页面一个入口，展开只是原地变宽（用户 2026-11-02 裁）", async () => {
        registerPage(chatPageView);
        const pages = [
            { id: "chat", title: "聊天", icon: "💬", group: "对话" },
            { id: "models", title: "模型配置", icon: "🧠", group: "设置" },
            { id: "bots", title: "Bot 配置", icon: "🤖", group: "设置" },
        ];
        for (const info of pages.slice(1)) {
            registerPage({ ...info, render: () => undefined });
        }
        const host = document.createElement("div");
        document.body.append(host);
        await mountWorkbench(
            host,
            { listPages: async () => pages, invoke: async () => undefined },
            { title: "测试工作台" },
        );

        // 每个页面**一个**按钮（窄态只见图标、宽态图标+文字）；抽屉 / 窄 bar 按钮都已不存在
        expect(host.querySelectorAll(".wb-nav-item").length).toBe(3);
        expect(host.querySelector(".wb-drawer")).toBeNull();
        expect(host.querySelector(".wb-rail-btn")).toBeNull();
        // 标题就在同一份按钮里，不需要第二份列表才有文字
        const labels = [...host.querySelectorAll(".wb-nav-label")].map((node) => node.textContent);
        expect(labels).toEqual(["聊天", "模型配置", "Bot 配置"]);

        // 展开 = 钉住（`data-open`）：宽窄是 CSS 的事，DOM 里菜单项数量不变
        (host.querySelector(".wb-side-toggle") as HTMLButtonElement).click();
        expect(host.querySelector(".wb-side")?.getAttribute("data-open")).toBe("true");
        expect(host.querySelectorAll(".wb-nav-item").length).toBe(3);
    });

    it("##499 判据 3 / 4：插件注册的 kind 用自己的渲染器；未注册的走 fallback 不崩", async () => {
        // 插件自造 kind：编译期显式注册，UI 主代码一行不改
        registerBlockRenderer("my-test", (block) => {
            const el = document.createElement("div");
            el.className = "my-test";
            el.textContent = `自定义:${String(block.data["value"])}`;
            return el;
        });
        const custom: WorkbenchGateway = {
            listPages: async () => [{ id: page.id, title: page.title }],
            invoke: async (_pageId, method) => {
                if (method === "snapshot") throw new Error("单会话模式");
                return {
                    messages: [
                        {
                            role: "assistant",
                            blocks: [
                                { kind: "my-test", id: "x", data: { value: "hi" } },
                                { kind: "nope", id: "y", data: { a: 1 } },
                            ],
                        },
                    ],
                };
            },
        };
        registerPage(chatPageView);
        const host = document.createElement("div");
        document.body.append(host);
        await mountWorkbench(host, custom, { title: "测试工作台" });

        const input = host.querySelector<HTMLInputElement>(".chat-input")!;
        typeInto(input, "触发");
        host.querySelector<HTMLFormElement>(".chat-composer")!.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
        );

        await waitFor(() => host.querySelector(".my-test") !== null);
        expect(host.querySelector(".my-test")?.textContent).toBe("自定义:hi");
        // 未注册的 kind：fallback 显示 JSON + 「未知块类型」，不崩不白屏
        const unknown = host.querySelector(".chat-block-unknown");
        expect(unknown?.textContent).toContain("未知块类型: nope");
        expect(unknown?.textContent).toContain('"a": 1');
    });

    it("##499 判据 6：tool 块运行中展开、结束后收起", () => {
        const running = renderBlock({ kind: "tool", id: "t1", data: { name: "read", args: "{}", state: "running" } }) as HTMLDetailsElement;
        expect(running.open).toBe(true);
        expect(running.dataset["state"]).toBe("running");
        const ok = renderBlock({ kind: "tool", id: "t2", data: { name: "read", args: "{}", state: "ok", summary: "完成" } }) as HTMLDetailsElement;
        expect(ok.open).toBe(false);
    });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > until) throw new Error("等待超时");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
