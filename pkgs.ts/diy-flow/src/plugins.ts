// plugins.ts — 插件槽位：五个固定接口（##166 §13.2）
//
// 判据（##166 §13.1）：**引擎能枚举的 → 配置（只选不写）；引擎查不到的 → 插件（代码）**。
// 「引擎查不到」只有两种 —— 读外部世界 / 写外部世界：
//
//   槽位      接口                              为什么非写不可
//   guard   (ctx) => { pass, reason }          **读**：外部世界的「过没过」（引擎看不到）
//   source  (ctx) => data                      **读**：外部数据（行情 / CI 日志 / 素材库）
//   action  (ctx) => { ok, ref }               **写**：对外部世界动手（合并 / 发布 / 下单）
//   render  (data, anchor) => View             **译**：非文本形状 → 引擎通用渲染器（不写页面）
//   notify  (event) => receipt                 **唤**：唤醒谁（接 ##166 §10.5 待决 7）
//
// **槽位固定、工作流只能「引用」不能自创接口**（§13.2）：所以这里是 `interface` 而不是回调注册点 ——
// 新槽位 = 改内核 + 发版。这与 §13.4 学的 GitHub 一致：把「必须写代码的地方」收敛成少数槽位，
// 上面的配置层（L1/L2）才能保持纯声明。
//
// 本包**不触外部世界**（##315 硬约束）：所有副作用都在宿主给的函数体里，内核只按名调用（见 registry.ts）。
// 因此这里只定义「长什么样」，一个具体实现的字节都不写。

import type { Anchor, Event } from '@diy/talk';
import { RENDERERS, type NodeDef, type Renderer, type WorkflowDef } from './define';
import { FlowError } from './errors';

/** 插件槽位全集（引擎枚举；工作流只能引用这五个） */
export const SLOTS = ['guard', 'source', 'action', 'render', 'notify'] as const;
export type Slot = (typeof SLOTS)[number];

/**
 * 插件上下文：内核交给插件的**全部**信息。
 *
 * **不给 `nodeId` 之外的活口**：插件要读外部世界（CI 状态 / 行情），读写动作都在它自己的闭包里；
 * 内核只把「现在轮到哪个节点、用的是哪份实例参数、谁在求值」递过去。
 */
export interface PluginContext {
    /** 整个工作流定义（插件可能需要看旁支：如「上游节点产出过什么」） */
    readonly workflow: WorkflowDef;
    /** 当前驻留节点（`guard` 判的就是「能不能离开它」；`source` 取的就是「它的产物」） */
    readonly node: NodeDef;
    /** L2 实例参数（##316 注入；本任务只透传、不校验） */
    readonly params: Readonly<Record<string, unknown>>;
    /** 求值 / 宣布的主体：`system`（引擎求值）或 actor id（actor 宣布，##166 §10.3） */
    readonly actor: string;
}

/** `guard` 槽的返回：过没过 + 为什么（不过时用） */
export interface GuardResult {
    readonly pass: boolean;
    /** `pass === false` 时的原因（进诊断与事件正文） */
    readonly reason?: string;
}

/** `action` 槽的返回：成没成 + 外部引用（订单号 / 发布 URL / PR 号） */
export interface ActionResult {
    readonly ok: boolean;
    /** `ok === true` 时指向外部世界的凭据 */
    readonly ref?: string;
}

/**
 * `render` 槽的返回：一段数据 + 该用哪个**引擎通用渲染器**画。
 * 行业插件只做「形状翻译」（raw → kline / table / timeline），不写页面（##166 §14.7）。
 */
export interface View {
    readonly renderer: Renderer;
    /** 交给该渲染器的数据（形状由 renderer 约定，引擎不管） */
    readonly payload: unknown;
    readonly note?: string;
}

/** `notify` 槽的返回：通知到了谁（被唤醒者的 id 列表） */
export interface Receipt {
    readonly delivered: readonly string[];
    readonly note?: string;
}

