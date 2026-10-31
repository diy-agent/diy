// tests/core/context-cache-delta.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 缓存前缀的**构造契约**（##442 / ##486）—— 这几条一破，钱就按全价付。
//
// 用户口径（2026-10-31 复述）：
//   ① 首次请求：变量（system / runtime 两类）**都**放第一条 role:system 里，之后跟 role:user
//   ② 以后每次请求：比对变量树，但**不重建第一条 system**，也不改历史 ——
//      "上次的历史 + 最新的 role:user" 逐字照发，前缀缓存才命中
//   ③ 变量变了：只把**变化的那几个字段**摘出来，按规则塞进新的 role:user 增量
//   ④ 只有压缩（新段）时才重建 system；其余任何时候历史消息不许变
//
// 这里只钉**纯函数**（不碰盘、不拉模型）：
//   segment-snapshot.ts（段首快照判据）· step-delta.ts（增量）· buildDelivery（报文形态）
// 真发链路的端到端口径见 `tests/core/context-refresh.test.ts`。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import { buildDelivery, defaultSystemPlaces, PLACE_CANDIDATES } from "@diy-agent/context/delivery";
import { userEnvelope } from "@diy-agent/context/envelope";
import { hasTopLevelRuntime, segmentSystemTextOf } from "../../src/shared/context/segment-snapshot";
import { stepDeltaOf } from "../../src/shared/context/step-delta";

/** 一份标称 globals（与 envelope-v2 / context-delivery 同一形状，便于跨文件对照） */
const globalsOf = (patch: Record<string, unknown> = {}, taskPatch: Record<string, unknown> = {}) => {
    const task = {
        uri: "projects/1/tasks/1",
        title: "标题一",
        state: "pending",
        dir: "/home/u/.diy/projects/1/tasks/1",
        created: "2026-10-01",
        parent: "",
        updated: "2026-10-01",
        change_type: "",
        module: "",
        priority: "",
        body: "正文一",
        ...taskPatch,
    };
    return {
        diy: { cli: "/repo/diy.sh", home: "/home/u/.diy" },
        project: { path: "/repo" },
        cwd: { path: "/repo", note: "", isFallback: false, isTaskDir: false, isAppDir: true },
        chain: [{ path: "/home/u/AGENTS.md", scope: "/home/u", content: "家目录规范\n" }],
        task,
        skills: [] as string[],
        identity: "你是 diy 管控台的本地 coding agent。",
        rules: "<rules>\n- 用中文\n</rules>\n",
        guard: "<guard>\n禁止杀宿主进程\n</guard>\n",
        reqlog: { file: "/home/u/.diy/log/network/2026-10-31.jsonl" },
        ...patch,
    };
};

const deliveryOf = (patch: Record<string, unknown> = {}, taskPatch: Record<string, unknown> = {}) =>
    buildDelivery(globalsOf(patch, taskPatch), defaultSystemPlaces());

/** system 文本里"第一个顶格 runtime: 之前"的部分 = help 段 + system 段（必须逐字稳定） */
const headOf = (systemText: string): string => {
    const at = systemText.search(/^runtime:/m);
    return at < 0 ? systemText : systemText.slice(0, at);
};

describe("段首快照：什么时候复用、什么时候重建（缓存命中的第一块）", () => {
    const live = "help:\n  x: y\nsystem:\n  a: 1\nruntime:\n  b: 2\n";

    it("首轮（没有上一步快照）→ 用现算的那份（重建一次）", () => {
        expect(segmentSystemTextOf({ liveText: live })).toBe(live);
        expect(segmentSystemTextOf({ liveText: live, lastText: null })).toBe(live);
        expect(segmentSystemTextOf({ liveText: live, lastText: "" })).toBe(live);
    });

    it("★ 同段 + 有快照 → 逐字复用（live 已经变了也不用）—— 这就是前缀缓存能命中的原因", () => {
        const snapshot = "help:\n  x: y\nsystem:\n  a: 1\nruntime:\n  b: 2\n";
        const liveNow = "help:\n  x: y\nsystem:\n  a: 1\nruntime:\n  b: 999\n"; // self 每步都在变
        expect(
            segmentSystemTextOf({ liveText: liveNow, lastText: snapshot, lastCompactAt: "T", boundaryAt: "T" }),
        ).toBe(snapshot);
        // 边界都是"没有"（还没压过）也算同段
        expect(segmentSystemTextOf({ liveText: liveNow, lastText: snapshot })).toBe(snapshot);
    });

    it("★ 压缩换了段 → 必须重建（旧段首描述的是已被压掉的那段世界）", () => {
        const snapshot = "help:\n  x: y\nsystem:\n  a: 1\nruntime:\n  b: 2\n";
        expect(segmentSystemTextOf({ liveText: live, lastText: snapshot, lastCompactAt: "T1", boundaryAt: "T2" })).toBe(
            live,
        );
        // 首次压缩（上一步没有 compactAt，现在有了）同样是新段
        expect(segmentSystemTextOf({ liveText: live, lastText: snapshot, lastCompactAt: null, boundaryAt: "T1" })).toBe(
            live,
        );
    });

    it("老格式快照（##442 之前：system 里没有顶格 runtime）→ 不能当段首，重建", () => {
        const old = "help:\n  runtime:\n    desc: 缩进的说明\nsystem:\n  a: 1\n";
        expect(hasTopLevelRuntime(old)).toBe(false);
        expect(segmentSystemTextOf({ liveText: live, lastText: old })).toBe(live);
    });

    it("★ 全部单元划进 system ⇒ 快照里是 `runtime: {}` —— 仍然是新格式，必须复用", () => {
        // 回归：旧判据用 `line === "runtime:"` 逐行相等，`runtime: {}` 一字不匹配 ⇒ 判成"老格式"
        // ⇒ 每一轮都重建 system ⇒ 缓存全废（用户把全部候选划进 system 时，配置本身是合法的）。
        const allSystem = buildDelivery(
            globalsOf(),
            PLACE_CANDIDATES.map((c) => c.path),
        );
        expect(allSystem.runtime.places).toEqual([]);
        expect(hasTopLevelRuntime(allSystem.system.text)).toBe(true);
        expect(allSystem.system.text).toContain("\nruntime: {}");
        // live 已变（self 之类），但同段 ⇒ 复用快照
        expect(segmentSystemTextOf({ liveText: live, lastText: allSystem.system.text })).toBe(allSystem.system.text);
    });
});

