// tests/services/local-agent-stop-cut.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 S1 回归（任务 201 R1 严重项）：主动停止（链式 return 截断）不得丢终态
//
// 根因（js 语义，probes/session-running/gen-return-swallows-finally.mjs 可复现）：
//   消费端取消 → channel-server-binding 的 `if (cancelled) return` → 对生成器链
//   逐层调 .return() → runTurn 的 finally 里**第一个 yield 吐出后，后续代码永不执行**。
//   旧 closeTurn「先 yield stop、后 noteTurnEnd/审计」+ llm dump 放 try 尾 —— 主动停止后：
//     · turn 的 stop 永不落 ops → toTree 重放 interrupted=true → UI 永久「⚠ 本轮未完成」
//     · turn-end 审计丢失（崩溃现场误判「死在生成中」）、llm.jsonl 缺最后一轮
//
// 两条路径（与 201 探针 probe-stop-truth.mts 同构，但 mock 掉 ai，零网络秒级跑）：
//   A = 消费端点停止：for-await 中途 break（= 链式 return，channel-server 取消的等价物）
//   B = 只 cancel 不断流：main 侧 abort → fullStream 自然结束 → 生成器正常走完
// 两者都必须「收尾完整」；A 在修复前必红（反事实），B 用于钉住「别改坏正常收尾」。
//
// 无网络、无 Electron：vi.mock("ai") 只吐两个 token 后挂起等 abort。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("ai", () => ({
    tool: (cfg: unknown) => cfg,
    stepCountIs: () => () => false,
    streamText: (opts: { abortSignal?: AbortSignal }) => {
        const sig = opts.abortSignal;
        return {
            // 吐两个 token 即挂起，直到 abort 才收束 —— 制造「轮次正在直播中」的窗口，
            // 两条路径都在这个窗口里分叉（A 切断 / B 取消）。
            fullStream: (async function* () {
                yield { type: "start-step" };
                yield { type: "text-start", id: "p1" };
                yield { type: "text-delta", id: "p1", text: "生成中…" };
                if (!sig) return;
                await new Promise<void>((resolve) => {
                    if (sig.aborted) {
                        resolve();
                        return;
                    }
                    sig.addEventListener("abort", () => resolve(), { once: true });
                });
                // abort 后自然结束（真实 ai-sdk 会吐 abort part；终态由 closeTurn 兜，本测试只断言终态）
            })(),
        };
    },
}));

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LocalAgentManager, opsFile } from "../../src/main/services/local-agent";
import { BlockStore, toTree, type Op } from "../../src/main/services/local-blocks";
import { activeTurnList, resetRuntimeContext } from "../../src/main/services/runtime-context";
import { auditFile } from "../../src/main/services/agent-audit";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (taskUri: string) =>
    opsFile(taskUri).split("/").pop()!.replace(/\.ops\.jsonl$/, "");

function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
}

/** 断言「收尾完整」——与 201 探针的判据一一对应（四项缺一即 ❌） */
function expectTerminal(taskUri: string, label: string): void {
    const ops = readJsonl<Op>(opsFile(taskUri));
    const lastTurn = [...ops].reverse().find((o) => o.op === "start" && o.kind === "turn") as
        | { id: string }
        | undefined;
    expect(lastTurn, `${label}: 应有 turn`).toBeTruthy();

    // ① turn 收到 stop（否则 toTree 重放 interrupted=true → UI 永久「本轮未完成」）
    const stops = new Set(ops.filter((o) => o.op === "stop").map((o) => o.id));
    expect(stops.has(lastTurn!.id), `${label}: turn 应收到 stop`).toBe(true);

    // ② UI 警告条件（interrupted && !live）必须为 false —— interrupted 语义本身不许被削弱，
    //    这里断言的是「主动停止后不该被标成中断」
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const lastRoot = store.roots()[store.roots().length - 1];
    const tree = toTree(store, lastRoot.id);
    expect(tree.attrs["interrupted"], `${label}: 重放后不应有 interrupted`).toBeUndefined();

    // ③ turn-end 审计（崩溃现场靠它区分「死在生成中」还是「生成已结束」）
    const auditRows = readJsonl<{ phase?: string; taskUri?: string }>(auditFile(diyHome()));
    expect(
        auditRows.some((r) => r.phase === "turn-end" && r.taskUri === taskUri),
        `${label}: 审计应有 turn-end`,
    ).toBe(true);

    // ④ llm.jsonl 最后一轮 dump（仿真预览的历史来源）
    const llmPath = join(diyHome(), "local", `${keyOf(taskUri)}.llm.jsonl`);
    expect(existsSync(llmPath), `${label}: llm dump 应存在`).toBe(true);
    expect(statSync(llmPath).size, `${label}: llm dump 不应为空`).toBeGreaterThan(0);

    // ⑤ 活跃轮次注销（UI 真值：否则永远显示生成中 + 停止无效）
    expect(
        activeTurnList().find((t) => t.taskUri === taskUri),
        `${label}: activeTurns 应已注销`,
    ).toBeUndefined();
}

let projectDir: string;
let pid: string;
let counter = 0;
function freshTask(title: string): string {
    counter++;
    return `projects/${pid}/tasks/${createTask({ title: `${title}-${counter}`, project: pid })}`;
}

beforeAll(() => {
    process.env["OPENCODE_ZEN_API_KEY"] = "test-key"; // 只为过 chat 入口校验；mock 不出网
    projectDir = mkdtempSync(join(tmpdir(), "stop-cut-probe-"));
    mkdirSync(projectDir, { recursive: true });
    pid = createProject(projectDir);
});

beforeEach(() => {
    resetRuntimeContext();
});

describe("主动停止的收尾完整性（201 R1-S1 回归）", () => {
    it("A：消费端中途切断（= renderer 点停止的链式 return）→ 终态五项齐全", async () => {
        const uri = freshTask("切断停止");
        const mgr = new LocalAgentManager();
        const gen = mgr.chat(uri, "你好");

        let cut = false;
        for await (const op of gen) {
            if (op.op === "delta" && (op.fields as { content?: string })?.content === "生成中…") {
                // 链式 return：等价于 channel-server-binding 收到 end 帧后的
                // `if (cancelled) return`（for-await 隐式 IteratorClose → 逐层 .return()）
                cut = true;
                break;
            }
        }
        expect(cut, "应到达直播中状态再切断").toBe(true);
        await sleep(50); // chat.finally 的异步收尾余量（写盘本身是同步的）

        expectTerminal(uri, "A 切断");
        // 修复前的指纹（反事实可对照）：turn 无 stop、无 turn-end、llm dump 缺失
        rmSync(projectDir, { recursive: true, force: true });
    });

    it("B：只 cancel 不断流（CLI 路径）→ 正常收尾不被改坏", async () => {
        const uri = freshTask("cancel收尾");
        const mgr = new LocalAgentManager();
        const gen = mgr.chat(uri, "你好");

        let cancelled = false;
        for await (const op of gen) {
            if (!cancelled && op.op === "delta" && (op.fields as { content?: string })?.content === "生成中…") {
                cancelled = true;
                expect(mgr.cancel(uri), "cancel 应命中在途轮次").toBe(true);
                // 不 break：继续消费，让生成器自然走完（这正是 CLI 只发 cancel 的路径）
            }
        }
        await sleep(50);

        expectTerminal(uri, "B cancel");
        rmSync(projectDir, { recursive: true, force: true });
    });
});
