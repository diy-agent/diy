// ##408 刀 9：run 的**表格视图**（纯函数）。判据写进用例名 —— 这里钉的是"字段口径"，
// 不是"渲染得好不好看"：面板 / CLI / 导出必须看同一份字段，否则必然漂。

import { describe, expect, it } from "vitest";
import {
    bytesText,
    clockText,
    originTextOf,
    runViewOf,
    navTargetOf,
    titleOf,
    type JobNavTarget,
    type RunFact,
    type RunOriginRef,
} from "../../src/shared/run-view";

const base: RunFact = {
    id: "r-1",
    command: "cd /tmp && npm i\n&& echo done",
    cwd: "/tmp",
    state: "running",
    startedAt: new Date(2026, 0, 2, 9, 8, 7).getTime(),
    dir: "/home/.diy/log/job/run/2026-01-02/r-1",
    logPath: "/home/.diy/log/job/run/2026-01-02/r-1/out.log",
    origin: { taskUri: "projects/4/tasks/408", turnId: "t1", stepId: "t1_s9", toolCallId: "call-1" },
};

describe("titleOf / 原始命令行", () => {
    it("没给标题就取命令首行（表格一列塞得下）", () => {
        expect(titleOf("sleep 5\necho x")).toBe("sleep 5");
    });

    it("给了标题就用标题，但 command 仍是**全文**（用户点名要看原始命令行）", () => {
        const v = runViewOf({ ...base, title: "装依赖" }, base.startedAt);
        expect(v.title).toBe("装依赖");
        expect(v.command).toBe(base.command);
        expect(v.commandFirstLine).toBe("cd /tmp && npm i");
    });

    it("空命令给占位，不渲染成看不见的空行", () => {
        expect(titleOf("   \n ")).toBe("（空命令）");
    });
});

describe("时长", () => {
    it("在跑 ⇒ 用 now 算（不必等结束才有数）", () => {
        const v = runViewOf(base, base.startedAt + 1_500);
        expect(v.durationMs).toBe(1_500);
        expect(v.durationText).toBe("1.5s");
        expect(v.terminal).toBe(false);
    });

    it("已结束 ⇒ 用 endedAt 算，且之后不再随 now 变（快照不漂）", () => {
        const ended = base.startedAt + 61_000;
        const v1 = runViewOf({ ...base, state: "exited", endedAt: ended, exitCode: 0 }, ended + 5);
        const v2 = runViewOf({ ...base, state: "exited", endedAt: ended, exitCode: 0 }, ended + 10_000);
        expect(v1.durationText).toBe("1m01s");
        expect(v2.durationText).toBe(v1.durationText);
        expect(v1.terminal).toBe(true);
    });

    it("时钟不越界（负时长夹到 0，系统钟回拨时不显示 -1s）", () => {
        expect(runViewOf(base, base.startedAt - 5_000).durationMs).toBe(0);
    });
});

describe("退出情况", () => {
    it("有信号 ⇒ 说信号（退出码 null 时不许显示成「退出码 0」）", () => {
        const v = runViewOf({ ...base, state: "killed", endedAt: base.startedAt + 10, exitCode: null, signal: "SIGTERM" }, 0);
        expect(v.exitText).toBe("信号 SIGTERM");
        expect(v.signal).toBe("SIGTERM");
    });

    it("在跑 ⇒ 「（未结束）」，不猜结局", () => {
        expect(runViewOf(base, 0).exitText).toBe("（未结束）");
    });

    it("pid 可缺（进程内 JS 任务没有 pid）", () => {
        expect(runViewOf({ ...base, pid: undefined }, 0).pid).toBeNull();
        expect(runViewOf({ ...base, pid: 4242 }, 0).pid).toBe(4242);
    });
});

describe("来源 / 输出量", () => {
    it("来源拼成一行：任务 · 轮 · 步 · 工具调用（少了哪个就不拼哪个）", () => {
        expect(originTextOf(base.origin)).toBe("projects/4/tasks/408 · t1 · t1_s9 · call-1");
        expect(originTextOf({ taskUri: "projects/4/tasks/408" })).toBe("projects/4/tasks/408");
        expect(originTextOf(undefined)).toBe("—");
    });

    it("`taskUri` 直接取 origin（kill 的归属声明要它，调用方只准照读、不准猜）", () => {
        expect(runViewOf(base, 0).taskUri).toBe("projects/4/tasks/408");
        expect(runViewOf({ ...base, origin: undefined }, 0).taskUri).toBeNull();
    });

    it("字节数人话（读不到给「—」，不许当成 0 字节）", () => {
        expect(bytesText(0)).toBe("0B");
        expect(bytesText(2048)).toBe("2.0K");
        expect(runViewOf(base, 0, null).outputText).toBe("—");
        expect(runViewOf(base, 0, 0).outputText).toBe("0B");
    });

    it("启动时刻是本地 HH:MM:SS", () => {
        expect(clockText(new Date(2026, 0, 2, 9, 8, 7).getTime())).toBe("09:08:07");
    });
});

