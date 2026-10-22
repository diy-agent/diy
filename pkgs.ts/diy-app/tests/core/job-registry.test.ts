// tests/core/job-registry.test.ts
// 🎯 ##408 刀 3 —— job 定义注册表（`shared/job-registry.ts` + `shared/job-trigger.ts`）
//
// 本刀只有「注册 + 查询 + 算下次时刻」，没有定时器、没有 handler 执行。故这里钉的是**判据**：
//   ① 重复 id 必抛 `agent/duplicate-job-id`（静默覆盖 = 其中一个 handler 永远不跑）；
//   ② kind 与 trigger 必须自洽（spawned 无日程 / scheduled 只吃 interval·daily / event 只吃 event）；
//   ③ `nextAt` 是纯函数：interval 精确、daily 走**本地墙钟**（跨天 / 等号边界 / DST 不存在的时刻）；
//   ④ 禁用 ≠ 算不出：`nextAt` 照算（规则还在），`nextRunAt` 返回 null（策略在这层）；
//   ⑤ 未知 id 是**正常查询结果**：`get` → undefined、`nextRunAt` → null，不抛。

import { describe, it, expect, beforeEach } from "vitest";
import {
    createJobRegistry,
    jobRegistry,
    normalizeJobDefinition,
    registerJob,
    resetJobRegistry,
    type JobDefinition,
} from "../../src/shared/job-registry";
import { MIN_INTERVAL_MS, assertTrigger, describeTrigger, nextAt, type JobTrigger } from "../../src/shared/job-trigger";
import { InvariantError } from "../../src/shared/error-triage";
import type { JobOwner } from "../../src/shared/job-run";

function catchInvariant(fn: () => unknown): InvariantError {
    try {
        fn();
    } catch (e) {
        if (e instanceof InvariantError) return e;
        throw e;
    }
    throw new Error("期望抛 InvariantError，实际没抛");
}

const owner: JobOwner = { type: "global", by: "maintain" };

function def(over: Partial<JobDefinition> = {}): JobDefinition {
    return {
        id: "models.refresh",
        kind: "scheduled",
        title: "刷新模型清单",
        owner,
        trigger: { type: "interval", data: { every: 3_600_000 } },
        enabled: true,
        ...over,
    } as JobDefinition;
}

/** 本地时间构造（daily 的口径是本地墙钟，测试也按本地时间说话） */
function local(y: number, mo: number, d: number, h: number, mi = 0): Date {
    return new Date(y, mo - 1, d, h, mi, 0, 0);
}

beforeEach(() => resetJobRegistry());

describe("注册 —— 只做注册与查询", () => {
    it("register / get / list / size；list 按 id 排序（输出稳定，不随注册顺序抖）", () => {
        const r = createJobRegistry();
        r.register(def({ id: "b.job" }));
        r.register(def({ id: "a.job" }));
        r.register(def({ id: "c.job" }));
        expect(r.size()).toBe(3);
        expect(r.list().map((j) => j.id)).toEqual(["a.job", "b.job", "c.job"]);
        expect(r.get("b.job")?.title).toBe("刷新模型清单");
        expect(r.has("a.job")).toBe(true);
    });

    it("重复 id ⇒ agent/duplicate-job-id（同族命名，见刀 2 裁决）", () => {
        const r = createJobRegistry();
        r.register(def());
        expect(catchInvariant(() => r.register(def())).code).toBe("agent/duplicate-job-id");
        expect(r.size()).toBe(1);
        // 覆盖尝试不该改掉原来那条
        expect(r.get("models.refresh")?.title).toBe("刷新模型清单");
    });

    it("未知 id 查询返回 undefined / null，**不抛**（查询结果不是缺陷）", () => {
        const r = createJobRegistry();
        expect(r.get("nope")).toBeUndefined();
        expect(r.has("nope")).toBe(false);
        expect(r.unregister("nope")).toBe(false);
        expect(r.setEnabled("nope", false)).toBeUndefined();
        expect(r.nextRunAt("nope", local(2026, 10, 22, 8))).toBeNull();
    });

    it("setEnabled 返回**新**对象（定义不可变，面板拿到的旧引用不会偷偷变）", () => {
        const r = createJobRegistry();
        const orig = r.register(def());
        const off = r.setEnabled(orig.id, false);
        expect(off?.enabled).toBe(false);
        expect(orig.enabled).toBe(true);
        expect(r.get(orig.id)?.enabled).toBe(false);
        expect(r.setEnabled(orig.id, true)?.enabled).toBe(true);
    });

    it("unregister 删掉就查不到（返回 true）；再删返回 false", () => {
        const r = createJobRegistry();
        r.register(def());
        expect(r.unregister("models.refresh")).toBe(true);
        expect(r.get("models.refresh")).toBeUndefined();
        expect(r.unregister("models.refresh")).toBe(false);
    });

    it("单例：jobRegistry() 恒等；reset 后重建（新实例为空）", () => {
        const a = jobRegistry();
        expect(jobRegistry()).toBe(a);
        registerJob(def());
        expect(jobRegistry().size()).toBe(1);
        resetJobRegistry();
        const b = jobRegistry();
        expect(b).not.toBe(a);
        expect(b.size()).toBe(0);
    });
});

