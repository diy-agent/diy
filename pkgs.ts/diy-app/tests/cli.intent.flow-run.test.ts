// tests/cli.intent.flow-run.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 工作流**自动轮转**的端到端契约（##341：节点执行器 + 驱动环 + actor 三分流）
//
// 需求（用户原话）：
//   > 需求确定后，就进入了自动轮转 —— 派任务给开发 agent、review agent 评审、打回、回应、
//   > 反复几轮、通过、PR/merge 结案。**我只要观察工作流的运转**。除非后面还有人工审批步骤。
//
// 本文件量的是**这件事真的发生了**（而不是「命令能敲」）：
//   1. **端到端自转**：`flow run` 一条命令，走完 `clarify→design→implement⇄review→ci`，
//      在人工审批点 `approve` 停下 —— 全程**无人** `advance`；`review→implement` 那一轮
//      **打回是自动的**（agent 末行说「打回」，环自己走 bounce 边）。
//   2. **停得对**：`human` 节点停下等人（不是自推）、CI 红**不推**（停在边上）、
//      `--max-steps` 到顶停、断开 RPC 流**中断在跑的轮次**（不悬着）、
//      **任务会话正忙时不替用户插话**（停因 `session-busy`，##341 review1 P2-1 —— 老实现会
//      把节点提示词排进用户会话的插话队列，且停因报 `empty-conclusion` 指错病因）。
//   3. **幂等**：重复 `run` 接着走、不重复消费已完成的节点（判据一律读 `flow show`）。
//   4. **落袋失败不挡轮次**（##341 review1 P3-4 / review2 P3-1）：agent 结论整段是纯 JSON 对象
//      而节点声明的是 `diff`/`patch` ⇒ 试译必抛。立场 = **不拿派生数据作废领域步**：
//      turn 帧亮 `artifactError`，环照常推进，袋里一个字节都不写。
//   5. **观察面**（不新增真源）：`flow show` 的折线/位置/终态、产物袋、`events.jsonl` 的 `author`
//      （谁推的这一步）。
//
// 为什么用桩上游：桩（本地 HTTP + SSE）让「agent 这一轮说什么」变成**确定输入** ——
//   真模型的输出不可控，「打回一轮」这种断言必然假红。落盘/CLI 契约由 tests/core/* 与
//   cli.intent.flow.test.ts 覆盖，本文件只管**驱动环**。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { opsFile } from "../src/main/services/local-agent";

// ─── 桩上游：把「这一轮 agent 说了什么」变成确定输入 ──────────────

interface Stub {
    url: string;
    /** 收到的请求数（用来判断「轮次真的起来了」） */
    requests: Array<Record<string, unknown>>;
    /** 挂起模式：只把 SSE 头发出去、正文不回 —— 用来测「可停」 */
    mode: "reply" | "hang";
    /** 各节点被回复过几次 */
    readonly seen: Map<string, number>;
    /** review 还要打回几次（**用例显式设定**；按全局第几次判会串到别的用例） */
    reviewBounceLeft: number;
    /**
     * 让**这个节点**这一轮回一段**纯 JSON 对象**（不带任何「结论：」行 ⇒ 判据按通过）。
     * 用来测「结论落袋试译失败」那条路（##341 review2 P3-1）：`implement` 声明的是 `diff`/`patch`，
     * 而 `patch` 的 `asText` 只认字符串 / `{text}` ⇒ 这一段必被 `putArtifact` 的试译拒掉。
     * `null` = 关（缺省）。
     */
    jsonNode: string | null;
    /**
     * 让 review 打回时**不带原因**（结论行只写「结论：打回」）—— `pit.flow-driver` ⑤ 明文允许这种写法。
     * 用来测「空意见不落讨论流」（##342 review1 P2-1）。`false` = 关（缺省）。
     */
    bounceReasonless: boolean;
    close(): Promise<void>;
}

