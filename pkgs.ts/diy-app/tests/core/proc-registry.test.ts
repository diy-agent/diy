import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcRegistry } from "../../src/main/services/proc-registry";

// ##408 刀 8：后台进程表（活体）。**真起 /bin/bash**，但不等固定时长 —— 一律用 `wait()` 事件。
// 判据：spawn 当场登记 / 判活靠事件 / 输出直落文件 / 杀进程组 / 起不来要说清楚。

let root: string;
let reg: ProcRegistry;
const origin = { taskUri: "projects/4/tasks/408", turnId: "t1", stepId: "t1_s1", toolCallId: "call-1" };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diy-proc-"));
    reg = new ProcRegistry({ rootDir: root });
});

afterEach(() => {
    for (const p of reg.list()) if (p.state === "running") reg.kill(p.id);
    reg.clear();
    rmSync(root, { recursive: true, force: true });
});

describe("登记与判活", () => {
    it("spawn 返回那一刻就在表里（不靠「跑够多久」才承认）", () => {
        const p = reg.spawn({ command: "sleep 5", cwd: root, origin });
        expect(p.state).toBe("running");
        expect(p.pid).toBeGreaterThan(0);
        expect(reg.list().map((x) => x.id)).toEqual([p.id]);
    });

    it("结束靠事件而不是轮询：wait 拿到终态 + 退出码，输出已落文件", async () => {
        const p = reg.spawn({ command: "echo hello; echo world", cwd: root });
        const done = await reg.wait(p.id, 10_000);
        expect(done?.state).toBe("exited");
        expect(done?.exitCode).toBe(0);
        expect(done?.endedAt).toBeGreaterThanOrEqual(done!.startedAt);
        expect(readFileSync(p.logPath, "utf8")).toBe("hello\nworld\n");
    });

    it("非零退出仍是 exited（成功与否由 exitCode 说，不塞进状态）", async () => {
        const p = reg.spawn({ command: "exit 7", cwd: root });
        const done = await reg.wait(p.id, 10_000);
        expect(done?.state).toBe("exited");
        expect(done?.exitCode).toBe(7);
    });

    it("输出真落文件：并发写入的多行不会撕（同一 fd，追加语义）", async () => {
        const p = reg.spawn({ command: "for i in 1 2 3; do echo line$i; done", cwd: root });
        await reg.wait(p.id, 10_000);
        expect(readFileSync(p.logPath, "utf8").trim().split("\n")).toEqual(["line1", "line2", "line3"]);
    });

    it("起在不存在的工作目录：状态 failed + 带原因，且表里仍有一条（「我起过它」不许凭空消失）", async () => {
        const p = reg.spawn({ command: "echo x", cwd: join(root, "no-such-dir") });
        // 起不来是 **error 事件**（异步）而不是同步抛：等它一拍再断言
        await new Promise((r) => setTimeout(r, 100));
        expect(p.state).toBe("failed");
        expect(p.error).toBeTruthy();
        expect(reg.get(p.id)?.state).toBe("failed");
    });
});

describe("查询与停止", () => {
    it("tail 取最后 N 行；未登记的 id 给 undefined（查询结果是结果，不是异常）", async () => {
        const p = reg.spawn({ command: "printf 'a\\nb\\nc\\n'", cwd: root });
        await reg.wait(p.id, 10_000);
        expect(reg.tail(p.id, 2)?.text).toBe("b\nc");
        expect(reg.tail("p-nope", 2)).toBeUndefined();
    });

    it("kill 按进程组发信号，终态是 killed（不是 exited）——「是我们杀的」这件事必须留在状态里", async () => {
        const p = reg.spawn({ command: "sleep 30", cwd: root });
        expect(reg.kill(p.id)).toBe(true);
        const done = await reg.wait(p.id, 10_000);
        expect(done?.state).toBe("killed");
        expect(done?.signal).toBe("SIGTERM");
    });

    it("kill 已结束的进程返回 false（幂等，不误伤——pid 会复用）", async () => {
        const p = reg.spawn({ command: "true", cwd: root });
        await reg.wait(p.id, 10_000);
        expect(reg.kill(p.id)).toBe(false);
    });

    it("wait 到点还没结束 ⇒ 返回仍在 running（「等多久」与「死没死」是两件事）", async () => {
        const p = reg.spawn({ command: "sleep 30", cwd: root });
        const still = await reg.wait(p.id, 50);
        expect(still?.state).toBe("running");
    });

    it("列表把活着的排在前面", async () => {
        const done = reg.spawn({ command: "true", cwd: root });
        await reg.wait(done.id, 10_000);
        const live = reg.spawn({ command: "sleep 30", cwd: root });
        expect(reg.list()[0]?.id).toBe(live.id);
    });
});

describe("结束通知（插话唤醒的数据面）", () => {
    it("带 origin 的进程结束时通知恰好一次，内容是「结论 + 尾巴」", async () => {
        const seen: Array<{ taskUri: string; text: string }> = [];
        const local = new ProcRegistry({ rootDir: root, notifier: (taskUri, text) => seen.push({ taskUri, text }) });
        const p = local.spawn({ command: "echo shipped", cwd: root, origin });
        await local.wait(p.id, 10_000);
        // close 事件在 wait 之后一拍
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toHaveLength(1);
        expect(seen[0]!.taskUri).toBe(origin.taskUri);
        expect(seen[0]!.text).toContain(p.id);
        expect(seen[0]!.text).toContain("shipped");
        local.clear();
    });

    it("没有 origin 的进程不通知（不知道叫醒谁，就不叫）", async () => {
        const seen: string[] = [];
        const local = new ProcRegistry({ rootDir: root, notifier: (_t, text) => seen.push(text) });
        const p = local.spawn({ command: "true", cwd: root });
        await local.wait(p.id, 10_000);
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toHaveLength(0);
        local.clear();
    });

    it("通知出口自己抛错也不许影响进程状态（观测不能炸业务）", async () => {
        const local = new ProcRegistry({
            rootDir: root,
            notifier: () => {
                throw new Error("boom");
            },
        });
        const p = local.spawn({ command: "true", cwd: root, origin });
        await local.wait(p.id, 10_000);
        await new Promise((r) => setTimeout(r, 20));
        expect(local.get(p.id)?.state).toBe("exited");
        local.clear();
    });
});
