// session.ts —— 上下文会话的**唯一门面**：组装、段首快照、增量、提交，全在这一次性收口。
//
// 为什么要有它（2026-11-19）：
//   在此之前，`assembleFromProviders → treeOfGlobals → stepDeltaOf → buildDelivery →
//   segmentSnapshot` 是一条**每个宿主自己拼**的五步仪式（diy-app / bot 各一份，diy2 将成第三份）。
//   缓存规则（system 段内逐字复用、变化只走 user 增量、空增量不产消息）散在各处 ⇒
//   「函数测试全绿、缓存还是失效」是结构必然。
//
// 门面只暴露四个动作：
//   open()   —— 组装一次、固定 system（首轮 / 换段）；返回快照
//   step()   —— 现算全量树，和上一次「模型看过的树」比出增量（不提交）
//   commit() —— 本步结束（**成败都调**，与 bot 的 finally 语义一致）
//   reset()  —— 丢快照；下一次 open 重建 system
//
// 不变量（测试守的就是这几条）：
//   · `system` 在 open 之后逐字不变；`step` 永不改它
//   · `step().user` 为空串 ⇒ **不要发消息**（不加字节、不砸缓存）
//   · `step` 只列变化的原子单元，值是变更后的新值

import type { z } from 'zod';

import { buildDelivery, type Delivery } from './delivery.js';
import { assembleFromProviders, helpsOf, type ContextProvider } from './provider.js';
import { AssembleGlobalsSchema } from './schema/prompt-schema.js';
import { stepDeltaOf, type DeltaSnapshot, type StepDelta } from './step-delta.js';

export interface ContextSessionOptions<T extends z.ZodObject<z.ZodRawShape> = typeof AssembleGlobalsSchema> {
    /** 无状态提供器：每次 `provide()` 都给当前全量值 */
    readonly providers: readonly ContextProvider[];
    /** 变量树契约；缺省 = diy 的 `AssembleGlobalsSchema`（room 宿主可传自己的 schema） */
    readonly schema?: T;
    /** 静态前缀（identity / rules / guard…）：与信封拼成 system；只在 open 时参与 */
    readonly instructions?: string;
    /** 调用方持久化恢复的上一份快照；null / 缺省 = 首轮（第一个 step 不发增量） */
    readonly initialSnapshot?: DeltaSnapshot | null;
}

export interface ContextOpenResult {
    /** 真正要发给模型的 system 原文（instructions + 信封） */
    readonly system: string;
    /** 这一次的变量树快照（落盘用） */
    readonly snapshot: DeltaSnapshot;
    /** 完整投递（含行号映射；观测 / 测试用） */
    readonly delivery: Delivery;
}

export interface ContextStepResult {
    /** 要追加到 user 消息的增量文本；**空串 = 这一步什么都没变，不要注入** */
    readonly user: string;
    /** null = 还没有可比的上一份快照（首轮 / 刚 reset） */
    readonly delta: StepDelta | null;
    /** 本步的变量树快照（`commit()` 后成为下一次比较的基准） */
    readonly snapshot: DeltaSnapshot;
}

export interface ContextSession {
    /** open 之后的 system；open 之前是空串 */
    readonly system: string;
    /** 当前已提交的快照（模型已经看过的树）；null = 还没有 */
    readonly snapshot: DeltaSnapshot | null;
    open(): ContextOpenResult;
    step(): ContextStepResult;
    commit(): void;
    reset(): void;
}

export function createContextSession<T extends z.ZodObject<z.ZodRawShape> = typeof AssembleGlobalsSchema>(
    opts: ContextSessionOptions<T>,
): ContextSession {
    let system = '';
    let cursor: DeltaSnapshot | null = opts.initialSnapshot ?? null;
    let pending: DeltaSnapshot | null = null;

    /** 现算一次全量（provider 无状态，值便宜；贵的只有 system 渲染，只发生在 open） */
    function assemble(): { delivery: Delivery; snapshot: DeltaSnapshot } {
        const globals = assembleFromProviders(opts.providers, opts.schema as T);
        const delivery = buildDelivery(globals as unknown as Record<string, unknown>, helpsOf(opts.providers));
        return { delivery, snapshot: { tree: delivery.tree, valueHashes: delivery.valueHashes } };
    }

    return {
        get system() {
            return system;
        },
        get snapshot() {
            return cursor;
        },
        open() {
            const { delivery, snapshot } = assemble();
            const prelude = (opts.instructions ?? '').trim();
            system = [prelude, delivery.text.text].filter((part) => part !== '').join('\n\n');
            // 有 initialSnapshot = 模型已经看过那棵树：**保留它**作为增量基准（重启后接着算）。
            // 没有（首轮 / reset 后的新段）：system 里就是当前全量，基准设成这份。
            if (cursor === null) cursor = snapshot;
            pending = null;
            return { system, snapshot, delivery };
        },
        step() {
            const { snapshot } = assemble();
            const delta = cursor === null ? null : stepDeltaOf(cursor, snapshot);
            pending = snapshot;
            return { user: delta === null ? '' : delta.text, delta, snapshot };
        },
        commit() {
            if (pending !== null) {
                cursor = pending;
                pending = null;
            }
        },
        reset() {
            system = '';
            cursor = null;
            pending = null;
        },
    };
}
