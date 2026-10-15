// src/main/services/flow-runner.ts — 工作流的**自动轮转**（##341：节点执行器 + 驱动环 + actor 三分流）
//
// 这里回答的问题是「**谁去跑 agent**」—— ##319/##337/##320 把「存储 + CLI + 产物 + UI」都铺好了，
// 但每一步的推进一直靠人手：`diy flow advance` 得有人敲、agent 得有人起。本文件把那条缝补上：
//
//   需求确定之后 → 派给开发 agent → 评审 agent 评 → 打回 / 回应 → 再来一轮 → 过 → CI → 人工批 → 合并
//   人只看工作流自己转（除人工审批点）。
//
// ── 驱动环（交付物 4）：按 `FlowView.next.mode` 三分流 ────────────────────────────────
//
//     entry        ⇒ 进入入口节点（第一次进工作流）
//     system       ⇒ `core/flow.ts::stepFlow`：**真求值** `pred:` / `action:`（CI 绿没绿、PR 可不可合）
//                    并自动推进 —— **这就是用户要的「绿线」**；不过就停在边上（不推）
//     actor + agent⇒ 起一轮本地 agent（节点提示词 + 上游产物 + 交付约定）→ 收结论 → 落产物 → 推进/打回
//     actor + human⇒ **停下等人**（人工审批点：`diy flow advance` / UI 上点「推进」才继续）
//
//   停止条件：终态（done）/ 等人 / 停在边上（stuck）/ 打回超上限 / 空结论 / 出错 / `--max-steps` / 被中断。
//   **幂等**：一切判据读 `flow show`（状态文件），推进过的节点不会再被消费 —— 重复 `run` 接着走，
//   已跑完的实例立刻返回（终态幂等 ##333）。
//
// ── 节点执行器（交付物 2）─────────────────────────────────────────────────────────
//
//   turn 消息 = 【角色】（执行者表的 role）+【节点】（名称/提示词）+【上游】（折线 + 上游产物摘要）
//              +【本步产物】（节点 `art.raw` 的人话说明）+【交付约定】（末行 `结论：通过` / `结论：打回`）。
//   起 turn 复用既有那条链（`LocalAgentManager.chat`：会话 / 人物 / 流式），**不另造**一套。
//   turn 结束后：结论正文落**产物袋**（`core/flow.ts::putArtifact`，同一个「JSON 能解析就是那个值」约定）
//   → 按判据 `advance` 或 `bounce`（审计 `author` = 该 agent 的标识）。
//
// ── 打回判据（交付物 2 要求「判据自定并写清」）────────────────────────────────────────
//
//   **末行约定**：`结论：通过` / `结论：打回（原因…）`。看的是**最后一行**（正文里出现「打回」二字不算），
//   且**只有当前节点真有 bounce 出边时才看**；读不到约定行 ⇒ **按通过**（不误打回、不会打出死循环）。
//   为什么用明文约定而不是猜语义：判据必须是**可复核**的（人能照着核对），猜「这句话像不像在拒绝」
//   只会得到一个偶尔打回、偶尔放行的黑盒。
//
// ── 观察（交付物 5）：不新增真源 ──────────────────────────────────────────────────
//
//   进度有两处既有可观测面：① `flow show` 的折线 / 位置 / 产物（领域事实）；② `events.jsonl` 审计流
//   （每跳一条，`author` 说清是 `system` 还是哪个 agent）。`flow run` 的回流帧只是**给人看的输出**，
//   不是真源 —— 关掉它、杀掉 CLI，状态文件照样是权威（`rule.core-log`）。

import type { FlowView } from "../core/flow";
import { advanceFlow, bounceFlow, finishFlow, putArtifact, showFlow, stepFlow } from "../core/flow";
import { readArtifacts } from "../core/flow-store";
import { diyHome } from "../core/state";
import { personaByIdOrName } from "../core/persona";
import type { CommandFact, HostPluginDeps } from "../workflows/plugins";
import { executorOf, workflowById, type NodeExecutor } from "../workflows";

