import { describe, expect, it } from "vitest";
import { createSink, deliverToSinks } from "../../src/main/services/watch-sinks";
import type { WatchEvent } from "../../src/shared/watch-event";
import type { SystemEventInput } from "../../src/main/services/journal-store";

// ##408 v2：出口注册表。**不写真的 journal** —— 注入假写入口
// （tests 里禁 `vi.mock`：`test-unit` 用 `--no-isolate`，mock 会静默失效）。

interface JournalCall {
    taskUri: string;
    input: SystemEventInput;
}

function fakeJournal() {
    const calls: JournalCall[] = [];
    const write = (taskUri: string, input: JournalCall["input"]) => {
        calls.push({ taskUri, input });
        return { added: null, skipped: null };
    };
    return { calls, write };
}

const event: WatchEvent = {
    watchId: "daily-pr",
    title: "看 PR 有没有人回",
    kind: "changed",
    at: 1_000,
    diff: "~ a: 1 → 2",
    subject: "task:projects/4/tasks/266",
};

describe("task: 出口", () => {
    it("写成 journal 的一条：system 通道的 code、progress、去重窗关掉", async () => {
        const j = fakeJournal();
        await createSink("task:projects/4/tasks/266", { journal: j.write, wake: () => {} }).deliver(event);
        expect(j.calls).toEqual([
            {
                taskUri: "projects/4/tasks/266",
                input: {
                    code: "job/watch-change",
                    title: "watch daily-pr 有变化（task:projects/4/tasks/266） · 看 PR 有没有人回",
                    kind: "progress",
                    body: "~ a: 1 → 2",
                    windowMs: 0,
                },
            },
        ]);
    });

    it("broken 走 pitfall + 自己的 code（「watch 坏了」比「有变化」急）", async () => {
        const j = fakeJournal();
        await createSink("task:projects/4/tasks/266", { journal: j.write, wake: () => {} }).deliver({
            ...event,
            kind: "broken",
            diff: "EACCES",
        });
        expect(j.calls[0].input.code).toBe("job/watch-broken");
        expect(j.calls[0].input.kind).toBe("pitfall");
        expect(j.calls[0].input.body).toBe("EACCES");
    });
});

describe("注册表", () => {
    it("未实现的出口不炸：记一条错，其余照投", async () => {
        const j = fakeJournal();
        const results = await deliverToSinks(["room:projects/4/tasks/266", "task:projects/4/tasks/266"], event, {
            journal: j.write,
            wake: () => {},
        });
        expect(results).toEqual([
            { addr: "room:projects/4/tasks/266", ok: false, error: "出口 room: 尚未实现" },
            { addr: "task:projects/4/tasks/266", ok: true },
        ]);
        expect(j.calls).toHaveLength(1);
    });

    it("一个出口抛错不阻断后面的出口（顺序投、互不阻断）", async () => {
        const calls: string[] = [];
        const results = await deliverToSinks(["task:projects/4/tasks/a", "task:projects/4/tasks/b"], event, {
            journal: (uri) => {
                calls.push(uri);
                if (uri === "projects/4/tasks/a") throw new Error("disk full");
                return null;
            },
            wake: () => {},
        });
        expect(results.map((r) => r.ok)).toEqual([false, true]);
        expect(results[0].error).toBe("disk full");
        expect(calls).toEqual(["projects/4/tasks/a", "projects/4/tasks/b"]);
    });

    it("同一次变化：先记账再唤醒（唤醒失败不影响投递结果）", async () => {
        const j = fakeJournal();
        const woken: Array<{ uri: string; text: string }> = [];
        const sink = createSink("task:projects/4/tasks/266", {
            journal: j.write,
            wake: (uri, text) => {
                woken.push({ uri, text });
                throw new Error("agent 没就绪");
            },
        });
        // 唤醒抛错 ⇒ 仍算投递成功（journal 那条是权威，叫不醒只是一轮的问题）
        await expect(sink.deliver(event)).resolves.toBeUndefined();
        expect(j.calls).toHaveLength(1);
        expect(woken).toHaveLength(1);
        expect(woken[0].uri).toBe("projects/4/tasks/266");
        expect(woken[0].text).toContain("watch daily-pr 有变化");
        expect(woken[0].text).toContain("~ a: 1 → 2");
    });

    it("未知前缀直接抛（地址校验应在上游拦住）", () => {
        expect(() => createSink("nope:x")).toThrow(/未知出口前缀/);
    });
});
