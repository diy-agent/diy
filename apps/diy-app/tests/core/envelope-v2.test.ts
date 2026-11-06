// tests/core/envelope-v2.test.ts
// 🎯 新信封（##442 用户 2026-10-27「dsh 方式 B」）的**字节级** golden 用例。
//
// 规格（先对过再写代码，见任务 442 body「字段规格」）：
//   role:system  content = help / vars（全量）
//   role:user    content = vars（增量）/ notify / chat（固定键序）
//   vars 增量：只列变化原子单元；数组 / map 整单元替换；`path: null` = 删除
//   chat:   [{ from, text }]
//   notify: [{ kind, text, ...按 kind 的字段 }]
//
// 这里只钉**产出字节**，不碰 UI / 压缩。

import { describe, expect, it } from "vitest";
import { buildDelivery, controlDeltaDelivery } from "@diy-agent/context/delivery";
import { chatEnvelope, isEnvelopeText, userEnvelope, withNotify, type NotifyItem } from "@diy-agent/context/envelope";

const globals = {
    diy: { cli: "/repo/diy.sh", home: "/home/u/.diy" },
    project: { path: "/repo" },
    cwd: { path: "/repo", note: "", isFallback: false, isTaskDir: false, isAppDir: true },
    chain: [{ path: "/home/u/AGENTS.md", scope: "/home/u", content: "规范\n" }],
    task: {
        uri: "projects/1/tasks/1",
        title: "投递任务",
        state: "pending",
        dir: "/home/u/.diy/projects/1/tasks/1",
        created: "2026-10-01",
        parent: "",
        updated: "2026-10-01",
        change_type: "",
        module: "",
        priority: "",
        body: "正文",
    },
    skills: [] as string[],
    identity: "你是 X",
    rules: "R",
    guard: "G",
    reqlog: { file: "/home/u/.diy/log/network/2026-10-27.jsonl" },
};

const deliveryOf = (patch: Record<string, unknown> = {}) => buildDelivery({ ...globals, ...patch });

describe("role:system：help + vars 全量", () => {
    it("两个顶层键按序出现，变量树只有一份", () => {
        const d = deliveryOf();
        expect(d.text.text).toMatch(/^help:\n/);
        expect(d.text.text).toContain("\nvars:\n");
        expect(d.text.text).not.toContain("\nsystem:\n");
        expect(d.text.text).not.toContain("\nruntime:\n");
        expect(d.text.text.indexOf("help:")).toBeLessThan(d.text.text.indexOf("\nvars:"));
        // 全部变量（含 body / reqlog）确实在同一份里
        expect(d.text.text).toContain("正文");
        expect(d.text.text).toContain("reqlog:");
    });

    it("data 是纯数据（不带 help），含全部单元", () => {
        const d = deliveryOf();
        expect(d.data.text.startsWith("chain:")).toBe(true);
        expect(d.data.text).not.toContain("help:");
        expect(d.data.text).toContain("正文");
    });
});

describe("role:user：控制增量", () => {
    it("变了才列；数组整单元替换", () => {
        const d = deliveryOf({ skills: ["a"] });
        const delta = controlDeltaDelivery(d.tree, ["task.state", "skills"]);
        expect(delta.text).toBe(
            ["vars:", "  skills:", "    - a", "  task:", "    state: pending"].join("\n"),
        );
    });

    it("单元消失 ⇒ path: null（不是静默不出现）", () => {
        const d = deliveryOf();
        expect(controlDeltaDelivery(d.tree, ["room.recent"]).text).toBe(
            ["vars:", "  room:", "    recent: null"].join("\n"),
        );
    });

    it("两段都空 ⇒ 空串（调用方不注入）", () => {
        const d = deliveryOf();
        expect(controlDeltaDelivery(d.tree, []).text).toBe("");
    });
});

