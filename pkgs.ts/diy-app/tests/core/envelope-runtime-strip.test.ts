// tests/core/envelope-runtime-strip.test.ts
// 🎯 ##422 第二轮：历史 user 消息**只剥 runtime 段**，其余信封字段（from / summary / …）保住
//
// 用户口径（2026-10-24 原文）：「历史里重放的 user 消息，**只剥 runtime 段**（那是每步易变的全量值，
// 重放只会浪费字节并误导模型），其余信封字段（from / 发言人 / 房间 / 投递来源等）**保留**。」
//
// 判据：
//   ① 真信封形态（`from:` + `summary:` + `runtime:` + `runtimeDiff:` + `user:`）⇒ runtime 两段**剥净**，
//      from / summary / user 段**逐字保住**
//   ② 裸文本 / 首行缩进 / 没有顶格 `user:` 的粘贴 YAML ⇒ **逐字不变**（宁少剥，不剥用户正文）
//   ③ **幂等**：剥过的再剥 = 同一份字节
//   ④ 集成：块树里存着一份带 runtime 的信封 ⇒ `projectAll` 出来的消息里没有 runtime、仍带 from
//
// 与本文件相邻的分工：`user-speaker.test.ts` 钉「from 段怎么来」（写入点 + 投影 + 合并），
// 本文件钉「重放时剥哪几段」（纯函数 + 一处投影集成）。

import { describe, it, expect } from "vitest";
import {
    renderFromPart,
    stripRuntimeSections,
    tailEnvelope,
    userEnvelope,
    ENVELOPE_TOP_KEYS,
} from "@diy-agent/context/envelope";
import { toYaml } from "@diy-agent/context/wire-render";
import { BlockStore, projectAll, type Op } from "../../src/main/services/local-blocks";

/** 一份**真形态**的历史 user 信封：from + summary + runtime + runtimeDiff + user（顺序照 `withRuntime`/`projectAll`） */
const realEnvelope = (): string =>
    tailEnvelope(
        [
            toYaml({ summary: "上一次压缩的结论" }),
            toYaml({ runtime: { docs: { count: 10 }, identity: "你是本地 coding agent" } }),
            toYaml({ runtimeDiff: { self: { turn: { steps: 3 } } } }),
            renderFromPart({ id: "agent:main", name: "deepseek-4.1-flash" }),
        ],
        "第一句\n多行内容：a: b",
    );

const topKeys = (text: string): string[] =>
    text
        .split("\n")
        .map((l) => /^([A-Za-z][A-Za-z0-9_]*):(\s|$)/.exec(l)?.[1])
        .filter((k): k is string => k !== undefined);

describe("##422 判据 ①：真信封只剥 runtime", () => {
    it("runtime / runtimeDiff 两段剥净，from / summary / user 逐字保住", () => {
        const env = realEnvelope();
        // 前提：这份 fixtures 真是信封、四段俱全（否则下面的断言测不到东西）
        expect(topKeys(env)).toEqual(["summary", "runtime", "runtimeDiff", "from", "user"]);
        const out = stripRuntimeSections(env);
        expect(topKeys(out)).toEqual(["summary", "from", "user"]);
        expect(out).not.toContain("runtime");
        // 线索段**逐字**还在（不是「差不多」）
        expect(out).toContain(renderFromPart({ id: "agent:main", name: "deepseek-4.1-flash" }));
        expect(out).toContain('summary: "上一次压缩的结论"');
        expect(out).toContain("第一句\n");
        // 剥完仍是同一份合法形状：`user.message` 里逐字 = 原话
        expect(out).toContain(toYaml({ user: { message: "第一句\n多行内容：a: b" } }));
    });

    it("runtime 段夹在中间（user 之后又来一条 runtime）也只剩非 runtime 段", () => {
        const env = tailEnvelope(
            [renderFromPart({ id: "human:chen56" }), toYaml({ runtime: { self: { window: { ratio: 6.6 } } } })],
            "再说一句",
        );
        const out = stripRuntimeSections(env);
        expect(topKeys(out)).toEqual(["from", "user"]);
        expect(out).toContain("再说一句");
    });

    it("只有 runtime（没有其它段）也剥干净 —— 但只在「有顶格 user:」的我们的形态上动手", () => {
        const env = tailEnvelope([toYaml({ runtime: { docs: { count: 10 } } })], "唯一一句");
        expect(stripRuntimeSections(env)).toBe(toYaml({ user: { message: "唯一一句" } }));
    });

    it("runtime 段里的**多行块标量**（含空行、含像顶层键的行）不会漏出来", () => {
        const noise = "行一\n\nuser: 这行是块标量里的内容，不是顶层键\n行尾";
        const env = tailEnvelope(
            [toYaml({ runtime: { identity: noise } }), renderFromPart({ id: "agent:main" })],
            "原话",
        );
        const out = stripRuntimeSections(env);
        expect(out).not.toContain("行一");
        expect(topKeys(out)).toEqual(["from", "user"]);
        expect(out).toBe(tailEnvelope([renderFromPart({ id: "agent:main" })], "原话"));
    });
});

