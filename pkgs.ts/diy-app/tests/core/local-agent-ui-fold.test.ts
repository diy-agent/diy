// tests/core/local-agent-ui-fold.test.ts
// 🎯 ##92：UI 会话重放不再整天全量 fold 大会话。
//
// 契约（任务 body 的处置方向）：
//   ① `history()`（UI 重放 / currentAction 的底座）**起点 = 压缩账本的 keptFromOpsOffset**，
//      与投递侧同一个 seek —— 142 MB 会话不再每次从字节 0 折起；
//   ② 断代 / 截断（`schema` 不符 / 文件被换）仍**整份重放**：那是展示，宁可慢也不能把聊天记录
//      静默变成空白（投递侧才必须断代）；
//   ③ `compactOps` 结果进同一份折叠缓存：块树没变（文件没长）⇒ **返回同一份数组**（不重算）；
//   ④ fold 期的 issue **只在新出现时出声**（旧实现每次取历史重打一遍 ⇒ 266 会话 1.6 次/秒）；
//   ⑤ 带游标的段有**长度上限**：超了从尾部重 seek，不把几十 MB 一段反复折。
// 纯文件读写 + 纯函数，无 Electron / 无网络。
import { describe, it, expect, beforeAll, vi } from "vitest";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager, compactFile } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { llmFile } from "../../src/main/core/local-paths";
import type { CompactEventRecord } from "@diy/compact/compaction";

