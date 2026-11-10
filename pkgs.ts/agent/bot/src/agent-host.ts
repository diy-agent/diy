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
import type { TrafficPort } from "@diy-agent/llm-provider";
import type { Agent, AgentPorts, HistoryEntry } from "./aggregate.js";
import { createAgent } from "./aggregate.js";
import { llmPorts, resolveProvider } from "./model-ports.js";
import { filePersist } from "./persist.js";
import type {
    Block,
    CompactInfo,
    BotChatHost,
    BotChatSnapshot,
    BotDraftInput,
    BotUpdateInput,
    BotView,
    ChatMetrics,
    FirstBotInput,
    ModelChoice,
    ModelChoices,
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
    /**
     * 给一个 bot 算 system 段（##530）：**每次建 agent 时算一次**，之后每轮原样带上。
     *
     * 不传 = 没有 system（测试 / 无上下文场景）。装配层（`apps/chat`）在这里接
     * AGENTS.md 链 / 知识库 / 技能 —— 那些 provider 必须在建会话时就位，否则
     * 老会话永远补不上（`initialMessages` 判据那个坑，见 `agent.ts` 的注释）。
     */
    readonly systemFor?: (bot: BotConfig) => string
    /**
     * 流量端口（##534）：交给 `llm-provider` 的 fetch 包装，每次真发记一条。
     * 不传 = 不记（测试 / 无观测场景）。传了必须永不抛。
     */
    readonly traffic?: TrafficPort
    /** 每个 bot 的快照目录；缺省 `<home>/agents/<botId>` */
    readonly dirFor?: (botId: BotId) => string
    /**
     * 每个 bot 的工具集（ai-sdk ToolSet）；缺省不给 = 纯对话。
     * 工具执行归 provider/ai-sdk，聚合只记账（见 `AgentPorts.complete` 的注释）。
     */
    readonly toolsFor?: (bot: BotConfig) => unknown
}

/** 历史条目 → 一条展示消息（checkpoint 用自造 kind，走 UI 的 fallback 渲染器） */
export function wireMessageOf(e: HistoryEntry): WireMessage {
    // 工具类条目映射到 UI 的**内置** `tool` 块（chat-page 的 block-renderers 认识它），
    // 这样工具调用/结果能直接显示成折叠块，而不是一坨 JSON。
    if (e.kind === "tool-call" || e.kind === "tool-result") {
        const isCall = e.kind === "tool-call"
        return {
            role: e.role === "tool" ? "user" : "assistant",
            blocks: [
                {
                    kind: "tool",
                    id: `seq-${e.seq}`,
                    data: {
                        name: isCall ? (e.tool?.name ?? e.content ?? "") : "tool result",
                        args: isCall ? (e.tool?.input ?? "") : "",
                        state: isCall ? "running" : "ok",
                        summary: isCall ? (e.tool?.name ?? "") : (e.content ?? "").slice(0, 80),
                        output: isCall ? "" : (e.content ?? ""),
                    },
                },
            ],
        }
    }
    const role: WireMessage["role"] = e.role === "assistant" ? "assistant" : "user"
    const kind = e.kind === "checkpoint" ? "checkpoint" : "text"
    const blocks: Block[] = [{ kind, id: `seq-${e.seq}`, data: { text: e.content ?? "" } }]
    return { role, blocks }
}

