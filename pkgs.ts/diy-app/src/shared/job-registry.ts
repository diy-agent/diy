/**
 * job-registry.ts — job **定义**注册表：纯内存、单例、进程内（##408 刀 3）。
 *
 * ── 为什么定义不落盘（本任务 D4）──
 *   job 定义进 git（可 review、可回滚），运行态与执行账落盘（`$DIY_HOME/jobs/`，刀 2）。
 *   两份真源是万恶之源：配置里改一半、代码里改一半，然后没人知道实际跑的老是哪个版本。
 *   ⇒ 本文件**零 IO**、不碰 `$DIY_HOME`、不碰 Electron —— 只有一张 `Map` 和几条判据。
 *
 * ── 本刀只做「注册 + 查询」──
 *   不建 timer、不判到期、不执行 handler（那些是刀 4 调度器）。这里唯一带「计算」味道的是
 *   `nextRunAt()` —— 它把「规则 → 下次时刻」和「开关 → 还跑不跑」两件事合成一个出口，
 *   免得调用方各写一遍 `if (!job.enabled)`。
 *
 * ── 语义决定（写在单测里，不埋进注释）──
 *   · **禁用 ≠ 算不出下次**：`nextAt(trigger, from)` 是纯日程数学，**不看开关**（禁用后规则仍然存在）；
 *     「禁用 ⇒ 不跑」这条策略落在 `nextRunAt()`：返回 `null`。两者分开，UI 才能显示
 *     「规则是每天 09:00，当前已停用」而不是「下次执行：无」这种信息丢失的文案。
 *   · **未知 id 不抛**：`get` / `setEnabled` / `nextRunAt` 对未知 id 返回 `undefined` / `null`。
 *     查询接口抛错只会逼调用方到处 try/catch；「你查的 job 不存在」是正常查询结果，不是缺陷。
 *   · 重复 id **必须抛**（`agent/duplicate-job-id`）：那是编程错误 —— 两个模块抢同一个 id，
 *     静默覆盖会让其中一个的 handler 永远不跑，且没人知道。
 */

import { z } from "zod";
import { invariant } from "./error-triage";
import { JOB_KINDS, assertOwner, isSafeJobId, type JobKind, type JobOwner } from "./job-run";
import { assertTrigger, nextAt, type JobTrigger } from "./job-trigger";

const nonEmpty = z.string().min(1);

/** handler 的返回：成功与否 + 一句人话（面板「上次结果」列直接显示它）。 */
export interface JobHandlerResult {
    readonly ok: boolean;
    readonly summary: string;
}

/**
 * job 的执行体（**内存态，不序列化**）。
 *
 * 定义进 git，但 handler 是活代码 —— 它不落盘、不进账本、不进上下文。
 * 刀 3 只存不用；刀 4 调度器负责调用与超时/单飞/退避。
 */
export type JobHandler = () => Promise<JobHandlerResult> | JobHandlerResult;

/** 注册一个 job 需要的东西（v1 最小集：来源 + 命名 + 规则 + 开关）。 */
export interface JobDefinition {
    /** 唯一 id，同时是执行账文件名（`^[A-Za-z0-9._-]+$`） */
    readonly id: string;
    /** 来源大类；决定面板 tab 与「该不该有 trigger」 */
    readonly kind: JobKind;
    /** 人话名（面板一列） */
    readonly title: string;
    /** 归属（D7 向上溯源：会话内 / 任务内 / 全局） */
    readonly owner: JobOwner;
    /** 触发规则：`spawned` 型为 `null`（由会话临时起，无日程）；`scheduled` / `event` 型必填 */
    readonly trigger: JobTrigger | null;
    /** 开关（用户可单独关；禁用 ⇒ `nextRunAt` 为 null，见文件头注） */
    readonly enabled: boolean;
    /** 执行体；v1 的 `spawned` 定义可以没有（真正的执行在 bash 工具侧） */
    readonly handler?: JobHandler;
}

const defSchema = z
    .object({
        // id 形状复用 `job-run.ts::isSafeJobId`（账本文件名同一份判据，见那里的理由）
        id: z.string().refine(isSafeJobId, "id 须是文件名安全串（A-Z a-z 0-9 . _ -，不以符号开头）"),
        kind: z.enum(JOB_KINDS),
        title: nonEmpty,
        enabled: z.boolean(),
        // owner / trigger / handler 各自单独校验（错误要落在各自的 code 上）
    })
    .strict();

/** owner / trigger / handler 各自单独校（错误要落在各自的 code 上），故先从主体里摘掉。 */
const SEPARATELY_CHECKED = ["owner", "trigger", "handler"] as const;

function checkShape(raw: unknown): { id: string; kind: JobKind; title: string; enabled: boolean } {
    invariant(typeof raw === "object" && raw !== null, "agent/invalid-job-def", "job 定义必须是对象");
    const body: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const k of SEPARATELY_CHECKED) delete body[k];
    const parsed = defSchema.safeParse(body);
    if (!parsed.success) {
        const why = parsed.error.issues
            .map((i) => `${i.path.join(".") || "<root>"} ${i.message}`)
            .join("; ");
        invariant(false, "agent/invalid-job-def", `job 定义非法：${why}`);
    }
    return parsed.data;
}

