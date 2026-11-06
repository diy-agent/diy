// tests/core/context-cache-delta.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 缓存前缀的**构造契约**（##442 / ##486 / ##520）—— 这几条一破，钱就按全价付。
//
// 用户口径（2026-10-31 复述）：
//   ① 首次请求：变量树**一份全量**放第一条 role:system 里，之后跟 role:user
//   ② 以后每次请求：比对变量树，但**不重建第一条 system**，也不改历史 ——
//      "上次的历史 + 最新的 role:user" 逐字照发，前缀缓存才命中
//   ③ 变量变了：只把**变化的那几个字段**摘出来，塞进新的 role:user 增量（`vars:` 一段）
//   ④ 只有压缩（新段）时才重建 system；其余任何时候历史消息不许变
//
// 这里只钉**纯函数**（不碰盘、不拉模型）：
//   segment-snapshot.ts（段首快照判据）· step-delta.ts（增量）· buildDelivery（报文形态）
// 真发链路的端到端口径见 `tests/core/context-refresh.test.ts`。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import { buildDelivery } from "@diy-agent/context/delivery";
import { userEnvelope } from "@diy-agent/context/envelope";
import {
    hasTopLevelVars,
    segmentSystemSnapshotOf,
    segmentSystemTextOf,
} from "../../src/shared/context/segment-snapshot";
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
    buildDelivery(globalsOf(patch, taskPatch));

describe("段首快照：什么时候复用、什么时候重建（缓存命中的第一块）", () => {
    const live = "help:\n  x: y\nvars:\n  a: 1\n";

    it("首轮（没有上一步快照）→ 用现算的那份（重建一次）", () => {
        expect(segmentSystemTextOf({ liveText: live })).toBe(live);
        expect(segmentSystemTextOf({ liveText: live, lastText: null })).toBe(live);
        expect(segmentSystemTextOf({ liveText: live, lastText: "" })).toBe(live);
    });

    it("★ 同段 + 有快照 → 逐字复用（live 已经变了也不用）—— 这就是前缀缓存能命中的原因", () => {
        const snapshot = "help:\n  x: y\nvars:\n  a: 1\n";
        const liveNow = "help:\n  x: y\nvars:\n  a: 999\n"; // self 每步都在变
        expect(
            segmentSystemTextOf({ liveText: liveNow, lastText: snapshot, lastCompactAt: "T", boundaryAt: "T" }),
        ).toBe(snapshot);
        expect(segmentSystemTextOf({ liveText: liveNow, lastText: snapshot })).toBe(snapshot);
    });

    it("★ 压缩换了段 → 必须重建（旧段首描述的是已被压掉的那段世界）", () => {
        const snapshot = "help:\n  x: y\nvars:\n  a: 1\n";
        expect(segmentSystemTextOf({ liveText: live, lastText: snapshot, lastCompactAt: "T1", boundaryAt: "T2" })).toBe(
            live,
        );
        expect(segmentSystemTextOf({ liveText: live, lastText: snapshot, lastCompactAt: null, boundaryAt: "T1" })).toBe(
            live,
        );
    });

    it("老格式快照（##520 之前：信封里没有顶格 vars）→ 不能当段首，重建", () => {
        const old = "help:\n  vars:\n    desc: 缩进的说明\nsystem:\n  a: 1\n";
        expect(hasTopLevelVars(old)).toBe(false);
        expect(segmentSystemTextOf({ liveText: live, lastText: old })).toBe(live);
    });

    it("★ 变量树为空 ⇒ 快照里是 `vars: {}` —— 仍然是新格式，必须复用", () => {
        const empty = buildDelivery({});
        expect(empty.text.places).toEqual([]);
        expect(hasTopLevelVars(empty.text.text)).toBe(true);
        expect(empty.text.text).toContain("\nvars: {}");
        expect(segmentSystemTextOf({ liveText: live, lastText: empty.text.text })).toBe(empty.text.text);
    });
});

describe("快照判据的原因：重建必须留痕（否则账单贵了只能靠猜）", () => {
    const snap = "help:\n  x: y\nvars:\n  a: 1\n";

    it("四种原因各归各的", () => {
        expect(segmentSystemSnapshotOf({ liveText: "live" }).reason).toBe("first");
        expect(segmentSystemSnapshotOf({ liveText: "live", lastText: snap }).reason).toBe("reuse");
        expect(
            segmentSystemSnapshotOf({ liveText: "live", lastText: snap, lastCompactAt: "T1", boundaryAt: "T2" }).reason,
        ).toBe("segment-changed");
        expect(segmentSystemSnapshotOf({ liveText: "live", lastText: "help:\n  system:\n    a: 1\n" }).reason).toBe(
            "legacy-format",
        );
    });

    it("reuse 给的是快照原文（不是重新渲染的 live），文本与 reason 同源同一次判定", () => {
        const r = segmentSystemSnapshotOf({ liveText: "live-变了", lastText: snap });
        expect(r.text).toBe(snap);
        expect(segmentSystemTextOf({ liveText: "live-变了", lastText: snap })).toBe(r.text);
    });
});