/** 驱动环停下来的原因（每一种都是**正常结局**，不是异常） */
export type RunStop =
    /** 工作流跑完（`done`） */
    | "done"
    /** 停在人工审批点等人 */
    | "human"
    /** 停在边上：系统求值不过、又无可走的 bounce 边（CI 红就是这条） */
    | "stuck"
    /** 打回次数到了 L2 参数给的 `maxBounces` 上限（死循环护栏） */
    | "bounce-limit"
    /** 本步的 agent 没给出结论（空正文）—— 不拿空结论推进 */
    | "empty-conclusion"
    /** 起 agent 轮次失败（模型 / 网络 / 配置） */
    | "turn-error"
    /** 步数护栏（`--max-steps`）到顶 */
    | "max-steps"
    /** 调用方中断（CLI 断开 / Ctrl-C） */
    | "aborted";

/** 一条进度帧（**给人看的输出**，不是真源；见文件头「观察」） */
export type RunFrame =
    | {
          readonly kind: "step";
          readonly node: string;
          readonly nodeName: string;
          readonly mode: "entry" | "system";
          readonly outcome: "moved" | "done" | "stuck";
          readonly to: string | null;
          readonly moveKind: string | null;
          readonly reason: string;
      }
    | {
          readonly kind: "turn";
          readonly node: string;
          readonly nodeName: string;
          readonly agent: string;
          readonly verdict: "pass" | "bounce";
          readonly chars: number;
      }
    | { readonly kind: "stop"; readonly reason: RunStop; readonly message: string };

export interface RunOptions {
    /** 步数护栏（缺省 32）：驱动环是状态机驱动，给个上限免得定义写错时空转 */
    readonly maxSteps?: number;
    /** `ci` / PR 命令的工作目录（缺省 = 进程 cwd = 应用包根） */
    readonly cwd?: string;
    /** 外部世界能力的替身（测试用；缺省真跑） */
    readonly deps?: HostPluginDeps;
    /** 中断信号（CLI 断开时由 RPC 层给） */
    readonly signal?: AbortSignal;
    /** 逐帧回调（`flow run` 的流式输出） */
    readonly onFrame?: (frame: RunFrame) => void;
}

export interface RunResult {
    readonly stopped: RunStop;
    readonly message: string;
    readonly steps: number;
    readonly frames: readonly RunFrame[];
}

/** 缺省步数护栏：够走完「6 节点 + 一轮打回 + 人工审批」还有余量 */
const DEFAULT_MAX_STEPS = 32;

/** 上游产物进 turn 消息时的截断长度（提示词不是日志转储） */
const ARTIFACT_CLIP = 800;

/**
 * 跑驱动环，直到停下（终态 / 等人 / 卡住 / 触上限 / 被中断）。**幂等**：重复调用接着走。
 *
 * 一步 = 一次「分类 → 分流 → 落盘」。每步都重新 `flow show`（判据一律读状态文件，不靠内存态），
 * 故中断 / 崩溃后重跑不会有「记在心里的进度」与盘上不一致的问题。
 */
