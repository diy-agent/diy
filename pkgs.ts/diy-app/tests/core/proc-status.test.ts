import { describe, expect, it } from "vitest";
import {
    exitText,
    formatDuration,
    isTerminal,
    MAX_TAIL_BYTES,
    notifyText,
    procLine,
    stateLabel,
    tailOf,
} from "../../src/shared/proc-status";

// ##408 刀 8：后台进程的呈现口径（纯函数）。判据写进用例名，改实现先看这些句子还成不成立。

describe("状态与时长", () => {
    it("四态各自有人话；running 之外的三个都是终态", () => {
        expect(stateLabel("running")).toBe("运行中");
        expect(stateLabel("exited")).toBe("已结束");
        expect(stateLabel("killed")).toBe("已被杀");
        expect(stateLabel("failed")).toBe("启动失败");
        expect(isTerminal("running")).toBe(false);
        expect([isTerminal("exited"), isTerminal("killed"), isTerminal("failed")]).toEqual([true, true, true]);
    });

    it("时长按量级换单位：毫秒 / 一位小数秒 / 分秒；负值与缺省给破折号", () => {
        expect(formatDuration(400)).toBe("400ms");
        expect(formatDuration(999)).toBe("999ms");
        expect(formatDuration(1000)).toBe("1.0s");
        expect(formatDuration(11_768)).toBe("11.8s");
        expect(formatDuration(60_000)).toBe("1m00s");
        expect(formatDuration(185_000)).toBe("3m05s");
        expect(formatDuration(undefined)).toBe("—");
        expect(formatDuration(-1)).toBe("—");
    });
});

describe("退出情况", () => {
    it("running 不说退出码；有信号说信号；否则说退出码（0 与非 0 都只是「退出码」，成功与否不在这里判）", () => {
        expect(exitText("running")).toBe("（未结束）");
        expect(exitText("killed", null, "SIGTERM")).toBe("信号 SIGTERM");
        expect(exitText("exited", 0)).toBe("退出码 0");
        expect(exitText("exited", 7)).toBe("退出码 7");
        expect(exitText("failed", null)).toBe("无退出码");
    });
});

describe("输出尾巴", () => {
    it("按行截尾：只留最后 N 行，且不把「文本以换行结尾」的空串算一行", () => {
        const r = tailOf("a\nb\nc\nd\n", 2);
        expect(r.text).toBe("c\nd");
        expect(r.lines).toBe(2);
        expect(r.droppedBytes).toBe(0);
    });

    it("字节上限生效时报清楚丢了多少字节（超长单行也切得动）", () => {
        const huge = "x".repeat(MAX_TAIL_BYTES * 2);
        const r = tailOf(huge, 40);
        expect(r.droppedBytes).toBeGreaterThan(0);
        expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(MAX_TAIL_BYTES);
    });

    it("截断点不产生替换字符：中文与 4 字节 emoji 跨切点时都不出 U+FFFD", () => {
        for (const unit of ["中", "😀"]) {
            const text = unit.repeat(Math.ceil((MAX_TAIL_BYTES * 2) / Buffer.byteLength(unit)));
            const r = tailOf(text, 10);
            expect(r.text.includes("\uFFFD")).toBe(false);
            expect(r.droppedBytes).toBeGreaterThan(0);
        }
    });

    it("空输出给 0 行（不是给一个空字符串当「有一行」）", () => {
        expect(tailOf("", 10)).toEqual({ text: "", lines: 0, droppedBytes: 0 });
    });
});

describe("花名册与结束通知", () => {
    const base = {
        id: "p-abc-1",
        command: "sleep 18; echo done",
        state: "exited" as const,
        startedAt: 1_000,
        endedAt: 19_000,
        exitCode: 0,
    };

    it("一行里能看出状态 / id / 时长 / 命令 / 来源", () => {
        const line = procLine({ ...base, origin: { taskUri: "projects/4/tasks/408" } }, 20_000);
        expect(line).toContain("已结束");
        expect(line).toContain("p-abc-1");
        expect(line).toContain("18.0s");
        expect(line).toContain("sleep 18; echo done");
        expect(line).toContain("projects/4/tasks/408");
    });

    it("多行命令只取首行进单行（花名册不许被换行拆开）", () => {
        expect(procLine({ ...base, command: "line1\nline2" }, 20_000)).not.toContain("\n");
    });

    it("结束通知带结论 + 尾巴 + 下一步命令（给的是「接着干」的最小上下文，不是全文）", () => {
        const text = notifyText(base, { text: "1\n2\n3", lines: 3, droppedBytes: 0 });
        expect(text).toContain("后台进程结束");
        expect(text).toContain("p-abc-1");
        expect(text).toContain("退出码 0");
        expect(text).toContain("18.0s");
        expect(text).toContain("job output p-abc-1");
    });

    it("无输出也明说「无输出」（不说「输出：」然后空着）", () => {
        expect(notifyText(base, { text: "", lines: 0, droppedBytes: 0 })).toContain("（无输出）");
    });
});
