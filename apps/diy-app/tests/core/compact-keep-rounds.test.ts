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
import { opsFile } from "../../src/main/core/local-paths";
import { appendTurnRecord, readBoundary } from "../../src/main/services/local-turns";

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
            texts: [{ seq: 0, text: "第1轮的回答" }], refFirstOp: { offset: 0, seq: 0 },
        });
        appendFileSync(fp, turnLines(2).join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1002", at: new Date().toISOString(), state: "ok", user: "第2轮的问题",
            texts: [{ seq: 0, text: "第2轮的回答" }], refFirstOp: { offset: statSync(fp).size, seq: 8 },
        });
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
        expect(existsSync(opsFile(task))).toBe(true);  // ops 原文保留（压缩不删历史）
    });

    it("keepRounds = 1 时保留最后一轮（切点落在轮首）", () => {
        const project = createProject(`${diyHome()}/keep1`, { label: "留一轮" });
        const task = createTask({ title: "留一轮验证", project });
        const fp = opsFile(task);
        writeFileSync(fp, turnLines(1).join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1001", at: new Date().toISOString(), state: "ok", user: "第1轮的问题",
            texts: [{ seq: 0, text: "第1轮的回答" }], refFirstOp: { offset: 0, seq: 0 },
        });
        appendFileSync(fp, turnLines(2).join("\n") + "\n");
        appendTurnRecord(task, {
            turnId: "t1002", at: new Date().toISOString(), state: "ok", user: "第2轮的问题",
            texts: [{ seq: 0, text: "第2轮的回答" }], refFirstOp: { offset: 0, seq: 8 },
        });

        const manager = new LocalAgentManager();
        const r = manager.compactToKeepRounds(task, 1);
        expect(r!.keptRounds).toBe(1);
        const boundary = readBoundary(task);
        expect(boundary!.cut.turnId).toBe("t1002");      // 第二轮 = 最后一轮
    });
});
