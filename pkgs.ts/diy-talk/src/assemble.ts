// assemble.ts — 装配器：多源 + 投影 + 窗口 → 一次 LLM 请求的 messages[]（##166 §一 结论 4/13）
//
// 「模式 = 一份装配策略，不是三套实现」（结论 4）：三模式都走这一个入口，差别只在
// **选哪些源 + 什么投影 + 什么窗口**。输出是纯 `Message[]` 数据，不碰任何 LLM SDK。
//
// 铁律（复用 role.ts，不在本任务重写）：**他人的发言装配进请求时绝不能是 `assistant`**；
// 他人的过程产物（tool / thinking）**永不进入装配**（过程私有，不投递）—— 故 `full`
// 与 `text-only` 的差别是「是否带上**自己的**过程」，绝不是「是否暴露别人的过程」。
//
// ⚠️ 需求对齐（review1 意见 1）：这条不变量**不是本装配器自创**，而是 ##312 `role.ts` 的既有契约 ——
// `assemblyRole({ kind: 'trace', author !== self })` 直接抛 `role-violation`（探针 `probe5-foreign-trace-guard.mts`）。
// 依据：##166 结论 6「过程私有——自己的 tool/thinking 不强制共享」+ §3.5 表「自己的 tool/thinking … **仅自己可见**」
// + §七「实践中 tool/thinking 从未流转，只流转结论与探针脚本」。故它落在 role 翻译层（策略看不到），
// **与 ##166 §3.1 表格「模式 1 … 过程全暴露，像开会各自表演」的字面表述偏离** ——
// 后者描述的是共享态（存储），非投递态（装配）；「按需检索他人推理」（结论 14）是**档案检索能力**，
// 不是默认塞入本次 messages[]。若 §四 待决 3「隐私边界」将来放开，须**协调改 role.ts**（新增显式 kind），
// 不能在装配层私自放行。
//
// 边界（结论 13：存结构、装配时渲染）：本包只消费 `Reaction` / `Event` 结构，**在装配时**渲染成
// 字符串；窗口 / 摘要是**注入式钩子**（宿主给裁剪函数），内核不自作主张（##166 §五：
// 「上下文窗口裁剪 / 摘要策略是真正的取舍点」）。

import { type Anchor } from './anchor';
import { TalkError, type TalkErrorCode } from './errors';
import { parseEvent, type Event } from './event';
import { parseReaction, type Reaction } from './reaction';
import { assemblyRole, assertRoleAssignments, type AssemblyRole, type SourceKind } from './role';
import { rejectUnknown, takeObject, takeString } from './validate';

const CODE: TalkErrorCode = 'invalid-assembly';

// ─── 输出 ─────────────────────────────────────────────

/** 装配出的一条消息（纯数据；宿主自行映射到具体 SDK 的 message 形状） */
export interface Message {
    readonly role: AssemblyRole;
    readonly content: string;
}

// ─── 输入源（多源）─────────────────────────────────────

