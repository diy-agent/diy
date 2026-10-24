/**
 * job-run.ts — 后台 job 的**运行记录**（JobRun）契约：类型 + 纯函数，零 IO（##408 刀 2）。
 *
 * ── 为什么 Job 与 Run 要分开（本任务 D6）──
 *   定时器 / 长时进程都是「一个定义、多次执行」。把两者捏成一个对象，面板就只能显示
 *   「最后一次」——用户原话：「定时器 job 比较特殊，它是多次执行的，所以应该是 1:n 的列表」。
 *   ⇒ `JobDefinition 1 ── n JobRun`；v1 只做 Run（定义进代码，刀 3 才接注册表）。
 *
 * ── 为什么每条 Run 必须带 origin（硬约束 1）──
 *   没有来源的 job 在面板里是孤儿：事后没人能回答「这玩意儿为啥在跑」。
 *   故 `assertOrigin()` 是**入口判据**：缺了或形状不对**当场抛**（`agent/missing-origin`），
 *   而不是落一条 origin 为空的账（脏账比缺账更难查）。
 *
 * ── origin 只存引用，不存快照（硬约束 2）──
 *   `{taskUri, turnId, stepId}` 本身就是地址（与 `shared/room.ts` 的 `ref` 同一思路）。
 *   点开时去读那边的真源；窗口已关 / 会话被压缩时降级成「原文不可用 + 落盘日志 tail」。
 *   ⇒ schema 一律 `.strict()`：多塞一个 `contextSnapshot` 之类的字段会**解析失败**，
 *      让「悄悄拷了一份上下文」在 CI 里就现形，而不是等半年后没人知道哪份才是真的。
 *   `cmd` 是唯一例外：它是该次执行的**实参**（退出码之外唯一能解释「到底跑了什么」的东西）。
 *
 * 形状遵守 `~/AGENTS.md::rule.discriminated-union`：判别键同级 = 公共字段，分支私有数据进 `data`。
 * 本文件的 origin / owner 都没有分支共有的载荷字段，故形状恒为 `{ type, data }` 的两种写法
 * （owner 的公共字段直接同级 —— 见下）。
 */

import { z } from "zod";
import { invariant } from "./error-triage";
import type { RunOutcome } from "./run-status";

// ═══════════════════════════════════════════════
//  枚举：kind / state
// ═══════════════════════════════════════════════

/**
 * job 的**来源大类**（未来面板按它分 tab）。
 *
 * v1 只有 `spawned` 有真实数据（会话里的 bash 工具起的后台进程）；另外两个现在就占位，
 * 是为了让面板 / CLI / 账本从一开始就有同一套枚举 —— 免得 v2 加定时器时全链路改签名。
 */
export type JobKind = "spawned" | "scheduled" | "event";

export const JOB_KINDS = ["spawned", "scheduled", "event"] as const;

// ═══════════════════════════════════════════════
//  jobId：唯一一份形状判据（账本文件名 / 注册表 id / CLI 入参共用）
// ═══════════════════════════════════════════════

/**
 * jobId 的**唯一**形状判据（##408 刀 2 落账本、刀 3 落注册表 —— 两处必须同一份）。
 *
 * 为什么这么严：`$DIY_HOME/jobs/<jobId>.jsonl` 直接拿它当文件名。
 * 含 `/` 或 `..` 就能把账写到 home 之外（穿越）；含空格 / 非 ASCII 会让 shell / URL / 文件名三方打架。
 * 为什么用 `[A-Za-z0-9]` 开头：`-x` / `.x` 这类首字符在 CLI 里会被当参数或隐藏文件。
 */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeJobId(id: string): boolean {
    return id.length > 0 && id.length <= 120 && JOB_ID_RE.test(id) && !id.includes("..");
}

/** 不合法的 jobId ⇒ `agent/invalid-job-id`（编程错误，不是用户输入校验）。 */
export function assertJobId(jobId: string, where = ""): void {
    invariant(isSafeJobId(jobId), "agent/invalid-job-id", `${jobId}${where ? ` @${where}` : ""}`);
}

