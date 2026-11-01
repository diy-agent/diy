// block-renderers.ts — Block 渲染器注册表（**renderer 侧**，##499）。
//
// 唯一规则：UI 只认识「Block」，认识的内置 kind 只有 text / think / tool。
// 插件可以自造 kind 并注册渲染器（编译期显式 import 注册即可，不做动态插件加载）；
// 没注册的 kind 走 fallback（<details> + JSON 原文 + 「未知块类型」），不崩不白屏。
//
// 本文件不许出现 core 事件名：那些在主进程 blocks.ts 里归一化，renderer 与它们无关。

import type { Block, TextBlockData, ThinkBlockData, ToolBlockData } from "./shared.js";

export type BlockRenderer = (block: Block) => HTMLElement;

/** kind → 渲染器。内置三个先注册；插件用 registerBlockRenderer 追加自己的。 */
const renderers = new Map<string, BlockRenderer>([
    ["text", renderText],
    ["think", renderThink],
    ["tool", renderTool],
]);

/** 插件注册自己的 kind（第二个插件出现前不做动态加载） */
export function registerBlockRenderer(kind: string, fn: BlockRenderer): void {
    renderers.set(kind, fn);
}

/** 唯一渲染入口：不认识的 kind 走 fallback，不崩不白屏 */
export function renderBlock(block: Block): HTMLElement {
    const renderer = renderers.get(block.kind);
    return renderer === undefined ? renderFallback(block) : renderer(block);
}

/** 一条消息的全部块（顺序即 DOM 顺序） */
export function renderBlocks(blocks: readonly Block[]): HTMLElement[] {
    return blocks.map(renderBlock);
}

// ── 内置三个 ─────────────────────────────────────────────

function renderText(block: Block): HTMLElement {
    const data = block.data as Partial<TextBlockData>;
    const el = element("div", "chat-block chat-text");
    el.textContent = data.text ?? "";
    return el;
}

function renderThink(block: Block): HTMLElement {
    const data = block.data as Partial<ThinkBlockData>;
    const el = element("details", "chat-block chat-block-think");
    // 还在想 → 展开；想完 → 收起（用户可以自己点开）
    el.open = data.done !== true;
    const summary = element("summary", "chat-think-head");
    summary.textContent = data.done === true ? "思考" : "思考中…";
    const body = element("div", "chat-think-text");
    body.textContent = data.text ?? "";
    el.append(summary, body);
    return el;
}

function renderTool(block: Block): HTMLElement {
    const data = block.data as Partial<ToolBlockData>;
    const state = data.state ?? "ok";
    const el = element("details", "chat-block chat-block-tool");
    el.dataset["state"] = state;
    // 正在跑 → 展开（看得到进度）；跑完 / 失败 → 收起
    el.open = state === "running";

    const summary = element("summary", "chat-tool-head");
    const dot = element("span", "chat-tool-dot");
    dot.dataset["state"] = state;
    const name = element("span", "chat-tool-name");
    name.textContent = data.name === undefined || data.name === "" ? "工具" : data.name;
    const args = element("span", "chat-tool-args");
    args.textContent = data.args ?? "";
    summary.append(dot, name, args);
    if (data.summary !== undefined && data.summary !== "") {
        const brief = element("span", "chat-tool-summary");
        brief.textContent = data.summary;
        summary.append(brief);
    }
    el.append(summary);

    if (data.output !== undefined && data.output !== "") {
        const output = element("pre", "chat-tool-output");
        output.textContent = data.output;
        el.append(output);
    }
    return el;
}

/** 不认识的 kind：显示 JSON 原文 + 明确标注（插件格式坏了也不白屏） */
function renderFallback(block: Block): HTMLElement {
    const el = element("details", "chat-block chat-block-unknown");
    el.open = true;
    const summary = element("summary", "chat-unknown-head");
    summary.textContent = `未知块类型: ${block.kind}`;
    const json = element("pre", "chat-unknown-json");
    json.textContent = safeJson(block.data);
    el.append(summary, json);
    return el;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const el = globalThis.document.createElement(tag);
    el.className = className;
    return el;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}