export function createAgentHost(opts: AgentHostOptions): BotChatHost {
    const agents = new Map<BotId, Agent>()
    let active: BotId | null = null

    const dirFor = opts.dirFor ?? ((id: BotId) => join(opts.home, "agents", id))
    const portsFor =
        opts.portsFor ??
        ((bot: BotConfig) =>
            llmPorts(resolveProvider(opts.home, bot.model, opts.traffic), {
                // 会话亲和键：优先用 bot 的长期会话 id（与 chat.ts 同口径），退回 bot id
                sessionId: bot.primarySessionId ?? `bot:${bot.id}`,
            }))

    /**
     * 该 bot 对应的模型目录项（找不到 = undefined）。
     *
     * `models` 由调用方传进来：模型目录是**每个 bot 算一次就够**的东西，
     * 之前这里每问一次就重算一遍（窗口 / 价目 / 列表各一次 ⇒ 一次切 bot 算 3 遍，##526 实测 400+ ms）。
     */
    const choiceOfIn = (models: readonly ModelChoice[], bot: BotConfig) => {
        for (const c of models) {
            const key = `${c.account === undefined ? "" : `${c.account}@`}${c.providerId}/${c.modelId}`
            if (key === bot.model) return c
        }
        return undefined
    }

    /** 该 bot 模型的窗口上限（模型目录里有 contextWindow 才算；没有 ⇒ null = 永不自动压） */
    const windowOfIn = (models: readonly ModelChoice[], bot: BotConfig): number | null => {
        for (const c of models) {
            const key = `${c.account === undefined ? "" : `${c.account}@`}${c.providerId}/${c.modelId}`
            if (key === bot.model) return c.contextWindow ?? null
        }
        return null
    }

    /**
     * 该 bot 的「模型事实」（窗口上限 + 价目）：**建 agent 时算一次，之后复用**。
     *
     * ##526：bot 列表 / 底部指标跟模型目录没关系 —— 模型变了才需要重算
     * （`updateBot` 改 model 时清掉，下次建 agent 再算）。
     */
    interface ModelFacts {
        readonly windowTokens: number | null
        readonly cost?: ModelChoice["cost"]
    }
    const facts = new Map<BotId, ModelFacts>()
    const factsFor = (bot: BotConfig): ModelFacts => {
        const hit = facts.get(bot.id)
        if (hit !== undefined) return hit
        const models = opts.models()
        const choice = choiceOfIn(models, bot)
        const value: ModelFacts = {
            windowTokens: windowOfIn(models, bot),
            ...(choice?.cost === undefined ? {} : { cost: choice.cost }),
        }
        facts.set(bot.id, value)
        return value
    }

    const agentOf = (bot: BotConfig): Agent => {
        const hit = agents.get(bot.id)
        if (hit) return hit
        const system = opts.systemFor?.(bot)
        const created = createAgent({
            id: bot.id,
            ...(system === undefined || system === '' ? {} : { system }),
            ports: portsFor(bot),
            persist: filePersist(dirFor(bot.id)),
            autoCompact: { windowTokens: factsFor(bot).windowTokens },
            ...(opts.toolsFor === undefined ? {} : { tools: opts.toolsFor(bot) }),
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
        // ##526：快照里**不含模型目录**（那是「配模型」才发现的东西，见 ModelChoices 的注释）。
        // 窗口 / 价目走 factsFor 的每 bot 缓存 —— 模型没变就不碰 model.yaml / models.dev.json。
        const all = await opts.botStore.list()
        const bots = await Promise.all(all.map(viewOf))
        const bot = await currentBot()
        if (bot === null) {
            return { bots: [], bot: null, messages: [], metrics: null }
        }
        const agent = agentOf(bot)
        const messages = agent.history().map(wireMessageOf)
        const st = agent.snapshot()
        const fact = factsFor(bot)
        const w = fact.windowTokens
        // 本轮花费（USD）：按模型目录的价目算；目录没价目 ⇒ 缺席（**不写 0**，那会被当成"免费"）。
        // 口径与 diy-app 一致：input 含缓存读（模型只有 input/output 两档价目时就这么算，偏保守）。
        const rates = fact.cost
        const cost =
            rates === undefined || st.usage === undefined
                ? undefined
                : (st.usage.inputTokens / 1e6) * rates.input + (st.usage.outputTokens / 1e6) * rates.output
        const metrics: ChatMetrics = {
            turns: st.turns,
            ...(st.usage === undefined
                ? {}
                : {
                      inputTokens: st.usage.inputTokens,
                      outputTokens: st.usage.outputTokens,
                      ...(st.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: st.usage.cacheReadTokens }),
                  }),
            ...(w === null ? {} : { contextWindow: w }),
            ...(cost === undefined ? {} : { cost }),
        }
        return { bots, bot: await viewOf(bot), messages, metrics }
    }

    const touch = async (bot: BotConfig, patch: Partial<BotConfig>): Promise<BotConfig> => {
        const next: BotConfig = { ...bot, ...patch, updatedAt: new Date().toISOString() }
        await opts.botStore.save(next)
        return next
    }

    return {
        snapshot,

        /** 模型目录：**按需拉**（配模型 / 新建 bot 时）。不进快照，见 protocol.ts 的 ModelChoices */
        async models(): Promise<ModelChoices> {
            const choices = opts.models()
            const first = choices[0]
            return {
                choices,
                defaultModel:
                    first === undefined
                        ? null
                        : `${first.account === undefined ? '' : `${first.account}@`}${first.providerId}/${first.modelId}`,
            }
        },

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
            if (next.model !== bot.model) {
                agents.delete(bot.id)
                facts.delete(bot.id)
            }
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

        async compactInfo(): Promise<CompactInfo> {
            const bot = await currentBot()
            if (bot === null) return { rounds: [], droppedCount: 0 }
            const agent = agentOf(bot)
            const all = agent.history({ raw: true }).filter((e) => e.kind === "message" || e.kind === "checkpoint")
            const delivered = new Set(agent.history().map((e) => e.seq))
            // 轮 = 一条 user +（可选）其后的 assistant；checkpoint 不算轮
            // 一轮 = 一条 user 消息（assistant 跟着它）——**只按 user 计轮**。
            // 之前用「隔一条取一条」，一旦有 checkpoint/通知就错位（实测出现 轮3→轮5→轮7）。
            // **只列还能保留的轮**（已压掉的选不回来，列出来会让读数自相矛盾 ——
            // 实测出现「保留最近 29 / 29 轮（已压掉 27 轮）」）。标签用绝对轮号，方便对上原文。
            const allUser = all.filter((e) => e.kind === "message" && (e.role === "user" || e.role === undefined))
            const keptRows = allUser
                .map((e, i) => ({ e, i }))
                .filter(({ e }) => delivered.has(e.seq))
                .map(({ e, i }) => ({
                    label: `轮${i + 1}`,
                    title: (e.content ?? "").replace(/\s+/g, " ").slice(0, 40),
                    kept: true,
                }))
            const w = factsFor(bot).windowTokens
            return {
                rounds: keptRows,
                droppedCount: allUser.length - keptRows.length,
                ...(w === null ? {} : { windowTokens: w }),
                usedTokens: undefined,
            }
        },

        async compact(keepRounds: number): Promise<BotChatSnapshot> {
            const bot = await currentBot()
            if (bot === null) throw new Error("还没有 bot，无法压缩")
            const agent = agentOf(bot)
            const r = await agent.compact({ kind: "keepTurns", turns: Math.max(0, keepRounds) })
            if (!r.accepted) throw new Error(r.error?.message ?? "压缩被拒绝")
            return snapshot()
        },

        async send(text: string, onDelta): Promise<BotChatSnapshot> {
            const bot = await currentBot()
            if (bot === null) throw new Error("还没有 bot，无法发送")
            const agent = agentOf(bot)
            const turnsBefore = agent.snapshot().turns
            const receipt = await agent.send({ content: text })
            if (!receipt.accepted) throw new Error(receipt.error?.message ?? "命令被拒绝")
            /**
             * 等这一轮**真的跑完**再返回。
             *
             * 不能只看 `running`：`send` 只是把轮次排进串行队列，`running` 要等队列轮到它才置真；
             * 之前直接在循环第一拍读 `running`（false）就退出了 ⇒ 界面只看到用户消息、永远等不到回答
             * （用户实测「发了消息都没回复」）。改为「见过 running 再等它落」或「turns 增加」两条判据。
             */
            let sawRunning = false
            const deadline = Date.now() + 180_000
            for (;;) {
                const st = agent.snapshot()
                if (st.running) sawRunning = true
                onDelta(agent.history().map(wireMessageOf))
                if (sawRunning && !st.running) break
                if (!sawRunning && st.turns > turnsBefore) break
                if (Date.now() > deadline) throw new Error("发送超时：这一轮 180s 内没有结束")
                await new Promise((r) => setTimeout(r, 30))
            }
            onDelta(agent.history().map(wireMessageOf))
            const failed = agent.takeFailure()
            if (failed !== undefined) throw new Error(failed)
            return snapshot()
        },
    }
}