/**
 * Run 的生命周期状态（四态）。
 *
 * 判据是**两个正交问题的答案**：① 结局已知吗 ② 成功吗。
 *   · `running`  —— 已启动，尚未观察到结束（结局未知，且**默认它没死**）。
 *   · `settled`  —— 进程自己结束且退出码 0（结局已知 + 成功）。
 *   · `failed`   —— 进程结束但退出码非 0 / 被信号杀掉 / 压根没起得来（结局已知 + 失败）。
 *   · `lost`     —— **结局不可知**：调度器自己重启过，pid 已不存在、也没有结束记录。
 *                   「不假装在跑」——重启恢复时把 `running` 判成 `lost` 而不是继续显示绿点。
 *
 * 为什么**不设** `killed` / `cancelled`：用户主动取消是被信号杀掉的一种，
 * `signal` + `summary` 已能说清；单开一个状态会让「同一件事两种表示」，
 * 面板的「失败数」统计就得在两处相加（那正是本任务要消灭的分裂）。
 */
export type JobRunState = "running" | "settled" | "failed" | "lost";

export const JOB_RUN_STATES = ["running", "settled", "failed", "lost"] as const;

/**
 * 合法的状态转移（append-only 账本的**写前判据**）。
 *
 * 只允许从 `running` 出发：账是增量写的，一次 run 一旦落终态就不再改（重写账 = 丢失历史）。
 * `running → running` 也**有意**禁止：心跳要走另一条通道（刀 3 的 live cursor），
 * 不该在账本里刷行 —— 否则一条长任务的账会被心跳撑成几万行。
 */
export const RUN_TRANSITIONS: Readonly<Record<JobRunState, readonly JobRunState[]>> = {
    running: ["settled", "failed", "lost"],
    settled: [],
    failed: [],
    lost: [],
};

export function isTerminalRunState(state: JobRunState): boolean {
    return RUN_TRANSITIONS[state].length === 0;
}

export function canTransitionRun(from: JobRunState, to: JobRunState): boolean {
    return RUN_TRANSITIONS[from].includes(to);
}

/** 非法转移 ⇒ `agent/invalid-run-transition`（状态机判据，不是用户输入校验）。 */
export function assertRunTransition(from: JobRunState, to: JobRunState): void {
    invariant(canTransitionRun(from, to), "agent/invalid-run-transition", `${from} → ${to}`);
}

// ═══════════════════════════════════════════════
//  origin：来源锚点（判别联合）
// ═══════════════════════════════════════════════

const nonEmpty = z.string().min(1);

/**
 * 来源锚点 —— 「这条 Run 是谁、在哪里按下的开始」。
 *
 * | type      | 谁起的                | 点它能去哪（导航目标）                                    |
 * |-----------|-----------------------|-----------------------------------------------------------|
 * | `spawned` | 会话里 agent 的工具调用 | 打开该任务会话 → 定位到那一步的 tool_call 块               |
 * | `trigger` | 定时器 / 事件注册      | 定时器详情（v2；v1 只留字段）                              |
 * | `manual`  | 人点了「立即运行」      | 停在详情页（无外部锚点）                                   |
 * | `agent`   | 另一个 agent / RPC     | 同 `spawned`，但落在**发起方**任务（不是执行方）           |
 *
 * 所有变体都是 `{ type, data }`：没有分支共有的载荷字段，公共部分就是判别键本身。
 */