export async function runFlow(uri: string, opts: RunOptions = {}): Promise<RunResult> {
    const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    const frames: RunFrame[] = [];
    const emit = (frame: RunFrame): void => {
        frames.push(frame);
        opts.onFrame?.(frame);
    };
    const stop = (reason: RunStop, message: string, steps: number): RunResult => {
        emit({ kind: "stop", reason, message });
        return { stopped: reason, message, steps, frames };
    };
    let steps = 0;

    for (let step = 0; step < maxSteps; step += 1) {
        steps += 1;
        if (opts.signal?.aborted) return stop("aborted", "被中断（调用方断开）", steps);
        const view = showFlow(uri);
        if (view.done) return stop("done", `工作流已跑完（位置 ${view.position ?? "—"}）`, steps);
        if (!view.node) {
            // 尚未进入：入口那一步也交给 `stepFlow`（内核 step 的 entry 分支，审计同样落盘）
            const r = await stepFlow(uri, opts.deps ?? {});
            if (r.status !== "moved") return stop("stuck", `进入入口失败：${r.reason}`, steps);
            const entered = r.to ?? view.entry;
            emit({ kind: "step", node: entered, nodeName: nodeNameOf(view.workflowId, entered), mode: "entry", outcome: "moved", to: r.to, moveKind: r.kind, reason: "" });
            continue;
        }

        const node = view.node;
        const exec = executorOf(view.workflowId, node.id, node.actor);

        // ① 系统推（`pred:` / `action:`）—— 「绿线」的路径
        if (view.next.mode === "system") {
            const r = await stepFlow(uri, opts.deps ?? {});
            if (r.status === "moved") {
                persistSystemFacts(uri, node.id, view, r.facts);
                emit({ kind: "step", node: node.id, nodeName: node.name, mode: "system", outcome: "moved", to: r.to, moveKind: r.kind, reason: r.reason });
                continue;
            }
            // 走完 / 停在边上也**发一帧**：系统推是全自动的那条路，人不在场 ——
            // 「它求了什么值、为什么没推」只能从这里与审计流看（少一帧就是少一处证据）。
            persistSystemFacts(uri, node.id, view, r.facts);
            if (r.status === "done") {
                emit({ kind: "step", node: node.id, nodeName: node.name, mode: "system", outcome: "done", to: null, moveKind: null, reason: r.reason });
                return stop("done", `系统求值全过，「${node.name}」没有 next 出边 ⇒ 工作流走完`, steps);
            }
            emit({ kind: "step", node: node.id, nodeName: node.name, mode: "system", outcome: "stuck", to: null, moveKind: null, reason: r.reason });
            return stop("stuck", `${node.name} 这一步没走成：${r.reason}`, steps);
        }

        // ② 人工审批点：停下等人
        if (exec.kind === "human") {
            const next = view.next.edges.map((edge) => edge.to).join(" / ") || "（无）";
            return stop("human", `停在人工审批点「${node.name}（${node.id}）」：批了就 \`diy flow advance ${uri} --to <下一节点>\`（可走：${next}），然后再 \`diy flow run\``, steps);
        }
        if (exec.kind === "system") {
            // 定义自相矛盾（`actor: system` 却带不可观测 guard）在组合期就被内核拒了，走不到这里
            return stop("stuck", `节点「${node.id}」的执行者是 system，但当前是 actor 模式（含不可观测 guard）：驱动环不替人宣布`, steps);
        }

        // ③ agent 节点：起一轮、收结论、落产物、按判据推进
        const turn = await runNodeTurn(uri, view, exec, opts);
        if (turn.aborted) return stop("aborted", "agent 轮次被中断", steps);
        if (turn.error !== null) return stop("turn-error", `起 agent 轮次失败：${turn.error}`, steps);
        const conclusion = turn.text.trim();
        if (conclusion === "") return stop("empty-conclusion", `「${node.name}」这一轮没有产出结论（空正文）：不拿空结论推进`, steps);

        putArtifact(uri, node.id, conclusion);
        const verdict = verdictOf(conclusion);
        const bounceEdge = view.next.edges.find((edge) => edge.kind === "bounce");
        const nextEdge = view.next.edges.find((edge) => edge.kind === "next");
        emit({ kind: "turn", node: node.id, nodeName: node.name, agent: exec.agent, verdict: verdict.kind, chars: conclusion.length });

        if (bounceEdge && verdict.kind === "bounce") {
            const limit = bounceLimitOf(view);
            if (limit !== null && view.bounces + 1 > limit) {
                return stop("bounce-limit", `打回已达上限（${limit} 次）：停在这里等人决定（产物与意见都在袋里与审计流里）`, steps);
            }
            bounceFlow(uri, bounceEdge.to, [refArg(exec.agent)], verdict.reason || "打回", exec.agent);
            continue;
        }
        if (!nextEdge) {
            // 结构终端 + 结论已出 ⇒ 宣布收尾（与内核「没有 next 出边 = 走完」同一条结构判据）
            finishFlow(uri, `由「${exec.agent}」的结论宣布`);
            return stop("done", `「${node.name}」是终端节点且结论已出 ⇒ 工作流走完`, steps);
        }
        advanceFlow(uri, nextEdge.to, [refArg(exec.agent)], "", exec.agent);
    }

    return stop("max-steps", `步数护栏 ${maxSteps} 到顶（定义可能有环，或某一步反复不过）`, steps);
}

// ═══════════════════════════════════════════════════════════════
// 节点执行器：起一轮、收结论
// ═══════════════════════════════════════════════════════════════

interface TurnResult {
    /** 本轮最后一段 assistant 正文（结论） */
    readonly text: string;
    readonly aborted: boolean;
    readonly error: string | null;
}

