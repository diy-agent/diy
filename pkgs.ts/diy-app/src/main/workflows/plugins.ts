// src/main/workflows/plugins.ts — 宿主注册的 **render 插件**（「形状翻译」层，##337）
//
// 依据 ##166 §14.7 / §13.2（**行业不写页面，只写形状翻译**）：
//
//     节点产出的 raw（行业知道形状） ── render 插件 ──▶ View{ renderer, payload }
//                                                       （引擎侧九种通用渲染器吃它）
//
// 页面长什么样归 ##320(UI)；本文件**只翻形状**：不碰 fs / 网络 / Electron / DOM，纯函数。
// 「引擎查不到的才写代码」（§13.1）——raw 的形状只有行业知道，故这一层非写代码不可；
// 但把它做薄，配置层（L1/L2）才能保持纯声明。
//
// 范围（第一版，##337）：**只有 `render` 一个槽有实现**。`guard` 全是 `prompt:`（不可观测）、
// 没有 `pred:`/`action:`/`notify`，故其余四槽一个都不注册（见 `workflows/dev.ts` 头注）。
//
// ⚠️ 内核**从不调用** `render` 槽（`rg "resolve\('render'" pkgs.ts/diy-flow/src` 零命中）：
//    槽位与 `parseView` 校验是内核给的，**什么时候译、拿哪份 raw 去译是宿主的决定** ——
//    调用点唯一：`core/flow.ts` 的 `translateArtifact`（见那里的立场：无产物 ⇒ null，坏 ⇒ 抛）。
//
// 注册表按内核 `PluginRegistry` 的规矩办：同名同槽重复注册、未注册就 resolve 一律**报错**，
// 绝不静默降级（`registry.ts` 头注：插件名打错一个字而静默降级，工作流会悄悄偏到另一条路上）。

import { createRegistry, type PluginRegistry, type RenderPlugin, type View } from '@diy/flow';

/** 把 raw 里「本该是字符串」的部分取出来（翻不了就抛，交给宿主 `callPlugin` 包成 `plugin-threw`） */
function asText(data: unknown, plugin: string): string {
    if (typeof data === 'string') return data;
    // `--file` 放进来的是 JSON 时，一段正文常写成 `"…"` 或 `{ "text": "…" }` —— 两种都认
    if (typeof data === 'object' && data !== null && !Array.isArray(data) && typeof (data as Record<string, unknown>)["text"] === 'string') {
        return (data as Record<string, string>)["text"]!;
    }
    throw new Error(`render 插件 ${plugin} 的 raw 应为字符串（或 { text: string }），实得 ${JSON.stringify(data)?.slice(0, 120)}`);
}

/**
 * `patch` —— raw 是 unified diff 文本 ⇒ 引擎 `diff` 渲染器要吃的 `{ lines }`（`view.ts::DiffData`）。
 *
 * `DiffLine.text` **含或不含行首标记都行**（渲染器只按 `kind` 上色），故这里按首字符分类后**原样保留文本**：
 * 插件只补「加 / 删 / 上下文」这个语义，剥不剥标记是渲染器的事（`view.ts` 的 `DiffLine` 头注）。
 */
const patch: RenderPlugin = (data): View => {
    const text = asText(data, 'patch');
    const lines = text.split('\n').map((line) => ({
        // 文件头 `--- a/x` / `+++ b/x`（以及 `diff --git` / `@@` / `\ No newline`）都算上下文：
        // 只有「单个 +/- 开头」才是增删行 —— 否则每份 diff 的头两行都会被上成红绿，一眼就错
        kind: line.startsWith('+++') || line.startsWith('---')
            ? ('context' as const)
            : line.startsWith('+')
              ? ('add' as const)
              : line.startsWith('-')
                ? ('del' as const)
                : ('context' as const),
        text: line,
    }));
    // 末尾换行会多切出一个空行；diff 里它没有语义，去掉（只在**最后一个**是空串时）
    if (lines.length > 1 && lines[lines.length - 1]!.text === '') lines.pop();
    return { renderer: 'diff', payload: { lines } };
};

/** 一行记录的取值：数组行原样当 cells；对象行按列序取值（缺列 ⇒ 空串，值一律 String —— table 只吃字符串） */
function cellsOf(row: unknown, columns: readonly string[] | undefined, plugin: string): string[] {
    if (Array.isArray(row)) return row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    if (typeof row === 'object' && row !== null) {
        const obj = row as Record<string, unknown>;
        const keys = columns ?? Object.keys(obj);
        return keys.map((key) => (obj[key] === null || obj[key] === undefined ? '' : String(obj[key])));
    }
    if (typeof row === 'string' || typeof row === 'number' || typeof row === 'boolean') return [String(row)];
    throw new Error(`render 插件 ${plugin} 的行应为数组 / 对象 / 标量，实得 ${JSON.stringify(row)}`);
}

/**
 * `records` —— raw 是「若干条记录」的清单 ⇒ 引擎 `table` 要吃的 `{ columns?, rows }`（`view.ts::TableData`）。
 *
 * 认两种 raw：`{ columns?, rows }` 或**裸数组**（= 只有 rows，列序取第一行的键序）。
 * 「评审判定 / 检查项 / 打回意见」这类产物天然是这个形状，故它是第一版最用得上的翻译器。
 */
const records: RenderPlugin = (data): View => {
    // 认两种 raw：裸数组（= 只有 rows）/ 对象 `{ columns?, rows }`；别的当场拒（不猜、不降级）
    let rawRows: unknown[];
    let rawColumns: unknown;
    if (Array.isArray(data)) {
        rawRows = data;
    } else if (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)["rows"])) {
        rawRows = (data as Record<string, unknown>)["rows"] as unknown[];
        rawColumns = (data as Record<string, unknown>)["columns"];
    } else {
        throw new Error(`render 插件 records 的 raw 应为数组或 { columns?, rows }，实得 ${JSON.stringify(data)?.slice(0, 120)}`);
    }
    const columns = Array.isArray(rawColumns) ? rawColumns.map((c: unknown) => String(c)) : undefined;
    const rows = rawRows.map((row) => ({ cells: cellsOf(row, columns, 'records') }));
    return columns === undefined ? { renderer: 'table', payload: { rows } } : { renderer: 'table', payload: { columns, rows } };
};

/**
 * 造一份**只含 render 槽**的注册表（每次调用都是新的：与内核 `createRegistry()` 同风格，不留共享可变态）。
 *
 * 加插件 = 在下面链一条 `.register('render', 名, 函数)` + 在定义的 `art.plugin` 里引用同一个名。
 * 名字一旦被实例数据引用就等于公开契约：**只增不改**（改名 = 老产物袋译不出来）。
 */
export function createRenderRegistry(): PluginRegistry {
    return createRegistry().register('render', 'patch', patch).register('render', 'records', records);
}

/** 已注册的 render 插件名（诊断 / 文档用；注册序） */
export function renderPluginNames(): string[] {
    return [...createRenderRegistry().names('render')];
}
