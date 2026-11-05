// tests/core/inbox-tools-surface.test.ts
// 🎯 ##519：工具面漂移条目（`kind: "tools-surface"`）—— 花钱的**事先**预报，进信箱才看得见。
//
// 钉三件事（每件都能单独坏）：
//   ① 形状合法（`InboxEntrySchema` 过），且 `kind` 在 `INBOX_KINDS` 里、有中文短名
//   ② 说的是"下一步会花钱"而不是"刚才花了钱"（文案里必须有两个 hash，用户才对得上）
//   ③ `taskUri` 是空串：这是**进程级**事实，不属于任何任务（编一个任务号会误导回看）

import { describe, it, expect } from "vitest";
import { INBOX_KIND_LABEL, INBOX_KINDS, InboxEntrySchema } from "../../src/shared/inbox";
import { inboxEntryOf, toolsSurfaceEntryOf } from "../../src/main/services/inbox";

const entry = () =>
    inboxEntryOf(
        toolsSurfaceEntryOf({
            hash: "bbbb22223333",
            previousHash: "aaaa11112222",
            previousAt: "2026-11-05T10:00:00.000+0800",
        }),
    );

describe("##519 工具面漂移信箱条目", () => {
    it("① 形状合法：schema 过、kind 在清单里、有中文短名", () => {
        const e = entry();
        expect(() => InboxEntrySchema.parse(e)).not.toThrow();
        expect(INBOX_KINDS).toContain(e.kind);
        expect(INBOX_KIND_LABEL["tools-surface"]).toBe("工具面漂移");
        // N1：只落条目，不顶顶栏角标（那条留给「有人在等你」）
        expect(e.level).toBe("N1");
        expect(e.id.startsWith("ib-")).toBe(true);
    });

    it("② 文案讲的是「下一步会全价」，且带前后 hash 与前次时刻", () => {
        const e = entry();
        expect(e.text).toContain("aaaa1111");
        expect(e.text).toContain("bbbb2222");
        expect(e.text).toContain("全价");
        expect(e.source).toContain("2026-11-05T10:00:00.000+0800");
        // 数字不撒谎：结构化事实里能在机器侧读到同一对 hash
        expect(e.data?.["hash"]).toBe("bbbb22223333");
        expect(e.data?.["previousHash"]).toBe("aaaa11112222");
        // 怎么查 / 怎么改，要写在 detail 里（不许只留一句「变了」）
        expect(e.detail).toContain("tools-surface-golden");
    });

    it("③ taskUri 空串 = 进程级事实，不冒充某个任务", () => {
        expect(entry().taskUri).toBe("");
    });

    it("上次时刻缺失时不崩，文案退回「未知」", () => {
        const e = inboxEntryOf(toolsSurfaceEntryOf({ hash: "bb", previousHash: "aa", previousAt: "" }));
        expect(e.source).toContain("未知");
        expect(e.data?.["previousAt"]).toBeNull();
    });
});
