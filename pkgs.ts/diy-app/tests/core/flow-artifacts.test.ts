// tests/core/flow-artifacts.test.ts
// 🎯 产物取数的**粒度**（##320 review1 P1-1）：每个驻留必须带**自己的 `seq`** 取数。
//
// 为什么这层能钉死它：`collectArtifacts`（纯派生层，不碰 RPC）的 IO 是**注入**的 —— 桩能记下
// 「每个驻留到底拿了什么参数」，而这正是 bug 的判据：旧实现按**节点**取数（不传 seq）⇒
// `flow view` 缺省给「该节点最后一次驻留」的产物 ⇒ 早前驻留显示后一次的（打回后第 2 次评审
// 结论盖掉第 1 次的）。E2E 那侧的同名判据在 `tests/cli.intent.flow-ui.test.ts`（要 ##337 接入）。
//
// 契约：
//   1. 取数粒度 = 落位粒度 = **驻留**（`visitKey(node, seq)`），每个驻留用自己的 seq 取
//   2. 四态如实分：`ready` / `none`（确实没产物）/ `unavailable`（命令不在或调用失败）/ `loading`
//   3. 一个驻留取数失败**不牵连**别的驻留（各落各的）

import { describe, it, expect } from "vitest";
import {
    collectArtifacts,
    visitKey,
    type ArtifactProbe,
    type FlowVisitBrief,
} from "../../src/renderer_solid/lib/flow-model";

const URI = "projects/1/tasks/1";

const visit = (node: string, seq: number): FlowVisitBrief => ({
    node,
    seq,
    kind: seq > 1 ? "bounce" : "next",
    at: "2026-10-15T00:00:00.000Z",
});

/** 桩：产物内容 = `RAW:<节点>:<第几次驻留>` —— 内容里带着「它是哪次驻留的」，串台一眼可辨 */
const artOf = (node: string, seq: number): ArtifactProbe => ({
    ok: true,
    value: { uri: URI, node, seq, art: { raw: `RAW:${node}:${seq}`, renderer: "table" }, view: null },
});

describe("产物取数：逐驻留（##320 review1 P1-1）", () => {
    it("每个驻留带**自己的 seq** 取数；同节点二次驻留不退化", async () => {
        const calls: Array<[string, string, number | undefined]> = [];
        const visits = [visit("implement", 1), visit("review", 1), visit("implement", 2), visit("review", 2)];

        const out = await collectArtifacts(URI, visits, async (uri, node, seq) => {
            calls.push([uri, node, seq]);
            return artOf(node, seq!);
        });

        // 取数调用逐一对上（顺序不保证 —— 并发取数，故排序后比）
        expect([...calls].sort()).toEqual([
            [URI, "implement", 1],
            [URI, "implement", 2],
            [URI, "review", 1],
            [URI, "review", 2],
        ]);
        // 落位逐个对得上：卡上的内容必须是**它自己那次**的
        const rawOf = (node: string, seq: number) => {
            const st = out[visitKey(node, seq)];
            return st?.kind === "ready" ? st.value.art?.raw : `(非 ready：${st?.kind})`;
        };
        expect(rawOf("review", 1)).toBe("RAW:review:1");
        expect(rawOf("review", 2)).toBe("RAW:review:2");
        expect(Object.keys(out).sort()).toEqual(["implement#1", "implement#2", "review#1", "review#2"]);
    });

    it("回归有牙：取数一旦退化成「节点最后一次」（老实现）⇒ 早前驻留就串台", async () => {
        const visits = [visit("review", 1), visit("review", 2)];
        // 老实现：忽略 seq，只按节点取 ⇒ 命令缺省给最后一次驻留（seq=2）
        const oldWay = await collectArtifacts(URI, visits, async (_uri, node) => artOf(node, 2));
        const st = oldWay[visitKey("review", 1)];
        expect(st?.kind).toBe("ready");
        expect(st?.kind === "ready" ? st.value.art?.raw : "").toBe("RAW:review:2"); // ← 正是 P1-1 的症状
        expect(st?.kind === "ready" ? st.value.art?.raw : "").not.toBe("RAW:review:1");
    });

    it("四态如实分：null ⇒ none；命令不在/抛错 ⇒ unavailable，且不牵连别的驻留", async () => {
        const visits = [visit("implement", 1), visit("review", 1), visit("ci", 1)];
        const out = await collectArtifacts(URI, visits, async (_uri, node, seq) => {
            if (node === "implement") return { ok: true, value: null }; // 该驻留确实没产物
            if (node === "review") return { ok: false, reason: "主进程未提供 `diy flow view` 命令（##337 未合入）" };
            throw new Error("调用炸了"); // 命令在但出错
        });
        expect(out[visitKey("implement", 1)]).toEqual({ kind: "none" });
        expect(out[visitKey("review", 1)]).toEqual({ kind: "unavailable", reason: "主进程未提供 `diy flow view` 命令（##337 未合入）" });
        expect(out[visitKey("ci", 1)]).toEqual({ kind: "unavailable", reason: "调用炸了" });
    });

    it("key 与落位同源：`visitKey` 是唯一命名（`节点#序号`）", () => {
        expect(visitKey("review", 2)).toBe("review#2");
    });

    it("空折线 ⇒ 空表（不编造卡）", async () => {
        expect(await collectArtifacts(URI, [], async () => artOf("x", 1))).toEqual({});
    });

    it("ready 态**原样**带上 view 载荷（取数层不加工，渲染归 UI）", async () => {
        const probe: ArtifactProbe = {
            ok: true,
            value: {
                uri: URI,
                node: "review",
                seq: 1,
                art: { raw: '{"columns":[],"rows":[]}', renderer: "table" },
                view: { renderer: "table", payload: { columns: ["项"], rows: [] } },
            },
        };
        const out = await collectArtifacts(URI, [visit("review", 1)], async () => probe);
        const st = out[visitKey("review", 1)];
        expect(st?.kind).toBe("ready");
        if (st?.kind === "ready" && probe.ok) expect(st.value).toEqual(probe.value);
        else throw new Error("应落在 ready 态");
    });
});
