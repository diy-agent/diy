// modelConfig.ts —— 模型配置的**写面**（配置页专用，一共七个动词）。
//
// 为什么单独一个出口、而不是把 store 的 `actions` 放出去：写路径要一条一条设计语义
// （谁审、失败了怎么回滚、写完要不要刷新谁）。这里只放配置页真的需要的几个，
// 并且**每个写完都调 `refreshCatalog()`** —— 不允许出现「配置已经改了、选模型器和顶部横幅还是旧的」
// 这种状态：那正是这一轮要消灭的那类「界面上看着配好了、其实发不出去」。
//
// 形状由 `@diy-agent/protocol` 定（服务端同一份）；回包即整页新快照，调用方直接替换。

import type {
    ModelConfigAccount,
    ModelConfigModel,
    ModelConfigProvider,
    ModelConfigSnapshot,
    ModelCostView,
} from '@diy-agent/protocol';

import { diy2, refreshCatalog } from './store';

export type { ModelConfigAccount, ModelConfigModel, ModelConfigProvider, ModelConfigSnapshot };

/** `saveProvider` 的入参（与 RPC 同一形状；`filter` 里 `null` = 删掉这个键） */
export interface ProviderPatchInput {
    providerId: string;
    /** 配置里还没有这家时指定落在哪个分组（`std` = 目录快照给规格，`custom` = 自定义 spec） */
    kind?: 'std' | 'custom';
    /** 只对 custom 有效：`providers.custom.yaml` 里的 spec */
    spec?: { id?: string; npm?: string; api?: string };
    /** 模型覆盖（`<provider>.models.<modelId>`）：名字 / 上下文 / 价目 */
    models?: Record<string, { name?: string; contextWindow?: number; cost?: ModelCostView }>;
    /** 模型开关；`null` = 删掉这个键（= 全放行） */
    filter?: { include?: string[] | null; exclude?: string[] | null };
}

/** 配置页要的全部操作。每个写方法返回写完之后的整页快照 */
export const modelConfig = {
    read(): Promise<ModelConfigSnapshot> {
        return diy2.models.config();
    },

    /** 手动拉一次 models.dev 目录快照（服务端带 ETag 条件请求），回整页配置 */
    async refreshSnapshot(): Promise<ModelConfigSnapshot> {
        const next = await diy2.models.refreshSnapshot();
        await refreshCatalog();
        return next as ModelConfigSnapshot;
    },

    async saveProvider(input: ProviderPatchInput): Promise<ModelConfigSnapshot> {
        const next = await diy2.models.saveProvider(input);
        await refreshCatalog();
        return next;
    },

    async removeProvider(providerId: string): Promise<ModelConfigSnapshot> {
        const next = await diy2.models.removeProvider(providerId);
        await refreshCatalog();
        return next;
    },

    /** 填 / 换 key。回包只有 `chars`，**原值永远不回来** */
    async saveAccount(input: {
        providerId: string;
        name: string;
        value: string;
        kind?: 'std' | 'custom';
    }): Promise<{ config: ModelConfigSnapshot; saved: { providerId: string; name: string; chars: number } }> {
        const next = await diy2.models.saveAccount(input);
        await refreshCatalog();
        return next;
    },

    async renameAccount(input: { providerId: string; from: string; to: string }): Promise<ModelConfigSnapshot> {
        const next = await diy2.models.renameAccount(input);
        await refreshCatalog();
        return next;
    },

    async removeAccount(input: { providerId: string; name: string }): Promise<ModelConfigSnapshot> {
        const next = await diy2.models.removeAccount(input);
        await refreshCatalog();
        return next;
    },

    /** `null` = 清掉 `defaultModel`（回到「没设」，界面不猜一个） */
    async saveDefaultModel(modelKey: string | null): Promise<ModelConfigSnapshot> {
        const next = await diy2.models.saveDefaultModel(modelKey);
        await refreshCatalog();
        return next;
    },
};
