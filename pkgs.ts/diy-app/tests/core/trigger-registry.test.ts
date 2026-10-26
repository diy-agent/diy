import { describe, expect, it } from "vitest";

// ⚠️ 顺序敏感：本 import **在模块求值时就把内置 6 条注册了**。
// 所以「内置目录」那个 describe 必须排在最前，且**不带 reset**
// （`__resetTriggerRegistry()` 会把它们清掉，而 ESM 模块不会重新求值）。
import "../../src/main/triggers";
import {
    __resetTriggerRegistry,
    defineTrigger,
    listTriggers,
    totalDispatchCount,
    triggerCount,
    triggerEmitCounts,
} from "../../src/main/services/trigger-registry";
import { isValidTriggerId, triggerNamespace } from "../../src/shared/trigger";

/** 断言错误码而不是文案：文案会变，码是契约。 */
function expectCode(fn: () => unknown, code: string): void {
    try {
        fn();
    } catch (e) {
        expect((e as { code?: string }).code).toBe(code);
        return;
    }
    throw new Error(`期望抛 ${code}，实际没抛`);
}

/* ───────────── ① 内置目录（必须在任何 reset 之前）───────────── */

describe("内置触发器目录", () => {
    it("六条一条不少（少了说明某个模块没被 import，静默失效）", () => {
        const ids = listTriggers().map((t) => t.id);
        expect(ids).toEqual([
            "env:broken",
            "inbox:message",
            "job:run-settled",
            "job:session-aborted",
            "notice:model-down",
            "watch:changed",
        ]);
        expect(triggerCount()).toBe(6);
    });

    it("每条都带命名空间，且都有说明与出口", () => {
        for (const t of listTriggers()) {
            expect(triggerNamespace(t.id)).toBe(t.id.slice(0, t.id.indexOf(":")));
            expect(t.desc.length).toBeGreaterThan(0);
            expect(t.sinks.length).toBeGreaterThan(0);
        }
    });

    it("强度只有 N0~N3，没有漏网的字符串", () => {
        const allowed = new Set(["N0", "N1", "N2", "N3"]);
        for (const t of listTriggers()) expect(allowed.has(t.level)).toBe(true);
    });
});

/* ───────────── ② 注册表行为（每条用例先清空）───────────── */

describe("注册表", () => {
    function fresh() {
        __resetTriggerRegistry();
    }

    it("合法定义返回句柄，字段与定义一致", () => {
        fresh();
        const h = defineTrigger<{ n: number }>({
            id: "test:ping",
            desc: "测试用",
            level: "N2",
            sinks: ["inbox"],
        });
        expect(h.id).toBe("test:ping");
        expect(h.level).toBe("N2");
        expect(h.sinks).toEqual(["inbox"]);
        expect(triggerCount()).toBe(1);
    });

    it("id 没有命名空间 ⇒ trigger/bad-id", () => {
        fresh();
        expectCode(
            () => defineTrigger({ id: "run-settled", desc: "x", level: "N1", sinks: ["owner"] }),
            "agent/trigger-bad-id",
        );
    });

    it("id 含大写 / 空格 ⇒ trigger/bad-id", () => {
        fresh();
        expectCode(
            () => defineTrigger({ id: "Job:Run", desc: "x", level: "N1", sinks: ["owner"] }),
            "agent/trigger-bad-id",
        );
    });

    it("重复注册同一个 id ⇒ trigger/duplicate（不静默覆盖）", () => {
        fresh();
        const def = { id: "test:dup", desc: "x", level: "N1" as const, sinks: ["inbox"] };
        defineTrigger(def);
        expectCode(() => defineTrigger(def), "agent/trigger-duplicate");
    });

    it("没有出口 ⇒ trigger/no-sink（投给谁都没说）", () => {
        fresh();
        expectCode(
            () => defineTrigger({ id: "test:nosink", desc: "x", level: "N1", sinks: [] }),
            "agent/trigger-no-sink",
        );
    });

    it("没有说明 ⇒ trigger/no-desc（目录里会变成空白行）", () => {
        fresh();
        expectCode(() => defineTrigger({ id: "test:nodesc", desc: "  ", level: "N1", sinks: ["inbox"] }), "agent/trigger-no-desc");
    });

    it("emit 计数，且 dispatch 只计数不产生通知（本步不动行为）", () => {
        fresh();
        const h = defineTrigger<{ a: number }>({
            id: "test:count",
            desc: "x",
            level: "N3",
            sinks: ["ignored"],
        });
        h.emit({ a: 1 });
        h.emit({ a: 2 });
        expect(triggerEmitCounts()["test:count"]).toBe(2);
        expect(totalDispatchCount()).toBe(2);
    });

    it("listTriggers 按 id 排序，不跟着注册顺序", () => {
        fresh();
        for (const id of ["test:c", "test:a", "test:b"]) {
            defineTrigger({ id, desc: "x", level: "N3", sinks: ["inbox"] });
        }
        expect(listTriggers().map((t) => t.id)).toEqual(["test:a", "test:b", "test:c"]);
    });
});

/* ───────────── ③ 纯函数 ───────────── */

describe("id 校验（纯函数，不依赖注册表）", () => {
    it("合法的：单段与多段都行", () => {
        for (const id of ["job:run-settled", "watch:changed", "my-plugin:stale-dep", "env:disk.full"]) {
            expect(isValidTriggerId(id)).toBe(true);
        }
    });

    it("非法的：没有冒号 / 空段 / 大写 / 数字开头后面符号", () => {
        for (const id of ["", "noseparator", ":x", "x:", "Job:x", "a b:c", "-x:y"]) {
            expect(isValidTriggerId(id)).toBe(false);
        }
    });

    it("命名空间取冒号前那半，非法 id 返回 null", () => {
        expect(triggerNamespace("job:run-settled")).toBe("job");
        expect(triggerNamespace("my-plugin:x")).toBe("my-plugin");
        expect(triggerNamespace("broken")).toBe(null);
    });
});
