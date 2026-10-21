// tests/core/error-remedy.test.ts
// 🎯 「这个错该去哪修」判据（src/shared/error-remedy.ts）的契约（##407）——**表驱动**。
//
// 为什么穷举：这张表决定提示上**出不出**「🛠 去修复」按钮、点了带人去**哪个**锚点。
//   · 判宽了 → 没有映射的错也冒按钮，点进去发现无处可改（假入口比没有入口更糟）；
//   · 判窄了 → 认证失败 / 配额耗尽时（此刻 LLM 已不可用、agent 帮不上忙）用户还是没指引。
// 所以两侧都要有用例：命中各一条 + **null 分支**（表里没有 ⇒ 不给按钮）。

import { describe, it, expect } from "vitest";
import { ANCHOR_MODEL_PICK, providerAnchor, remedyOf, staticModelChoices } from "../../src/shared/error-remedy";
import { FREE_MODEL_CANDIDATES, FREE_MODEL_CHECKED_AT } from "../../src/shared/model-default";
import type { RemedyInput } from "../../src/shared/error-remedy";

type Case = {
    name: string;
    input: RemedyInput;
    /** null = 不给按钮（表里没有映射） */
    expect: null | { label: string; anchor: string };
};

const CASES: Case[] = [
    // ── auth：唯一动作 = 去把 key 配好；provider 已知就定位到那张卡 ──
    {
        name: "kind=auth + provider 已知 → 定位到那张 provider 卡片",
        input: { reason: "认证失败（401）", ctx: { kind: "auth", provider: "opencode-go" } },
        expect: { label: "去配 provider 密钥", anchor: "provider-std-opencode-go" },
    },
    {
        name: "只有 HTTP 401（没 kind）+ custom provider → 定位到 custom 卡片",
        input: { ctx: { httpStatus: 401, provider: "custom:zhipu" } },
        expect: { label: "去配 provider 密钥", anchor: "provider-custom-zhipu" },
    },
    {
        name: "code=llm/forbidden（403 归一码）+ provider 未知 → 落回模型页顶部引导块",
        input: { code: "llm/forbidden" },
        expect: { label: "去配 provider 密钥", anchor: ANCHOR_MODEL_PICK },
    },
    // ── 配额 / 限流：换模型（或等额度）；文案里必须列出**静态**可用模型 ──
    {
        name: "kind=quota → 换模型（带静态清单）",
        input: { ctx: { kind: "quota", provider: "opencode-go" } },
        expect: { label: "换一个可用模型", anchor: "provider-std-opencode-go" },
    },
    {
        name: "HTTP 429（没 kind）→ 换模型",
        input: { ctx: { httpStatus: 429 } },
        expect: { label: "换一个可用模型", anchor: ANCHOR_MODEL_PICK },
    },
    // ── 模型本身不可用：只能换模型，且与 provider 无关 → 永远落引导块 ──
    {
        name: "kind=coming-soon → 换模型（忽略 provider，锚点固定在引导块）",
        input: { ctx: { kind: "coming-soon", provider: "opencode-go", model: "mimo-v2.6-flash" } },
        expect: { label: "换一个可用模型", anchor: ANCHOR_MODEL_PICK },
    },
    {
        name: "kind=unknown-model（id 不认识）→ 换模型",
        input: { ctx: { kind: "unknown-model", model: "chen56@x/gone" } },
        expect: { label: "换一个可用模型", anchor: ANCHOR_MODEL_PICK },
    },
    // ── null 分支：表里没有 ⇒ 不给按钮（不造假入口） ──
    { name: "没有任何事实 → null", input: {}, expect: null },
    { name: "上游 5xx → null（服务端抖动，不是配置问题）", input: { ctx: { httpStatus: 503 } }, expect: null },
    { name: "步数上限（llm/step-limit）→ null（不是配置能修的）", input: { code: "llm/step-limit" }, expect: null },
    { name: "磁盘满（fs/disk-full）→ null（另一条通道：环境感知顶栏条）", input: { code: "fs/disk-full" }, expect: null },
];

describe("remedyOf（表驱动）", () => {
    for (const c of CASES) {
        it(c.name, () => {
            const r = remedyOf(c.input);
            if (c.expect === null) {
                expect(r).toBeNull();
                return;
            }
            expect(r).not.toBeNull();
            expect(r!.label).toBe(c.expect.label);
            expect(r!.target.page).toBe("models");
            expect(r!.target.anchor).toBe(c.expect.anchor);
        });
    }

    it("引导卡自足：每条都答「改哪个字段 / 填什么 / 为什么不能自动改」", () => {
        for (const c of CASES) {
            const r = remedyOf(c.input);
            if (!r) continue;
            expect(r.hint).toContain("改哪个字段");
            expect(r.hint).toContain("填什么");
            expect(r.hint).toContain("为什么不能自动改");
        }
    });

    it("换模型类的引导带**静态**可用模型清单（含核对日期；不请求任何模型）", () => {
        const r = remedyOf({ ctx: { kind: "unknown-model" } });
        expect(r).not.toBeNull();
        for (const id of FREE_MODEL_CANDIDATES) expect(r!.hint).toContain(id);
        expect(r!.hint).toContain(FREE_MODEL_CHECKED_AT);
        expect(staticModelChoices()).toContain(FREE_MODEL_CANDIDATES[0]!);
    });

    it("reason 进引导卡（有就给「为什么是这条」，没有也不留空行）", () => {
        const withReason = remedyOf({ reason: "认证失败（HTTP 401）", ctx: { kind: "auth" } });
        expect(withReason!.hint).toContain("为什么是这条：认证失败（HTTP 401）");
        const bare = remedyOf({ ctx: { kind: "auth" } });
        expect(bare!.hint).not.toContain("为什么是这条");
    });
});

describe("providerAnchor", () => {
    it("std 与 custom 两个前缀各走一路", () => {
        expect(providerAnchor("opencode-go")).toBe("provider-std-opencode-go");
        expect(providerAnchor("custom:zhipu")).toBe("provider-custom-zhipu");
    });

    it("拿不到 / 空串 → null（调用方回落引导块，不编造卡片名）", () => {
        expect(providerAnchor(null)).toBeNull();
        expect(providerAnchor(undefined)).toBeNull();
        expect(providerAnchor("  ")).toBeNull();
        expect(providerAnchor("custom:")).toBeNull();
    });
});
