// src/shared/context/request.ts
// 🎯 请求预览：把**真实请求体**渲染成一份大 YAML（纯函数）。
//
// 为什么需要它（第二版上下文的取舍，148 会话收敛）：
//   · wire 不动 —— 请求体里的 system 段（responses 面是 developer 消息）就是一个文本字符串，
//     不为了 UI 去改真发格式（"request 真格式与预览 UI 不冲突"）；
//   · 但那份文本**本身就是 YAML**（Context Tree 的投影，见 render.ts），于是视图把它"拿出来"
//     就地解析、作为 YAML 子节点展开 —— 整份请求 = 一棵可寻址的树，与真发内容没有隔阂
//     （解析的是 body 里那段原文，不是另算的一份）。
//
// 三类字符串的处理（按判定顺序）：
//   1. 与传入的内嵌文本**逐字相等**（system 份 / runtime 份）→ 解析为 YAML 并展开为子节点；
//   2. 其他多行字符串 → 块标量（`|`），保换行与缩进；
//   3. 其余 → 标量。产出统一走 render.ts 的产出器（与投递渲染同一套词法）。
//
// 行号映射（path → 行区间）由**本次产出**直接收集（产出器边写边记）—— 与文本天然同源，
// 不对任何源文本做平移，避免"高亮指错行"（那比不高亮更糟）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import * as yaml from "js-yaml";
import { CONTEXT_GUIDE } from "./guide";
import { emitYamlTraced, type EmbedSpec, type RenderedYaml } from "./render";

/**
 * 拆「说明头 + 数据」。
 * 正常路径按内建说明头（guide.ts）精确切分（说明头是固定长文，拼法见 renderPathsTraced）；
 * 说明头被自定义/调整时退化为启发式：**第一个"顶层键"行之前**算说明头 ——
 * 只在精确切分失败时兜底，不改变正常语义。
 */
function splitGuide(text: string): { guide: string[]; data: string } {
    if (text.startsWith(CONTEXT_GUIDE)) {
        return {
            // 逐行输出为注释（含说明头与数据之间那行空行，与源文本逐行一一对应）
            guide: [...CONTEXT_GUIDE.replace(/\n$/, "").split("\n"), ""],
            data: text.slice(CONTEXT_GUIDE.length).replace(/^\n+/, ""),
        };
    }
    const lines = text.split("\n");
    const at = lines.findIndex((l) => /^[A-Za-z_$][A-Za-z0-9_$.-]*:( |$)/.test(l));
    if (at > 0) return { guide: lines.slice(0, at), data: lines.slice(at).join("\n") };
    return { guide: [], data: text };
}

/** 解析一份内嵌文本；失败（或不是结构）返回 null —— 调用方按普通字符串输出，原文不丢 */
function parseEmbed(text: string): EmbedSpec | null {
    if (text.trim() === "") return null;
    const { guide, data } = splitGuide(text);
    try {
        // JSON_SCHEMA：类型判断只认 JSON 那套（不做时间戳之类的隐式转换），
        // 预览里看到的结构与文本写法一一对应
        const value = yaml.load(data, { schema: yaml.JSON_SCHEMA });
        if (value === null || value === undefined || typeof value !== "object") return null;
        return { guide, value };
    } catch {
        return null;
    }
}

/**
 * 请求体 → 一份大 YAML + 行号映射。
 * `embedTexts`：与请求体里"某段字符串逐字相等"的文本（system 份 / runtime 份）；
 * 命中处解析为 YAML 子节点展开（解析失败则按原文块标量输出，不强行展开）。
 */
export function requestYaml(body: unknown, embedTexts: readonly string[]): RenderedYaml {
    const embeds = new Map<string, EmbedSpec>();
    for (const text of embedTexts) {
        if (!text || embeds.has(text)) continue;
        const spec = parseEmbed(text);
        if (spec) embeds.set(text, spec);
    }
    return emitYamlTraced(body, embeds);
}