describe("role:user：chat / notify 与键序", () => {
    it("chat 一项 = {from, text}（块风格）", () => {
        expect(chatEnvelope([{ from: "human:chen56", text: "说1" }])).toBe(
            ["chat:", "  - from: human:chen56", '    text: "说1"'].join("\n"),
        );
    });

    it("chat 多项保持顺序（不按人分组）", () => {
        const out = chatEnvelope([
            { from: "human:chen56", text: "一" },
            { from: "agent:dev", text: "二" },
            { from: "human:chen56", text: "三" },
        ]);
        expect(out.indexOf("一")).toBeLessThan(out.indexOf("二"));
        expect(out.indexOf("二")).toBeLessThan(out.indexOf("三"));
    });

    it("notify 带字段（compact / job-done）不会丢", () => {
        const notify: NotifyItem[] = [
            {
                kind: "compact",
                source: "/l/llm.jsonl",
                summary: "结论：已经修好 A",
            },
            {
                kind: "job-done",
                text: "[后台进程结束] r-1 · exited 0",
                run: "r-1",
                state: "exited",
                exitCode: 0,
                signal: null,
                durationMs: 83000,
                command: "sleep 600",
                tail: "done",
                truncatedBytes: 0,
            },
        ];
        const out = userEnvelope({ notify });
        expect(out).toMatch(/^notify:\n/);
        // compact 字段（##442 最大精简：只有 source + summary）
        expect(out).toContain("  - kind: compact");
        expect(out).toContain("    source: /l/llm.jsonl");
        expect(out).toContain('    summary: "结论：已经修好 A"');
        expect(out).not.toContain("lines:");
        expect(out).not.toContain("ask:");
        // job-done 字段
        expect(out).toContain("  - kind: job-done");
        expect(out).toContain("    run: r-1");
        expect(out).toContain("    exitCode: 0");
        expect(out).toContain("    signal: null");
        expect(out).toContain("    durationMs: 83000");
    });

    it("withNotify：把 notify 并进已有 user 信封，不新增消息，键序 vars → notify → chat", () => {
        const item: NotifyItem = { kind: "compact", source: "/l/llm.jsonl", summary: "预检超限" };
        const plain = withNotify('chat:\n  - from: human:chen56\n    text: "说"', item);
        expect(plain.startsWith("notify:\n")).toBe(true);
        expect(plain.indexOf("notify:")).toBeLessThan(plain.indexOf("chat:"));
        const mixed = withNotify("vars:\n  self: { steps: 1 }\nchat:\n  - from: human:chen56\n    text: \"说\"", item);
        expect(mixed.indexOf("vars:")).toBeLessThan(mixed.indexOf("notify:"));
        expect(mixed.indexOf("notify:")).toBeLessThan(mixed.indexOf("chat:"));
        expect(mixed).toContain("kind: compact");
    });

    it("键序固定：vars → notify → chat", () => {
        const out = userEnvelope({
            vars: { self: { steps: 1 } },
            notify: [{ kind: "job-done", text: "t", run: "r-1" }],
            chat: [{ from: "human:chen56", text: "说2" }],
        });
        const at = (k: string): number => out.indexOf(`\n${k}:`) + 1;
        expect(out.startsWith("vars:\n")).toBe(true);
        expect(at("vars")).toBeLessThan(at("notify"));
        expect(at("notify")).toBeLessThan(at("chat"));
    });

    it("纯控制增量没有 chat（UI 不显示）", () => {
        const out = userEnvelope({ vars: { self: { steps: 1 } } });
        expect(out).toBe(["vars:", "  self:", "    steps: 1"].join("\n"));
        expect(out).not.toContain("chat:");
    });
});

describe("信封判据", () => {
    it("chat / notify / 控制增量都被认成信封（不会被相邻 user 合并）", () => {
        expect(isEnvelopeText(chatEnvelope([{ from: "human:chen56", text: "x" }]))).toBe(true);
        expect(isEnvelopeText(userEnvelope({ notify: [{ kind: "job-done", text: "x" }] }))).toBe(true);
        expect(isEnvelopeText(userEnvelope({ vars: { self: { steps: 1 } } }))).toBe(true);
    });

    it("普通正文 / 缩进的 YAML 不算信封", () => {
        expect(isEnvelopeText("说1")).toBe(false);
        expect(isEnvelopeText("  chat:\n    - x")).toBe(false);
    });
});
