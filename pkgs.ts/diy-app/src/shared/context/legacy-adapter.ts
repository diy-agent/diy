// src/shared/context/legacy-adapter.ts
// 🎯 旧事件流（Op: start/delta/patch/stop）→ ContextFact 的**临时适配层**。
//
// 这是 148 里唯一认识旧格式的文件，也是 108 重构后**唯一需要替换**的文件：
//   现在：Op        → legacy-adapter → ContextFact
//   108： EventRecord → context-fact-adapter → ContextFact（树/reducer/投影不动）
//
// 两条纪律（144 结论）：
//   · 旧格式只是**临时载体**：ContextTree 与 reducer 绝不接收 Op 作为入参。
//   · **不改 BlockKind / 不让 BlockStore 理解 Context**：旧流里的载体用临时命名空间
//     `kind: "context"`，只在本文件识别（BlockStore 不认识它，也不该认识）。
//
// 临时载体约定（本任务内自定，108 后作废）：
//   { op:"start", id:"env.os", kind:"context", meta:{ renderer, place?, container? } }
//   { op:"delta", id:"env.os", fields:{ content:"…" } }        // 文本增量（拼接）
//   { op:"patch", id:"env.os", fields:{ value:<json> } }        // 直接写值
//   { op:"patch", id:"env.os", fields:{ __removed:true } }      // 删除
//   { op:"stop",  id:"env.os" }                                 // 定稿 → replace 事实

import type { ContextContainer, ContextFact, ContextPath } from "./types";

/** 旧 Op 的宽松形状：结构兼容 local-blocks.Op，但**不 import 它**（shared 不能依赖 main） */
export interface LegacyOp {
    op: "start" | "delta" | "patch" | "stop";
    id: string;
    kind?: string;
    parent?: string;
    meta?: Record<string, unknown>;
    fields?: Record<string, unknown>;
}

/** 旧流里 Context 事实的临时命名空间 */
export const LEGACY_CONTEXT_KIND = "context";

/** 删除标记字段（旧流没有 delete op，用保留字段表达） */
const REMOVED_FIELD = "__removed";

/**
 * 转换结果。
 * `places`/`placement` **不是事实**（144：places 是唯一配置，不该在每条事实里重复携带），
 * 所以从事实流里分出来单独返回，由调用方用 setPlaces/setPlacement 落到树上。
 */
export interface LegacyConversion {
    places: ContextPath[];
    placement: Record<ContextPath, ContextContainer>;
    facts: ContextFact[];
}

interface OpenBlock {
    renderer: string;
    buf: string;
    /** 是否已产出过事实（空内容且没产出过 → 不发，避免噪声） */
    emitted: boolean;
}

/** 把一段旧 Op 流转成 ContextFact（纯函数：同样输入 → 同样输出） */
export function opsToFacts(ops: readonly LegacyOp[]): LegacyConversion {
    const open = new Map<string, OpenBlock>();
    const facts: ContextFact[] = [];
    const places: ContextPath[] = [];
    const placement: Record<ContextPath, ContextContainer> = {};

    for (const op of ops) {
        if (op.op === "start") {
            if (op.kind !== LEGACY_CONTEXT_KIND) continue;
            const meta = op.meta ?? {};
            open.set(op.id, { renderer: String(meta.renderer ?? "yaml"), buf: "", emitted: false });
            if (meta.place === true) {
                places.push(op.id);
                // 缺省 runtime 也**显式**记一条：否则「没写 container」与「写了 runtime」会
                // 在 placement 表上留下两种表示，golden 比对（换 adapter 后必须一致）就假红。
                placement[op.id] = meta.container === "system" ? "system" : "runtime";
            }
            continue;
        }

        if (op.op === "delta") {
            const st = open.get(op.id);
            if (!st) continue;
            const c = op.fields?.content;
            if (typeof c === "string") st.buf += c;
            continue;
        }

        if (op.op === "patch") {
            const f = op.fields ?? {};
            if (f[REMOVED_FIELD] === true) {
                facts.push({ type: "remove", path: op.id });
                continue;
            }
            if ("value" in f) {
                facts.push({ type: "patch", path: op.id, op: "set", value: f.value });
                open.get(op.id)!.emitted = true;
                continue;
            }
            // 其余字段按「局部覆盖」合并成一次 set（旧流的 patch 语义就是覆盖字段）
            const st = open.get(op.id);
            if (st) {
                st.emitted = true;
                facts.push({ type: "patch", path: op.id, op: "set", value: { ...f } });
            }
            continue;
        }

        if (op.op === "stop") {
            const st = open.get(op.id);
            if (!st) continue;
            open.delete(op.id);
            // 空内容且从未 patch 过 → 不发（"内容未变不发"的精神：没有内容就没有事实）
            if (st.buf.length === 0 && !st.emitted) continue;
            if (st.buf.length === 0) continue;
            facts.push({
                type: "replace",
                path: op.id,
                content: st.buf,
                contentFormat: st.renderer === "template" ? "template-text" : "yaml",
            });
        }
    }

    return { places, placement, facts };
}
