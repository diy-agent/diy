// format.ts — 页面用的纯格式化函数（**零依赖**：renderer 打包会把这些带进浏览器上下文）。
//
// 为什么不放 actions.ts：那边 import @diy-agent/model-catalog（node:fs / js-yaml），
// renderer 的 esbuild 是 `--platform=browser`，带上它整包就编不过（##467 实测）。
import type { AccountStateView, ModelView, SavedAccountView } from "./shared.js";

/** 账号状态的一行文字 —— 只有长度 / 环境引用，永不回显原值 */
export function accountLabel(account: AccountStateView): string {
    if (!account.configured) return "未设置";
    if (account.env) return "已设置（环境变量）";
    if (account.chars !== undefined) return `已设置（${account.chars} 字符）`;
    return "已设置";
}

/** 写后的账号提示（与 accountLabel 同一口径） */
export function savedAccountLabel(saved: SavedAccountView): string {
    return `已设置（${saved.chars} 字符）`;
}

/** 模型限定名 `providerId/modelId`（modelId 自身可含 `/`，反解按第一个 `/`） */
export function modelKeyOf(providerId: string, modelId: string): string {
    return `${providerId}/${modelId}`;
}

/** 把模型按 provider 分组（保持目录顺序） */
export function groupModels(models: readonly ModelView[]): Map<string, ModelView[]> {
    const out = new Map<string, ModelView[]>();
    for (const model of models) {
        const list = out.get(model.providerId) ?? [];
        list.push(model);
        out.set(model.providerId, list);
    }
    return out;
}
