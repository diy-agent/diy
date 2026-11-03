// tests/core/flow-render.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 宿主产物链的**单测**（##337 review1 P3-1）：意图测试（`cli.intent.flow.test.ts`）覆盖端到端
//    「放 raw → 出 view」；这里补端到端**造不出来**的两件：
//      1. `translateArtifact` 的四条立场 —— 它是全工程**唯一**的翻译出口（`flow view` 与 `flow show`
//         都只走它），故它的边界比任何一条命令都该被钉住；
//      2. 「声明的 renderer 必须与插件结果一致」那道闸门 —— 要一份**失配的 `art`** 才到得了，
//         而生产定义里不该存在失配的 art（有就是 bug），故只有单测能直接构造。
//    外加一条**定义自洽**回归（P2-A 的护身符）：`workflows/dev.ts` 每个节点的 `art.renderer` 必须
//    等于其插件对样本 raw 的产物 renderer —— P2-A 正是这条缝：声明 `doc` 却不挂插件，裸文本直吃
//    raw ⇒ UI 上只剩「形状不符」，用户永远看不到 CI 输出。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { translateArtifact } from "../../src/main/core/flow";
import { DEV_WORKFLOW } from "../../src/main/workflows/dev";
import { createRenderRegistry } from "../../src/main/workflows/plugins";

/** 只作错误消息 / 袋路径的落点，本文件从不落盘（翻译是纯函数） */
const URI = "projects/1/tasks/1";
/** 与宿主 `core/flow.ts::anchorOf` 同形的「这条泳道的节点」锚点（`@diy-agent/talk` 的 `node` 分支） */
const ANCHOR = { type: "node", data: { nodeId: "implement" } } as const;

/** 每个注册插件的样本 raw（形状由插件自己认；缺样本 = 该补，见下面的覆盖断言） */
const SAMPLES: Record<string, unknown> = {
    patch: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-旧\n+新\n",
    records: [{ 项: "落点", 结论: "已补" }],
    text: "./sha.sh check\nEXIT=0\n",
};

describe("translateArtifact：宿主唯一的翻译出口（##337）", () => {
    it("无产物（缺项 / null）⇒ null：**不是错**（产物不是领域态，缺项是正常态）", () => {
        const art = { raw: "纯文本", renderer: "doc", plugin: "text" } as const;
        expect(translateArtifact(URI, "ci", art, undefined)).toBeNull();
        expect(translateArtifact(URI, "ci", art, null)).toBeNull();
    });

    it("`plugin` 留空 = 直吃 raw：payload 就是 raw 本身（唯一合法含义 = raw 已是该 renderer 的 data）", () => {
        const art = { raw: "已经是 badge 的 data", renderer: "badge" } as const;
        const raw = { label: "绿", tone: "ok" };
        const view = translateArtifact(URI, "implement", art, raw);
        expect(view).toEqual({ renderer: "badge", payload: raw });
        expect(view!.payload).toBe(raw); // **同一个引用**：宿主不替它包一层（要包就写成插件）
    });

    it("插件返回的 renderer ≠ 声明 ⇒ 当场抛（声明是 UI 预选渲染器的契约，撒谎就炸）", () => {
        // records 给的是 table，声明却写 diff
        const wrong1 = { raw: "评审清单", renderer: "diff", plugin: "records" } as const;
        expect(() => translateArtifact(URI, "review", wrong1, [{ 项: "x" }])).toThrow(/不一致/);
        // 反向：patch 给的是 diff，声明却写 doc —— 裸字符串配 doc 正是 P2-A 那条缝
        const wrong2 = { raw: "diff 文本", renderer: "doc", plugin: "patch" } as const;
        expect(() => translateArtifact(URI, "implement", wrong2, "-旧\n+新\n")).toThrow(/不一致/);
    });

    it("插件名打错 ⇒ 抛（绝不静默降级成「没产物」）", () => {
        const art = { raw: "x", renderer: "doc", plugin: "text2" } as const;
        expect(() => translateArtifact(URI, "ci", art, "x")).toThrow(/未注册的插件/);
    });
});

describe("dev 定义的产物链自洽（P2-A 的护身符）", () => {
    it("每个注册插件都有样本 raw，且每个节点的 art.renderer == 该插件对样本的产物 renderer", () => {
        const registry = createRenderRegistry();
        for (const name of registry.names("render")) {
            expect(SAMPLES, `render 插件 ${name} 缺样本 raw（新增插件时补上）`).toHaveProperty(name);
        }
        const withArt = DEV_WORKFLOW.nodes.filter((n) => n.art);
        expect(withArt.length, "dev 定义应至少有一个声明了 art 的节点").toBeGreaterThan(0);
        for (const node of withArt) {
            const art = node.art!;
            if (!art.plugin) continue; // 直吃 raw 的节点：raw 必须已是该 renderer 的 data（无插件可查）
            const plugin = registry.resolve("render", art.plugin);
            const view = plugin(SAMPLES[art.plugin], ANCHOR);
            expect(view.renderer, `节点 ${node.id} 声明 ${art.renderer}，插件 ${art.plugin} 却给出 ${view.renderer}`).toBe(art.renderer);
        }
    });

    it("`doc` 的产物必须是 `{ text: string }`（裸文本配 doc = P2-A 的错），且非文本 raw 被拒", () => {
        const registry = createRenderRegistry();
        const art = DEV_WORKFLOW.nodes.find((n) => n.id === "ci")!.art!;
        expect(art.renderer).toBe("doc");
        expect(art.plugin, "ci 的 raw 是纯文本，必须挂插件把「纯文本 → { text }」这步说出来").toBe("text");
        const view = translateArtifact(URI, "ci", art, SAMPLES["text"]);
        expect(view!.renderer).toBe("doc");
        // `DocData` = `{ text: string }`：对象形态（不是裸字符串）+ text 是字符串
        expect(view!.payload).toMatchObject({ text: expect.any(String) });
        expect(typeof view!.payload).not.toBe("string");
        // 只会包文本：给个没有 text 的对象 ⇒ 拒（不猜、不降级）
        const text = registry.resolve("render", "text");
        expect(() => text({ rows: [] }, ANCHOR)).toThrow(/应为字符串/);
    });
});