export type JobOrigin =
    | {
          readonly type: "spawned";
          readonly data: {
              /** 发起该工具调用的任务（`projects/<pid>/tasks/<tid>`） */
              readonly taskUri: string;
              /** 会话轮次 id —— 与 `localChatStore.jumpTo` 的检索口径同一套 */
              readonly turnId: string;
              /** 轮内步号（工具调用的步） */
              readonly stepId: string;
              /** 工具调用块 id（会话块 DFS 定位用，`LocalChatPage.tsx::anchorRowIndex` 同源） */
              readonly toolCallId: string;
              /** 实际执行的命令 —— **实参**，不是上下文快照（见文件头注硬约束 2） */
              readonly cmd: string;
          };
      }
    | {
          readonly type: "trigger";
          readonly data: {
              /** 触发它的 job（定时器 / 事件源） */
              readonly jobId: string;
              /** 该次触发时刻（ISO） */
              readonly firedAt: string;
              /** 为什么触发（`interval` / `daily` / `event:<topic>` / `catch-up`） */
              readonly reason: string;
          };
      }
    | {
          readonly type: "manual";
          readonly data: {
              /** 谁点的（`human:<name>` / `agent:<name>`） */
              readonly by: string;
              /** 执行时的 cwd（诊断用） */
              readonly cwd: string;
          };
      }
    | {
          readonly type: "agent";
          readonly data: {
              /** 发起方成员 / 任务（`room.ts` 的 `memberUri` 口径） */
              readonly memberUri: string;
              readonly turnId: string;
          };
      };

export const JOB_ORIGIN_TYPES = ["spawned", "trigger", "manual", "agent"] as const;

const originSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("spawned"),
            data: z
                .object({
                    taskUri: nonEmpty,
                    turnId: nonEmpty,
                    stepId: nonEmpty,
                    toolCallId: nonEmpty,
                    cmd: nonEmpty,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("trigger"),
            data: z.object({ jobId: nonEmpty, firedAt: nonEmpty, reason: nonEmpty }).strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("manual"),
            data: z.object({ by: nonEmpty, cwd: nonEmpty }).strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("agent"),
            data: z.object({ memberUri: nonEmpty, turnId: nonEmpty }).strict(),
        })
        .strict(),
]);

/**
 * 校验并收窄 origin —— **硬约束 1 的唯一落点**。
 *
 * 缺失 / 形状不对（含「多塞了私有字段」）一律 `agent/missing-origin`：
 * 同一类缺陷（这条 Run 说不清从哪来）用同一个 code，才能按频次统计。
 *
 * ⚠️ code 域没有 `job`（`error-triage.ts` 锚定 `llm|fs|net|rpc|agent|db|ui`，见 `~/AGENTS.md`），
 *    故落 `agent/` —— job 编排本就是 agent 的后台活。若日后要独立的 `job/` 域，
 *    得先改 `error-triage.ts::CODE_RE` + 全局规范，是一次单独的契约变更，不在本刀里夹带。
 */
export function assertOrigin(value: unknown, where = ""): JobOrigin {
    const parsed = originSchema.safeParse(value);
    const at = where ? ` @${where}` : "";
    if (!parsed.success) {
        const why = value == null ? "缺失" : `非法：${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; ")}`;
        invariant(false, "agent/missing-origin", `JobRun origin ${why}${at}`);
    }
    return parsed.data;
}

export function originTypeOf(origin: JobOrigin): JobOrigin["type"] {
    return origin.type;
}

// ═══════════════════════════════════════════════
//  owner：向上溯源的锚点（D7；v1 只用到 turn）
// ═══════════════════════════════════════════════

/**
 * job 的**归属**（比 origin 更持久：origin 是「这一次谁按的开始」，owner 是「它属于谁」）。
 *
 * 三档层级对应 D7：会话内 / 任务内 / 全局。v1 的 `spawned` 天然是 `turn`；
 * `trigger` 型（定时器）三种都可能，故字段现在就定下，v2 只填数据不改类型。
 */
export type JobOwner =
    | { readonly type: "turn"; readonly taskUri: string; readonly turnId: string }
    | { readonly type: "task"; readonly taskUri: string }
    | { readonly type: "global"; readonly by: string };

const ownerSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("turn"), taskUri: nonEmpty, turnId: nonEmpty }).strict(),
    z.object({ type: z.literal("task"), taskUri: nonEmpty }).strict(),
    z.object({ type: z.literal("global"), by: nonEmpty }).strict(),
]);