/** 从请求体里认出「这是哪个节点的轮次」（驱动环的 turn 消息带【当前节点】…（id）） */
function nodeOf(body: unknown): string {
    const msgs = (body as { messages?: unknown[] } | null)?.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return "";
    const last = JSON.stringify(msgs[msgs.length - 1]);
    const m = /【当前节点】[^"]*（([a-z]+)）/.exec(last);
    return m ? m[1] : "";
}

async function startStub(): Promise<Stub> {
    const requests: Array<Record<string, unknown>> = [];
    const seen = new Map<string, number>();
    const held: Array<import("node:http").ServerResponse> = [];
    let mode: "reply" | "hang" = "reply";
    const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try {
                body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                body = { __unparsed: raw };
            }
            requests.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (mode === "hang") {
                res.write(": stub waiting\n\n");
                held.push(res);
                return;
            }
            const node = nodeOf(body);
            seen.set(node, (seen.get(node) ?? 0) + 1);
            // review 打回 N 次（`reviewBounceLeft`）再通过 —— 「反复几轮」里那一轮打回就靠它
            const bounce = node === "review" && stub.reviewBounceLeft > 0;
            if (bounce) stub.reviewBounceLeft -= 1;
            const text = bounce
                ? stub.bounceReasonless
                    ? "评审意见：这一版先这样。\n结论：打回"
                    : "评审意见：开发的边界条件没覆盖。\n结论：打回（边界条件没覆盖）"
                : node === stub.jsonNode
                  ? '{"summary":"这一步的结论恰好是个纯 JSON 对象（译不进 diff/patch）"}'
                  : `${node} 这一步做完了。\n结论：通过`;
            const chunk = (delta: Record<string, unknown>, finish: string | null) =>
                `data: ${JSON.stringify({
                    id: "stub",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "mimo-v2.6-flash",
                    choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`;
            res.write(chunk({ content: text }, null));
            res.write(chunk({}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        seen,
        reviewBounceLeft: 0,
        jsonNode: null,
        bounceReasonless: false,
        get mode() {
            return mode;
        },
        set mode(m: "reply" | "hang") {
            mode = m;
            if (m === "reply") for (const r of held.splice(0)) r.end();
        },
        close: () =>
            new Promise<void>((r) => {
                for (const h of held.splice(0)) h.end();
                server.close(() => r());
            }),
    };
}

// ─── 夹具 ─────────────────────────────────────────────

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let stub: Stub;

beforeAll(async () => {
    stub = await startStub();
    process.env["OPENCODE_API_KEY"] ||= "intent-test-dummy-key";
    process.env["DIY_ZEN_BASE_URL"] = stub.url;
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = { electron, HOME, sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }) };
}, 120_000);

afterAll(async () => {
    await stub?.close();
    await fx?.electron?.stop();
});

/** 新建「项目 + 一条任务」，起 dev 工作流，并把系统节点换成**不碰网络**的命令 */
async function freshFlow(name: string, params: readonly string[]): Promise<string> {
    const res = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/run-${name}`);
    const pid = String(((res.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id);
    await fx.sh.run(`./diy.sh task create 自动轮转 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;
    const started = await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
    expect(started.code, started.stderr).toBe(0);
    if (params.length > 0) {
        // ⚠️ `--param` 是**数组型**选项：重复给会**后者覆盖前者**（parser 逐项 `input[key]=value`）。
        // 多项必须走 JSON 数组那一种写法（与 `--fields '[“title”]'` 同一个约定）。
        const arg = params.length === 1 ? `'${params[0]}'` : `'${JSON.stringify(params)}'`;
        const set = await fx.sh.run(`./diy.sh flow params set ${uri} --param ${arg}`);
        expect(set.code, set.stderr).toBe(0);
    }
    return uri;
}

interface Frame {
    kind?: string;
    node?: string;
    nodeName?: string;
    verdict?: string;
    reason?: string;
    message?: string;
    outcome?: string;
    to?: string | null;
    /** 结论落袋失败的原因（##341 review1 P3-4；`null` = 落袋正常） */
    artifactError?: string | null;
}

/** 跑一轮驱动环，逐帧解析（帧是**给人看的输出**，不是真源） */
async function runFlow(uri: string, extra = "", timeoutMs = 120_000): Promise<{ code: number; frames: Frame[]; stop: Frame; stdout: string; stderr: string }> {
    const r = await fx.sh.run(`./diy.sh flow run ${uri} ${extra}`.trim(), timeoutMs);
    const frames = r.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Frame);
    const stop = frames.find((f) => f.kind === "stop");
    expect(stop, `未收到停帧；stdout=${r.stdout}\nstderr=${r.stderr}`).toBeTruthy();
    return { code: r.code, frames, stop: stop!, stdout: r.stdout, stderr: r.stderr };
}

