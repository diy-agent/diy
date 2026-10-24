// tests/core/foreground-bash.test.ts
// 🎯 ##408 刀 21 —— 前台调用的「转后台」入口表（UI 按 toolCallId 找得到、转得动）
//
// 与刀 19 的分工：那边钉「怎么转」（handoff 六个坑），这边钉「谁来按按钮」：
//   · 只有**本任务 + 还在跑 + 有 toolCallId** 的条目才可转（转不了的按钮不如没有）
//   · 转完工具调用**必须**收尾（`finishAsDetached`）—— 不收尾这一轮就挂死
//   · 拒绝是正常时序（已结束 / 连按两次 / 跨任务），按 code 分支
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBash, type BashControl, type LocalAgentLimits } from "../../src/main/services/local-agent";
import { ForegroundBash, ForegroundBashError } from "../../src/main/services/foreground-bash";
import { RunRegistry } from "../../src/main/services/run-registry";

const limits = { bashTimeoutMs: 30_000 } as unknown as LocalAgentLimits;
const taskUri = "projects/4/tasks/408";
const origin = { taskUri, turnId: "t1", stepId: "t1_s1", toolCallId: "call-1" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;
let reg: RunRegistry;
let table: ForegroundBash;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diy-fg-"));
    reg = new RunRegistry({ rootDir: root });
    table = new ForegroundBash(reg);
});

afterEach(() => {
    for (const p of reg.list()) if (p.state === "running") reg.kill(p.id);
    reg.clear();
    rmSync(root, { recursive: true, force: true });
});

/** 起一条前台命令并登记进表（模拟 bash 工具的 `onControl`）。 */
function start(command: string, id = "call-1", uri = taskUri) {
    let ctl: BashControl | undefined;
    const run = runBash(command, root, limits, undefined, { onControl: (c) => (ctl = c) });
    if (!ctl) throw new Error("onControl 没有被同步调用");
    table.register(id, { process: ctl, command, cwd: root, origin: { ...origin, taskUri: uri, toolCallId: id } });
    return { run, ctl };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
        await p;
        return "(no error)";
    } catch (e) {
        return e instanceof ForegroundBashError ? e.code : `(unexpected: ${String(e)})`;
    }
};

describe("前台转后台（入口表）", () => {
    it("转成功：工具调用拿回 runId、进程不重启、后半段输出继续落 out.log", async () => {
        const { run, ctl } = start("echo first; sleep 0.5; echo second");
        await sleep(80);
        const pid = ctl.pid;
        const info = await table.detach("call-1", taskUri);
        const result = await run; // ← 不收尾的话这里永远等不到
        expect(pid).toBe(ctl.pid);
        expect(info.pid).toBe(pid);
        expect(result.text).toContain(`[已转后台] ${info.id}`);
        // 工具调用已经返回，但进程还在跑：run 表里是 running
        expect(reg.get(info.id)?.state).toBe("running");
        await sleep(900);
        expect(reg.get(info.id)?.state).not.toBe("running");
        const log = readFileSync(info.logPath, "utf8");
        expect(log).toContain("first"); // 前半段不丢
        expect(log).toContain("second"); // 交接之后的字节照样进文件
        expect(table.list(taskUri)).toEqual([]); // 转完就从可转列表消失
    });

    it("已经结束的调用：拒绝（job/already-ended），并摘掉条目", async () => {
        const { run } = start("true");
        await run;
        expect(await codeOf(table.detach("call-1", taskUri))).toBe("agent/job-already-ended");
        expect(table.list(taskUri)).toEqual([]);
    });

    it("连按两次：第二次说 job/not-found（第一次已经转走了）", async () => {
        start("sleep 0.6");
        await sleep(80);
        await table.detach("call-1", taskUri);
        expect(await codeOf(table.detach("call-1", taskUri))).toBe("agent/job-not-found");
    });

    it("跨任务：给了别的 taskUri 就拒绝（job/foreign），条目留着不动", async () => {
        start("sleep 0.6");
        await sleep(80);
        expect(await codeOf(table.detach("call-1", "projects/4/tasks/999"))).toBe("agent/job-foreign");
        expect(table.list(taskUri)).toHaveLength(1);
    });

    it("list 只列本任务、还在跑的（别的任务看不见，结束的不列）", async () => {
        start("sleep 0.6", "call-a");
        start("true", "call-b");
        await sleep(150);
        const mine = table.list(taskUri);
        expect(mine.map((v) => v.toolCallId)).toEqual(["call-a"]);
        expect(mine[0]!.runningMs).toBeGreaterThan(0);
        expect(table.list("projects/4/tasks/999")).toEqual([]);
    });
});