describe("定义校验 —— 形状 / owner / kind 与 trigger 自洽", () => {
    it("kind 与 trigger 必须自洽（三种错法都要拦）", () => {
        // spawned 不许带日程
        expect(
            catchInvariant(() => normalizeJobDefinition(def({ kind: "spawned", trigger: { type: "interval", data: { every: 1000 } } })))
                .code,
        ).toBe("agent/invalid-job-def");
        // scheduled / event 必须带规则
        expect(catchInvariant(() => normalizeJobDefinition(def({ trigger: null }))).code).toBe("agent/invalid-job-def");
        // 规则类型要匹配 kind（event 型不吃 interval）
        expect(
            catchInvariant(() =>
                normalizeJobDefinition(def({ kind: "event", trigger: { type: "interval", data: { every: 1000 } } })),
            ).code,
        ).toBe("agent/invalid-job-def");
        // scheduled 也不吃 event 规则
        expect(
            catchInvariant(() => normalizeJobDefinition(def({ trigger: { type: "event", data: { topic: "x" } } }))).code,
        ).toBe("agent/invalid-job-def");
    });

    it("spawned 型 job 允许无 trigger（会话临时起的进程没有日程）", () => {
        const d = normalizeJobDefinition(def({ id: "bash.background", kind: "spawned", trigger: null }));
        expect(d.trigger).toBeNull();
        expect(d.kind).toBe("spawned");
    });

    it("id 必须是文件名安全（账本 `$DIY_HOME/jobs/<id>.jsonl` 同一条判据）", () => {
        for (const bad of ["../x", "a/b", "", "有中文", "a b"]) {
            expect(catchInvariant(() => normalizeJobDefinition(def({ id: bad }))).code).toBe("agent/invalid-job-def");
        }
        expect(normalizeJobDefinition(def({ id: "watch_self.v2" })).id).toBe("watch_self.v2");
    });

    it("owner 缺失 / 非法 ⇒ agent/invalid-job-owner（定义问题独立成码，别混进 run 的 code）", () => {
        expect(catchInvariant(() => normalizeJobDefinition({ ...def(), owner: undefined })).code).toBe(
            "agent/invalid-job-owner",
        );
        expect(
            catchInvariant(() => normalizeJobDefinition({ ...def(), owner: { type: "nobody", by: "x" } })).code,
        ).toBe("agent/invalid-job-owner");
    });

    it("handler 非函数（含多余字段）⇒ agent/invalid-job-def；函数则原样保留", () => {
        expect(
            catchInvariant(() => normalizeJobDefinition({ ...def(), handler: "not a fn" })).code,
        ).toBe("agent/invalid-job-def");
        const h = (): { ok: boolean; summary: string } => ({ ok: true, summary: "done" });
        expect(normalizeJobDefinition({ ...def(), handler: h }).handler).toBe(h);
    });

    it("trigger 非法（间隔过小 / 非整数 / at 不是 HH:MM / 多塞字段）⇒ agent/invalid-job-trigger", () => {
        for (const bad of [
            { type: "interval", data: { every: MIN_INTERVAL_MS - 1 } },
            { type: "interval", data: { every: 1500.5 } },
            { type: "interval", data: { every: 60_000, jitter: 5 } },
            { type: "daily", data: { at: "24:00" } },
            { type: "daily", data: { at: "9:00" } },
            { type: "daily", data: { at: "09:60" } },
            { type: "event", data: { topic: "" } },
            { type: "cron", data: {} },
        ]) {
            expect(catchInvariant(() => assertTrigger(bad)).code).toBe("agent/invalid-job-trigger");
        }
        expect(assertTrigger({ type: "daily", data: { at: "00:00" } })).toEqual({ type: "daily", data: { at: "00:00" } });
    });
});