interface View {
    position: string | null;
    done: boolean;
    bounces: number;
    next: { mode: string; terminal: boolean; edges: Array<{ to: string; kind: string }> };
    trajectory: Array<{ node: string; seq: number; kind: string }>;
    viewError: string | null;
}

async function show(uri: string): Promise<View> {
    // `getJson` 已经剥掉 CLI 的 `{ok, data}` 外壳：`r.data` 就是 `FlowView` 本身
    const r = await fx.sh.getJson(`./diy.sh flow show ${uri}`);
    return r.data as unknown as View;
}

const line = (v: { node: string; seq: number }): string => `${v.node}#${v.seq}`;

/** 某节点某次驻留的**产物视图**（`flow view` 的 `{ renderer, payload }`；没放产物 ⇒ null） */
async function payloadOf(uri: string, node: string, seq: number): Promise<{ renderer: string; payload: unknown } | null> {
    const r = await fx.sh.getJson(`./diy.sh flow view ${uri} --node ${node} --seq ${seq}`);
    return ((r.data as Record<string, unknown>)["view"] as { renderer: string; payload: unknown } | null) ?? null;
}

/** 审计流（`events.jsonl` —— **只作审计**，驱动判据读的是状态文件） */
function audit(uri: string): Array<{ kind?: string; author?: string; to?: string; content?: string }> {
    const raw = readFileSync(join(fx.HOME, uri, "flow", "events.jsonl"), "utf-8");
    return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>) as Array<{ kind?: string; author?: string; to?: string; content?: string }>;
}

interface OpLine {
    op?: string;
    kind?: string;
    id?: string;
    fields?: Record<string, unknown>;
}

/** 盘上该会话的 ops（权威）—— 用来证明「轮次真的被中断了」 */
function ops(uri: string): OpLine[] {
    const fp = join(fx.HOME, sessionFileRel(uri, "ops"));
    if (!existsSync(fp)) return [];
    return readFileSync(fp, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>) as OpLine[];
}

/** 已开场的轮次 id（`op:start, kind:turn`）—— 轮次的「结束原因」是**后面对这个 id 的 patch**，
 *  不是另一条 start（`Op` 的 patch 不带 `kind`，按 `kind` 找永远找不到）。 */
function turnIds(uri: string): string[] {
    return ops(uri)
        .filter((o) => o.op === "start" && o.kind === "turn")
        .map((o) => String(o.id));
}

/** 每个已收尾轮次的结束原因（`patch` 里的 `endReason.type`） */
function turnEndReasons(uri: string): string[] {
    const ids = new Set(turnIds(uri));
    return ops(uri)
        .filter((o) => o.op === "patch" && ids.has(String(o.id)) && o.fields && "endReason" in o.fields)
        .map((o) => String((o.fields!["endReason"] as { type?: string })?.type ?? ""));
}

// ─── 用例 ─────────────────────────────────────────────

