// tests/core/compact-preview-reuse.test.ts
// 🎯 压缩预览「同一块树多次投影」的复用安全（##321 review1 建议 B）——
//    `compactPreview` 一次算 base/mod **两份视图共用同一份折好的块树**（省掉两遍整读+折叠）。
//    这条捷径的正确性依赖一个**隐式契约**：投影（`projectAll` / `blocksToMessages`）只读、不回写块树。
//    契约无声，将来谁在投影链里引入就地裁剪（比如 `renderMessage` 里 splice 掉一段）就会
//    **静默互相污染** —— base 先把大工具输出裁短，mod 再投就看不到原文，预览与真发分叉。
//    故钉在这里：同一 store 上反复投影必须恒等。

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { getLocalAgent } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { replay, projectAll, blocksToMessages, type Op } from "../../src/main/services/local-blocks";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "compact-reuse-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `预览复用 ${++seq}`, project: PROJECT });

/** 三轮会话（每轮 user + assistant 文本 + 一个 tool），工具输出大到可被 headtail 裁 */
function seedOps(uri: string, turns = 3): void {
    const lines: string[] = [];
    for (let i = 1; i <= turns; i++) {
        const t = `t${7000 + i}`;
        const big = Array.from({ length: 200 }, (_, k) => `row ${k}`).join("\n");
        const push = (o: unknown) => lines.push(JSON.stringify(o));
        push({ op: "start", id: t, kind: "turn" });
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
        push({ op: "stop", id: `${t}_u` });
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
        push({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" } } });
        push({ op: "patch", id: `${t}_c`, fields: { status: "done", output: big } });
        push({ op: "stop", id: `${t}_c` });
        push({ op: "stop", id: `${t}_s1` });
        push({ op: "stop", id: t });
    }
    writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
}

/** 从落盘的 ops.jsonl 折出一份块树（与 main 侧同策略：半行跳过） */
function storeOf(uri: string): ReturnType<typeof replay> {
    const ops = readFileSync(opsFile(uri), "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .flatMap((l) => {
            try {
                return [JSON.parse(l) as Op];
            } catch {
                return [];
            }
        });
    return replay(ops);
}

describe("④ 投影只读：同一块树反复投影恒等（base/mod 共享 store 的复用安全）", () => {
    it("同一 store 上 projectAll / blocksToMessages 交错反复调用，结果不变", () => {
        const uri = newUri();
        seedOps(uri);
        const store = storeOf(uri);
        const msg0 = blocksToMessages(store);
        const all0 = projectAll(store);
        expect(msg0.length).toBeGreaterThan(0);
        // 再投一次 —— 若投影就地裁剪/回写块树，这里就会与首次不同
        expect(blocksToMessages(store)).toEqual(msg0);
        expect(projectAll(store)).toEqual(all0);
        // 交错顺序也不能影响结果
        // 中间插一次**带裁剪**的投递（模拟 headtail）：投影若就地改块树，下面就会变
        blocksToMessages(store, { transformToolResult: (b) => b.output.slice(0, 10) });
        expect(blocksToMessages(store)).toEqual(msg0);
        expect(projectAll(store)).toEqual(all0);
    });
});

describe("④ 压缩预览公开入口：连续两次 + 交错其它投影，输出逐字段一致", () => {
    it("compactPreview(uri, policy) 两次 deep-equal；中间插一次 requestView 也不变", async () => {
        const uri = newUri();
        seedOps(uri);
        const policy = { budgetBytes: 1024 * 1024, toolResult: { render: "asis" } };
        const p1 = await getLocalAgent().compactPreview(uri, policy);
        await getLocalAgent().requestView(uri); // 交错的另一次投影（共享同一份文件）
        const p2 = await getLocalAgent().compactPreview(uri, policy);
        expect(p2).toEqual(p1);
        expect(p2.baseRequest).toEqual(p1.baseRequest);
        expect(p2.modRequest).toEqual(p1.modRequest);
        expect(p2.facts).toEqual(p1.facts);
    });
});