/** 一轮的行（user 文本 + assistant 文本）；`filler` 用来把单轮撑大（段封顶用例） */
function turnLines(i: number, filler = 0): string[] {
    const t = `t${String(i).padStart(4, "0")}`;
    const chunk = filler > 0 ? "字".repeat(filler) : `第 ${i} 答：好的`;
    const push = (o: unknown) => JSON.stringify(o);
    return [
        push({ op: "start", id: t, kind: "turn", meta: { model: "0@test/m" } }),
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } }),
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 问` } }),
        push({ op: "stop", id: `${t}_u` }),
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t }),
        push({ op: "start", id: `${t}_a`, kind: "text", parent: `${t}_s1`, meta: { role: "assistant" } }),
        push({ op: "delta", id: `${t}_a`, fields: { content: chunk } }),
        push({ op: "stop", id: `${t}_a` }),
        push({ op: "stop", id: `${t}_s1` }),
        push({ op: "stop", id: t }),
    ];
}

const TURNS = 6;
/** 保留起点 = 第 4 轮（前 3 轮被压缩掉） */
const KEEP_FROM = 4;
const CANON = Array.from({ length: TURNS }, (_, k) => turnLines(k + 1).join("\n")).join("\n") + "\n";

const turnIdsOf = (ops: ReadonlyArray<{ op: string; id?: string; kind?: string }>): string[] =>
    ops.filter((o) => o.op === "start" && o.kind === "turn").map((o) => o.id as string);

function turnOffset(text: string, turnId: string): number {
    const line = `{"op":"start","id":"${turnId}","kind":"turn"`;
    const at = text.indexOf(line);
    if (at < 0) throw new Error(`fixture 里找不到 ${turnId}`);
    return Buffer.byteLength(text.slice(0, at), "utf-8");
}

let manager: LocalAgentManager;
let project = "";
let seq = 0;

beforeAll(() => {
    manager = new LocalAgentManager();
    project = createProject(join(diyHome(), "ui-fold-work"));
});

/** 每个用例一个全新任务（折叠缓存 / 会话缓存不互相污染） */
function newTask(opsText: string, ledger?: (ctx: { from: number; llmLine: number; size: number }) => unknown[]): {
    uri: string;
    fp: string;
} {
    const uri = createTask({ title: `ui fold ${++seq}`, project });
    const fp = opsFile(uri);
    mkdirSync(join(fp, ".."), { recursive: true });
    writeFileSync(fp, opsText, "utf-8");
    mkdirSync(join(llmFile(uri), ".."), { recursive: true });
    writeFileSync(llmFile(uri), `${JSON.stringify({ role: "user", content: "占位" })}\n`, "utf-8");
    if (ledger) {
        const from = turnOffset(opsText, `t${String(KEEP_FROM).padStart(4, "0")}`);
        const llmLine = (KEEP_FROM - 1) * 2 + 1;
        const size = statSync(fp).size;
        const lines = ledger({ from, llmLine, size }).map((e) => JSON.stringify(e));
        writeFileSync(compactFile(uri), `${lines.join("\n")}\n`, "utf-8");
    }
    return { uri, fp };
}

function compactEvent(
    ctx: { from: number; llmLine: number; size: number },
    over: Partial<CompactEventRecord> = {},
) {
    return {
        kind: "compact",
        v: 4,
        id: "2026-10-23T00:00:00.000Z",
        ts: "2026-10-23T00:00:00.000Z",
        schema: 1,
        by: "cli",
        trigger: "manual",
        policy: { mode: "budget", modeData: { budgetBytes: 61440 }, summary: false },
        boundary: {
            keptFromTurnId: `t${String(KEEP_FROM).padStart(4, "0")}`,
            keepFromOpIndex: (KEEP_FROM - 1) * 10,
            keptFromOpsOffset: ctx.from,
            keptFromLlmLine: ctx.llmLine,
            opsBytes: ctx.size,
        },
        size: {
            before: { turns: 6, messages: 12, bytes: 1, estTokens: 1 },
            after: { turns: 3, messages: 6, bytes: 1, estTokens: 1 },
            keptTurns: 3,
            droppedTurns: 3,
        },
        ...over,
    };
}

describe("history()：UI 重放的起点 = 压缩账本偏移", () => {
    it("从未压缩 ⇒ 全量（6 轮都在）", () => {
        const { uri } = newTask(CANON);
        expect(turnIdsOf(manager.history(uri))).toHaveLength(TURNS);
    });

    it("已压缩 ⇒ 只 fold 保留段（被压掉的 3 轮不在 UI 重放里）", () => {
        const { uri } = newTask(CANON, (ctx) => [compactEvent(ctx)]);
        const ids = turnIdsOf(manager.history(uri));
        expect(ids).toHaveLength(TURNS - KEEP_FROM + 1);
        expect(ids[0]).toBe(`t${String(KEEP_FROM).padStart(4, "0")}`);
        // 与全量块树的保留段一致：首轮完整（起点是轮首 ⇒ 不塌成根、不丢 patch）
        const ops = manager.history(uri);
        expect(ops[0]).toMatchObject({ op: "start", kind: "turn" });
        expect(ops.some((o) => o.op === "start" && o.id === "t0003")).toBe(false);
    });

    it("断代（schema 不符）⇒ UI 仍整份重放（展示不许静默空白）", () => {
        const { uri } = newTask(CANON, (ctx) => [compactEvent(ctx, { schema: 9 })]);
        expect(turnIdsOf(manager.history(uri))).toHaveLength(TURNS);
    });

    it("账本偏移不是轮首（手改 / 旧版）⇒ 退全量（半个轮会把块树折成根）", () => {
        const { uri } = newTask(CANON, (ctx) => [
            compactEvent({ ...ctx, from: ctx.from + 3, llmLine: 7 }),
        ]);
        expect(turnIdsOf(manager.history(uri))).toHaveLength(TURNS);
    });
});

describe("折叠缓存：compactOps 不重算、issue 不重打", () => {
    it("块树没变 ⇒ 返回同一份数组（缓存命中）；文件长了一点 ⇒ 换新的一份", () => {
        const { uri, fp } = newTask(CANON);
        const a = manager.history(uri);
        const b = manager.history(uri);
        expect(b).toBe(a); // 同一份引用 = 没重算 compactOps
        // 轮末追加一条新 op ⇒ 块树变了 ⇒ 必须重算（不能拿旧折叠流糊弄）
        appendFileSync(fp, `${JSON.stringify({ op: "start", id: "t0007", kind: "turn", meta: { model: "0@test/m" } })}\n`, "utf-8");
        const c = manager.history(uri);
        expect(c).not.toBe(a);
        expect(turnIdsOf(c)).toContain("t0007");
    });

    it("fold 期 issue 只在**新出现**时打日志（缓存命中不再重打）", () => {
        // 一条指向不存在块的 delta ⇒ BlockStore 记一条 issue（不抛）
        const withIssue = `{"op":"delta","id":"ghost","fields":{"content":"x"}}\n${CANON}`;
        const { uri } = newTask(withIssue);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            manager.history(uri);
            const first = warn.mock.calls.filter((c) => String(c[0]).includes("条 issue")).length;
            manager.history(uri);
            manager.history(uri);
            const after = warn.mock.calls.filter((c) => String(c[0]).includes("条 issue")).length;
            expect(first).toBe(1);
            expect(after).toBe(1); // 后两次命中缓存 ⇒ 不再出声
        } finally {
            warn.mockRestore();
        }
    });
});

describe("historyWindow：带游标的段有长度上限", () => {
    it("段超过上限 ⇒ 从尾部重 seek（段不再无限变长）", () => {
        // 真实形状：首载拿一个小段（游标固定），随后会话长开把文件涨到段 > 16 MB。
        // ⚠️ 初始文件必须 > 4 KB：游标指纹按「前 4KB」算（见 local-ops-seek 的 fileSig），
        //    不足 4KB 的文件一长长指纹就变 ⇒ 游标失效、走的是"退全量"而不是本用例要验的上限。
        const { uri, fp } = newTask(`${turnLines(1, 5000).join("\n")}\n${turnLines(2, 5000).join("\n")}\n`);
        const first = manager.historyWindow(uri, { budgetBytes: 4096 });
        expect(turnIdsOf(first.ops)[0]).toBe("t0002"); // 首载窗口贴近尾部（约 4 KB）
        // 长开：追加 ~24 MB 内容（40 轮 × ~600 KB）把段撑过 WINDOW_CAP_BYTES = 16 MB。
        // ⚠️ 必须是**多轮**：单轮 20 MB 是一整行，seek 找不到轮首就会按既定的 floor 降级退全量
        //    （见 local-ops-seek 的「单个块自身不可切」），那验的不是本上限。
        const grown = Array.from({ length: 40 }, (_, k) => turnLines(k + 3, 200_000).join("\n")).join("\n");
        appendFileSync(fp, `${grown}\n`, "utf-8");
        // 轮末重取（渲染端不传预算 —— 与真实调用一致）：段已超上限 ⇒ 起点前移、段变小
        const again = manager.historyWindow(uri, { cursor: first.cursor });
        const ids2 = turnIdsOf(again.ops);
        expect(ids2[0]).not.toBe("t0002"); // 起点已从最初那段前移
        expect(ids2.length).toBeLessThan(40); // 段确实变小了（不再是整份）
        expect(ids2.at(-1)).toBe("t0042"); // 尾部内容仍在（段只是不再从文件头算起）
    });
});