/** 源的类型全集：发言线 · 私有过程 · 资料演进（每源内容**同质**，故可由源类型定 kind） */
export const SOURCE_TYPES = ['reactions', 'trace', 'material'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * 装配输入源（判别联合，遵 `rule.discriminated-union`：判别键 `type` 同级无公共字段 ⇒ `{ type, data }`）。
 * - `reactions` 发言线（kind=`speech`）：模式 1/2 的争论线，模式 3 的批注线
 * - `trace`     私有过程（kind=`trace`）：某 agent 的 tool / thinking（他人过程不投递）
 * - `material`  资料演进（kind=`material`）：文档修订 / 任务字段变更（对模型是外部事实）
 */
export type Source =
    | { readonly type: 'reactions'; readonly data: { readonly reactions: readonly Reaction[] } }
    | { readonly type: 'trace'; readonly data: { readonly events: readonly Event[] } }
    | { readonly type: 'material'; readonly data: { readonly events: readonly Event[] } };

const SOURCE_KEYS = ['type', 'data'] as const;
const SOURCE_DATA_KEYS: Record<SourceType, readonly string[]> = {
    reactions: ['reactions'],
    trace: ['events'],
    material: ['events'],
};
/** 源类型 → 内容类别（决定 role 轴，复用 role.ts 的 SOURCE_KINDS） */
const SOURCE_KIND: Record<SourceType, SourceKind> = {
    reactions: 'speech',
    trace: 'trace',
    material: 'material',
};

/** 校验并规范化一个源（内部条目也逐条 `parseReaction` / `parseEvent`，非法带点路径报错） */
export function parseSource(value: unknown, path = 'source'): Source {
    const obj = takeObject(value, path, CODE);
    rejectUnknown(obj, SOURCE_KEYS, path, CODE);
    const type = takeString(obj.type, `${path}.type`, CODE);
    if (!(SOURCE_TYPES as readonly string[]).includes(type)) {
        throw new TalkError(CODE, `未知来源类型 ${JSON.stringify(type)}（合法：${SOURCE_TYPES.join(' | ')}）`, `${path}.type`);
    }
    const data = takeObject(obj.data, `${path}.data`, CODE);
    rejectUnknown(data, SOURCE_DATA_KEYS[type as SourceType], `${path}.data`, CODE);
    if (type === 'reactions') {
        const raw = data.reactions;
        if (!Array.isArray(raw)) throw new TalkError(CODE, '应为发言数组', `${path}.data.reactions`);
        return { type: 'reactions', data: { reactions: raw.map((r, i) => parseReaction(r, `${path}.data.reactions[${i}]`)) } };
    }
    const raw = data.events;
    if (!Array.isArray(raw)) throw new TalkError(CODE, '应为事件数组', `${path}.data.events`);
    const events = raw.map((e, i) => parseEvent(e, `${path}.data.events[${i}]`));
    return type === 'trace' ? { type: 'trace', data: { events } } : { type: 'material', data: { events } };
}

// ─── 展开后的一条内容（投影 / 渲染的操作对象）──────────────

/** 源内一条内容，展开成同形（片段携带足够信息做 role 翻译与渲染） */
export interface AssemblyItem {
    /** 内容类别：决定 role 的唯一轴（复用 role.ts） */
    readonly kind: SourceKind;
    readonly author: string;
    readonly content: string;
    /** 这条内容指向哪（发言 = target；资料 / 过程 = 事件 anchor） */
    readonly anchor: Anchor;
    /** 结构化寻址：回复的是哪条发言的 id（仅发言有；资料 / 过程恒 null） */
    readonly replyTo: string | null;
    readonly at: string;
}

// ─── 策略（选哪些源 + 什么投影 + 什么渲染）──────────────────

/** 策略运行期上下文 */
export interface StrategyContext {
    /** 本次装配的 agent 自己 */
    readonly selfId: string;
}

/**
 * 一份装配策略。三模式共用本入口，差别只在此对象：
 * - `selectSource` 选源（缺省全收）
 * - `selectItem` 投影（缺省全收；**他人的过程已被内核剔除**，策略看不到）
 * - `render` 渲染正文（缺省 `renderItem`，保留 replyTo 寻址）
 */
export interface AssemblyStrategy {
    readonly name: string;
    readonly selectSource?: (source: Source) => boolean;
    readonly selectItem?: (item: AssemblyItem) => boolean;
    readonly render?: (item: AssemblyItem, ctx: StrategyContext) => string;
}

/** 内置策略名（结论 4：模式 = 一份装配策略） */
export const STRATEGY_NAMES = ['full', 'text-only', 'changes-only'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/**
 * 缺省渲染：结构 → 字符串（结论 13：装配时才渲染，落盘存结构）。
 * - 发言：非自己的加 `作者: ` 前缀；有 replyTo 时保留 `[回复 <id>]` 寻址（text-only 尤其要保）
 * - 资料 / 过程：加 `【资料·<锚点>】` / `【过程·<锚点>】` 前缀，让人知道在说哪一段
 */
export function renderItem(item: AssemblyItem, ctx: StrategyContext): string {
    if (item.kind === 'speech') {
        const who = item.author === ctx.selfId ? '' : `${item.author}: `;
        const to = item.replyTo === null ? '' : `[回复 ${item.replyTo}] `;
        return `${who}${to}${item.content}`;
    }
    const tag = item.kind === 'material' ? '资料' : '过程';
    return `【${tag}·${anchorLabel(item.anchor)}】${item.content}`;
}

/** 锚点的可读定位（渲染前缀用） */
function anchorLabel(anchor: Anchor): string {
    switch (anchor.type) {
        case 'message':
            return `消息 ${anchor.data.messageId}`;
        case 'doc-range':
            return `文档 ${anchor.data.revisionId}@${anchor.data.offset}`;
        case 'task-field':
            return `任务字段 ${anchor.data.field}`;
        case 'node':
            return `泳道节点 ${anchor.data.nodeId}`;
    }
}

/** 模式 1 全量档案：**自己的**过程 + 发言 + 资料（**他方过程除外**，见文件头需求对齐） */
export const FULL: AssemblyStrategy = { name: 'full' };

/** 模式 2 去过程：丢掉 tool / thinking（含自己的），保留发言（含 replyTo 寻址）与资料 */
export const TEXT_ONLY: AssemblyStrategy = {
    name: 'text-only',
    selectItem: (item) => item.kind !== 'trace',
};

/** 模式 3 文档为中心：只留资料（文档修订）+ 钉在文档上的批注线 */
export const CHANGES_ONLY: AssemblyStrategy = {
    name: 'changes-only',
    selectItem: (item) => item.kind === 'material' || (item.kind === 'speech' && item.anchor.type === 'doc-range'),
};

/** 内置策略表 */
export const STRATEGIES: Record<StrategyName, AssemblyStrategy> = {
    full: FULL,
    'text-only': TEXT_ONLY,
    'changes-only': CHANGES_ONLY,
};

/** 把策略名解析成策略对象；已是对象则原样返回（自检 name） */
export function resolveStrategy(strategy: StrategyName | AssemblyStrategy): AssemblyStrategy {
    if (typeof strategy === 'string') {
        const found = STRATEGIES[strategy];
        if (found === undefined) {
            throw new TalkError(CODE, `未知装配策略 ${JSON.stringify(strategy)}（内置：${STRATEGY_NAMES.join(' | ')}）`, 'strategy');
        }
        return found;
    }
    if (typeof strategy !== 'object' || strategy === null || typeof strategy.name !== 'string' || strategy.name === '') {
        throw new TalkError(CODE, 'strategy 应为内置策略名，或带 name 的装配策略对象', 'strategy');
    }
    for (const key of ['selectSource', 'selectItem', 'render'] as const) {
        const fn = strategy[key];
        if (fn !== undefined && typeof fn !== 'function') {
            throw new TalkError(CODE, `策略的 ${key} 应为函数`, `strategy.${key}`);
        }
    }
    return strategy;
}

// ─── 窗口 / 摘要（注入式钩子）──────────────────────────

/**
 * 窗口 / 摘要钩子：宿主给裁剪函数，内核不自作主张（##166 §五）。
 * 入参是渲染后的 `Message[]`，返回裁剪（必要时前插摘要消息）后的 `Message[]`。
 *
 * ⚠️ 边界（review1 意见 2，选②「显式声明」）：`window` 是**宿主注入的可信代码**，
 * 其返回值被视为宿主的最终意图、**不再经 `assertRoleAssignments` 复核**。
 * 故 README「他人发言绝不为 `assistant`」的保证**仅覆盖装配器自身产出**（window 之前）；
 * 钩子若改写 role，责任在宿主。（窗口后无法复核的原因：`Message` 只含 `role`+`content`，
 * 已丢失 author/kind 溯源信息；要复核就得让 `Message` 携带溯源，与「输出是纯 `Message[]`」冲突。）
 */
export type WindowHook = (messages: readonly Message[]) => readonly Message[];

// ─── 装配入口 ──────────────────────────────────────────

export interface AssembleInput {
    /** 多源（顺序即装配顺序 —— 内核不替宿主排序） */
    readonly sources: readonly Source[];
    /** 内置策略名，或自定义策略对象 */
    readonly strategy: StrategyName | AssemblyStrategy;
    /** 本次请求的 agent 自己 */
    readonly selfId: string;
    /** 窗口 / 摘要钩子（缺省不裁剪） */
    readonly window?: WindowHook;
}

/** 装配入参的合法顶层键（形状封闭，见 `rejectUnknown`） */
const ASSEMBLE_KEYS = ['sources', 'strategy', 'selfId', 'window'] as const;

/**
 * 装配：多源 + 投影 + 窗口 → `Message[]`（唯一出口）。
 *
 * 步骤：① 逐源校验 → ② 按策略选源 → ③ 展开为条目并**剔除他人的过程**（不变量，先于策略）
 * → ④ 按策略投影 → ⑤ role 翻译（复用 `assemblyRole`，并以 `assertRoleAssignments` 复核铁律）
 * → ⑥ 渲染 → ⑦ 交给窗口钩子。
 */
export function assemble(input: AssembleInput): Message[] {
    if (typeof input !== 'object' || input === null) throw new TalkError(CODE, 'assemble 入参应为对象', 'assemble');
    // 形状封闭（rule.loud）：顶层未知字段一律拒绝 —— 否则把 `window` 误拼成 `windo` 会静默失效
    rejectUnknown(input as unknown as Record<string, unknown>, ASSEMBLE_KEYS, 'assemble', CODE);
    if (!Array.isArray(input.sources)) throw new TalkError(CODE, 'sources 应为数组', 'sources');
    if (typeof input.selfId !== 'string' || input.selfId === '') {
        throw new TalkError(CODE, 'selfId（装配对象）不能为空：没有「我」就无从判断哪条是自己的', 'selfId');
    }
    if (input.window !== undefined && typeof input.window !== 'function') {
        throw new TalkError(CODE, 'window 应为函数（窗口 / 摘要钩子）', 'window');
    }
    const strategy = resolveStrategy(input.strategy);
    const selfId = input.selfId;

    const items: AssemblyItem[] = [];
    input.sources.forEach((raw, si) => {
        const source = parseSource(raw, `sources[${si}]`);
        if (strategy.selectSource !== undefined && !strategy.selectSource(source)) return;
        for (const item of flatten(source)) {
            // 内核不变量：他人的过程产物永不进入装配（过程私有，不投递）
            if (item.kind === 'trace' && item.author !== selfId) continue;
            if (strategy.selectItem !== undefined && !strategy.selectItem(item)) continue;
            items.push(item);
        }
    });

    // role 翻译（复用 role.ts 的规则表）+ 铁律复核
    const assignments = items.map((item) => ({
        kind: item.kind,
        author: item.author,
        self: selfId,
        role: assemblyRole({ kind: item.kind, author: item.author, self: selfId }),
    }));
    assertRoleAssignments(assignments);

    const render = strategy.render ?? renderItem;
    const messages: Message[] = items.map((item, i) => ({
        role: assignments[i]!.role,
        content: render(item, { selfId }),
    }));
    return input.window === undefined ? messages : [...input.window(messages)];
}

/** 把一个已校验的源展平成条目（不排序 —— 顺序归宿主） */
function flatten(source: Source): AssemblyItem[] {
    if (source.type === 'reactions') {
        return source.data.reactions.map((reaction) => ({
            kind: 'speech',
            author: reaction.author,
            content: reaction.content,
            anchor: reaction.target,
            replyTo: reaction.replyTo,
            at: reaction.at,
        }));
    }
    return source.data.events.map((event) => ({
        kind: SOURCE_KIND[source.type],
        author: event.author,
        content: event.content,
        anchor: event.anchor,
        replyTo: null,
        at: event.at,
    }));
}