describe("首轮报文：变量树只有一份全量", () => {
    it("★ 顶格键序 help → vars；稳定项与易变项都在同一份 vars 里", () => {
        const d = deliveryOf();
        expect(d.text.text.startsWith("help:\n")).toBe(true);
        const atHelp = d.text.text.indexOf("help:");
        const atVars = d.text.text.indexOf("\nvars:\n");
        expect(atHelp).toBeLessThan(atVars);
        const body = d.text.text.slice(atVars);
        expect(body).toContain("家目录规范");
        expect(body).toContain("created: 2026-10-01");
        expect(body).toContain("正文一");
        expect(body).toContain("reqlog:");
        expect(d.text.text).not.toContain("\nruntime:\n");
        for (const p of d.text.places) {
            const leaf = p.split(".").pop()!;
            expect(body).toContain(`${leaf}:`);
        }
    });

    it("同一份 globals 两次构建 → 逐字节相同（没有随机的键序 / 时间戳混进去）", () => {
        const a = deliveryOf();
        const b = deliveryOf();
        expect(b.text.text).toBe(a.text.text);
        expect(b.valueHashes).toEqual(a.valueHashes);
    });
});

describe("全量快照：值不变则逐字相同", () => {
    it("值没变 → 全文逐字相同；改任意单元 → 全文变（段首冻结由运行层负责）", () => {
        const before = deliveryOf().text.text;
        expect(deliveryOf().text.text).toBe(before);
        for (const patch of [{ title: "标题二" }, { state: "done" }, { body: "正文二" }, { updated: "2026-10-31" }]) {
            expect(deliveryOf({}, patch).text.text).not.toBe(before);
        }
    });
});

describe("增量：变几个字段就发几个字段", () => {
    it("★ 只改标题 → 增量里只有 title（不含未变的兄弟字段）", () => {
        const prev = deliveryOf();
        const next = deliveryOf({}, { title: "标题二" });
        const delta = stepDeltaOf(prev, next);
        expect(delta.paths).toEqual(["task.title"]);
        expect(delta.text).toBe('vars:\n  task:\n    title: "标题二"');
        expect(delta.text).not.toContain("正文一");
        expect(delta.text).not.toContain("state:");
        expect(delta.text).not.toContain("uri:");
    });

    it("同时改两个单元 → 都发、共用一个容器壳、顺序稳定（字典序）", () => {
        const prev = deliveryOf();
        const next = deliveryOf({}, { title: "标题二", body: "正文二" });
        const delta = stepDeltaOf(prev, next);
        expect(delta.paths).toEqual(["task.body", "task.title"]);
        expect(delta.text).toBe('vars:\n  task:\n    body: "正文二"\n    title: "标题二"');
    });

    it("什么都没变 → 空串（调用方据此**不注入**：不加消息、不加字节 ⇒ 前缀缓存不动）", () => {
        const prev = deliveryOf();
        const same = deliveryOf();
        const delta = stepDeltaOf(prev, same);
        expect(delta.text).toBe("");
        expect(delta.paths).toEqual([]);
        expect(delta.part.bytes).toBe(0);
    });

    it("单元整体消失 → `path: null`（不发 = 模型继续按旧值干活）", () => {
        const withRoom = buildDelivery({
            ...globalsOf(),
            room: { members: { roomId: "projects/1/tasks/1", name: "#1" }, recent: { items: [] } },
        });
        const gone = deliveryOf();
        const delta = stepDeltaOf(withRoom, gone);
        expect(delta.paths).toContain("room.recent");
        expect(delta.text).toContain("recent: null");
    });
});

describe("历史不动：增量只追加在**本轮** user 信封里（不新建消息、不改历史）", () => {
    it("增量 + 当轮发言 = 一份合法 YAML，键序 变量段 → chat", () => {
        const delta = stepDeltaOf(deliveryOf(), deliveryOf({}, { title: "标题二" }));
        const tail = `${delta.text}\n${userEnvelope({ chat: [{ from: "human:chen56", text: "这一轮" }] })}`;
        const loaded = yaml.load(tail, { schema: yaml.JSON_SCHEMA }) as any;
        expect(tail.startsWith("vars:\n")).toBe(true);
        expect(tail.indexOf("vars:")).toBeLessThan(tail.indexOf("chat:"));
        expect(loaded.vars.task.title).toBe("标题二");
        expect(loaded.chat).toEqual([{ from: "human:chen56", text: "这一轮" }]);
        expect(loaded.vars.task.body).toBeUndefined();
    });

    it("★ 历史消息一条都不变：增量只出现在**末条**，前面几条逐字照旧", () => {
        const system = deliveryOf().text.text;
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
        merged[merged.length - 1] = { role: "user", content: `${delta.text}\n${inbound}` };

        expect(system).toBe(deliveryOf().text.text);
        expect(merged[0]).toEqual(history[0]);
        expect(merged[1]).toEqual(history[1]);
        expect(merged[2]!.content.endsWith(inbound)).toBe(true);
        expect(merged[2]!.content.startsWith("vars:\n")).toBe(true);
    });

    it("增量文本本身是**可直接前置**的（以 `vars:` 开头，不带空行 / 前导空白）", () => {
        const delta = stepDeltaOf(deliveryOf(), deliveryOf({}, { title: "标题二" }));
        expect(delta.text.startsWith("vars:")).toBe(true);
        expect(delta.text.startsWith("\n")).toBe(false);
        expect(delta.text.includes("\n\n")).toBe(false);
    });
});