export type GuardPlugin = (ctx: PluginContext) => GuardResult;
export type SourcePlugin = (ctx: PluginContext) => unknown;
export type ActionPlugin = (ctx: PluginContext) => ActionResult;
export type RenderPlugin = (data: unknown, anchor: Anchor) => View;
export type NotifyPlugin = (event: Event) => Receipt;

/** 槽位 → 插件形状的映射（注册表按它做类型护栏：哪个槽收哪种函数） */
export interface SlotPlugins {
    readonly guard: GuardPlugin;
    readonly source: SourcePlugin;
    readonly action: ActionPlugin;
    readonly render: RenderPlugin;
    readonly notify: NotifyPlugin;
}

export type PluginOf<K extends Slot> = SlotPlugins[K];
export type Plugin = SlotPlugins[Slot];

// ── 返回值校验：插件是宿主代码，形状不对**立即报错**（不静默降级成「不通过 / 空数据」）──────
// 与 define.ts 的「形状封闭」略有不同：插件返回值是运行期产物，**允许多带调试字段**
// （多带不该失败），但**必填字段类型不对一律抛**。

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function takeBool(obj: Record<string, unknown>, key: string, path: string, what: string): boolean {
    if (typeof obj[key] !== 'boolean') throw new FlowError('invalid-plugin-result', `${what} 的 ${key} 应为 boolean`, `${path}.${key}`);
    return obj[key];
}

function takeOptionalString(obj: Record<string, unknown>, key: string, path: string, what: string): string | undefined {
    if (obj[key] === undefined) return undefined;
    if (typeof obj[key] !== 'string') throw new FlowError('invalid-plugin-result', `${what} 的 ${key} 应为 string`, `${path}.${key}`);
    return obj[key];
}

export function parseGuardResult(value: unknown, path = 'result'): GuardResult {
    if (!isObject(value)) throw new FlowError('invalid-plugin-result', 'guard 插件应返回 { pass, reason? }', path);
    const reason = takeOptionalString(value, 'reason', path, 'guard 插件返回值');
    const pass = takeBool(value, 'pass', path, 'guard 插件返回值');
    return reason === undefined ? { pass } : { pass, reason };
}

export function parseActionResult(value: unknown, path = 'result'): ActionResult {
    if (!isObject(value)) throw new FlowError('invalid-plugin-result', 'action 插件应返回 { ok, ref? }', path);
    const ref = takeOptionalString(value, 'ref', path, 'action 插件返回值');
    const ok = takeBool(value, 'ok', path, 'action 插件返回值');
    return ref === undefined ? { ok } : { ok, ref };
}

export function parseView(value: unknown, path = 'result'): View {
    if (!isObject(value)) throw new FlowError('invalid-plugin-result', 'render 插件应返回 { renderer, payload, note? }', path);
    const renderer = value.renderer;
    if (typeof renderer !== 'string' || !(RENDERERS as readonly string[]).includes(renderer)) {
        throw new FlowError('invalid-plugin-result', `render 插件返回了未知 renderer ${JSON.stringify(renderer)}（合法：${RENDERERS.join(' | ')}）`, `${path}.renderer`);
    }
    if (!('payload' in value)) throw new FlowError('invalid-plugin-result', 'render 插件返回值缺少 payload', `${path}.payload`);
    const note = takeOptionalString(value, 'note', path, 'render 插件返回值');
    return note === undefined ? { renderer: renderer as Renderer, payload: value.payload } : { renderer: renderer as Renderer, payload: value.payload, note };
}

export function parseReceipt(value: unknown, path = 'result'): Receipt {
    if (!isObject(value)) throw new FlowError('invalid-plugin-result', 'notify 插件应返回 { delivered, note? }', path);
    const delivered = value.delivered;
    if (!Array.isArray(delivered) || delivered.some((x) => typeof x !== 'string')) {
        throw new FlowError('invalid-plugin-result', 'notify 插件返回值的 delivered 应为 string 数组', `${path}.delivered`);
    }
    const note = takeOptionalString(value, 'note', path, 'notify 插件返回值');
    return note === undefined ? { delivered: delivered as string[] } : { delivered: delivered as string[], note };
}
