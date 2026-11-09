// src/agent-host.ts
// 🎯 把 Agent 聚合接到 chat 页面用的 `BotChatHost` 接口上（S2）。
//
// 为什么不改 chat-page：它只认 `BotChatHost`（`protocol.ts:189`）这一个契约。
// 于是「新 Agent」可以以**适配器**的身份替换旧宿主（`createBotChat`），页面一行不用改 ——
// 这也让两套实现能并存对照（`DIY_CHAT_AGENT=1` 切换）。
//
// 与 `createBotChat` 的区别（有意为之）：
//   · 会话状态来自 `createAgent` 的**内存聚合 + 快照**，不是 JSONL 回放；
//   · 消息线 = `agent.history()`（投递视图：有 checkpoint 就从它开始）；
//   · 压缩是 agent 的命令（`compact(strategy)`），不是外部算的边界。

import { join } from "node:path";
import type { Agent, AgentPorts, HistoryEntry } from "./aggregate.js";
import { createAgent } from "./aggregate.js";
import { llmPorts, resolveProvider } from "./model-ports.js";
import { filePersist } from "./persist.js";
import type {
    Block,
    BotChatHost,
    BotChatSnapshot,
    BotDraftInput,
    BotUpdateInput,
    BotView,
    ChatMetrics,
    FirstBotInput,
    ModelChoice,
    WireMessage,
} from "./protocol.js";
import type { BotConfig, BotId, BotStore } from "./types.js";

export interface AgentHostOptions {
    /** 数据根（bot 配置、agent 快照都在这下面） */
    readonly home: string
    readonly botStore: BotStore
    /** 模型选择器（由宿主注入，避免把 model-catalog 拉进本包） */
    readonly models: () => readonly ModelChoice[]
    /** 给一个 bot 造 port；缺省 = 按它的 model 解析真 provider */
    readonly portsFor?: (bot: BotConfig) => AgentPorts
    /** 每个 bot 的快照目录；缺省 `<home>/agents/<botId>` */
    readonly dirFor?: (botId: BotId) => string
}

/** 历史条目 → 一条展示消息（checkpoint 用自造 kind，走 UI 的 fallback 渲染器） */
export function wireMessageOf(e: HistoryEntry): WireMessage {
    const role: WireMessage["role"] = e.role === "assistant" ? "assistant" : "user"
    const kind = e.kind === "checkpoint" ? "checkpoint" : "text"
    const blocks: Block[] = [{ kind, id: `seq-${e.seq}`, data: { text: e.content ?? "" } }]
    return { role, blocks }
}

