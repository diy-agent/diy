// admin.ts — bot 管理域（2026-11-05 A3）：**业务规则**，不是页面逻辑。
//
// 从哪里来：原来是 `@diy-agent/bot-config-page/actions.ts` 里的 313 行，
// 页面包里混了三层：
//   ① 参数校验（recordOf / requiredString）      → 留在页面 ✅
//   ② 业务规则（重名、id 生成、模型必填）        → **搬到这里**
//   ③ 能力编排（建会话 + 跑测试对话）            → **搬到这里**
//   ④ 视图转换（BotView / models）               → 留在页面 ✅
//
// 为什么②③该在 core：
//   · 「bot 名字不能重复」是**领域规则**，不是「这个页面怎么显示」；
//     Web 版要同一个规则，不该再实现一遍。
//   · 页面包因此不再依赖 node:fs —— 它的 `.` 入口从「危险 barrel」变成安全的。
//
// 判据：如果一条逻辑换个宿主（Web / CLI / 测试）还要重写，它就不在页面里。

import { loadCatalog, readDefaultModel, type ModelCatalogEntry } from "@diy-agent/model-catalog";
import { localISOString } from "@diy-agent/time";
import { BotError } from "./errors.js";
import { nextBotId } from "./uri.js";
import type { BotConfig, BotStore } from "./types.js";

/** 一行列表数据：身份 + 会话数（页面只做展示转换） */
export interface BotAdminRow {
    readonly config: BotConfig;
    readonly sessionCount: number;
}

export interface BotAdminOptions {
    /** 数据根（`$DIY_HOME`） */
    readonly home: string;
    /** 注入的存储；缺省按 home 建文件实现（与 bot 包其他地方一致） */
    readonly store: BotStore;
    readonly clock?: () => Date;
}

/** 新建 / 更新 bot 的输入（**已校验过形状**，规则由本函数检查） */
export interface BotAdminDraft {
    readonly name: string;
    readonly instructions?: string;
    readonly model?: string | null;
    /** 显式 id（缺省 = `bot-<n>`） */
    readonly id?: string;
}

export interface BotAdmin {
    /** 全部 bot（按存储层顺序）+ 各自的会话数 */
    rows(): Promise<readonly BotAdminRow[]>;
    /** 模型目录（页面直接展示用；读的是 `$DIY_HOME` 下的 models.dev.json） */
    models(): Promise<readonly ModelCatalogEntry[]>;
    defaultModel(): string | null;
    load(id: string): Promise<BotConfig | null>;
    create(draft: BotAdminDraft): Promise<BotConfig>;
    save(id: string, patch: Partial<BotAdminDraft>): Promise<BotConfig>;
    remove(id: string): Promise<void>;
}

/**
 * 组合根（本包的第二个入口，与 `createBotChat` 平级）：
 * 前者是「对话宿主」，这个是「配置管理」。
 *
 * 它们共享同一个 store —— 装配器传同一个进去（##505 的教训：
 * 两个页面各建各的存储 ⇒ 建了看不见）。
 */
export function createBotAdmin(options: BotAdminOptions): BotAdmin {
    const { home, store } = options;
    const now = options.clock ?? (() => new Date());

    let catalogCache: readonly ModelCatalogEntry[] | null = null;
    const catalog = (): readonly ModelCatalogEntry[] => (catalogCache ??= loadCatalog(home));

    /** ##497：model 必填（没有「跟随宿主缺省」这条路） */
    const checkModel = (model: string | null | undefined): string => {
        if (model === null || model === undefined || model.trim() === "") {
            throw new BotError("bot/no-model", "必须先选一个模型");
        }
        const found = catalog().some((entry) => `${entry.providerId}/${entry.modelId}` === model);
        if (!found) throw new BotError("bot/unknown-model", `模型目录里没有 ${model}`);
        return model;
    };

    const rows = async (): Promise<readonly BotAdminRow[]> => {
        const list = await store.list();
        return Promise.all(
            list.map(async (config) => ({ config, sessionCount: (await store.sessionsOf(config.id)).length })),
        );
    };

    const create = async (draft: BotAdminDraft): Promise<BotConfig> => {
        const existing = await store.list();
        if (existing.some((config) => config.name === draft.name)) {
            // 名字只是标签，允许重名会让人分不清谁是谁；id 才是引用键
            throw new BotError("bot/name-taken", `已经有同名 bot「${draft.name}」`);
        }
        const id = draft.id ?? nextBotId(existing.map((config) => config.id));
        if (existing.some((config) => config.id === id)) {
            throw new BotError("bot/id-taken", `bot id 已存在：${id}`);
        }
        const at = localISOString(now());
        const config: BotConfig = {
            id,
            name: draft.name,
            instructions: draft.instructions ?? "",
            // ##497：model **必填**（没有「跟随宿主缺省」这条路）
            model: checkModel(draft.model),
            createdAt: at,
            updatedAt: at,
        };
        await store.save(config);
        return config;
    };

    const save = async (id: string, patch: Partial<BotAdminDraft>): Promise<BotConfig> => {
        const current = await store.load(id);
        if (current === null) throw new BotError("bot/not-found", `没有 bot ${id}`);
        // 未给的字段沿用当前值；给了就必须过校验（model 仍是必填）
        const model = patch.model === undefined ? current.model : checkModel(patch.model);
        const next: BotConfig = {
            id: current.id,
            name: patch.name ?? current.name,
            instructions: patch.instructions ?? current.instructions,
            model,
            // ##498：长期会话 id 也是身份的一部分 —— 改配置不能把它弄丢（否则聊天气泡换一个）
            ...(current.primarySessionId === undefined ? {} : { primarySessionId: current.primarySessionId }),
            ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
            ...(current.maxOutputTokens === undefined ? {} : { maxOutputTokens: current.maxOutputTokens }),
            createdAt: current.createdAt,
            updatedAt: localISOString(now()),
        };
        await store.save(next);
        return next;
    };

    return {
        rows,
        models: async () => catalog(),
        defaultModel: () => readDefaultModel(home),
        load: (id) => store.load(id),
        create,
        save,
        remove: (id) => store.remove(id),
    };
}