describe("flow run：自动轮转", () => {
    /** 端到端那一份实例（用例之间**顺序**共用：自转 → 幂等 → 审批后收尾） */
    let uri = "";

    it("自转：clarify→design→implement⇄review→ci 全程无人推进，在人工审批点停下（打回那一轮也是自动的）", async () => {
        stub.reviewBounceLeft = 1; // 这一轮要被自动打回一次（「反复几轮」的实质）
        uri = await freshFlow("spin", ["ci.command=echo CI-OK", "merge.command=echo MERGEABLE"]);
        const { code, frames, stop } = await runFlow(uri);
        expect(code).toBe(0);

        // 停因 = 人工审批点（**不是**自推出来的位置）
        expect(stop.reason).toBe("human");
        expect(stop.message).toContain("人工审批点");
        expect(stop.message).toContain("approve");

        // 六个 agent 轮次：review 第一轮打回、第二轮通过（打回走的是 bounce 边，不是人敲的）
        const turns = frames.filter((f) => f.kind === "turn");
        expect(turns.map((t) => t.node)).toEqual(["clarify", "design", "implement", "review", "implement", "review"]);
        expect(turns.map((t) => t.verdict)).toEqual(["pass", "pass", "pass", "bounce", "pass", "pass"]);

        // 状态文件是权威：折线、位置、打回次数
        const view = await show(uri);
        expect(view.position).toBe("approve");
        expect(view.done).toBe(false);
        expect(view.bounces).toBe(1);
        expect(view.trajectory.map(line)).toEqual([
            "clarify#1",
            "design#1",
            "implement#1",
            "review#1",
            "implement#2",
            "review#2",
            "ci#1",
            "approve#1",
        ]);
        expect(view.trajectory.map((v) => v.kind)).toEqual(["next", "next", "next", "next", "bounce", "next", "next", "next"]);

        // 系统那一步（ci）真的跑了命令，产物袋里有它的输出
        const ciPayload = await payloadOf(uri, "ci", 1);
        expect(ciPayload?.renderer).toBe("doc");
        expect(JSON.stringify(ciPayload)).toContain("CI-OK");
        // 产物逐驻留各一份：review 被打回那次也有一份（一行一条 ⇒ `records` 翻成表）
        const reviewPayload = await payloadOf(uri, "review", 1);
        expect(reviewPayload?.renderer).toBe("table");
        expect(JSON.stringify(reviewPayload)).toContain("边界条件");

        // 审计流说得出「这一跳是谁推的」：agent 真名进 author，系统那步记 system
        const ev = audit(uri);
        const authors = ev.map((e) => e.author);
        expect(authors).toContain("评审 agent");
        expect(authors).toContain("system");
        // 打回那一跳是 review 自己的结论推的
        expect(ev.find((e) => e.kind === "bounce")?.author).toBe("评审 agent");
    }, 150_000);

    /**
     * ##342：自动打回的**评审意见正文**要有它自己的载体（可见、留痕）。
     *
     * 判据：驱动环走 bounce 边时把 `verdict.reason`（结论末行括号里那句话）落进讨论流
     * `flow/threads.jsonl`，锚点 = 这次打回的落点驻留（`review#1 → implement#2`），作者 = 评审 agent。
     * 它**只是旁注**（`rule.core-log`）：不进 `state.json`、删了不影响推进（上一条幂等用例照常）。
     */
    it("自动打回的意见进讨论流：锚点 = 那次打回、作者 = 评审 agent（不参与驱动判据）", async () => {
        const r = await fx.sh.getJson(`./diy.sh flow thread list ${uri}`);
        const d = r.data as Record<string, unknown>;
        const threads = (d["threads"] as Array<Record<string, unknown>>) ?? [];
        expect(threads.map((t) => t["id"])).toEqual(["review->implement#2"]);
        // 锚点对得上折线：源 = review#1、落点 = implement#2、折线上第 5 条
        expect(threads[0]).toMatchObject({ real: true, fromSeq: 1, at: 4, status: "open" });
        const posts = (threads[0]!["posts"] as Array<Record<string, unknown>>) ?? [];
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            author: "评审 agent",
            type: "note",
            anchor: { from: "review", to: "implement", seq: 2 },
        });
        expect(String(posts[0]!["text"])).toContain("边界条件没覆盖");
        // 旁注不是领域态：意见正文一个字都不进 state.json（`rule.domain-first`）
        expect(readFileSync(join(fx.HOME, uri, "flow", "state.json"), "utf-8")).not.toContain("边界条件");
    }, 60_000);

    it("幂等：重复 run 立刻在同一个点停下，不重复消费已走完的节点", async () => {
        const before = (await show(uri)).trajectory.length;
        const { stop, frames } = await runFlow(uri);
        expect(stop.reason).toBe("human");
        expect(frames.filter((f) => f.kind === "turn")).toHaveLength(0); // 一轮都没起
        const view = await show(uri);
        expect(view.trajectory.length).toBe(before);
        expect(view.position).toBe("approve");
    }, 60_000);

    it("人工审批之后继续：merge 是系统推（查 PR 可合并），走完 ⇒ 终态 done", async () => {
        const adv = await fx.sh.run(`./diy.sh flow advance ${uri} --to merge`);
        expect(adv.code, adv.stderr).toBe(0);
        const { stop, frames } = await runFlow(uri);
        expect(stop.reason).toBe("done");
        // 系统推那一帧在（不是人手敲的 advance —— 人敲的是 `advance`，它不发帧）
        const steps = frames.filter((f) => f.kind === "step");
        expect(steps.map((s) => [s.node, s.outcome])).toEqual([["merge", "done"]]);

        const view = await show(uri);
        expect(view.done).toBe(true);
        expect(view.position).toBe("merge");
        // 合并那一步的查询输出也进了袋（「这一步真查了什么」有据）
        expect(JSON.stringify(await payloadOf(uri, "merge", 1))).toContain("MERGEABLE");
    }, 60_000);

    it("终态幂等：跑完的实例再 run 立刻返回 done（不重跑 action:）", async () => {
        const { stop, frames } = await runFlow(uri);
        expect(stop.reason).toBe("done");
        expect(frames.filter((f) => f.kind === "step")).toHaveLength(0);
    }, 60_000);
});

