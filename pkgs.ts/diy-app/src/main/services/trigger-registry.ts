/**
 * 触发器注册表（**内存 Map，不落盘**）。
 *
 * 大王 2026-10-26 定：**没有内置事件，全部从零注册**。所以这里没有
 * `BUILTIN` 常量表，也没有「内置优先 / 插件覆盖」的仲裁 —— 只有一张表，
 * 一条路径。内置的那几条吃同样的饭（`main/triggers/*.ts` 在启动时 define）。
 *
 * 为什么这是对的：
 *   · 一个 Map ⇒ 一种行为，没有"内置走这、插件走那"的分叉
 *   · `defineTrigger()` 返回句柄 ⇒ 拿到句柄就意味着已注册，**结构上不可能漏注册**
 *     （拿不到句柄就写不出 `emit` 调用，编译期就断了）
 *   · 插件卸载 = 句柄随模块卸载 ⇒ 表里自然消失，不需要显式清理协议
 *
 * 为什么内存：触发器目录是**产品能力清单**（改它要发版），不是用户数据。
 * 要落盘的是 watch 的指纹基线 —— 那是另一回事，见 `job-watch-registry.ts`。
 */

import type { Trigger, TriggerDef } from "../../shared/trigger";
import { isValidTriggerId } from "../../shared/trigger";
import { InvariantError } from "../../shared/error-triage";

/** id → 定义。只有 `defineTrigger()` 能写。 */
const registry = new Map<string, TriggerDef<unknown>>();

/**
 * 每条触发器被 `emit` 了几次（进程内累计）。
 *
 * 用途：① 接线前的"没人调用"自查（改完硬编码后计数应当上涨）② 测试断言。
 * **不是审计账** —— 进程重启即清零，与「不要历史审计账」的既有裁决一致。
 */
const emitCounts = new Map<string, number>();

/** 投递次数（`dispatch` 里累加；接线前恒为 0，可用于验证"真的没动行为"）。 */
let dispatchCount = 0;

function assertDef(def: TriggerDef<unknown>): void {
    if (!isValidTriggerId(def.id)) {
        // 码用 `agent/` 前缀：重复注册 / id 非法都是**我方缺陷**（triage = defect），不是用户输入错。
        throw new InvariantError(
            "agent/trigger-bad-id",
            `id=${JSON.stringify(def.id)}（要 <ns>:<name>，如 job:run-settled）`,
        );
    }
    if (registry.has(def.id)) {
        // 重复注册 = 两个模块抢同一个 id（打包去重失败 / 插件冒充内置）。
        // 宁可直接炸，也不要静默让后者覆盖前者 —— 行为不可预测比崩溃更贵。
        throw new InvariantError("agent/trigger-duplicate", `id=${def.id}`);
    }
    if (def.sinks.length === 0) {
        throw new InvariantError("agent/trigger-no-sink", `id=${def.id}（投给谁？至少一个）`);
    }
    if (def.desc.trim() === "") {
        throw new InvariantError("agent/trigger-no-desc", `id=${def.id}`);
    }
}

/**
 * 投递实现（由 main 层注入）：拿到「定义 + 载荷 + 一个出口名」，自己决定怎么落地。
 *
 * 为什么是注入而不是在这里 import `inbox` / `wakeTaskWithSteer`：
 * 注册表要保持**零依赖**（插件 / 测试 / renderer 都能用同一份目录），
 * 真投递涉及会话、信箱、UI —— 那是宿主的事。
 */
export type TriggerDelivery = (def: TriggerDef<unknown>, payload: unknown, sink: string) => void;

let delivery: TriggerDelivery | undefined;

/** main 进程启动时注入一次（见 `local-agent.ts` 的 `installTriggerDelivery` 调用）。 */
export function setTriggerDelivery(fn: TriggerDelivery | undefined): void {
    delivery = fn;
}

/** 投递失败不许拖死调用方：观测数据可以腐烂，业务不能。 */
function dispatch<P>(def: TriggerDef<P>, payload: P): void {
    emitCounts.set(def.id, (emitCounts.get(def.id) ?? 0) + 1);
    dispatchCount += 1;
    if (!delivery) return;
    for (const sink of def.sinks) {
        try {
            delivery(def as TriggerDef<unknown>, payload, sink);
        } catch (e) {
            console.warn(`[trigger] 投递失败 ${def.id} → ${sink}`, e);
        }
    }
}

/**
 * 定义一条触发器。**这是唯一的注册入口**，且必须写在模块顶层
 * （见 `main/triggers/index.ts` 的 import 清单）。
 */
export function defineTrigger<P>(def: TriggerDef<P>): Trigger<P> {
    assertDef(def as TriggerDef<unknown>);
    registry.set(def.id, def as TriggerDef<unknown>);
    return {
        id: def.id,
        level: def.level,
        sinks: def.sinks,
        emit: (payload: P) => dispatch(def, payload),
    };
}

/** 目录快照（按 id 排序）。给 `diy trigger ls` 与 UI 用，不含 emit 计数。 */
export function listTriggers(): ReadonlyArray<TriggerDef<unknown>> {
    return [...registry.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 注册总数（测试里断言「一条不少」用）。 */
export function triggerCount(): number {
    return registry.size;
}

/** emit 计数快照（进程内）。 */
export function triggerEmitCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(emitCounts);
}

/** 已经 `emit` 过多少次（所有触发器合计）。 */
export function totalDispatchCount(): number {
    return dispatchCount;
}

/** 测试专用：清空注册表与计数。生产代码不许调（没有 defer 语义，清了就回不来）。 */
export function __resetTriggerRegistry(): void {
    registry.clear();
    emitCounts.clear();
    dispatchCount = 0;
}
