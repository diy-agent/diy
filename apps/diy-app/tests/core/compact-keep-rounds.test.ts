// ##266：压缩到 0（全清）后，投递必须从 EOF 开始 —— 不再带旧历史。
//
// 之前的 bug：`compact.setKept` 对 keepRounds = 0 直接 return（"不支持 0"），
// 于是压到 0 时**一条边界都没写**，旧历史照旧投递，模型表现为「压了还是疯癫」。
import { describe, it, expect } from "vitest";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager, keptRoundsView, resolveOpsReplay } from "../../src/main/services/local-agent";
import { opsFile, sessionFileRel } from "../../src/main/core/local-paths";
import { join } from "node:path";
import { diyHome as _home } from "../../src/main/core/state";
import { appendTurnRecord, readBoundary } from "../../src/main/services/local-turns";

/** usage.jsonl 的一行：`keptRoundsView` 的轮序就是从这里来的（不是从 turns 账） */
function usageLine(turnId: string, i: number, tokens: number): string {
    return JSON.stringify({
        ts: new Date().toISOString(), turnId, step: 1, model: "test", apiFace: "chat",
        usage: { inputTokens: tokens, outputTokens: 10 },
    });
}

function seedUsage(task: string, lines: string[]): void {
    writeFileSync(join(_home(), sessionFileRel(task, "usage")), lines.join("\n") + "\n");
}

function turnLines(i: number): string[] {
    const id = `t${1000 + i}`;
    return [
        JSON.stringify({ op: "start", id, kind: "turn" }),
        JSON.stringify({ op: "start", id: `${id}_u`, kind: "text", parent: id, meta: { role: "user" } }),
        JSON.stringify({ op: "delta", id: `${id}_u`, fields: { content: `第${i}轮的问题` } }),
        JSON.stringify({ op: "stop", id: `${id}_u` }),
        JSON.stringify({ op: "start", id: `${id}_a`, kind: "text", parent: id, meta: { role: "assistant" } }),
        JSON.stringify({ op: "delta", id: `${id}_a`, fields: { content: `第${i}轮的回答` } }),
        JSON.stringify({ op: "stop", id: `${id}_a` }),
        JSON.stringify({ op: "stop", id }),
    ];
}

describe("compaction：keepRounds = 0 是全清", () => {
    it("写 turnId=null 的边界，且重放起点 = ops 文件尾", () => {
        const project = createProject(`${diyHome()}/allclear`, { label: "全清" });
        const task = createTask({ title: "全清验证", project });
        const fp = opsFile(task);
        writeFileSync(fp, turnLines(1).join("\n") + "\n");
        // 轮记录必须存在：全清边界要靠「最后一轮的 ops 锚点」写 keptFromOpsOffset，
        // 没有它 resolveOpsReplay 只能老实全读（= 旧历史照旧投递，##266 的现象）。
        appendTurnRecord(task, {
            turnId: "t1001", at: new Date().toISOString(), state: "ok", user: "第1轮的问题",
            texts: [{ seq: 0, text: "第1轮的回答" }], refFirstOp: { offset: 0, seq: 0, len: 0 },
        });
        const off2 = statSync(fp).size; // 第二轮第一条 op 的起点
        appendFileSync(fp, turnLines(2).join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1002", at: new Date().toISOString(), state: "ok", user: "第2轮的问题",
            texts: [{ seq: 0, text: "第2轮的回答" }], refFirstOp: { offset: off2, seq: 8, len: 0 },
        });
        seedUsage(task, [usageLine("t1001", 1, 1000), usageLine("t1002", 2, 2000)]);
        const sizeBefore = statSync(fp).size;

        const manager = new LocalAgentManager();
        const r = manager.compactToKeepRounds(task, 0);
        expect(r).not.toBeNull();
        expect(r!.keptRounds).toBe(0);

        const boundary = readBoundary(task);
        expect(boundary).not.toBeNull();
        expect(boundary!.cut.turnId).toBeNull();        // 全清的判据
        expect(boundary!.cut.llmLine).toBeGreaterThan(0);

        // 投递起点必须是文件尾 —— 这才叫「不带旧历史上去」
        const replay = resolveOpsReplay(task);
        expect(replay.from).toBe(sizeBefore);

        // 面板读数也必须是 0：`boundary.turnId === null`（全清）曾被当成「没有边界 ⇒ 全保留」，
        // 于是压到 0 之后重新打开面板仍显示原来的轮数（用户实测「看起来没压干净」）。
        const view = keptRoundsView(task);
        expect(view.keptCount).toBe(0);
        expect(view.rounds.length).toBe(0);

        // 全清之后继续对话：**新产生的轮必须被算作保留**（用户实测「保持 0 不变了」）。
        // 判据是字节锚点：轮的 ops 起点 ≥ 边界的 ops 起点 ⇒ 保留（与投递侧同一口径）。
        const off3 = statSync(fp).size; // 第三轮第一条 op 的起点（= 全清边界之后）
        const newTurn = turnLines(3);
        appendFileSync(fp, newTurn.join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1003", at: new Date().toISOString(), state: "ok", user: "第3轮的问题",
            texts: [{ seq: 0, text: "第3轮的回答" }], refFirstOp: { offset: off3, seq: 16, len: 0 },
        });
        // 新一轮的用量也要进 usage（轮序从那里来）
        const uf = join(_home(), sessionFileRel(task, "usage"));
        appendFileSync(uf, usageLine("t1003", 3, 3000) + "\n");
        const after = keptRoundsView(task);
        expect(after.keptCount).toBe(1);
        expect(after.rounds[0]!.label).toBe("轮3");
        expect(after.droppedCount).toBe(2);
        expect(existsSync(opsFile(task))).toBe(true);  // ops 原文保留（压缩不删历史）
    });

    it("keepRounds = 1 时保留最后一轮（切点落在轮首）", () => {
        const project = createProject(`${diyHome()}/keep1`, { label: "留一轮" });
        const task = createTask({ title: "留一轮验证", project });
        const fp = opsFile(task);
        writeFileSync(fp, turnLines(1).join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1001", at: new Date().toISOString(), state: "ok", user: "第1轮的问题",
            texts: [{ seq: 0, text: "第1轮的回答" }], refFirstOp: { offset: 0, seq: 0, len: 0 },
        });
        const off2 = statSync(fp).size; // 第二轮第一条 op 的起点
        appendFileSync(fp, turnLines(2).join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1002", at: new Date().toISOString(), state: "ok", user: "第2轮的问题",
            texts: [{ seq: 0, text: "第2轮的回答" }], refFirstOp: { offset: 0, seq: 8, len: 0 },
        });

        const manager = new LocalAgentManager();
        const r = manager.compactToKeepRounds(task, 1);
        expect(r!.keptRounds).toBe(1);
        const boundary = readBoundary(task);
        expect(boundary!.cut.turnId).toBe("t1002");      // 第二轮 = 最后一轮
    });
});