/**
 * 校验并收窄 owner —— job 定义（刀 3 注册表）与 Run 共用同一份判据。
 *
 * 与 `assertOrigin` 分开的原因：owner 是「它属于谁」，缺失同样不可接受（孤儿 job 无处溯源），
 * 但它是**定义**的问题，不是单次执行的问题 ⇒ 独立 code，便于区分「注册写错」和「起 run 时丢了来源」。
 */
export function assertOwner(value: unknown, where = ""): JobOwner {
    const parsed = ownerSchema.safeParse(value);
    if (!parsed.success) {
        const why =
            value == null
                ? "缺失"
                : parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; ");
        invariant(false, "agent/invalid-job-owner", `JobOwner ${why}${where ? ` @${where}` : ""}`);
    }
    return parsed.data;
}

// ═══════════════════════════════════════════════
//  JobRun
// ═══════════════════════════════════════════════

/**
 * 一次执行 —— 账本的一行、面板的一行。
 *
 * 字段取舍（「为什么需要它」写在这里，免得日后有人按「看着多余」删掉）：
 *   · `id`         run 自增 / 随机 id：同一 job 多次运行要能单独引用（日志、跳转）。
 *   · `jobId`      归属的定义 id：面板按它分组折叠（父行「该 job 共 N 次运行」）。
 *   · `kind`       冗余自定义：v1 还没有注册表，Run 必须**自足**才能渲染分类 tab。
 *   · `title`      同理冗余：列表不 join 定义就能显示人话名（定义删了，历史账还读得懂）。
 *   · `owner`      向上溯源（D7）。比 origin 稳：定义换了触发方式，归属不变。
 *   · `state`      四态（见上）。
 *   · `startedAt`  唯一的时间基准；`endedAt`/`ms` 都由它派生，面板排序也用它。
 *   · `endedAt`    终态必填（`normalizeRun` 判）；`running` 时缺省 —— 「还没结束」不能编一个时间。
 *   · `exitCode`   只有自然退出才有；被信号杀 / 没起得来时缺省，别拿 -1 冒充。
 *   · `signal`     被信号杀时是**唯一**能解释「为什么退出码是 null」的证据（SIGKILL / SIGTERM）。
 *   · `ms`         `endedAt - startedAt` 的缓存；面板/CLI 都要它，避免每处各算一遍。
 *   · `origin`     来源锚点（硬约束 1：**必填**）。
 *   · `summary`    一句话结果（成功侧的「跑了多久、干了啥」）。
 *   · `error`      失败侧的可读原因（与 `summary` 分开：面板要一眼分出红/绿两栏）。
 *   · `logPath`    输出环落盘的绝对路径（刀 5 填）；没有它，点进详情只能看到 tail。
 *   · `outcome`    **怎么结束的**（刀 5 加）：`ok|fail|canceled|timeout`。
 *                  四态 `state` 回答「收敛了没 / 成功吗」，「超时」与「用户取消」在它里面都落
 *                  `failed`（刀 2 定稿：被信号杀 = failed + signal）—— 但这两件事**不是缺陷**，
 *                  面板的失败率与「⊘ 取消 / 超时」必须能分开统计，否则人会去查一堆不是 bug 的失败。
 *                  之所以不从 `error` 文案里猜：文案是给人看的、随时会改，判据不许依赖解析句子。
 */
export interface JobRun {
    readonly id: string;
    readonly jobId: string;
    readonly kind: JobKind;
    readonly title: string;
    readonly owner: JobOwner;
    readonly state: JobRunState;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly ms?: number;
    readonly origin: JobOrigin;
    readonly summary?: string;
    readonly error?: string;
    readonly logPath?: string;
    readonly outcome?: RunOutcome;
}