describe("首轮报文：system / runtime 两类变量都在第一条 system 里", () => {
    it("★ 顶格键序 help → system → runtime，两类变量各自就位（之后跟的才是 role:user）", () => {
        const d = deliveryOf();
        expect(d.system.text.startsWith("help:\n")).toBe(true);
        const atHelp = d.system.text.indexOf("help:");
        const atSystem = d.system.text.indexOf("\nsystem:\n");
        const atRuntime = d.system.text.indexOf("\nruntime:\n");
        expect(atHelp).toBeLessThan(atSystem);
        expect(atSystem).toBeLessThan(atRuntime);
        // 稳定项在 system 段（在 runtime 之前）
        expect(headOf(d.system.text)).toContain("家目录规范");
        expect(headOf(d.system.text)).toContain("created: 2026-10-01");
        expect(headOf(d.system.text)).not.toContain("正文一");
        // 易变项在 runtime 段
        const run = d.system.text.slice(atRuntime);
        expect(run).toContain("正文一");
        expect(run).toContain("reqlog:");
        // 两条树都是**全量**（不是增量）：runtime 段里该有本任务全部易变单元
        for (const p of d.runtime.places) {
            const leaf = p.split(".").pop()!;
            expect(run).toContain(`${leaf}:`);
        }
    });

    it("同一份 globals 两次构建 → 逐字节相同（没有随机的键序 / 时间戳混进去）", () => {
        const a = deliveryOf();
        const b = deliveryOf();
        expect(b.system.text).toBe(a.system.text);
        expect(b.runtime.text).toBe(a.runtime.text);
        expect(b.valueHashes).toEqual(a.valueHashes);
    });
});

describe("段内稳定：只改易变单元时，system 的 help + system 段逐字节不变", () => {
    it("改标题 / 状态 / 正文 → 头部（help + system 段）一字不动，只有 runtime 段变", () => {
        const before = deliveryOf().system.text;
        for (const patch of [{ title: "标题二" }, { state: "done" }, { body: "正文二" }, { updated: "2026-10-31" }]) {
            const after = deliveryOf({}, patch).system.text;
            expect(headOf(after)).toBe(headOf(before));
            expect(after).not.toBe(before); // 变化确实落在 runtime 段（否则这条用例是假绿）
        }
    });
});