describe("flow run：停得住", () => {
    it("系统推不过就停在边上：CI 红 ⇒ 不推（位置停在 ci，没有 approve）", async () => {
        stub.reviewBounceLeft = 0; // 这一次不打回：要单独看 CI 红这一步
        const uri = await freshFlow("red", ["ci.command=false"]);
        const { stop, frames } = await runFlow(uri);
        expect(stop.reason).toBe("stuck");
        expect(stop.message).toContain("CI 未绿");
        // 系统推这一帧照样发（人不在场，「它求了什么值」只能从这里看）；
        // 第一帧是「进入入口」那一步（mode=entry），第二帧才是 ci 的求值
        expect(frames.filter((f) => f.kind === "step").map((s) => [s.node, s.outcome])).toEqual([
            ["clarify", "moved"],
            ["ci", "stuck"],
        ]);
        const view = await show(uri);
        expect(view.position).toBe("ci");
        expect(view.done).toBe(false);
        expect(view.trajectory.map(line)).toEqual([
            "clarify#1",
            "design#1",
            "implement#1",
            "review#1",
            "ci#1",
        ]);
        expect(view.next.edges.map((e) => e.to)).toEqual(["approve"]); // 边上还有路，只是这一刻不通
    }, 150_000);

    it("步数护栏：--max-steps 到顶即停（不空转）", async () => {
        const uri = await freshFlow("guard", []);
        const { stop, frames } = await runFlow(uri, "--max-steps 1");
        expect(stop.reason).toBe("max-steps");
        expect(frames.filter((f) => f.kind === "turn")).toHaveLength(0); // 只走了「进入入口」那一步
        expect((await show(uri)).position).toBe("clarify");
    }, 120_000);

    it("可停：断开驱动环 ⇒ 在跑的那一轮真的被中断（不悬着）", async () => {
        const uri = await freshFlow("abort", []);
        stub.reviewBounceLeft = 0;
        stub.mode = "hang"; // 上游挂着不回 = 这一轮永远不会自己结束
        const child = spawn("./diy.sh", ["flow", "run", uri], {
            cwd: join(__dirname, "..", "..", ".."),
            env: { ...process.env, DIY_HOME: fx.HOME, HOME: fx.HOME, DIY_VARIANT: "test", DIY_CLI_MODE: "compiled" },
            detached: true,
            stdio: "ignore",
        });
        try {
            // 等到轮次真起来（桩收到请求 = 驱动环已经把它发出去了）
            const first = stub.requests.length;
            await waitUntil(async () => stub.requests.length > first, (ok) => ok, { label: "驱动环起轮次", timeoutMs: 30_000 });
            // 再等它落进盘上（轮次开场 op）—— 断得太早就没有「被中断」可言
            await waitUntil(async () => turnIds(uri).length, (n) => n > 0, { label: "轮次开场", timeoutMs: 20_000, intervalMs: 200 });
            expect(turnEndReasons(uri)).toEqual([]); // 还没有结束原因 = 正挂着

            process.kill(-child.pid!, "SIGKILL"); // 收掉整个进程组（CLI + 它的 node）
            const reasons = await waitUntil(async () => turnEndReasons(uri), (r) => r.length > 0, { label: "轮次收尾（中断）", timeoutMs: 20_000 });
            expect(reasons).toContain("aborted");
        } finally {
            try {
                process.kill(-child.pid!, "SIGKILL");
            } catch {
                /* 已退出 */
            }
            stub.mode = "reply";
        }

        // 中断的轮次**不留位置变更**：还在入口节点，实例照常可读、可续跑
        const view = await show(uri);
        expect(view.position).toBe("clarify");
        expect(view.trajectory.map(line)).toEqual(["clarify#1"]);
        const again = await runFlow(uri, "--max-steps 3");
        expect(again.stop.reason).toBe("max-steps");
    }, 150_000);

    it("会话忙：不替用户插话、不污染用户会话（停因 session-busy，提示词一个字节都没发上游）", async () => {
        const uri = await freshFlow("busy", []);
        stub.mode = "hang"; // 用户那一轮永远不结束 ⇒ 该任务会话一直「在跑」
        // 用户自己的轮次（同一条任务会话）—— 驱动环**不许**把自己那一步塞进他后面排队
        const child = spawn("./diy.sh", ["agent", "local", "chat", uri, "用户插话：先别动"], {
            cwd: join(__dirname, "..", "..", ".."),
            env: { ...process.env, DIY_HOME: fx.HOME, HOME: fx.HOME, DIY_VARIANT: "test", DIY_CLI_MODE: "compiled" },
            detached: true,
            stdio: "ignore",
        });
        try {
            const first = stub.requests.length;
            await waitUntil(async () => stub.requests.length > first, (ok) => ok, { label: "用户轮次起飞", timeoutMs: 30_000 });
            const busyAt = stub.requests.length;

            const { stop, frames } = await runFlow(uri, "", 60_000);
            // 停因**说得出病因**（老实现报 `empty-conclusion`「这一轮没有产出结论」—— 把人引去查模型/提示词）
            expect(stop.reason).toBe("session-busy");
            expect(stop.message).toContain("会话正忙");
            // 一轮 agent 都没起（只有「进入入口」那一领域步，不经会话）
            expect(frames.filter((f) => f.kind === "turn")).toHaveLength(0);
            // 节点提示词**一个字节都没发上游**（老实现：退化成插话 ⇒ 请求数不增）
            expect(stub.requests.length).toBe(busyAt);
            // 领域态：照常进入入口，但**停在原地**（没推进 —— 安全侧）
            const view = await show(uri);
            expect(view.position).toBe("clarify");
            expect(view.done).toBe(false);
            expect(view.trajectory.map(line)).toEqual(["clarify#1"]);
            // **没有污染**：用户会话的插话队列里没有驱动环的 turn 消息
            const steer = await fx.sh.run(`./diy.sh agent local steer list ${uri}`);
            expect(steer.stdout).not.toContain("【当前节点】");
        } finally {
            try {
                process.kill(-child.pid!, "SIGKILL");
            } catch {
                /* 已退出 */
            }
            stub.mode = "reply";
        }
    }, 150_000);
});

