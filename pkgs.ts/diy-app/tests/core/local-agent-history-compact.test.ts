// tests/core/local-agent-history-compact.test.ts
// 🎯 `agent local history`（UI 重放数据源）的折叠与增量缓存（任务 290）。
//
// 契约（对消费端完全透明，故这里只验两件事）：
//   ① history() 返回的 op 流**重放出的块树**与原始日志逐字段一致 —— 只是 op 数少了两个数量级；
//   ② 增量：append 后只读新增尾巴，结果与「整份重放」等价 —— 缓存不许把两份文件缝在一起，
//      也不许重复 fold 已有轮次。
// 缓存失效的两个哨兵各一条用例：文件变短（清空）、前 4KB 变（整文件覆盖且尺寸相同）。
import { describe, it, expect, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { BlockStore, replay, type Op } from "../../src/main/services/local-blocks";

/** 轮的行：text 块内容逐 token 落盘（真实形态）—— 3 个 delta = 3 条 op，折叠后 1 条 patch */
function turnLines(i: number, filler = 40): string[] {
    const id = `t${String(i).padStart(4, "0")}`;
    const chunk = "字".repeat(filler);
    return [
        JSON.stringify({ op: "start", id, kind: "turn", meta: { model: "0@test/m" } }),
        JSON.stringify({ op: "start", id: `${id}_u`, kind: "text", parent: id, meta: { role: "user" } }),
        JSON.stringify({ op: "delta", id: `${id}_u`, fields: { content: `问${i}` } }),
        JSON.stringify({ op: "stop", id: `${id}_u` }),
        JSON.stringify({ op: "start", id: `${id}_s1`, kind: "step", parent: id }),
        JSON.stringify({ op: "start", id: `${id}_a1`, kind: "text", parent: `${id}_s1`, meta: { role: "assistant" } }),
        ...Array.from({ length: 3 }, (_, k) => JSON.stringify({ op: "delta", id: `${id}_a1`, fields: { content: `${k}${chunk}` } })),
        JSON.stringify({ op: "stop", id: `${id}_a1` }),
        JSON.stringify({ op: "stop", id: `${id}_s1` }),
        JSON.stringify({ op: "stop", id }),
    ];
}

/** 块树快照（结构 + 终值字段；touched 是 fold 时序号，不参与比较） */
function snapshot(store: BlockStore) {
    const STRUCT = new Set(["id", "kind", "parent", "children", "stopped", "touched"]);
    return [...store.blocks.values()]
        .map((b) => ({
            id: b.id,
            kind: b.kind,
            parent: b.parent ?? null,
            children: [...b.children],
            stopped: b.stopped,
            fields: Object.fromEntries(
                Object.entries(b).filter(([k]) => !STRUCT.has(k)).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)),
            ),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const toLines = (ops: Op[]): string => ops.map((o) => JSON.stringify(o)).join("\n");

/** 测试侧的「整份重放」参照实现（与 main 的读法不同源，用来交叉验证） */
const parseAll = (text: string): Op[] =>
    text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Op);

let manager: LocalAgentManager;
let uri = "";
let fp = "";
const TURNS = 6;

beforeAll(() => {
    manager = new LocalAgentManager();
    const project = createProject(path.join(diyHome(), "hist-compact-work"));
    uri = createTask({ title: "历史折叠", project });
    fp = opsFile(uri);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, Array.from({ length: TURNS }, (_, k) => turnLines(k + 1).join("\n")).join("\n") + "\n");
});

const countTurns = (ops: Op[]): number => ops.filter((o) => o.op === "start" && o.kind === "turn").length;

describe("history 折叠：块树等价、体积骤降", () => {
    it("返回折叠流（无 delta），重放出的块树与原日志一致", () => {
        const raw = replay(parseAll(readFileSync(fp, "utf-8")));
        const h = manager.history(uri);
        expect(h.some((o) => o.op === "delta")).toBe(false); // 折叠后不该再有 delta
        expect(countTurns(h)).toBe(TURNS);
        expect(snapshot(replay(h))).toEqual(snapshot(raw));
    });

    it("缓存命中：同样内容多次调用返回一致结果", () => {
        const a = manager.history(uri);
        const b = manager.history(uri);
        expect(b).toEqual(a);
    });
});

describe("history 增量：append 只读尾巴", () => {
    it("新增一轮后：结果含新轮，且不重复已有轮", () => {
        appendFileSync(fp, turnLines(TURNS + 1).join("\n") + "\n");
        const h = manager.history(uri);
        expect(countTurns(h)).toBe(TURNS + 1);
        // 无重复：同一 id 只出现一次 start
        const starts = h.filter((o) => o.op === "start").map((o) => (o as { id: string }).id);
        expect(new Set(starts).size).toBe(starts.length);

        // 与整份重放等价
        const whole = replay(parseAll(readFileSync(fp, "utf-8")));
        expect(snapshot(replay(h))).toEqual(snapshot(whole));
    });

    it("尾部半行（写入中途）不被消费，补全后才进来", () => {
        // 追加一个**没有结尾换行**的 turn start = 写入中途的半行
        appendFileSync(fp, JSON.stringify({ op: "start", id: "t0009", kind: "turn", meta: { model: "m" } }));
        const h1 = manager.history(uri);
        expect(countTurns(h1)).toBe(TURNS + 1); // 半行不算一轮（上一用例的第 7 轮已在）
        expect(h1.some((o) => o.op === "start" && (o as { id: string }).id === "t0009")).toBe(false);

        appendFileSync(fp, "\n");
        const h2 = manager.history(uri);
        expect(countTurns(h2)).toBe(TURNS + 2);
        expect(h2.some((o) => o.op === "start" && (o as { id: string }).id === "t0009")).toBe(true);
    });
});

describe("history 缓存失效：两个哨兵", () => {
    it("文件变短（清空）→ 重放，不残留旧轮", () => {
        rmSync(fp, { force: true });
        expect(manager.history(uri)).toEqual([]);
        // 重建一个短会话：也不该混进旧内容
        writeFileSync(fp, turnLines(99).join("\n") + "\n");
        const h = manager.history(uri);
        expect(countTurns(h)).toBe(1);
        expect(h.some((o) => (o as { id: string }).id.startsWith("t0001"))).toBe(false);
    });

    it("同尺寸整文件覆盖（前 4KB 变）→ 检出并重建", () => {
        const a = toLines(turnLines(1).map((l) => JSON.parse(l) as Op)) + "\n";
        writeFileSync(fp, a);
        expect(countTurns(manager.history(uri))).toBe(1);

        // 换一份**字节数相同**但内容不同的日志：把 id 里的 't' 改成 'x'（等长）
        const b = a.replace(/t0001/g, "x0001");
        expect(b.length).toBe(a.length);
        writeFileSync(fp, b);
        const h = manager.history(uri);
        expect(h.some((o) => (o as { id: string }).id.startsWith("x0001"))).toBe(true);
        expect(h.some((o) => (o as { id: string }).id.startsWith("t0001"))).toBe(false);
    });
});
