// src/renderer_solid/lib/models-sync.ts
// 🎯 「刷新模型目录」的 renderer 侧状态机（##385）：模型页按钮与模型不可用 bar **共用一份**。
//
// 为什么抽出来：两个入口（常规入口 = 设置→模型页；故障现场入口 = 顶栏 bar）挂的是同一个动作，
// 三态文案（更新中 / 成功报了数 / 失败给原因）也必须同口径 —— 各写一份必然分叉。
//
// 文案口径（body §3.3）：
//   · running —— 「更新中…」（按钮 disabled，防重复点击）
//   · ok      —— 有 diff：`已更新：新增 N 个模型 / 下线 M 个（X providers · Y models）`
//                无 diff：`已是最新（X providers · Y models）`
//   · error   —— `更新失败：<原因>`（并明确「本地数据未改动」—— 这就是 fail-soft 的用户可见语义）
import { createSignal } from "solid-js";
import type { ModelsRefreshResult } from "../../shared/model-config";
import { diyService } from "./rpc";

export type ModelsSyncPhase = "idle" | "running" | "ok" | "error";

/** 结果 → 一行给人看的文案（纯函数，便于单测） */
export function modelsSyncText(r: ModelsRefreshResult): string {
    if (!r.ok) return `更新失败：${r.error ?? "未知原因"}（本地数据未改动）`;
    if (!r.changed) return `已是最新（${r.providers} providers · ${r.models} models）`;
    return `已更新：新增 ${r.addedModels} 个模型 / 下线 ${r.removedModels} 个（${r.providers} providers · ${r.models} models）`;
}

export function createModelsSync(opts: { onDone?: (r: ModelsRefreshResult) => void } = {}) {
    const [phase, setPhase] = createSignal<ModelsSyncPhase>("idle");
    const [result, setResult] = createSignal<ModelsRefreshResult | null>(null);
    const [error, setError] = createSignal<string | null>(null);

    const run = async (): Promise<void> => {
        if (phase() === "running") return; // 防重复点击（RPC 本身也没有副作用风险，但没必要并发抓两遍）
        setPhase("running");
        setError(null);
        try {
            const r = await diyService.diy.llmConfig.syncModels({});
            setResult(r);
            if (!r.ok) {
                setError(r.error ?? "未知原因");
                setPhase("error");
            } else {
                setPhase("ok");
            }
            opts.onDone?.(r);
        } catch (e) {
            // RPC 层失败（实例断了 / 契约不符）：同样算失败，且**本地数据未改动**
            setError(e instanceof Error ? e.message : String(e));
            setPhase("error");
        }
    };

    /** 一行状态文本（idle 时为空串 —— 不占位、不显示「未更新」这类噪音） */
    const text = (): string => {
        const p = phase();
        if (p === "running") return "更新中…";
        if (p === "ok") {
            const r = result();
            return r ? modelsSyncText(r) : "";
        }
        if (p === "error") return `更新失败：${error() ?? "未知原因"}（本地数据未改动）`;
        return "";
    };

    return { phase, result, error, run, text };
}
