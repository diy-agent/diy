// src/node/yaml-out.ts — 真源 YAML 的**输出风格**（唯一一处，别在各 dump 调用点各配一遍）
//
// 为什么不是纯 `dump(..., { quoteStyle: 'single' })`：`value` / `description` 是**人要继续改的
// 多行文本**（md 段落、列表、表格）。js-yaml 缺省按内容挑风格 —— 单行值落成裸标量或单引号
// 一行，人在这种值后面追加一段，diff 就变成「整行重排」，review 时看不出改了哪句（##5 实测）。
//
// 故：`value` / `description` 一律**块标量**（`|-`，strip chomping）。两个性质必须同时成立：
//   ① 多行值本来就是这个形态（js-yaml 自动选 `|-`），把单行值拉齐 —— 同一字段永远同形，
//      人不必先判断"这条是不是多行"再决定怎么改；
//   ② **round-trip 精确**：`|-` 去掉末尾换行，故 `load(dump(x)) === x`（实测，含空行与列表）。
//      这正是不能靠"给字符串补 \n 骗它选块风格"的原因 —— 那会在读回时多一个换行。
//
// 实现用 `transform` 钩子把 AST 标量节点的 `style` 改成枚举值，不动内容、不加引号、不带 tag。
// ⚠️ js-yaml 5.5 起 `style` 是**单个枚举值**（`SCALAR_STYLE.LITERAL_BLOCK`），不再是
// 5.2 的布尔标志集合（`{literal, folded, …}`）—— 旧写法在 5.5 上类型即报错，且运行时会静默不生效。

import { dump, SCALAR_STYLE, type Document, type DumpOptions, type Node } from 'js-yaml';

/** 一律用块标量的字段（人读的长文本；id / at / probe 这类短 token 不在此列，别扩大） */
const LITERAL_KEYS = new Set(['value', 'description']);

function walk(node: Node | null): void {
    if (node === null) return;
    if (node.kind === 'mapping') {
        for (const item of node.items) {
            const key = item.key.kind === 'scalar' ? item.key.value : '';
            const value = item.value;
            if (LITERAL_KEYS.has(key) && value.kind === 'scalar') {
                value.style = SCALAR_STYLE.LITERAL_BLOCK;
            }
            walk(item.key);
            walk(value);
        }
        return;
    }
    if (node.kind === 'sequence') {
        for (const item of node.items) walk(item);
    }
}

/**
 * 与 `dump` 同一签名，仅 `transform` 由本函数接管（调用方传了也没用 —— 那是本函数的位置）。
 * 所有**真源**落盘（facts / subjects / expose）都走它；投影（给模型看的）不强制块标量 ——
 * 那边是消费侧的排版自由。
 */
export function dumpSource(data: unknown, options: Omit<DumpOptions, 'transform'> = {}): string {
    return dump(data, {
        ...options,
        transform: (documents: Document[]): void => {
            for (const doc of documents) walk(doc.contents);
        },
    });
}
