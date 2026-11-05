// src/provider.ts
// 🎯 上下文树的**提供器机制**：provider 交出「某个根键的值」，机制层只负责拼与校验。
//
// ── 空壳判据（2026-11-05 用户裁）──
//   「context 本质是一个业务无关的上下文树机制 … 希望拆成机制 + 提供器形式，
//     即 context 本身就是一个空壳，只是提供插入 provider 的能力」。
//
// 所以本文件**不知道任何业务**：
//   · 没有 task / project / persona / facts 的概念
//   · 不管依赖怎么来（那是 provider 工厂闭包的事：`taskProvider(home, taskUri)`）
//   · 不管 diff（那是 projection 层的事，`renderedHash` / `RuntimeCursor`）
//   · 不管缓存与时间（需要就由 provider 工厂自己闭包一份，机制层不介入）
//
// 它只做三件事：
//   ① 按 key 把各 provider 的值拼成一棵树
//   ② 校验 key **全在契约内**（provider 加新键必须先改 schema —— 契约强制，不静默吃）
//   ③ 用 `AssembleGlobalsSchema` 校验形状（漂移栽在这，不在各 provider）

import { AssembleGlobalsSchema, type AssembleGlobals } from './schema/prompt-schema.js';

/**
 * 一个上下文提供器。
 *
 * **无状态**是硬要求：每次 `provide()` 都必须给**当前全量值**，不许记「上次给了什么」——
 * 增量由 `projection` 用 `renderedHash` 算（`types.ts` 的 `RuntimeCursor`）。
 * provider 自己攒 diff 会和机制层打架（两处各算一份，必然分叉）。
 */
export interface ContextProvider {
    /** 树里的根键（与 `AssembleGlobalsSchema` 的顶层键一一对应） */
    readonly key: string;
    /** 交当前值；`undefined` / `null` 都表示「本节缺席」（信封渲染时整段不出现） */
    provide(): unknown;
}

/** 契约允许的顶层键（从 schema 推导，不手抄 —— 加键只需改 schema） */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(AssembleGlobalsSchema.shape));

/**
 * 按 provider 列表拼一棵树并校验。
 *
 * 两种失败都**直接抛**（不静默降级）：
 *   · 未知 key —— provider 加了契约里没有的键（说明它和 `prompt-schema.ts` 漂移了）
 *   · 形状不对 —— `AssembleGlobalsSchema` 校验失败
 *
 * 为什么不吞：上下文一旦静默少一节，模型就少了规则/知识，且**没有任何地方会报错**——
 * 这类漂移只能靠抛错暴露（宁可发不出去，也不发一份残缺的 system）。
 *
 * 同 key 后注册的覆盖先注册的：允许装配方用「兜底 provider + 覆盖 provider」的模式。
 */
export function assembleFromProviders(providers: readonly ContextProvider[]): AssembleGlobals {
    const tree: Record<string, unknown> = {};
    for (const provider of providers) {
        if (!ALLOWED_KEYS.has(provider.key)) {
            throw new Error(
                `上下文 provider 的 key "${provider.key}" 不在契约里（允许：${[...ALLOWED_KEYS].join(' / ')}）` +
                    ' —— 加新键请先改 schema/prompt-schema.ts',
                { cause: { code: "context/unknown-key" } },
            );
        }
        const value = provider.provide();
        // `undefined` / `null` = 本节缺席（信封渲染时整段不出现）；直接跳过，不往树里塞键。
        // `null` 也要跳过：可选节的上游常常用 `null` 表达「没有」（`room?: X | null`），
        // 而 schema 里没有哪个键允许 null —— 塞进去必然 parse 失败，语义上它和 undefined 是一回事。
        if (value === undefined || value === null) continue;
        tree[provider.key] = value;
    }
    return AssembleGlobalsSchema.parse(tree);
}