/**
 * 起一轮本地 agent 并收它的结论（正文）。
 *
 * 复用 `LocalAgentManager.chat`（就是 CLI `diy agent local chat` 那条链）：**会话 = 任务自己的会话**
 * ——于是工作流的每一轮都落在任务页上，用户**看得见** agent 在干什么（用户的原话是「我只要观察」）。
 */
async function runNodeTurn(uri: string, view: FlowView, exec: Extract<NodeExecutor, { kind: "agent" }>, opts: RunOptions): Promise<TurnResult> {
    const { getLocalAgent } = await import("./local-agent");
    const message = composeTurnMessage(uri, view, exec);
    const model = personaModelOf(exec.persona);
    // **可停**（本任务硬约束）：断开 RPC 流只让 `chat()` 的订阅退订，**不停正在跑的轮次**
    // （##305 拍板：消费端断开不掐轮次，刷新只是重新接上视图）。驱动环是**替用户跑**的，
    // 没人看了还继续烧 token、还卡着 `flow run` 不返回 —— 那不是「可停」。
    // 故这里在中断时**显式停轮次**（`LocalAgentManager.cancel` 是唯一的"停"入口）；
    // 判据只看 signal，不看「有没有人在看」（后者会误杀正常长任务）。
    const stopTurnOnAbort = (): void => {
        try {
            getLocalAgent().cancel(uri);
        } catch {
            /* 轮次已经结束（或本会话没在跑）：没什么可停的 */
        }
    };
    if (opts.signal?.aborted) stopTurnOnAbort();
    else opts.signal?.addEventListener("abort", stopTurnOnAbort, { once: true });
    const texts = new Map<string, { role: string; text: string; order: number }>();
    let order = 0;
    try {
        for await (const op of getLocalAgent().chat(uri, message, model, undefined, opts.signal)) {
            if (op.op === "start" && op.kind === "text") {
                texts.set(op.id, { role: String(op.meta?.["role"] ?? ""), text: "", order: (order += 1) });
            } else if (op.op === "delta") {
                const block = texts.get(op.id);
                const chunk = op.fields["content"];
                if (block && typeof chunk === "string") block.text += chunk;
            }
        }
    } catch (e) {
        return { text: "", aborted: opts.signal?.aborted === true, error: (e as Error).message };
    } finally {
        opts.signal?.removeEventListener("abort", stopTurnOnAbort);
    }
    if (opts.signal?.aborted) return { text: "", aborted: true, error: null };
    // 结论 = **最后一段**非空 assistant 正文（多步轮次里，收尾那一段才是结论）
    const assistant = [...texts.values()].filter((b) => b.role === "assistant" && b.text.trim() !== "").sort((a, b) => a.order - b.order);
    return { text: assistant.length > 0 ? assistant[assistant.length - 1]!.text : "", aborted: false, error: null };
}

/**
 * 装配本步的 turn 消息（##341 交付物 2 的「节点提示词 + 上游产物/`Visit.ref` 作为上下文」）。
 *
 * 五段：角色 / 节点 / 上游 / 本步产物 / 交付约定。**节点提示词取自 `FlowView.node.hint`**
 * （内核 `renderHint` 已插值 `${参数}`，与 `diy flow prompt` 同一个来源）—— 不另拼一份。
 */
export function composeTurnMessage(uri: string, view: FlowView, exec: Extract<NodeExecutor, { kind: "agent" }>): string {
    const parts: string[] = [];
    if (exec.role !== "") parts.push(`【角色】${exec.role}`);
    parts.push(`【当前节点】${view.workflowName} · ${view.node?.name ?? ""}（${view.node?.id ?? "?"}）`);
    if (view.node && view.node.hint.trim() !== "") parts.push(`【本步要求】${view.node.hint}`);
    const upstream = upstreamContext(uri, view);
    if (upstream !== "") parts.push(`【上游】\n${upstream}`);
    if (view.art?.raw) parts.push(`【本步产物】${view.art.raw}`);
    parts.push("【交付约定】正文照常写；**末行**必须是「结论：通过」或「结论：打回（原因…）」—— 驱动环按它决定走下一步还是打回。");
    return parts.join("\n\n");
}