/** 除 origin 之外的形状（origin 单独走 `assertOrigin`，好让缺陷落在同一个 code 上）。 */
const runBodySchema = z
    .object({
        id: nonEmpty,
        jobId: nonEmpty,
        kind: z.enum(JOB_KINDS),
        title: nonEmpty,
        owner: ownerSchema,
        state: z.enum(JOB_RUN_STATES),
        startedAt: nonEmpty,
        endedAt: nonEmpty.optional(),
        exitCode: z.number().int().optional(),
        signal: nonEmpty.optional(),
        ms: z.number().int().nonnegative().optional(),
        summary: z.string().optional(),
        error: z.string().optional(),
        logPath: nonEmpty.optional(),
        outcome: z.enum(["ok", "fail", "canceled", "timeout"]).optional(),
    })
    .strict();

/**
 * 把**任意来源**（账本行 / RPC 载荷 / 未来 UI 回填）收窄成合法 `JobRun`。
 *
 * 两条不变量（都是「账本自相矛盾」的判据，写进单测名）：
 *   ① origin 必须存在且合法（硬约束 1）；
 *   ② 终态必须带 `endedAt`：账上写着「结束了」却没有结束时刻 = 无法算耗时、无法排时间线。
 *      反向不判：`running` 带 `endedAt` 会在下面被 `state==='running'` 检查拦掉。
 *
 * 抛 `InvariantError` 是**刻意**的：坏数据进到业务逻辑里说明我方写错了；
 * 而**观测量可腐烂**（外部改动 / 半行）→ 读侧（`job-ledger.readRuns`）负责跳过，不在这里容忍。
 */
export function normalizeRun(raw: unknown): JobRun {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    const origin = assertOrigin(record?.["origin"], "normalizeRun");
    // origin 已单独校验（缺陷要落在同一个 code 上），从主体里摘掉再解析 ——
    // 否则 `.strict()` 会把**我们自己的字段**当陌生键拦下。
    const body: Record<string, unknown> = record ? { ...record } : {};
    delete body["origin"];
    const parsed = runBodySchema.safeParse(body);
    if (!parsed.success) {
        invariant(
            false,
            "agent/invalid-job-run",
            parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; "),
        );
    }
    const fields = parsed.data;
    if (fields.state === "running") {
        invariant(fields.endedAt === undefined, "agent/invalid-job-run", `running 不得带 endedAt（${fields.id}）`);
    } else {
        invariant(fields.endedAt !== undefined, "agent/invalid-job-run", `终态 ${fields.state} 缺 endedAt（${fields.id}）`);
    }
    const run: JobRun = { ...fields, origin };
    return Object.freeze(run);
}

/**
 * 由起止时刻算耗时（ms）；非法 / 缺失返回 undefined。
 * 独立成函数而不是内联：CLI / 面板 / 账本三处都要「同一把尺子」。
 */
export function runDurationMs(startedAt: string, endedAt?: string): number | undefined {
    if (!endedAt) return undefined;
    const a = Date.parse(startedAt);
    const b = Date.parse(endedAt);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
    return b - a;
}

/**
 * 完成一次 run：把 `running` 的账补成终态（不改原对象）。
 * 用来把「必须填什么」收在一处，免得调用点各拼一遍（漏 `ms` / 漏 `endedAt` 都是常见错）。
 */
export function settleRun(
    run: JobRun,
    outcome: {
        state: Exclude<JobRunState, "running">;
        endedAt: string;
        exitCode?: number;
        signal?: string;
        summary?: string;
        error?: string;
        logPath?: string;
        outcome?: RunOutcome;
    },
): JobRun {
    assertRunTransition(run.state, outcome.state);
    invariant(!isTerminalRunState(run.state), "agent/invalid-run-transition", `已终态 ${run.state} 不得再 settle（${run.id}）`);
    return normalizeRun({
        ...run,
        state: outcome.state,
        endedAt: outcome.endedAt,
        ms: runDurationMs(run.startedAt, outcome.endedAt),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.logPath !== undefined ? { logPath: outcome.logPath } : {}),
        ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
    });
}