export function createAgentHost(opts: AgentHostOptions): BotChatHost {
    const agents = new Map<BotId, Agent>()
    let active: BotId | null = null

    const dirFor = opts.dirFor ?? ((id: BotId) => join(opts.home, "agents", id))
    const portsFor = opts.portsFor ?? ((bot: BotConfig) => llmPorts(resolveProvider(opts.home, bot.model)))

    /** 该 bot 模型的窗口上限（模型目录里有 contextWindow 才算；没有 ⇒ null = 永不自动压） */
    const windowOf = (bot: BotConfig): number | null => {
        for (const c of opts.models()) {
            const key = `${c.account === undefined ? "" : `${c.account}@`}${c.providerId}/${c.modelId}`
            if (key === bot.model) return c.contextWindow ?? null
        }
        return null
    }

    const agentOf = (bot: BotConfig): Agent => {
        const hit = agents.get(bot.id)
        if (hit) return hit
        const created = createAgent({
            id: bot.id,
            ports: portsFor(bot),
            persist: filePersist(dirFor(bot.id)),
            autoCompact: { windowTokens: windowOf(bot) },
        })
        agents.set(bot.id, created)
        return created
    }

    const viewOf = async (bot: BotConfig): Promise<BotView> => ({
        id: bot.id,
        name: bot.name,
        instructions: bot.instructions,
        model: bot.model,
        needsModel: bot.model === "" || bot.needsModel === true,
        ...(bot.reasoningEffort === undefined ? {} : { reasoningEffort: bot.reasoningEffort }),
        sessionCount: (await opts.botStore.sessionsOf(bot.id)).length,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
    })

    /** 当前选中的 bot 配置（没有 bot ⇒ null） */
    const currentBot = async (): Promise<BotConfig | null> => {
        const all = await opts.botStore.list()
        if (all.length === 0) return null
        const picked = active === null ? undefined : all.find((b) => b.id === active)
        const bot = picked ?? all[0]!
        active = bot.id
        return bot
    }

    const snapshot = async (): Promise<BotChatSnapshot> => {
        const all = await opts.botStore.list()
        const bots = await Promise.all(all.map(viewOf))
        const bot = await currentBot()
        if (bot === null) {
            return { bots: [], bot: null, models: opts.models(), messages: [], metrics: null, selectedModel: null }
        }
        const agent = agentOf(bot)
        const messages = agent.history().map(wireMessageOf)
        const st = agent.snapshot()
        const metrics: ChatMetrics = { turns: st.turns }
        return {
            bots,
            bot: await viewOf(bot),
            models: opts.models(),
            messages,
            metrics,
            selectedModel: bot.model === "" ? (opts.models()[0]?.modelId ?? null) : bot.model,
        }
    }

    const touch = async (bot: BotConfig, patch: Partial<BotConfig>): Promise<BotConfig> => {
        const next: BotConfig = { ...bot, ...patch, updatedAt: new Date().toISOString() }
        await opts.botStore.save(next)
        return next
    }

    return {
        snapshot,

        async createFirstBot(input: FirstBotInput): Promise<BotChatSnapshot> {
            const existing = await opts.botStore.list()
            if (existing.length > 0) throw new Error("已经有 bot 了，不允许再走首启建号")
            const now = new Date().toISOString()
            const bot: BotConfig = {
                id: "bot_1",
                name: input.name ?? "bot 1",
                instructions: input.instructions ?? "",
                model: input.model,
                createdAt: now,
                updatedAt: now,
            }
            await opts.botStore.save(bot)
            active = bot.id
            return snapshot()
        },

        async createBot(input: BotDraftInput): Promise<BotChatSnapshot> {
            const existing = await opts.botStore.list()
            const now = new Date().toISOString()
            // id 用递增序号，避免靠时间戳撞名；已存在的跳过
            let n = existing.length + 1
            while (existing.some((b) => b.id === `bot_${n}`)) n += 1
            const bot: BotConfig = {
                id: `bot_${n}`,
                name: input.name,
                instructions: "",
                model: input.model,
                createdAt: now,
                updatedAt: now,
            }
            await opts.botStore.save(bot)
            active = bot.id
            return snapshot()
        },

        async updateBot(input: BotUpdateInput): Promise<BotChatSnapshot> {
            const bot = await opts.botStore.load(input.id)
            if (bot === null) throw new Error(`没有这个 bot：${input.id}`)
            const patch: Partial<BotConfig> = {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
                ...(input.model === undefined ? {} : { model: input.model }),
                ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
            }
            const next = await touch(bot, patch)
            // 模型变了 ⇒ 旧 agent 的 port 还是旧模型，丢掉让它按新配置重建（快照仍在盘上，不丢历史）
            if (next.model !== bot.model) agents.delete(bot.id)
            return snapshot()
        },

        async removeBot(id: string): Promise<BotChatSnapshot> {
            await opts.botStore.remove(id)
            agents.delete(id)
            if (active === id) active = null
            return snapshot()
        },

        async selectBot(id: string): Promise<BotChatSnapshot> {
            active = id
            return snapshot()
        },

        async send(text: string, onDelta): Promise<BotChatSnapshot> {
            const bot = await currentBot()
            if (bot === null) throw new Error("还没有 bot，无法发送")
            const agent = agentOf(bot)
            const receipt = await agent.send({ content: text })
            if (!receipt.accepted) throw new Error(receipt.error?.message ?? "命令被拒绝")
            // 推中间态：轮询内存状态（聚合是同步可读的，比订阅更省一条通道）
            for (;;) {
                onDelta(agent.history().map(wireMessageOf))
                if (!agent.snapshot().running) break
                await new Promise((r) => setTimeout(r, 30))
            }
            onDelta(agent.history().map(wireMessageOf))
            return snapshot()
        },
    }
}