describe("nextAt —— 纯函数，注入时刻不真等", () => {
    it("interval：from + every（永不早于现在）", () => {
        const t: JobTrigger = { type: "interval", data: { every: 90_000 } };
        const from = local(2026, 10, 22, 8, 0);
        expect(nextAt(t, from)?.getTime()).toBe(from.getTime() + 90_000);
    });

    it("daily：今天没到点 ⇒ 今天；过点或正好等于 ⇒ 明天（严格大于）", () => {
        const t: JobTrigger = { type: "daily", data: { at: "09:00" } };
        const before = nextAt(t, local(2026, 10, 22, 8, 30));
        expect(before?.getDate()).toBe(22);
        expect(before?.getHours()).toBe(9);
        expect(before?.getMinutes()).toBe(0);

        const after = nextAt(t, local(2026, 10, 22, 9, 30));
        expect(after?.getDate()).toBe(23);
        expect(after?.getHours()).toBe(9);

        const exact = nextAt(t, local(2026, 10, 22, 9, 0));
        expect(exact?.getDate()).toBe(23); // 等于 from 不算「下一次」，否则原地打转
    });

    it("daily：跨月 / 跨年边界靠 Date 的自然进位（不自己做算术）", () => {
        const t: JobTrigger = { type: "daily", data: { at: "07:00" } };
        const monthEnd = nextAt(t, local(2026, 10, 31, 8, 0));
        expect([monthEnd?.getMonth(), monthEnd?.getDate()]).toEqual([10, 1]); // 11 月 1 日（getMonth 0 基）
        const yearEnd = nextAt(t, local(2026, 12, 31, 8, 0));
        expect([yearEnd?.getFullYear(), yearEnd?.getMonth(), yearEnd?.getDate()]).toEqual([2027, 0, 1]);
    });

    it("daily：**本地墙钟**口径（结果的小时数就是 at，不受时区偏移影响）", () => {
        // 换任何本机时区，算出来的都必须是「本地 09:00」，而不是「UTC 09:00」
        const t: JobTrigger = { type: "daily", data: { at: "09:00" } };
        const n = nextAt(t, local(2026, 10, 22, 0, 1));
        expect([n?.getHours(), n?.getMinutes()]).toEqual([9, 0]);
        expect(n!.getTime() - local(2026, 10, 22, 0, 1).getTime()).toBeGreaterThan(0);
    });

    it("event：无日程 ⇒ null（明确的「没有下一次」，不是算不出来）", () => {
        expect(nextAt({ type: "event", data: { topic: "task.finished" } }, local(2026, 10, 22, 8))).toBeNull();
    });

    it("describeTrigger：人话在 shared 里统一拼（UI 不许各写一份）", () => {
        expect(describeTrigger({ type: "interval", data: { every: 3_600_000 } })).toBe("每 1 小时");
        expect(describeTrigger({ type: "interval", data: { every: 1_800_000 } })).toBe("每 30 分钟");
        expect(describeTrigger({ type: "interval", data: { every: 15_000 } })).toBe("每 15 秒");
        expect(describeTrigger({ type: "interval", data: { every: 1500 } })).toBe("每 1500 毫秒");
        expect(describeTrigger({ type: "daily", data: { at: "09:00" } })).toBe("每天 09:00");
        expect(describeTrigger({ type: "event", data: { topic: "models.changed" } })).toBe("事件 models.changed");
    });
});

describe("nextRunAt —— 「规则算不算」与「该不该跑」分两层", () => {
    it("禁用 ⇒ null；但 nextAt(trigger) 照算（规则还在，UI 要能显示「规则是每天 09:00，已停用」）", () => {
        const r = createJobRegistry();
        const d = r.register(def({ trigger: { type: "daily", data: { at: "09:00" } } }));
        const from = local(2026, 10, 22, 8, 0);
        expect(r.nextRunAt(d.id, from)?.getHours()).toBe(9);
        r.setEnabled(d.id, false);
        expect(r.nextRunAt(d.id, from)).toBeNull();
        expect(nextAt(d.trigger!, from)?.getHours()).toBe(9);
    });

    it("spawned（无 trigger）⇒ null；event 型 ⇒ null", () => {
        const r = createJobRegistry();
        r.register(def({ id: "bash.background", kind: "spawned", trigger: null }));
        r.register(def({ id: "on-task-done", kind: "event", trigger: { type: "event", data: { topic: "task.done" } } }));
        const from = local(2026, 10, 22, 8, 0);
        expect(r.nextRunAt("bash.background", from)).toBeNull();
        expect(r.nextRunAt("on-task-done", from)).toBeNull();
    });
});
