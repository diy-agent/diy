// tests/core/inbox.test.ts
// ═══════════════════════════════════════════════════════════════
// ##429 通知信箱：**落盘留痕** + 订阅只推增量 + 任务级覆盖的文件读取。
//
// 为什么这几条必须在服务层验（纯函数验不了）：
//   ① 落盘 = 重启后仍能回看（内存 ring 无法兑现这条承诺）—— 真读盘
//   ② 订阅**不回放历史**：回放会让 renderer 每次重载都糊一脸旧 toast
//   ③ 坏行（进程被杀写坏的半行）不能让整个信箱读不出来
//   ④ 任务 frontmatter 的 `max_output_tokens` 是覆盖链最高优先级 —— 读不懂要当"没设"
//
// 全部在临时 DIY_HOME 里跑（绝不碰生产 ~/.diy）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxEntryOf, inboxFile, inboxHub } from "../../src/main/services/inbox";
import { inboxLineOf, type InboxEntry } from "../../src/shared/inbox";
import { taskOutputOverride, TASK_OUTPUT_KEY } from "../../src/main/core/output-budget";

let home: string;
const base = (over: Partial<Omit<InboxEntry, "id" | "ts">> = {}): Omit<InboxEntry, "id" | "ts"> => ({
    level: "N1",
    kind: "max-tokens",
    taskUri: "projects/4/tasks/429",
    text: "这次回复被输出上限截断（16384（场景缺省）），说「继续」可接上",
    source: "agent 输出上限（##429）",
    reason: "本轮某个回答撞上了输出上限 16384",
    detail: "机制说明：真发值 = min(软上限, 模型硬上限)。",
    ...over,
});

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-inbox-"));
    process.env["DIY_HOME"] = home;
    vi.resetModules(); // hub 有模块级 ring/loaded 状态：每个用例一份干净实例
});

afterEach(() => {
    delete process.env["DIY_HOME"];
    rmSync(home, { recursive: true, force: true });
});

describe("##429 信箱：落盘 + 回看", () => {
    it("push 之后条目在盘上（append-only jsonl，一行一条），list 能读回来", async () => {
        const { inboxHub: hub, inboxFile: file, inboxEntryOf: make } = await import("../../src/main/services/inbox");
        await hub.push(make(base()));
        await hub.push(make(base({ kind: "cost-step", text: "单步花了 $0.20，超过阈值 $0.10" })));
        const lines = readFileSync(file(), "utf-8").trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: "max-tokens", level: "N1" });
        const rows = await hub.list();
        expect(rows.map((r) => r.kind)).toEqual(["max-tokens", "cost-step"]);
        expect(rows[0]!.taskUri).toBe("projects/4/tasks/429");
    });

    it("按任务筛 / 按条数截尾", async () => {
        const { inboxHub: hub, inboxEntryOf: make } = await import("../../src/main/services/inbox");
        for (let i = 0; i < 5; i++) await hub.push(make(base({ text: `第 ${i} 条` })));
        await hub.push(make(base({ taskUri: "projects/4/tasks/1", text: "别的任务" })));
        expect((await hub.list({ taskUri: "projects/4/tasks/1" })).map((r) => r.text)).toEqual(["别的任务"]);
        // 截尾取的是**最后落的那几条**（不是按任务分组后的尾部）
        expect((await hub.list({ limit: 2 })).map((r) => r.text)).toEqual(["第 4 条", "别的任务"]);
    });

    it("重启后（新模块实例）从文件尾部回填 —— “重启后仍可回看”是被兑现的", async () => {
        const first = await import("../../src/main/services/inbox");
        await first.inboxHub.push(first.inboxEntryOf(base({ text: "重启前那条" })));
        // 模拟进程重启：清模块表 ⇒ hub 重新构造、内存 ring 为空，必须从盘回填
        vi.resetModules();
        const second = await import("../../src/main/services/inbox");
        const rows = await second.inboxHub.list();
        expect(rows.map((r) => r.text)).toEqual(["重启前那条"]);
    });

    it("尾部坏行（半截写入）只跳过那一条，不吃掉整个信箱", async () => {
        const file = inboxFile();
        mkdirSync(join(home, "local"), { recursive: true });
        writeFileSync(file, `${JSON.stringify(inboxEntryOf(base({ text: "好行" })))}\n{"broken":`, "utf-8");
        const { inboxHub: hub } = await import("../../src/main/services/inbox");
        expect((await hub.list()).map((r) => r.text)).toEqual(["好行"]);
    });
});

describe("##429 订阅语义：只推增量，不回放历史", () => {
    it("订阅前落的不推；订阅后落的才推", async () => {
        const { inboxHub: hub, inboxEntryOf: make } = await import("../../src/main/services/inbox");
        await hub.push(make(base({ text: "订阅前" })));
        const ctrl = new AbortController();
        const seen: string[] = [];
        const consumer = (async () => {
            for await (const e of hub.subscribe(ctrl.signal)) {
                seen.push(e.text);
                if (seen.length >= 1) break;
            }
        })();
        await hub.push(make(base({ text: "订阅后" })));
        await consumer;
        ctrl.abort();
        expect(seen).toEqual(["订阅后"]);
    });
});

describe("##429 任务级覆盖（frontmatter max_output_tokens）", () => {
    const writeTask = (front: string) => {
        const dir = join(home, "projects/4/tasks/429");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "AGENTS.md"), `---\ntitle: t\n${front}---\n\n正文\n`, "utf-8");
    };

    it("读到数字就返回；字符串数字也认（手写常见）", async () => {
        writeTask(`${TASK_OUTPUT_KEY}: 8000\n`);
        expect(await taskOutputOverride(home, "projects/4/tasks/429")).toBe(8000);
        writeTask(`${TASK_OUTPUT_KEY}: "6000"\n`);
        expect(await taskOutputOverride(home, "projects/4/tasks/429")).toBe(6000);
    });

    it("没写 / 写坏了 ⇒ null（读侧宽容：坏值当没设，不阻断对话）", async () => {
        writeTask("");
        expect(await taskOutputOverride(home, "projects/4/tasks/429")).toBeNull();
        writeTask(`${TASK_OUTPUT_KEY}: abc\n`);
        expect(await taskOutputOverride(home, "projects/4/tasks/429")).toBeNull();
        writeTask(`${TASK_OUTPUT_KEY}: -5\n`);
        expect(await taskOutputOverride(home, "projects/4/tasks/429")).toBeNull();
        expect(await taskOutputOverride(home, "projects/4/tasks/999")).toBeNull(); // 任务不存在
    });
});

describe("##429 人读一行", () => {
    it("inboxLineOf：时刻 / kind / 任务 / 结论", () => {
        const e = inboxEntryOf(base());
        expect(inboxLineOf(e)).toContain("max-tokens");
        expect(inboxLineOf(e)).toContain("projects/4/tasks/429");
        expect(inboxLineOf(e)).toContain("输出上限");
    });
});