// ##408 刀 14：表格「类型」列 + 概要页的后台属性（用户实测：默认详情页看不出来是不是后台）。
describe("后台属性（刀 14 / 刀 16 收窄）", () => {
    it("表里没有前台概念（用户 2026-10-24：job 只管后台；前台命令不登记、不列出）", () => {
        const v = runViewOf(base, 0) as unknown as Record<string, unknown>;
        expect(v["foreground"]).toBeUndefined();
        expect(v["background"]).toBeUndefined();
        expect(v["modeText"]).toBeUndefined();
    });

    it("进程组就是根 pid（detached spawn；进程内任务两者皆 null）", () => {
        expect(runViewOf({ ...base, pid: 4242 }, 0).pgid).toBe(4242);
        expect(runViewOf({ ...base, pid: undefined }, 0).pgid).toBeNull();
    });

    it("「留下过后台子孙」与「正在等后台子孙」是两个事实，分别透出", () => {
        const waiting = runViewOf({ ...base, awaitingGroup: true, hadSurvivingGroup: true }, 0);
        expect(waiting.awaitingGroup).toBe(true);
        expect(waiting.hadSurvivingGroup).toBe(true);
        const after = runViewOf({ ...base, awaitingGroup: false, hadSurvivingGroup: true }, 0);
        expect(after.awaitingGroup).toBe(false);
        expect(after.hadSurvivingGroup).toBe(true);
    });

    it("通知状态透出（「agent 会不会被叫醒」要能看见）", () => {
        expect(runViewOf(base, 0).notified).toBe(false);
        expect(runViewOf({ ...base, notified: true }, 0).notified).toBe(true);
    });
});

// 用户 20:5x：「某会话启动的长 job 应可以打开会话定位到那个 message/toolcall 点上」；
// 硬约束：「指不回去的 job **不显示成可点**」—— navTargetOf 是唯一判据。
describe("来源导航判据（navTargetOf）", () => {
    const TASK = "projects/4/tasks/408";

    it("锚点齐全 ⇒ 给出 (taskUri, turnId, blockId)（blockId = toolCallId）", () => {
        expect(navTargetOf({ taskUri: TASK, turnId: "t1", stepId: "t1_s3", toolCallId: "call_a" })).toEqual({
            taskUri: TASK,
            turnId: "t1",
            blockId: "call_a",
        } satisfies JobNavTarget);
    });

    it("缺 toolCallId / turnId / taskUri ⇒ null（不假装能导航）", () => {
        expect(navTargetOf({ taskUri: TASK, turnId: "t1" })).toBeNull();
        expect(navTargetOf({ taskUri: TASK, toolCallId: "call_a" })).toBeNull();
        // 类型上 taskUri 必填，但运行时数据可能来自旧结构 / 半截写入 —— 判据必须扛得住
        expect(navTargetOf({ turnId: "t1", toolCallId: "call_a" } as unknown as RunOriginRef)).toBeNull();
        expect(navTargetOf({} as unknown as RunOriginRef)).toBeNull();
    });

    it("空串与空白算缺（面板里的空字段是常见形态）", () => {
        expect(navTargetOf({ taskUri: TASK, turnId: " ", toolCallId: "call_a" })).toBeNull();
        expect(navTargetOf({ taskUri: TASK, turnId: "t1", toolCallId: "" })).toBeNull();
    });

    it("taskUri 形状不对 ⇒ null（拼错的地址点开只会把用户送到空页）", () => {
        expect(navTargetOf({ taskUri: "not-a-uri", turnId: "t1", toolCallId: "c" })).toBeNull();
        expect(navTargetOf({ taskUri: "/tmp/x", turnId: "t1", toolCallId: "c" })).toBeNull();
    });

    it("没有 origin ⇒ null（将来的 scheduled/event 型天然落这里）", () => {
        expect(navTargetOf(null)).toBeNull();
        expect(navTargetOf(undefined)).toBeNull();
    });
});
