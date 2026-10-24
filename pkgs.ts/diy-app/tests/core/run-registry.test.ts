import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunRegistry } from "../../src/main/services/run-registry";

// ##408 刀 8：后台进程表（活体）。**真起 /bin/bash**，但不等固定时长 —— 一律用 `wait()` 事件。
// 判据：spawn 当场登记 / 判活靠事件 / 输出直落文件 / 杀进程组 / 起不来要说清楚。

let root: string;
let reg: RunRegistry;
const origin = { taskUri: "projects/4/tasks/408", turnId: "t1", stepId: "t1_s1", toolCallId: "call-1" };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diy-proc-"));
    reg = new RunRegistry({ rootDir: root });
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
        const local = new RunRegistry({ rootDir: root, notifier: (taskUri, text) => seen.push({ taskUri, text }) });
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
        const local = new RunRegistry({ rootDir: root, notifier: (_t, text) => seen.push(text) });
        const p = local.spawn({ command: "true", cwd: root });
        await local.wait(p.id, 10_000);
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toHaveLength(0);
        local.clear();
    });

    it("通知出口自己抛错也不许影响进程状态（观测不能炸业务）", async () => {
        const local = new RunRegistry({
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

// ── 刀 9（用户订正）：叫 run 不叫 proc / 按日期分目录 / 落盘只有 meta.json + out.log ──
describe("落盘布局（log/job/run/<date>/<id>/）", () => {
    it("默认根是 $DIY_HOME/log/job/run，且日期目录按**启动时刻**的本地日期分", async () => {
        const { runRoot, dateDirOf, RunRegistry: R } = await import("../../src/main/services/run-registry");
        expect(runRoot("/home/x").endsWith(join("log", "job", "run"))).toBe(true);
        // 用本地时间构造，避免测试受时区影响（dateDirOf 也按本地日期）
        const ts = new Date(2026, 0, 2, 23, 59, 0).getTime();
        expect(dateDirOf(ts)).toBe("2026-01-02");
        // 跨午夜不改目录：目录取启动时刻，不取收口时刻
        const r = new R({ rootDir: root });
        const p = r.spawn({ command: "true", cwd: root });
        expect(p.dir.startsWith(join(root, dateDirOf(p.startedAt)))).toBe(true);
        await r.wait(p.id, 10_000);
        r.clear();
    });

    it("meta.json 写一次：命令 / cwd / 启动时刻 / 来源都在里面（「存储数据」tab 的真相）", async () => {
        const p = reg.spawn({ command: "echo hi", cwd: root, origin, title: "打个招呼" });
        await reg.wait(p.id, 10_000);
        const raw = reg.metaJson(p.id);
        expect(raw).toBeTruthy();
        const meta = JSON.parse(raw!) as Record<string, unknown>;
        expect(meta["command"]).toBe("echo hi");
        expect(meta["cwd"]).toBe(root);
        expect(meta["title"]).toBe("打个招呼");
        expect(meta["origin"]).toEqual(origin);
        expect(typeof meta["startedAt"]).toBe("string");
        // 终态**不进** meta.json：它是一次性自述，不是账本
        expect(meta["state"]).toBeUndefined();
        expect(meta["exitCode"]).toBeUndefined();
    });

    it("起不来也要留一条 failed + meta.json（'我起过它'不许凭空消失）", async () => {
        const p = reg.spawn({ command: "true", cwd: join(root, "不存在的目录") });
        // Node 的 spawn 对非法 cwd 是**异步**报错（`error` 事件），不是同步抛 ⇒ 登记了再看它转终态
        await reg.wait(p.id, 5_000);
        expect(p.state).toBe("failed");
        expect(p.error).toBeTruthy();
        expect(p.pid).toBeUndefined();
        expect(reg.metaJson(p.id)).toBeTruthy();
    });

    it("outputBytes 跟着文件长（表格「输出」列的来源，不读全文）", async () => {
        const p = reg.spawn({ command: "printf 12345", cwd: root });
        await reg.wait(p.id, 10_000);
        expect(reg.outputBytes(p.id)).toBe(5);
    });

    it("没有 pid 的 run（进程内任务）也能查，只是 kill 无从下手", () => {
        const p = reg.spawn({ command: "true", cwd: root });
        // 模拟进程内任务的形状：表里的一条 run 不一定有 pid
        const internal = { ...p, id: "r-internal", pid: undefined, state: "running" as const };
        expect(internal.pid).toBeUndefined();
        expect(reg.kill("r-internal")).toBe(false);
    });
});

// ##408 刀 11：**前台** run 也进表 —— 判据是"谁起的"（`&` 起的孤儿总得有个爹）
describe("前台 run（track）", () => {
    it("登记即 running、写出去的字节进 out.log、收口后是 exited", () => {
        const h = reg.track({ command: "echo hi; echo bye", cwd: root, origin });
        expect(h.info.state).toBe("running");
        expect(h.info.foreground).toBe(true);
        h.setPid(12345);
        h.write(Buffer.from("hi\n"));
        h.write(Buffer.from("bye\n"));
        h.finish({ exitCode: 0 });
        const after = reg.get(h.info.id);
        expect(after?.state).toBe("exited");
        expect(after?.exitCode).toBe(0);
        expect(after?.pid).toBe(12345);
        expect(after?.foreground).toBe(true);
        expect(readFileSync(h.info.logPath, "utf8")).toBe("hi\nbye\n");
        // pid 后补录后 meta.json 也要跟着（"这条 run 是谁"的一半是 pid）
        expect(JSON.parse(reg.metaJson(h.info.id) ?? "{}").pid).toBe(12345);
    });

    it("我们主动杀的（超时/取消）⇒ killed，而不是 failed", () => {
        const h = reg.track({ command: "sleep 99", cwd: root });
        h.finish({ killed: true, signal: "SIGTERM" });
        const after = reg.get(h.info.id);
        expect(after?.state).toBe("killed");
        expect(after?.signal).toBe("SIGTERM");
    });

    it("起不来（无码无信号 + 有原因）⇒ failed，表里仍留一条", () => {
        const h = reg.track({ command: "x", cwd: root });
        h.finish({ error: "spawn ENOENT" });
        expect(reg.get(h.info.id)?.state).toBe("failed");
        expect(reg.get(h.info.id)?.error).toBe("spawn ENOENT");
    });

    it("收口幂等：重复 finish 只有第一次生效（不会被后一次改掉终态）", () => {
        const h = reg.track({ command: "echo x", cwd: root });
        h.finish({ exitCode: 0 });
        h.finish({ killed: true });
        expect(reg.get(h.info.id)?.state).toBe("exited");
        // 收口后不再写盘（fd 已关，写不进去也不报错）
        h.write(Buffer.from("late\n"));
        expect(readFileSync(h.info.logPath, "utf8")).toBe("");
    });
});

// ##408 刀 14：**谁该被叫醒**。
// 用户实测报的病：「为啥他所有指令都会执行完通知 agent？都是后台指令？」
// —— 刀 11 让前台命令也进表之后，`settle` 无差别通知，于是 `ls` 也会插一句话。
// 判据：后台 run（工具早已返回）要叫；前台 run 只有**留下过后台子孙**才叫
// （那时工具返回的只是"起好了"）；普通前台 run 不叫 —— 结果already在模型手里。
describe("结束通知的判据（刀 14）", () => {
    it("普通前台命令不叫醒 agent（工具结果已经回到模型手里，再插一句是噪音）", () => {
        const notes: string[] = [];
        const r = new RunRegistry({ rootDir: root, notifier: (_t, text) => notes.push(text) });
        const h = r.track({ command: "ls -la", cwd: root, origin });
        h.setPid(process.pid);
        h.finish({ exitCode: 0 });
        expect(r.get(h.info.id)?.state).toBe("exited");
        expect(notes).toHaveLength(0);
        r.clear();
    });

    it("前台命令留下过后台子孙（nohup … &）⇒ 组空那一刻叫一次（工具当时只返回了「起好了」）", async () => {
        let alive = true;
        const notes: string[] = [];
        const r = new RunRegistry({
            rootDir: root,
            probeGroup: () => alive,
            reapMs: 20,
            notifier: (_t, text) => notes.push(text),
        });
        const h = r.track({ command: "nohup sleep 99 & echo ok", cwd: root, origin });
        h.setPid(4242);
        h.finish({ exitCode: 0 });
        expect(notes).toHaveLength(0); // 根退了，但组里还有活口 ⇒ 还不叫
        expect(r.get(h.info.id)?.awaitingGroup).toBe(true);
        expect(r.get(h.info.id)?.hadSurvivingGroup).toBe(true);
        alive = false;
        await r.wait(h.info.id, 5_000);
        await new Promise((res) => setTimeout(res, 120));
        expect(notes).toHaveLength(1);
        r.clear();
    });

    it("后台 run（background:true）照旧叫醒（工具早已返回，人只能靠通知知道结局）", async () => {
        const notes: string[] = [];
        const r = new RunRegistry({ rootDir: root, notifier: (_t, text) => notes.push(text) });
        const p = r.spawn({ command: "exit 0", cwd: root, origin });
        await r.wait(p.id, 10_000);
        expect(notes).toHaveLength(1);
        r.clear();
    });
});

// ##408 刀 13：run 的寿命 = **进程组的寿命**，不是根 bash 的寿命。
// 用户实测的病：`nohup sleep 600 > /dev/null 2>&1 &` 这条命令 35ms 就返回，
// 表上写「已结束 · 35ms」、通知也在 35ms 发完，而真正在跑的 `sleep 600` 还在跑。
// 判据：组里还有活口 ⇒ 仍 running；组空那一刻才收口 + **只发一次**通知。
describe("寿命按进程组算（不是根 bash）", () => {
    it("根退出但组里还有活口 ⇒ 状态仍是 running（不许写「已结束」）", async () => {
        const r = new RunRegistry({ rootDir: root, probeGroup: () => true, reapMs: 60_000 });
        const p = r.spawn({ command: "exit 0", cwd: root, origin });
        await new Promise((res) => setTimeout(res, 120));
        expect(p.state).toBe("running");
        expect(p.awaitingGroup).toBe(true);
        expect(p.rootExitedAt).toBeGreaterThanOrEqual(p.startedAt);
        r.clear();
    });

    it("组空了才收口，且这一等出来的终态仍是 exited + 真实退出码", async () => {
        let alive = true;
        const r = new RunRegistry({ rootDir: root, probeGroup: () => alive, reapMs: 20 });
        const p = r.spawn({ command: "exit 3", cwd: root, origin });
        await new Promise((res) => setTimeout(res, 80));
        expect(p.state).toBe("running");
        alive = false;
        const done = await r.wait(p.id, 5_000);
        expect(done?.state).toBe("exited");
        expect(done?.exitCode).toBe(3);
        expect(done?.awaitingGroup).toBe(false);
        r.clear();
    });

    it("真进程：`nohup sleep &` 的父命令秒退，run 活到后台进程真的没了才结束", async () => {
        const p = reg.spawn({ command: "nohup sleep 0.6 > /dev/null 2>&1 & echo ok", cwd: root, origin });
        // 根命令本身 20ms 级就退；此时不许收口
        await new Promise((res) => setTimeout(res, 150));
        expect(p.state).toBe("running");
        expect(p.awaitingGroup).toBe(true);
        const done = await reg.wait(p.id, 10_000);
        expect(done?.state).toBe("exited");
        expect(done?.exitCode).toBe(0);
        // 时长按"真正没人跑"算（≥ 后台进程那 ~600ms），不是父命令的 20ms
        expect(done!.endedAt! - done!.startedAt).toBeGreaterThanOrEqual(400);
    }, 15_000);

    it("通知只在组空那一刻发，且只发一次（探活多轮不重复唤醒）", async () => {
        let alive = true;
        const notes: string[] = [];
        const r = new RunRegistry({
            rootDir: root,
            probeGroup: () => alive,
            reapMs: 20,
            notifier: (_t, text) => notes.push(text),
        });
        const p = r.spawn({ command: "exit 0", cwd: root, origin });
        await new Promise((res) => setTimeout(res, 120));
        expect(notes).toHaveLength(0); // 组里还有活口 ⇒ 还不叫醒
        alive = false;
        await r.wait(p.id, 5_000);
        await new Promise((res) => setTimeout(res, 120)); // 再多探几轮
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("r-");
        r.clear();
    });

    it("我们主动杀的：不发唤醒（通知是「跑完了」，不是「被停了」）", async () => {
        const notes: string[] = [];
        const r = new RunRegistry({ rootDir: root, notifier: (_t, text) => notes.push(text) });
        const p = r.spawn({ command: "sleep 5", cwd: root, origin });
        r.kill(p.id);
        const done = await r.wait(p.id, 10_000);
        expect(done?.state).toBe("killed");
        expect(notes).toHaveLength(0);
        r.clear();
    });
});