describe("增量：变几个字段就发几个字段", () => {
    it("★ 只改标题 → 增量里只有 title（不含未变的兄弟字段，也没有多余的 system 段）", () => {
        const prev = deliveryOf();
        const next = deliveryOf({}, { title: "标题二" });
        const delta = stepDeltaOf(prev, next);
        expect(delta.paths).toEqual(["task.title"]);
        expect(delta.systemPaths).toEqual([]);
        expect(delta.runtimePaths).toEqual(["task.title"]);
        expect(delta.text).toBe('runtime:\n  task:\n    title: "标题二"');
        // 未变的兄弟一个都不许出现（否则等于把整个 task 单元重发一遍）
        expect(delta.text).not.toContain("正文一");
        expect(delta.text).not.toContain("state:");
        expect(delta.text).not.toContain("uri:");
        expect(delta.text).not.toContain("system:");
    });

    it("同时改两个单元 → 都发、共用一个容器壳、顺序稳定（字典序）", () => {
        const prev = deliveryOf();
        const next = deliveryOf({}, { title: "标题二", body: "正文二" });
        const delta = stepDeltaOf(prev, next);
        expect(delta.paths).toEqual(["task.body", "task.title"]);
        expect(delta.text).toBe('runtime:\n  task:\n    body: "正文二"\n    title: "标题二"');
    });

    it("什么都没变 → 空串（调用方据此**不注入**：不加消息、不加字节 ⇒ 前缀缓存不动）", () => {
        const prev = deliveryOf();
        const same = deliveryOf();
        const delta = stepDeltaOf(prev, same);
        expect(delta.text).toBe("");
        expect(delta.paths).toEqual([]);
        expect(delta.part.bytes).toBe(0);
    });

    it("★ 按**本步划分**分流：划进 system 的单元走 `system:` 段，不混进 runtime", () => {
        const systemPlaces = [...defaultSystemPlaces(), "task.body"];
        const prev = buildDelivery(globalsOf(), systemPlaces);
        const next = buildDelivery(globalsOf({}, { body: "正文二" }), systemPlaces);
        const delta = stepDeltaOf(prev, next);
        expect(delta.systemPaths).toEqual(["task.body"]);
        expect(delta.runtimePaths).toEqual([]);
        expect(delta.text).toBe('system:\n  task:\n    body: "正文二"');
    });

    it("两段同时变 → `system:` 在前、`runtime:` 在后（键序固定）", () => {
        const systemPlaces = [...defaultSystemPlaces(), "task.body"];
        const prev = buildDelivery(globalsOf(), systemPlaces);
        const next = buildDelivery(globalsOf({}, { body: "正文二", state: "done" }), systemPlaces);
        const delta = stepDeltaOf(prev, next);
        expect(delta.text).toBe('system:\n  task:\n    body: "正文二"\nruntime:\n  task:\n    state: done');
        expect(delta.text.indexOf("system:")).toBeLessThan(delta.text.indexOf("runtime:"));
    });

    it("单元整体消失 → `path: null`（不发 = 模型继续按旧值干活）", () => {
        const withRoom = buildDelivery(
            {
                ...globalsOf(),
                room: { members: { roomId: "projects/1/tasks/1", name: "#1" }, recent: { items: [] } },
            },
            defaultSystemPlaces(),
        );
        const gone = deliveryOf();
        const delta = stepDeltaOf(withRoom, gone);
        expect(delta.paths).toContain("room.recent");
        expect(delta.text).toContain("recent: null");
    });
});

describe("历史不动：增量只追加在**本轮** user 信封里（不新建消息、不改历史）", () => {
    it("增量 + 当轮发言 = 一份合法 YAML，键序 控制段 → chat", () => {
        const delta = stepDeltaOf(deliveryOf(), deliveryOf({}, { title: "标题二" }));

        // 真发里的形态（local-agent 的 sentOf）：增量拼在**当轮** user 信封之前 ——
        // 历史那几条消息根本不在这次拼接里（连碰都没碰）。
        const tail = `${delta.text}\n${userEnvelope({ chat: [{ from: "human:chen56", text: "这一轮" }] })}`;
        const loaded = yaml.load(tail, { schema: yaml.JSON_SCHEMA }) as any;
        expect(tail.startsWith("runtime:\n")).toBe(true);
        expect(tail.indexOf("runtime:")).toBeLessThan(tail.indexOf("chat:"));
        // 控制值真的被模型读到（不是只拼了字符串）
        expect(loaded.runtime.task.title).toBe("标题二");
        // 人说的话仍是自己的顶层键，没被卷进变量树
        expect(loaded.chat).toEqual([{ from: "human:chen56", text: "这一轮" }]);
        expect(loaded.runtime.task.body).toBeUndefined(); // 没变的字段不发
    });

    it("★ 历史消息一条都不变：增量只出现在**末条**，前面几条逐字照旧", () => {
        // 模拟 sentOf：messages = [system, 历史 user/assistant…, 当轮 user 信封]
        const system = deliveryOf().system.text;
        const history = [
            { role: "user" as const, content: 'chat:\n  - from: human:chen56\n    text: "第一轮"' },
            { role: "assistant" as const, content: "好" },
        ];
        const inbound = userEnvelope({ chat: [{ from: "human:chen56", text: "第二轮" }] });
        const delta = stepDeltaOf(deliveryOf(), deliveryOf({}, { title: "标题二" }));

        const merged = [
            ...history.slice(0, -1),
            { ...history[history.length - 1]! },
            { role: "user" as const, content: inbound },
        ];
        // 增量拼进末条（只有末条会变）
        merged[merged.length - 1] = { role: "user", content: `${delta.text}\n${inbound}` };

        // ① system 与历史段逐字节不变（前缀缓存能命中的充要条件）
        expect(system).toBe(deliveryOf().system.text);
        expect(merged[0]).toEqual(history[0]);
        expect(merged[1]).toEqual(history[1]);
        // ② 改动只发生在末条，而且是在**原有正文之前**追加
        expect(merged[2]!.content.endsWith(inbound)).toBe(true);
        expect(merged[2]!.content.startsWith("runtime:\n")).toBe(true);
    });

    it("增量文本本身是**可直接前置**的（以 `runtime:` / `system:` 开头，不带空行 / 前导空白）", () => {
        const delta = stepDeltaOf(deliveryOf(), deliveryOf({}, { title: "标题二" }));
        expect(delta.text.startsWith("runtime:")).toBe(true);
        expect(delta.text.startsWith("\n")).toBe(false);
        expect(delta.text.includes("\n\n")).toBe(false);
    });
});
