// registry.ts — 插件注册表：按名注册 / 解析
//
// 依据 ##166 §13.2（槽位固定）+ §13.4（GitHub 的做法：只订协议，实现外置）：
// 工作流定义里**只写名字**（`pred:ci_green` / `action:publish` / render 插件名），真函数由宿主
// （各工作流开发包）在启动时注册进来 —— 内核只按名解析，不认识任何一个具体插件。
//
// **未注册即报错**（`unknown-plugin`）：`pred:ci_grenn` 打错一个字，若静默降级成「永远不通过」
// 或「永远通过」，工作流就会**悄悄偏到另一条路径**上 —— 而「偏了一步」正是折线投影最难肉眼
// 发现的失败形态（##166 §7.4 痛点 2：靠肉眼对齐会幻觉）。所以：绝不降级，重名也绝不静默覆盖。

import { FlowError } from './errors';
import { SLOTS, type Slot, type SlotPlugins } from './plugins';

export interface PluginRegistry {
    /** 注册一个插件；同名同槽重复注册 → `duplicate-plugin`（返回自身，可链式） */
    register<K extends Slot>(slot: K, name: string, plugin: SlotPlugins[K]): PluginRegistry;
    /** 按名解析；未注册 → `unknown-plugin`（绝不返回 undefined 让调用方漏判） */
    resolve<K extends Slot>(slot: K, name: string): SlotPlugins[K];
    has(slot: Slot, name: string): boolean;
    /** 某槽已注册的名字（键序 = 注册序，便于报错时列出「已注册：…」） */
    names(slot: Slot): readonly string[];
}

/** 空注册表 */
export function createRegistry(): PluginRegistry {
    const tables = new Map<Slot, Map<string, unknown>>();
    for (const slot of SLOTS) tables.set(slot, new Map<string, unknown>());

    function take(slot: Slot): Map<string, unknown> {
        const table = tables.get(slot);
        if (!table) throw new FlowError('invalid-plugin', `未知插件槽位 ${JSON.stringify(slot)}（合法：${SLOTS.join(' | ')}）`, 'slot');
        return table;
    }

    function register<K extends Slot>(slot: K, name: string, plugin: SlotPlugins[K]): PluginRegistry {
        if (typeof name !== 'string' || name === '') {
            throw new FlowError('invalid-plugin', '插件名必须是非空字符串', `${slot}:name`);
        }
        if (typeof plugin !== 'function') {
            throw new FlowError('invalid-plugin', `插件 ${slot}:${name} 必须是函数`, `${slot}:${name}`);
        }
        const table = take(slot);
        if (table.has(name)) {
            throw new FlowError('duplicate-plugin', `插件 ${slot}:${name} 重复注册（不静默覆盖）`, `${slot}:${name}`);
        }
        table.set(name, plugin);
        return api;
    }

    function resolve<K extends Slot>(slot: K, name: string): SlotPlugins[K] {
        const table = take(slot);
        const plugin = table.get(name);
        if (!plugin) {
            const known = [...table.keys()].join(', ');
            throw new FlowError('unknown-plugin', `未注册的插件 ${slot}:${name}（该槽已注册：${known === '' ? '（无）' : known}）`, `${slot}:${name}`);
        }
        return plugin as SlotPlugins[K];
    }

    function has(slot: Slot, name: string): boolean {
        return take(slot).has(name);
    }

    function names(slot: Slot): readonly string[] {
        return [...take(slot).keys()];
    }

    const api: PluginRegistry = { register, resolve, has, names };
    return api;
}