/** 折线 + 各次驻留的产物摘要（截断）—— 让本步的 agent 看得见前面发生了什么 */
function upstreamContext(uri: string, view: FlowView): string {
    const lines: string[] = [];
    for (const visit of view.trajectory) {
        // `Visit.kind` 只有 `next` / `bounce`（进入入口那一次也是 `next`，见内核 container.ts）
        lines.push(`- ${visit.node}#${visit.seq}（${visit.kind === "bounce" ? "打回" : "推进"}）`);
        const raw = artifactSummary(uri, visit.node, visit.seq);
        if (raw !== "") lines.push(`  产物：${raw}`);
    }
    return lines.join("\n");
}

/** 某次驻留的产物摘要（**容错**：产物不是领域态，读不出只提示、不拖垮本轮） */
function artifactSummary(uri: string, nodeId: string, seq: number): string {
    try {
        const raw = readArtifacts(uri, nodeId)[seq - 1];
        if (raw === undefined || raw === null) return "";
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        return text.length > ARTIFACT_CLIP ? `${text.slice(0, ARTIFACT_CLIP)}…（截断）` : text;
    } catch (e) {
        return `（产物袋读不出：${(e as Error).message}）`;
    }
}

/**
 * 结论判据（本任务定案，见文件头）：看**最后一行**里的 `结论：通过` / `结论：打回`。
 * 读不到 ⇒ 按通过（不误打回）。
 */
export function verdictOf(conclusion: string): { kind: "pass" | "bounce"; reason: string } {
    const lines = conclusion.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const last = lines.length > 0 ? lines[lines.length - 1]! : "";
    const m = /结论\s*[:：]\s*(通过|打回|驳回|放行|批准)(.*)$/.exec(last);
    if (!m) return { kind: "pass", reason: "" };
    const word = m[1]!;
    if (word === "打回" || word === "驳回") return { kind: "bounce", reason: m[2]!.replace(/^[（(]/, "").replace(/[）)]$/, "").trim() };
    return { kind: "pass", reason: "" };
}

/** 本节点 L2 参数里的打回上限（`<节点>.maxBounces`；没声明 ⇒ null = 不设上限） */
function bounceLimitOf(view: FlowView): number | null {
    const bag = view.node ? view.params[view.node.id] : undefined;
    const raw = typeof bag === "object" && bag !== null ? (bag as Record<string, unknown>)["maxBounces"] : undefined;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** 人物 → 模型（执行者表里的可选 `persona`）；没给 ⇒ undefined（用任务绑定的人物） */
function personaModelOf(persona: string | undefined): string | undefined {
    if (persona === undefined || persona === "") return undefined;
    const found = personaByIdOrName(diyHome(), persona);
    if (!found) throw new Error(`执行者表绑的人物 ${JSON.stringify(persona)} 不存在（可用：diy agent persona list）`);
    return found.model;
}

/**
 * 系统节点的**产物** = 求值事实里的命令输出（`ci` 的 CI 日志 / `merge` 的 PR 查询输出）。
 *
 * 先落袋再判「推没推」不重要：袋是派生数据（`rule.domain-first`），与位置无关；这一步只补
 * 「系统那一步真跑了什么」。节点没声明 `art` ⇒ 不落（不编产物）。
 */
function persistSystemFacts(uri: string, nodeId: string, view: FlowView, facts: Readonly<Record<string, CommandFact>>): void {
    if (!view.art) return;
    const withOutput = Object.values(facts).find((fact) => fact.output.trim() !== "");
    if (!withOutput) return;
    try {
        putArtifact(uri, nodeId, withOutput.output);
    } catch (e) {
        // 系统节点的产物是**旁证**：写不进去不该作废已经落定的推进（审计里留话）
        console.warn(`[flow-runner] 系统节点 ${nodeId} 的产物落袋失败：${(e as Error).message}`);
    }
}

/** 定义的节点显示名（进入入口那一刻 `view.node` 还是 null，只能回定义里取） */
function nodeNameOf(workflowId: string, nodeId: string): string {
    const def = workflowById(workflowId);
    return def?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
}

/** 折线 `Visit.ref` 里记的执行者标识（`k=v` 形状，与 `--ref` 同一个约定） */
function refArg(agent: string): string {
    return `agent=${agent}`;
}