describe("flow run：产物落袋失败不挡这一轮（##341 review1 P3-4 / review2 P3-1）", () => {
    it("结论整段是纯 JSON 对象（译不进 diff/patch）⇒ 亮 artifactError、照常推进、袋里一个字节不写", async () => {
        stub.jsonNode = "implement"; // implement 声明的是 `diff`/`patch`，而这一轮正文是纯 JSON 对象
        try {
            const uri = await freshFlow("artifact-error", ["ci.command=echo CI-OK", "merge.command=echo MERGEABLE"]);
            const { stop, frames } = await runFlow(uri);

            // ① 立场：落袋失败**不作废**这一轮 —— 停因不是 turn-error，位置也越过了 implement
            expect(stop.reason).not.toBe("turn-error");
            expect(stop.reason).toBe("human"); // 照常走到人工审批点
            const impl = frames.filter((f) => f.kind === "turn" && f.node === "implement");
            expect(impl).toHaveLength(1);
            // 失败原因**亮出来**（不静默）：说得出是哪个插件、原样是对象
            expect(impl[0]!.artifactError).toBeTruthy();
            expect(String(impl[0]!.artifactError)).toContain("patch");

            // ② 照常推进：后一个节点（review）也跑了，折线位置在审批点
            expect(frames.filter((f) => f.kind === "turn").map((f) => f.node)).toEqual(["clarify", "design", "implement", "review"]);
            const view = await show(uri);
            expect(view.position).toBe("approve");
            expect(view.done).toBe(false);
            expect(view.trajectory.map(line)).toEqual(["clarify#1", "design#1", "implement#1", "review#1", "ci#1", "approve#1"]);

            // ③ 袋里**一个字节都没写**（试译失败就不留「谁也译不出的半成品」）……
            expect(existsSync(join(fx.HOME, uri, "flow", "artifacts", "implement.json"))).toBe(false);
            // …而**不相干**的节点照常落袋（不是一损俱损）
            expect(JSON.stringify(await payloadOf(uri, "review", 1))).toContain("通过");
        } finally {
            stub.jsonNode = null;
        }
    }, 150_000);
});

