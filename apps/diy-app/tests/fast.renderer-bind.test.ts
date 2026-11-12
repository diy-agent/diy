/**
 * fast.renderer-bind.test.ts — renderer 侧 `diy.ui.*` 的**装配期**自检（毫秒级，不起 Electron / 不碰 DOM）
 *
 * ## 为什么要有这条
 *
 * renderer 的 handler 树是手写字面量（`const handlers: any = {…}`，因为 `HandlersOf` 对 ui 域
 * 推不出类型），**形状错了 tsc 看不见**。2026-11-11 的 ##87 迁移把 `uiService.bind` 换成
 * `binding.use({ prefix: "diy", api: uiApi, handlers })` 时多包了一层 `ui`：
 * `{ ui: { ui: { component… } } }`。
 *
 * 症状是**首屏白屏**：`mountService` 按路径 `ui.component.list` 取 handler 取不到 → 抛
 * `mountService(diy): 缺少 handler —— ui.component.list` → renderer 在渲染前就崩
 * （`~/.diy/log/main.log` 里只有一行 `[renderer:ERROR]`，窗口照常 show，纯白）。
 *
 * 所以这里真装配一次、真调一次 —— 只断言「不抛」不够，路径拼错（多/少一层）也能装配通过。
 */
import { describe, expect, it } from "vitest";
import { ChannelClientBinding, ChannelServerBinding, createMemTransportPair, createTypedClient } from "@diy-agent/rpc";
import { bindRendererApi } from "../src/renderer_solid/lib/renderer-api-impl";
import { apiDef } from "../src/main/services/api-def";

describe("bindRendererApi 装配", () => {
    it("diy.ui.component.list 真绑上（handler 树与 uiApi 的模块层同构）", async () => {
        const { serverTx, clientTx } = createMemTransportPair();
        expect(() => bindRendererApi(serverTx)).not.toThrow();
        const client = new ChannelClientBinding(clientTx);
        try {
            const rpc = createTypedClient<typeof apiDef>(client, apiDef);
            const r = await rpc.diy.ui.component.list({});
            expect(r.status).toBe("ok");
            expect(r.data.components.length).toBeGreaterThan(0);
        } finally {
            client.dispose();
        }
    });
});