describe("##422 判据 ②：不是我们的形态 ⇒ 逐字不变", () => {
    it("裸文本（存量老块）一字不动", () => {
        for (const t of ["原话", "第一行\n第二行", "a: b\nc: d"]) {
            expect(stripRuntimeSections(t)).toBe(t);
        }
    });

    it("用户粘贴的一段 runtime YAML（**没有顶格 user:**）不动 —— 剥错正文比少剥严重", () => {
        const pasted = "runtime:\n  docs:\n    count: 10\n";
        expect(stripRuntimeSections(pasted)).toBe(pasted);
    });

    it("首行缩进的正文（像信封但不是：首行不顶格）不动", () => {
        const pasted = "  runtime:\n    x: 1\nuser:\n  message: hi";
        expect(stripRuntimeSections(pasted)).toBe(pasted);
    });

    it("首行是非白名单键的信封样文本不动", () => {
        const t = "notakey:\n  x: 1\nuser:\n  message: hi";
        expect(stripRuntimeSections(t)).toBe(t);
    });

    it("真信封但**本来就没有**易变段 ⇒ 逐字不变（含结尾换行等边角）", () => {
        const env = tailEnvelope([renderFromPart({ id: "agent:main" })], "原话");
        expect(stripRuntimeSections(env)).toBe(env);
    });
});

describe("##422 判据 ③：幂等", () => {
    it("剥一次与剥两次同一份字节", () => {
        const once = stripRuntimeSections(realEnvelope());
        expect(stripRuntimeSections(once)).toBe(once);
    });
});

describe("##442 新形态：投影 chat / 剥控制段", () => {
    const build = (content: string, speaker?: Record<string, unknown>): string => {
        const s = new BlockStore();
        for (const op of [
            { op: "start", id: "t1", kind: "turn" },
            {
                op: "start",
                id: "u1",
                kind: "text",
                parent: "t1",
                meta: { role: "user", ...(speaker ? { speaker } : {}) },
            },
            { op: "delta", id: "u1", fields: { content } },
            { op: "stop", id: "u1" },
            { op: "stop", id: "t1" },
        ] as Op[])
            s.apply(op);
        const first = projectAll(s)[0] as { content?: unknown } | undefined;
        return typeof first?.content === "string" ? first.content : "";
    };

    it("裸文本 ⇒ chat: [{from, text}]（默认 from = 本机用户）", () => {
        expect(build("那句原话")).toBe('chat:\n  - from: human:chen56\n    text: "那句原话"');
        expect(build("那句原话", { id: "agent:main" })).toBe('chat:\n  - from: agent:main\n    text: "那句原话"');
    });

    it("块上有 meta.notify ⇒ 投影成 notify 信封（不走 chat）", () => {
        const notify = { kind: "job-done", text: "后台结束", run: "r-1", state: "exited", exitCode: 0 };
        const s = new BlockStore();
        for (const op of [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "u1", kind: "text", parent: "t1", meta: { role: "user", notify } },
            { op: "delta", id: "u1", fields: { content: "后台结束" } },
            { op: "stop", id: "u1" },
            { op: "stop", id: "t1" },
        ] as Op[])
            s.apply(op);
        const first = projectAll(s)[0] as { content?: unknown } | undefined;
        expect(first?.content).toBe(userEnvelope({ notify: [notify as never] }));
        expect(String(first?.content)).not.toContain("chat:");
    });

    it("块里存着带 runtime 的新信封 ⇒ 投影无 runtime、chat 保留", () => {
        const stored = userEnvelope({ runtime: { self: { steps: 3 } }, chat: [{ from: "agent:main", text: "原话" }] });
        const text = build(stored, { id: "agent:main" });
        expect(text).not.toContain("runtime");
        expect(topKeys(text)).toEqual(["chat"]);
        expect(text).toContain("  - from: agent:main");
        expect(text).toContain('text: "原话"');
        expect(ENVELOPE_TOP_KEYS.has(topKeys(text)[0]!)).toBe(true);
    });
});
