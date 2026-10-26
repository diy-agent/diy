// tests/core/delivery-badge.test.ts
// 🎯 「历史」徽章的文案真源（##423）：徽章文本 / hover 是**契约**，这里逐条钉住。
//
// 用户 2026-10-23：「Q3 需要写清楚，不然我也搞不清触发条件」——
// 旧文案 `投递·全量` 的「全量」在 runtime 语境里读作「runtime 全量投递」，
// 实际含义只是「这一步一条历史消息都没丢」（历史裁剪维度）。
//
// ##432 刀 2 之后口径又变了一次（用户 2026-10-25 复查）：
//   · 唯一旋钮是 `history.limit.limitTokens`（token）⇒ 徽章里的数**一律 token**，不再拿字节比 token 上限；
//   · 「什么时候会压」是**事件制**（写边界），三触发器只写审计 —— hover 必须把这条界线说清。

import { describe, it, expect } from "vitest";
import {
    deliveryBadgeText,
    deliveryBadgeTitle,
    fmtBudgetBytes,
    fmtLimitTokens,
    fmtTokensShort,
    TRIGGER_LABEL,
    type DeliveryBadgeInput,
} from "../../src/shared/context/delivery-badge";

const sel = (over: Partial<DeliveryBadgeInput["selection"]> = {}): DeliveryBadgeInput["selection"] => ({
    retainTokens: 20_000,
    keptTokens: 4_100,
    droppedTokens: 12_300,
    keptBytes: 20_480,
    keptRuns: 2,
    droppedMessages: 0,
    totalMessages: 5,
    ...over,
});

const input = (over: Partial<DeliveryBadgeInput> = {}): DeliveryBadgeInput => ({
    selection: sel(),
    boundary: null,
    ...over,
});

describe("##423 徽章文本：维度写在词里，且数一律 token", () => {
    it("没丢消息 → 「历史·无裁剪」", () => {
        expect(deliveryBadgeText(sel())).toBe("历史·无裁剪");
    });

    it("丢了 → 报 **token**（不是条数、更不是字节）：`历史·丢 12.3k tok`", () => {
        expect(deliveryBadgeText(sel({ droppedMessages: 3 }))).toBe("历史·丢 12.3k tok");
    });

    it("老账本没有 droppedTokens → 退回条数，**不拿字节换算**", () => {
        const old = sel({ droppedMessages: 3 });
        delete (old as { droppedTokens?: number }).droppedTokens;
        expect(deliveryBadgeText(old)).toBe("历史·丢 3 条");
    });

    it("任何情况下都不出现裸「全量」", () => {
        for (const d of [0, 3]) expect(deliveryBadgeText(sel({ droppedMessages: d }))).not.toContain("全量");
    });
});

describe("##423 徽章 hover：维度 / 口径 / 什么时候会压 / 三触发器只写审计", () => {
    it("① 首行说清维度 + 全用 token（上限 / 保留 / 丢几条+tok / 段数）", () => {
        const t = deliveryBadgeTitle(input({ selection: sel({ droppedMessages: 3 }) }));
        expect(t).toContain("历史裁剪");
        expect(t).toContain("与 runtime 无关");
        expect(t).toContain("20,000 token");
        expect(t).toContain("4.1k tok");
        expect(t).toContain("丢 3/5 条（12.3k tok）");
        expect(t).toContain("2 段");
    });

    it("② 口径那一句只有一个数域（token）；字节口径退场", () => {
        const t = deliveryBadgeTitle(input());
        expect(t).toContain("中文 1 字 1 token");
        expect(t).toContain("与上限同一个数域");
        expect(t).not.toContain("KB");
    });

    it("字节人读小件仍可用（装配层硬上限用），但**不进**徽章", () => {
        expect(fmtBudgetBytes(3072)).toBe("3 KB");
        expect(deliveryBadgeTitle(input())).not.toContain(fmtBudgetBytes(20_480));
    });

    it("③ 事件制：没边界 → 说「投递的是全量」，有边界 → 说「哪次事件写的、之后不重算」", () => {
        expect(deliveryBadgeTitle(input({ boundary: null }))).toContain("还没有压缩事件");
        const t = deliveryBadgeTitle(
            input({ boundary: { at: "2026-10-25T10:00:00.000Z", dropped: 7, retainTokens: 12_000 } }),
        );
        expect(t).toContain("2026-10-25T10:00:00.000Z 写的压缩事件");
        expect(t).toContain("丢 7 条");
        expect(t).toContain("12,000 token");
        expect(t).toContain("不重算");
        // 再压的判据 = **只看保留段**，不是全量
        expect(t).toContain("只看保留段自己");
    });

    it("边界没取到 → 整块省略，不编事实（##442 删 mode 后徽章只讲历史裁剪）", () => {
        const t = deliveryBadgeTitle({ selection: sel() });
        expect(t).not.toContain("压缩事件");
        expect(t).not.toContain("自动压缩");
    });

    it("`must` / 字节预算这些 ##432 已删的词不再出现", () => {
        const t = deliveryBadgeTitle(input({ boundary: null }));
        expect(t).not.toContain("must");
        expect(t).not.toContain("预算");
        expect(t).not.toContain("KB");
    });
});

describe("人读小件", () => {
    it("fmtTokensShort：1000 以下原样，千以上一位小数（不丢精度也不啰嗦）", () => {
        expect(fmtTokensShort(820)).toBe("820");
        expect(fmtTokensShort(3_400)).toBe("3.4k");
        expect(fmtTokensShort(4_000)).toBe("4k");
    });

    it("fmtLimitTokens：千位分隔 + token 单位", () => {
        expect(fmtLimitTokens(20_000)).toBe("20,000 token");
    });

    it("触发器短名仍与压缩详情共用（不另起一套词）", () => {
        expect(TRIGGER_LABEL.manual).toBe("手动");
        expect(TRIGGER_LABEL.contextWindowOver).toBe("窗口超限");
    });
});