describe("flow run：打回但结论没写原因 ⇒ 不落空发言（##342 review1 P2-1）", () => {
    /**
     * **病根**：`pit.flow-driver` ⑤ 明文允许结论行只写「结论：打回」⇒ `verdictOf` 给出
     * `{kind:"bounce", reason:""}`（**合法**）。而驱动环那两行是
     * `bounceFlow(..., verdict.reason || "打回", ...)` 紧跟 `appendBounceOpinion(..., verdict.reason, ...)`：
     * ⇒ **审计**记 `打回`、**讨论流**落空串 —— 同一次打回两处留痕不一致，UI 上一条没有任何内容的争议发言。
     * 这是**无人值守的主路径**，不是罕见分支（「留痕可见」恰是本任务的交付）。
     *
     * **修法**：闸门收成一处真源（`flow-store.ts::requirePostText`，与 CLI 面板 `postThread` 共用）；
     * 驱动环侧**不凑** `verdict.reason || "打回"`（那是往留痕里造一句评审没说过的话），
     * 它已有 catch ⇒ 自动降级为**不写 + warn**（领域事实已落盘，不该因一句留痕停环）。
     */
    it("自动打回无原因 ⇒ 讨论流**一条发言都没有**（审计照旧记 打回）", async () => {
        stub.reviewBounceLeft = 1;
        stub.bounceReasonless = true; // 结论行 = 「结论：打回」（无括号）
        try {
            const uri = await freshFlow("reasonless", ["ci.command=echo CI-OK", "merge.command=echo MERGEABLE"]);
            const { stop, frames } = await runFlow(uri);
            expect(stop.reason).toBe("human"); // 照常跑到人工审批点（打回确实发生且不挡环）

            // 打回那一跳：**审计**照旧有（口径不同是对的 —— 它记的是「发生了打回」这件事）
            const bounced = frames.filter((f) => f.kind === "turn" && f.verdict === "bounce");
            expect(bounced).toHaveLength(1); // 打回是环自己走的（`turn` 帧不带 reason —— 那在审计与结论里）
            const ev = audit(uri).filter((e) => e.kind === "bounce");
            expect(ev).toHaveLength(1);
            // 审计记的是「发生了打回」（人类可读，note 兜底成「打回」放括号里）—— 与讨论流的空申报不是一回事
            expect(String(ev[0]!.content)).toContain("打回：「Review」→「开发」");
            expect(String(ev[0]!.content)).toMatch(/（打回）$/);

            // **讨论流**：线程**在**（从折线的真打回边推得出来），但**一条发言都没有**（不落空发言）
            const r = await fx.sh.getJson(`./diy.sh flow thread list ${uri}`);
            const threads = ((r.data as Record<string, unknown>)["threads"] as Array<Record<string, unknown>>) ?? [];
            expect(threads.map((t) => t["id"])).toEqual(["review->implement#2"]);
            expect(threads[0]!["posts"]).toEqual([]);
            // 一次写都没发生 ⇒ 文件根本不该被创建
            expect(existsSync(join(fx.HOME, uri, "flow", "threads.jsonl"))).toBe(false);
        } finally {
            stub.bounceReasonless = false;
            stub.reviewBounceLeft = 0;
        }
    }, 150_000);
});
