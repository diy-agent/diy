// examples/dev.plugins.ts — 范例①的两个插件：`pred:ci_green` / `action:pr_mergeable`
//
// 判据（##166 §13.1）：**引擎能枚举的 → 配置；引擎查不到的 → 插件**。「引擎查不到」只有两种 ——
//   · **读**外部世界（CI 绿没绿）⇒ `guard` 槽；
//   · **写**外部世界（动手合并 PR）⇒ `action` 槽。
// 故这两个槽位只能写代码（内核只按名调用，一个具体实现的字节都不写）。槽位固定、不能自创接口（§13.2）。
//
// **范例态**：不接真 CI / 真仓库（真接入是 ##319 的事）—— 外部事实由 `DevFacts` 注入，缺省「都过」。
// 于是「绿 → 推」与「红 → 停在边上」两条路都能在测试里跑到，且**不碰 fs、不引新依赖**。

import type { ActionPlugin, GuardPlugin, PluginContext, PluginRegistry } from '@diy/flow';

/** 外部世界的事实（真实现此刻去读 CI / 仓库；范例用注入的假数据） */
export interface DevFacts {
    /** CI 绿没绿（真实现：读 CI 状态 / 真跑一遍 `ci.command`） */
    readonly ciGreen?: boolean;
    /** PR 可不可合并（真实现：读 PR 状态 —— 看冲突与批准） */
    readonly prMergeable?: boolean;
    /** 合并后拿到的外部凭据（PR 号 / commit sha） */
    readonly mergeRef?: string;
}

/**
 * 取**本节点**分组的 L2 参数袋。
 *
 * `ctx.params` 的形状是 `{ 节点 id: { 局部名: 值 } }`（已校验 + 已合并缺省、冻结），插件只读
 * **本节点**那几个旋钮（别人的旋钮归别人）—— 所以拿 `ctx.node.id` 当键。
 */
function paramBagOf(ctx: PluginContext): Record<string, unknown> {
    const bag = ctx.params[ctx.node.id];
    return typeof bag === 'object' && bag !== null ? (bag as Record<string, unknown>) : {};
}

/** 本范例的两个插件实现（工厂：`facts` 注入外部事实，便于测试与真接入替换） */
export function devPlugins(facts: DevFacts = {}): { ciGreen: GuardPlugin; prMergeable: ActionPlugin } {
    /** `pred:ci_green` —— **读**外部世界：CI 绿没绿（读本节点的 `ci.command`，好让提示词与判据同源） */
    const ciGreen: GuardPlugin = (ctx) => {
        const command = paramBagOf(ctx).command;
        const label = typeof command === 'string' ? command : '(未声明 command)';
        const pass = facts.ciGreen ?? true;
        return { pass, reason: pass ? '' : `CI 未绿（${label}）` };
    };

    /** `action:pr_mergeable` —— **写**外部世界（真实现调仓库 API；范例只回执外部凭据） */
    const prMergeable: ActionPlugin = () => {
        const ok = facts.prMergeable ?? true;
        return ok ? { ok, ref: facts.mergeRef ?? 'PR#317' } : { ok };
    };

    return { ciGreen, prMergeable };
}

/**
 * 把范例插件注册进宿主的注册表 —— **先注册齐，再 `createRuntime`**
 * （组合期就查名字：`ci_grenn` 这种错字不必等到「走到那一步」才暴露）。
 */
export function registerDevPlugins(registry: PluginRegistry, facts: DevFacts = {}): PluginRegistry {
    const { ciGreen, prMergeable } = devPlugins(facts);
    registry.register('guard', 'ci_green', ciGreen);
    registry.register('action', 'pr_mergeable', prMergeable);
    return registry;
}