/**
 * 校验并归一化一条定义 —— 注册入口的唯一判据。
 *
 * 三条硬判据（都是「不留着以后排查」的编程错误）：
 *   ① id / kind / title / enabled 形状对；
 *   ② owner 合法（`assertOwner`，D7 的三种层级之一）；
 *   ③ **kind 与 trigger 必须自洽**：`spawned` 不带日程；`scheduled` 只能是 interval/daily；
 *      `event` 只能是 event 规则。不自洽的定义 = 永远不跑或跑错时刻，属于注册代码写错。
 */
export function normalizeJobDefinition(raw: unknown): JobDefinition {
    const shape = checkShape(raw);
    const record = raw as Record<string, unknown>;

    const owner = assertOwner(record["owner"], shape.id);

    const rawTrigger = record["trigger"];
    const trigger = rawTrigger === null || rawTrigger === undefined ? null : assertTrigger(rawTrigger, shape.id);

    invariant(
        shape.kind !== "spawned" || trigger === null,
        "agent/invalid-job-def",
        `spawned 型 job 不带触发规则（${shape.id}）`,
    );
    invariant(
        shape.kind === "spawned" || trigger !== null,
        "agent/invalid-job-def",
        `${shape.kind} 型 job 必须声明触发规则（${shape.id}）`,
    );
    if (trigger !== null) {
        const ok =
            (shape.kind === "scheduled" && (trigger.type === "interval" || trigger.type === "daily")) ||
            (shape.kind === "event" && trigger.type === "event");
        invariant(ok, "agent/invalid-job-def", `${shape.kind} 型不接受 ${trigger.type} 规则（${shape.id}）`);
    }

    const handler = record["handler"];
    invariant(
        handler === undefined || typeof handler === "function",
        "agent/invalid-job-def",
        `handler 必须是函数（${shape.id}）`,
    );

    return {
        id: shape.id,
        kind: shape.kind,
        title: shape.title,
        owner,
        trigger,
        enabled: shape.enabled,
        ...(handler === undefined ? {} : { handler: handler as JobHandler }),
    };
}

export interface JobRegistry {
    /** 注册（重复 id ⇒ `agent/duplicate-job-id`）；返回归一化后的定义 */
    register(def: JobDefinition): JobDefinition;
    /** 未知 id ⇒ `undefined`（正常查询结果，不抛） */
    get(id: string): JobDefinition | undefined;
    /** 全部定义，**按 id 排序**（面板 / CLI 输出要稳定，不能随注册顺序抖） */
    list(): readonly JobDefinition[];
    has(id: string): boolean;
    /** 注销；返回是否真的删掉了（未知 id ⇒ false） */
    unregister(id: string): boolean;
    /** 开关；未知 id ⇒ `undefined`。返回**新的**定义（不可变对象，不原地改） */
    setEnabled(id: string, enabled: boolean): JobDefinition | undefined;
    /**
     * 下次该跑的时刻：
     *   · 未知 id / 禁用 / `event` 型（无日程）⇒ `null`
     *   · `interval` / `daily` ⇒ `nextAt(trigger, from)`
     */
    nextRunAt(id: string, from: Date): Date | null;
    /** 定义条数 */
    size(): number;
    /** 清空（测试 / 热重载用） */
    clear(): void;
}

export function createJobRegistry(): JobRegistry {
    const defs = new Map<string, JobDefinition>();

    const registry: JobRegistry = {
        register(raw) {
            const def = normalizeJobDefinition(raw);
            invariant(!defs.has(def.id), "agent/duplicate-job-id", `job id 重复注册：${def.id}`);
            defs.set(def.id, def);
            return def;
        },
        get(id) {
            return defs.get(id);
        },
        list() {
            return [...defs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        },
        has(id) {
            return defs.has(id);
        },
        unregister(id) {
            return defs.delete(id);
        },
        setEnabled(id, enabled) {
            const cur = defs.get(id);
            if (!cur) return undefined;
            const next: JobDefinition = { ...cur, enabled };
            defs.set(id, next);
            return next;
        },
        nextRunAt(id, from) {
            const def = defs.get(id);
            if (!def || !def.enabled || def.trigger === null) return null;
            return nextAt(def.trigger, from);
        },
        size() {
            return defs.size;
        },
        clear() {
            defs.clear();
        },
    };

    return registry;
}

let singleton: JobRegistry | null = null;

/**
 * 进程内单例 —— 全应用**一张**注册表（「一处注册、一处调度、一处可见」）。
 *
 * 懒创建：`import` 本身不产生任何副作用（单测里 import 不会污染全局），
 * 只有真去拿单例才建。测试用 `resetJobRegistry()` 收尾。
 */
export function jobRegistry(): JobRegistry {
    singleton ??= createJobRegistry();
    return singleton;
}

/** 丢弃单例（测试收尾 / 热重载）；下次 `jobRegistry()` 重建。 */
export function resetJobRegistry(): void {
    singleton = null;
}

/** 便捷入口：注册到单例（调用方最常用的那个）。 */
export function registerJob(def: JobDefinition): JobDefinition {
    return jobRegistry().register(def);
}
