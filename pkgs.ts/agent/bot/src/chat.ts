// chat.ts — bot 对话宿主：把「一个 bot 一个长期会话」这件事做成可直接注入界面的端口。
//
// ##505 的边界（与 apps/chat 拆开）：
//   · **bot 领域逻辑**住这里：首启建 bot / 建 bot / 改配置 / 删 bot / 切 bot、对话编排
//     （`send`）、快照（`snapshot`）、模型解析、会话标题。
//   · **会话只是内部技术**：没有「会话列表 / 新建会话」—— UI 看到的是 bot，点进去就是
//     它的长期会话（`bot.primary()` 懒创建 + 幂等，id 写回 bot.json）。
//   · **成本计算**不在这里：价目表与算价都在 @diy-agent/model-catalog（`costOf`）。
//
// ##498（沿用）：左栏是 bot（`<home>/bots/<id>/bot.json`）；会话本体在
// `<home>/sessions/chat/<id>/`（meta.json + session-store 的桶）；bots 为空 ⇒ snapshot.bot = null
// （UI 走首启引导）；模型是 bot 身份的一部分。
//
// ##505-B：不再写 `<home>/chat-ui.json`（它只存「上次选中的 bot」—— 没有会话列表就不需要
// 持久化这个界面状态；本次进程内记住，重启回落到第一个 bot）。
//
// ##480（store 方向）：会话缺省存储是**内存**，所以装配器必须**显式**注入具体 store ——
// 缺省用内存（2026-11-05：只有 model / bot 配置落盘）；`persist: true` 才换成 jsonl。
//
// 并发（docs/plans/2026-11-02-concurrency-actor.md）：单实例 = 单 actor。
//   · 所有改状态的操作（读—改—写）排进同一条队列（`createSerial`），一次跑一个
//   · 纯读（snapshot）不排队
//   · 消息按会话各排一条队列（同一会话两条 send 串行；不同会话互不阻塞）

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { localISOString } from "@diy-agent/time";
import { createSession, type AgentSession, type ChatMessage, type LlmPort, type SessionStore, type TokenUsage } from "@diy-agent/session";
import { openJsonlSessionStore } from "@diy-agent/session-store-jsonl";
import { openMemorySessionStore } from "@diy-agent/session";
import { agentsChain } from "@diy-agent/agents-chain";
import { kbRootOf, scanKb } from "@diy-agent/kb";
import { skillsOf } from "@diy-agent/skills";
import { homedir } from "node:os";
import { createBotAgent, type BotAgent } from "./agent.js";
import { createOpenAiCompatible, resolveProviderConfig } from "@diy-agent/llm-provider";
import {
    costOf,
    listAccountStates,
    loadCatalog,
    readAccountValue,
    type ModelCatalogEntry,
} from "@diy-agent/model-catalog";
import { toolArgsFromInput } from "@diy-agent/session";
import { createBot, createFirstBot as createFirstBotIn, newSessionId } from "./bot.js";
import { nextBotId } from "./uri.js";
import {
    applyPriorBoundary,
    createBotCompactor,
    type BotCompactionState,
    type BotCompactor,
} from "./compaction.js";
import { buildSystemContext } from "./system-context.js";
import { runToolCalls, type BotToolSet, type PendingToolCall } from "./tools.js";
import type { Bot, BotConfig, BotStore } from "./types.js";
import { createFileBotStore } from "./store-fs.js";
import {
    wireOf,
    type BotChatHost,
    type BotChatSnapshot,
    type BotDraftInput,
    type BotUpdateInput,
    type BotView,
    type ChatMetrics,
    type FirstBotInput,
    type ModelChoice,
    type ModelChoices,
    type WireMessage,
    type CompactInfo,
} from "./protocol.js";

/** `meta.json` 的形状（会话自己的身份；消息正文在桶里） */
interface SessionMeta {
    readonly id: string;
    readonly title: string;
    /** 模型限定名 `providerId/modelId` */
    readonly model: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly messageCount: number;
}

/** 上一步的用量（底部指标条的「输入 / 缓存 / 本轮」都取这一步，不是会话累计） */
interface StepUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
}

/**
 * 首启草案的**缺省名字 / 指令**（##497）。
 *
 * 注意没有 model：模型必须人来选，不给缺省 —— 以前 `DEFAULT_BOT` 静默建 bot 正是
 * 「用户从没选过模型却已经在聊」的病因。
 */
export const FIRST_BOT_DRAFT = {
    id: "bot-1",
    name: "大王助手",
    instructions: "你是「大王助手」，在 diy 的聊天窗口里陪大王干活。回答要短、要具体，能查证的不靠猜。",
} as const;

/**
 * 写进 system 的「工作目录说明」（##514 第 5 步，用户 2026-11-04 裁：**不设权限限制**）。
 *
 * 只说三件事：cwd 在哪、相对路径怎么解析、临时产物别丢在别人的仓里。
 * 刻意不写「你只能访问这里」—— 工具仍可读写任何路径，那才是它能干活的前提。
 */
export function workspaceOf(home: string, botId: string): string {
    return `${home}/bots/${botId}/workspace`;
}

function workspaceNote(home: string, botId: string): string {
    if (home === "") return "";
    const dir = workspaceOf(home, botId);
    return [
        `你的工作目录是 ${dir}。`,
        "相对路径按它解析，shell 命令默认在这里执行；目录不存在时先建。",
        "这不是权限边界：你仍可以读写任何路径。但新建文件、试验脚本、下载物默认放工作目录里，",
        "不要在主仓或用户的项目目录里留临时产物。",
        // 实测（2026-11-04）：deepseek 会把 `bash` 写成 `Bash`（学 Claude 的命名），
        // 于是 ai-sdk 直接抛 NoSuchToolError，整轮变成「没反应」。点明一下成本最低。
        "调用工具时工具名**一律小写**（`bash` / `read` / `write` / `edit` / `job`），不要写成 `Bash`。",
    ].join("");
}

export interface BotChatOptions {
    /** 数据根（`$DIY_HOME`） */
    readonly home: string;
    /** bot 身份存储；缺省 = `createFileBotStore({ home, sessionsDir })` */
    readonly botStore?: BotStore;
    /** 会话目录根；缺省 `<home>/sessions/chat` */
    readonly sessionsDir?: string;
    /**
     * **落盘总开关（缺省 false = 纯内存）**。
     *
     * 用户 2026-11-05：「除了 model 配置、bot 配置，其他都要内存化版本，就是为了甩掉包袱」。
     * 所以缺省只落两样：`model.yaml`（不在本包）与 `bots/<id>.json`（`botStore`）。
     * 会话历史 / meta / 压缩状态**全在进程里**，重启即清零。
     *
     * 要文件版（对照验证 / 排障）显式给 `persist: true` —— 两者可交替使用。
     */
    readonly persist?: boolean;
    /**
     * 会话存储工厂（按会话 id 打开；同一条会话反复进来必须拿到**同一个** store 实例）。
     * 缺省跟随 `persist`：false ⇒ 内存 store；true ⇒ `openJsonlSessionStore({ dir })`。
     */
    readonly openSessionStore?: (sessionId: string, dir: string) => Promise<SessionStore> | SessionStore;
    /**
     * 会话 meta（`meta.json`：标题 / 模型 / 消息数）是否落盘；缺省 true。
     * 内存入口传 false —— 连 meta 都不写，`$DIY_HOME/sessions` 一个字节不碰（判据：mtime 不变）。
     */
    readonly persistMeta?: boolean;
    /** 建 LLM 端口（测试注入假实现；缺省 = 真 provider，key 从 readAccountValue 取） */
    readonly llmFor?: (modelKey: string) => LlmPort;
    /**
     * 工具集**工厂**（##514 第 5 步；缺省 = 不装工具，纯对话）。
     *
     * 为什么是工厂而不是固定对象：一个宿主可能管多个 bot，每个 bot 有**自己的 cwd**
     * （`$DIY_HOME/bots/<id>/workspace/`）。传固定对象等于所有 bot 共用一个目录。
     *
     * 装配器示例：`toolsFor: (botId) => buildTools({ cwd: workspaceOf(botId) })`
     */
    readonly toolsFor?: (botId: string) => BotToolSet | undefined;
    /**
     * 工具循环的**工具步上限**（缺省 20）。计数单位 = 「执行了工具的那几步」，
     * 不是「LLM 调用次数」（后者 = 步数 + 1：最后一步不再调工具）。
     */
    readonly maxToolSteps?: number;
    /** 快照超时（毫秒，缺省 2000）：超时返回上一次成功快照，避免一个卡住的会话拖死整个 UI */
    readonly snapshotTimeoutMs?: number;
}

/** 把 `providerId/modelId` 切开（模型 id 自身可含 `/`，按第一个 `/` 切） */
/**
 * 拆 `account@provider/model` → 三段。
 *
 * 照抄 diy-app 的 `splitQualified`（shared/model-config.ts:678）——
 * **provider 段里最后一个 `@` 切 account**。之前 bot 只切 `/`，
 * 于是 `aug@opencode-go/deepseek-v4.1-flash` 的 provider 被当成
 * `aug@opencode-go`，`readAccountValue` 找不到 provider、也永远拿不到正确的 key。
 *
 * 无 `@` 时 account 为 undefined（裸 provider 的老写法仍可用）。
 */
export function splitModelKey(key: string): { account?: string; providerId: string; modelId: string } {
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) return { providerId: key, modelId: "" };
    const providerSeg = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    const at = providerSeg.lastIndexOf("@");
    if (at <= 0) return { providerId: providerSeg, modelId };
    return { account: providerSeg.slice(0, at), providerId: providerSeg.slice(at + 1), modelId };
}

/** 新 bot id：`bot-<n>`，n = 现有 `bot-<数字>` 的最大值 + 1（人可读） */
/**
 * 单实例 = 单 actor（docs/plans/2026-11-02-concurrency-actor.md）。
 *
 * 一个宿主一份队列：所有会**改变状态**的操作（读—改—写）排进来，一次跑一个。
 * 纯读（snapshot）不排队 —— 读不需要互斥，只要写是串行的。
 *
 * `tail` 永远指向「最后一个入队的操作」，且**吞掉失败**（前一个抛错，下一个照常跑）。
 */
export type Serial = <T>(fn: () => Promise<T>) => Promise<T>;

export function createSerial(): Serial {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const next = tail.then(fn, fn);
        tail = next.catch(() => {});
        return next;
    };
}

/** 建一个 bot 对话宿主（懒打开：第一次调用才读目录 / 建目录） */
/** 技能节点的结构说明（与 `@diy-agent/skills` 的 provider 同一份） */
const SKILLS_HELP = {
    type: "array",
    desc: "技能清单（空则整节跳过）",
    items: {
        name: { type: "string", desc: "技能名" },
        desc: { type: "string", desc: "说明（含触发词）" },
        path: { type: "string", desc: "SKILL.md 路径（要看全文就 read 它）" },
    },
};

/** AGENTS.md 链的节点说明 */
const CHAIN_HELP = {
    type: "array",
    desc: "AGENTS.md 链（逐层，从最外层到最深处）",
    items: {
        path: { type: "string", desc: "AGENTS.md 路径" },
        scope: { type: "string", desc: "生效目录" },
        content: { type: "string", desc: "正文" },
    },
};

/** 知识库节点的说明 */
const KB_HELP = {
    type: "object",
    desc: "知识库索引（md 文件；要内容直接读那个文件）。项目库优先、全局库兜底",
    entries: {
        type: "array",
        desc: "每个 md 一条（按路径排序）；空则整节跳过",
        items: {
            path: { type: "string", desc: "相对知识库根的路径" },
            desc: { type: "string", desc: "这个文件讲什么" },
            sections: { type: "number", desc: "多少个 ## 小节" },
            scope: { type: "string", desc: "project / global" },
        },
    },
};

/**
 * 知识库两层合并（与 diy-app 的 `kbProvider` 同判据）。
 *
 * 为什么不在 `@diy-agent/kb` 里给一个 `mergedKbOf`：那边是纯数据，宿主才知道
 * 「项目库在哪、全局库在哪」；两处各写一遍的是**同一个规则**（项目覆盖全局），
 * 判据相同、实现 10 行，比多一个跨包抽象便宜。
 */
function botKb(cwd: string, home: string): unknown {
    const roots = [
        { dir: kbRootOf(cwd), scope: "project" },
        { dir: join(home, "knowledge"), scope: "global" },
    ];
    const byPath = new Map<string, { path: string; desc: string; sections: number; scope: string }>();
    for (const { dir, scope } of [...roots].reverse()) {
        for (const e of scanKb(dir).entries) {
            byPath.set(e.path, { path: e.path, desc: e.desc, sections: e.sections, scope });
        }
    }
    if (byPath.size === 0) return undefined;
    return { entries: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export function createBotChat(options: BotChatOptions): BotChatHost {
    const home = options.home;
    const root = options.sessionsDir ?? join(home, "sessions", "chat");
    // bot 身份在 `<home>/bots/`；会话归属落在会话自己的目录里（方案 B）
    const botStore = options.botStore ?? createFileBotStore({ home, sessionsDir: root });
    const persist = options.persist ?? false;
    const openSessionStore =
        options.openSessionStore ??
        (persist
            ? (_id: string, dir: string) => openJsonlSessionStore({ dir })
            : () => openMemorySessionStore());
    /** 内存模式：meta 也只活在进程里（不写 `sessions/chat/<id>/meta.json`） */
    const persistMeta = options.persistMeta ?? persist;
    const metaMemory = new Map<string, SessionMeta>();

    let catalogCache: ModelCatalogEntry[] | null = null;
    /** 「上次选中的 bot」只活在本次进程里（##505-B：不落 chat-ui.json） */
    let activeBotId: string | null = null;

    /** 打开中的会话（桶 + session 都缓存；同一个 bot 反复点进来必须是同一条消息线） */
    const open = new Map<
        string,
        { store: SessionStore; session: AgentSession; agent: BotAgent; meta: SessionMeta; compactor: BotCompactor }
    >();
    /** 内存模式下的压缩状态（persistMeta=false 时也只在进程里） */
    const compactMemory = new Map<string, BotCompactionState>();
    /**
     * 快照守卫：**读不该被写卡死**。
     *
     * 实测（用户 2026-11-04）：某个 bot 的模型调用挂住（无超时）⇒ 它的会话队列一直占着；
     * 更糟的是快照也要过 `act` 队列，于是「其他 bot 也进不去」——UI 整片失灵。
     *
     * 取舍：超时（缺省 2s）就返回**上一次成功快照**，并标明 stale。宁可给人看旧数据，
     * 也不能让人对着一个永远转圈的界面。下一次刷新若能拿到新数据，自然恢复。
     */
    let lastSnapshot: BotChatSnapshot | null = null;
    const withSnapshotGuard = async (run: () => Promise<BotChatSnapshot>): Promise<BotChatSnapshot> => {
        const timeoutMs = options.snapshotTimeoutMs ?? 2000;
        const raced = await Promise.race([
            run().then((snap) => ({ ok: true as const, snap })),
            new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), timeoutMs)),
        ]);
        if (raced.ok) {
            lastSnapshot = raced.snap;
            return raced.snap;
        }
        if (lastSnapshot !== null) return lastSnapshot;
        // 一次都没成功过：给一个不撒谎的空壳（UI 会显示「正在读取…」而不是白屏）
        throw new Error(`快照超时（${timeoutMs}ms）且尚无可用快照`);
    };

    /** 每个会话「上一步」的用量（进程内；重启后指标为空 — 不编数字） */
    const lastStep = new Map<string, StepUsage>();
    /** 状态操作的队列（bot 增删改 / 选中 / meta 落盘）—— 单实例顺序执行 */
    const act = createSerial();
    /** 每个会话一条消息队列：同一会话的两条 send 也串行（不同会话互不阻塞） */
    const messageQueues = new Map<string, Serial>();
    const queueFor = (sessionId: string): Serial => {
        const hit = messageQueues.get(sessionId);
        if (hit !== undefined) return hit;
        const queue = createSerial();
        messageQueues.set(sessionId, queue);
        return queue;
    };

    const catalog = (): ModelCatalogEntry[] => (catalogCache ??= loadCatalog(home));

    /**
     * 可选模型 = **provider × account × model** 的展开（diy-app 的三段式）。
     *
     * 为什么必须展开 account：`model.yaml` 里一个 provider 可以有多个账号（aug / chen56 …），
     * key 与配额各不相同。只列 provider/model 时用户无法表达「用 aug 这个账号」，
     * 取 key 时就只能拿第一个 —— 实测这会表现成「上游不回应 / 超时」。
     *
     * 只展开**已配置**的账号（`configured`）；一个都没配的 provider 退回裸 provider/model 一项。
     */
    const choices = (): ModelChoice[] => {
        const accountsByProvider = new Map(
            listAccountStates(home).map((p) => [
                p.providerId,
                p.accounts.filter((a) => a.configured).map((a) => a.name),
            ]),
        );
        const out: ModelChoice[] = [];
        for (const entry of catalog()) {
            const base = {
                providerId: entry.providerId,
                modelId: entry.modelId,
                ...(entry.cost === undefined ? {} : { cost: entry.cost }),
                ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            };
            const accounts = accountsByProvider.get(entry.providerId) ?? [];
            if (accounts.length === 0) {
                out.push({ ...base, name: entry.name });
                continue;
            }
            for (const account of accounts) {
                // name 保持**纯模型名**：account 由 UI 拼在 provider 前面（否则显示成
                // 「chen56@deepseek · chen56@DeepSeek V4.1 Flash」—— account 出现两次）
                out.push({ ...base, account, name: entry.name });
            }
        }
        return out;
    };

    /** 模型 key：`account@provider/model`（无 account 时退回 `provider/model`） */
    const keyOf = (entry: ModelCatalogEntry | null, account?: string): string =>
        entry === null
            ? ""
            : `${account === undefined ? "" : `${account}@`}${entry.providerId}/${entry.modelId}`;

    const writeMeta = async (meta: SessionMeta): Promise<void> => {
        if (!persistMeta) {
            metaMemory.set(meta.id, meta);
            return;
        }
        const dir = join(root, meta.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 4)}\n`, "utf-8");
    };

    const readMetaOf = async (id: string): Promise<SessionMeta | null> =>
        persistMeta ? readMeta(join(root, id)) : (metaMemory.get(id) ?? null);

    const llmFor = (modelKey: string): LlmPort => {
        if (options.llmFor !== undefined) return options.llmFor(modelKey);
        const { account, providerId, modelId } = splitModelKey(modelKey);
        const entry = catalog().find((item) => item.providerId === providerId && item.modelId === modelId);
        if (entry === undefined) {
            throw new Error(`模型目录里没有 ${modelKey}（model.yaml / providers.custom.yaml 可能变了）`);
        }
        // account 必须传下去：model.yaml 里一个 provider 可以有多个账号（aug / chen56 / …），
        // 不传就取了第一个 —— key 不对，上游要么 401 要么一直不回应（实测：超时）。
        const apiKey = readAccountValue(home, providerId, account);
        try {
            // 已知 provider：拿 provider 表的默认 endpoint / 会话 header
            return createOpenAiCompatible(
                resolveProviderConfig({ provider: providerId, apiKey, model: modelId, baseURL: entry.baseURL }),
            );
        } catch {
            // 表里没有的 custom provider：catalog 的 baseURL 直接用（仍然 OpenAI 兼容面）
            return createOpenAiCompatible({ name: providerId, baseURL: entry.baseURL, apiKey, model: modelId });
        }
    };

    /** 建一个 bot 句柄：createSession 回调负责建会话目录（meta.json），归属由 bot 包写 */
    const handleOf = (config: BotConfig): Bot =>
        createBot({
            store: botStore,
            config,
            createSession: async (bot) => {
                const now = localISOString();
                const meta: SessionMeta = {
                    id: newSessionId(),
                    title: "新会话",
                    model: bot.model,
                    createdAt: now,
                    updatedAt: now,
                    messageCount: 0,
                };
                await writeMeta(meta);
                return meta.id;
            },
        });

    /** 读 / 写会话的压缩状态（`<会话目录>/compaction.json`；内存模式只活在进程里） */
    const readCompaction = async (sessionId: string): Promise<BotCompactionState | null> => {
        if (!persistMeta) return compactMemory.get(sessionId) ?? null;
        try {
            const raw = await readFile(join(root, sessionId, "compaction.json"), "utf-8");
            const parsed: unknown = JSON.parse(raw);
            if (parsed === null || typeof parsed !== "object") return null;
            return parsed as BotCompactionState;
        } catch {
            // 文件不存在 / 坏了 = 从没压过（不猜）
            return null;
        }
    };

    const writeCompaction = async (sessionId: string, state: BotCompactionState): Promise<void> => {
        if (!persistMeta) {
            compactMemory.set(sessionId, state);
            return;
        }
        const dir = join(root, sessionId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "compaction.json"), `${JSON.stringify(state, null, 4)}\n`, "utf-8");
    };

    /** 正在打开中的会话（同一 id 并发打开只跑一次；打开是**每个会话自己**的事，不进全局 act） */
    const opening = new Map<string, Promise<{ store: SessionStore; session: AgentSession; agent: BotAgent; meta: SessionMeta; compactor: BotCompactor }>>();

    const opened = async (
        id: string,
    ): Promise<{ store: SessionStore; session: AgentSession; agent: BotAgent; meta: SessionMeta; compactor: BotCompactor }> => {
        const hit = open.get(id);
        if (hit !== undefined) return hit;
        const pending = opening.get(id);
        if (pending !== undefined) return pending;
        const task = openSession(id);
        opening.set(id, task);
        try {
            return await task;
        } finally {
            opening.delete(id);
        }
    };

    const openSession = async (
        id: string,
    ): Promise<{ store: SessionStore; session: AgentSession; agent: BotAgent; meta: SessionMeta; compactor: BotCompactor }> => {
        const dir = join(root, id);
        const meta = await readMetaOf(id);
        if (meta === null) throw new Error(`没有会话 ${id}`);
        // ##498：模型以 **bot 的当前配置**为准（一个 bot 一条长期会话，改模型就是改这条会话）
        const ownerId = await botStore.ownerOf(id);
        const owner = ownerId === null ? null : await botStore.load(ownerId);
        const modelKey = owner !== null && owner.model.trim() !== "" ? owner.model : meta.model;
        const instructions = owner?.instructions.trim() ?? "";
        // ##480：装配器是决定者 —— 传实例而不是策略名：将来换远程 store 只改这一行，
        // 不存在 switch 分派。
        const store = await openSessionStore(id, dir);
        // ##517：**重建时就把已落盘的压缩边界套上** —— 否则重启后的界面会把压缩过的全量历史又画一遍
        // （阈值判定在下一轮才跑，那时已经晚了：用户先看到的是一整段旧消息）。
        const initialMessages: readonly ChatMessage[] = applyPriorBoundary(
            await store.readFrom(0),
            await readCompaction(id),
        );
        // ##516：**只在新建会话时**组装一次系统上下文（AGENTS.md 链 + facts 摘要）。
        // 每轮重写会把前缀缓存打碎；老会话也不再追加（历史里已经有一条 system）。
        // 组装失败降级为缺席（`buildSystemContext` 永不抛）。
        const contextText =
            initialMessages.length === 0
                ? buildSystemContext({ home: options.home, cwd: workspaceOf(options.home, ownerId ?? id) }).text
                : "";
        const systemText = [instructions, contextText, workspaceNote(options.home, ownerId ?? id)]
            .filter((x) => x !== "")
            .join("\n\n");
        const { modelId } = splitModelKey(modelKey);
        const llm = llmFor(modelKey);
        // ##517：上下文压缩（窗口未知 ⇒ 不压；判据 / 摘要 prompt 全部来自 @diy-agent/compaction）
        const entry = catalog().find((item) => keyOf(item) === modelKey) ?? null;
        const compactor = createBotCompactor({
            windowTokens: entry?.contextWindow ?? null,
            llm,
            ...(modelId === "" ? {} : { model: modelId }),
            loadState: () => readCompaction(id),
            saveState: (state) => writeCompaction(id, state),
        });
        // 2026-11-05：改由 createBotAgent 建（它算 system、记 lastRequest、管跨轮增量）。
        // 这里给 providers 的是**最小集**（diy / cwd / chain / skills）—— 它们进信封的
        // `vars:` 段（**一份全量**，##520），也是「哪些变量变了」的增量来源。
        // ⚠ facts / 链的内容暂时仍走 systemText（与 provider 值并存不影响正确性）。
        const workspace = workspaceOf(options.home, ownerId ?? id);
        const agent = createBotAgent({
            id,
            llm,
            store,
            model: modelId,
            instructions: systemText,
            providers: [
                { key: "diy", provide: () => ({ cli: "", home: options.home }) },
                {
                    key: "cwd",
                    provide: () => ({
                        path: workspace,
                        note: "",
                        isFallback: false,
                        isTaskDir: false,
                        isAppDir: false,
                    }),
                },
                // 2026-11-07：不再返回空数组 —— AGENTS.md 链真扫（与 diy-app 同一套判据：
                // 外层在前、上界 homedir）。之前一直是 `[]`，所以 `~/AGENTS.md` → `~/git/AGENTS.md`
                // → 仓库 AGENTS.md 里的全局规则一条都进不来（比缺 kb 严重）。
                // `appHome` 传一个不存在的路径：bot 没有「应用级规范」这个概念。
                {
                    key: "chain",
                    help: CHAIN_HELP,
                    provide: () => agentsChain({ appHome: join(options.home, "__no_app__"), cwd: workspace }),
                },
                // 知识库：两层（项目 `<cwd>/.diy/knowledge` 优先、全局 `$DIY_HOME/knowledge` 兜底），
                // 与 diy-app 的 kbProvider 同判据（PR #445）。只投目录不投正文 —— 要看就 read 那个文件。
                { key: "kb", help: KB_HELP, provide: () => botKb(workspace, options.home) },
                { key: "skills", help: SKILLS_HELP, provide: () => skillsOf({ cwd: workspace, globalRoot: join(homedir(), ".agents") }) },
            ],
            initialMessages,
            initialSnapshot: null,
            compact: compactor.compact,
        });
        const session = agent.session;
        const nextMeta: SessionMeta = meta.model === modelKey ? meta : { ...meta, model: modelKey };
        if (nextMeta !== meta) await writeMeta(nextMeta);
        const value = { store, session, agent, meta: nextMeta, compactor };
        open.set(id, value);
        return value;
    };

    /** bot 配置 → 左栏一行（sessionCount 是扫会话目录的投影，不是 bot.json 的一部分） */
    const botView = async (config: BotConfig): Promise<BotView> => ({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        needsModel: config.needsModel === true || config.model.trim() === "",
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        sessionCount: (await botStore.sessionsOf(config.id)).length,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
    });

    /** 底部指标：上一步的桶 + 模型目录里的窗口 / 价目（缺就缺席，不补 0） */
    const metricsOf = (config: BotConfig, sessionId: string, usage: TokenUsage): ChatMetrics => {
        const last = lastStep.get(sessionId);
        const entry = catalog().find((item) => keyOf(item) === config.model) ?? null;
        const cost = last === undefined ? undefined : costOf(entry?.cost, last);
        return {
            ...(last === undefined ? {} : { inputTokens: last.inputTokens, outputTokens: last.outputTokens }),
            ...(last?.cacheReadTokens === undefined ? {} : { cacheReadTokens: last.cacheReadTokens }),
            ...(entry?.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(cost === undefined ? {} : { cost }),
            turns: usage.turns,
        };
    };

    /** 当前 bot（本次进程里上次选中的那个；没有 / 已删 ⇒ 列表第一个） */
    const activeConfig = async (): Promise<BotConfig | null> => {
        const configs = await botStore.list();
        if (configs.length === 0) return null;
        const active = configs.find((config) => config.id === activeBotId) ?? configs[0]!;
        activeBotId = active.id;
        return active;
    };

    /**
     * 快照本体（**必须在队列里跑**：见 return 里的 snapshot 包装）。
     *
     * 为什么读也要排队（docs/plans/2026-11-02-concurrency-actor.md）：
     * 写操作是「save bot → focus」这类多步，读要是插在中间就会看到**半成品**——
     * 实测：新建 bot 后 UI 列表里已有它，但当前 bot 还是上一个（`createBot` 的 save 与 focus 之间
     * 夹进了一次 snapshot），于是 UI 永远显示旧会话。读进同一个队列 ⇒ 只能看到写完的状态。
     */
    const snapshotNow = async (): Promise<BotChatSnapshot> => {
        const configs = await botStore.list();
        const bots = await Promise.all(configs.map(botView));
        // 缺省选中 = 列表第一项（带 account，和 choices 同一套拼法）
        const active = configs.length === 0 ? null : ((await activeConfig()) ?? configs[0]!);
        if (active === null) {
            return { bots: [], bot: null, messages: [], metrics: null };
        }
        // 存量 bot 没选过模型（##497）：UI 要先拦到配置页 —— 这里也不能替它开会话
        if (active.needsModel === true || active.model.trim() === "") {
            return { bots, bot: await botView(active), messages: [], metrics: null };
        }
        // 长期会话：第一次进来才建（幂等；建过就一直是它 —— 判据 3/4）
        const ref = await handleOf(active).primary();
        const current = await opened(ref.id);
        const messages: readonly WireMessage[] = wireOf(current.session.messages);
        return { bots, bot: await botView(active), messages, metrics: metricsOf(active, ref.id, current.session.usage) };
    };

    /** 模型必须是目录里的（##497：没有「跟随宿主缺省」这条路） */
    const checkModel = (model: string): string => {
        if (model.trim() === "") throw new Error("必须先选一个模型（bot 的 model 必填）");
        // 三段式：account@provider/model —— 按 provider+model 查目录，account 只影响取哪个 key
        const { providerId, modelId } = splitModelKey(model);
        const found = catalog().some((entry) => entry.providerId === providerId && entry.modelId === modelId);
        if (!found) throw new Error(`模型目录里没有 ${model}`);
        return model;
    };

    const focus = (id: string): void => {
        activeBotId = id;
    };

    return {
        /**
         * 快照**不进写队列**（用户 2026-11-04 裁：「actor 应该是每个 bot 单独的，
         * 因为对话是可以并行的，存储也是分离的」）。
         *
         * 之前读和写共用 `act` ⇒ 一个挂住的会话把队列占死 ⇒ 所有 bot 的界面都读不到数据。
         * 现在：写操作（建/删/选中 bot、落 meta）仍然串行（那是真共享状态），
         * 读完全独立 —— 读到的最多是「某条消息刚写了一半」，而不是整个界面失灵。
         *
         * 498 当初把读塞进队列是为了修「新建 bot 后 UI 显示旧会话」，那个场景现在由
         * 「写操作返回前自己取一次新快照」（`createBot` 等内部直接调 `snapshotNow()`）覆盖。
         */
        snapshot: () => withSnapshotGuard(snapshotNow),

        /** 模型目录：按需拉（##526）。快照里不再带它 */
        async models(): Promise<ModelChoices> {
            const list = choices();
            const first = list[0];
            return {
                choices: list,
                defaultModel:
                    first === undefined
                        ? null
                        : `${first.account === undefined ? "" : `${first.account}@`}${first.providerId}/${first.modelId}`,
            };
        },

        /** 首启建 bot（##497：必须有 model；已存在则报错） */
        createFirstBot(input: FirstBotInput): Promise<BotChatSnapshot> {
            return act(async () => {
                const config = await createFirstBotIn(botStore, {
                    id: FIRST_BOT_DRAFT.id,
                    name: input.name?.trim() || FIRST_BOT_DRAFT.name,
                    instructions: input.instructions ?? FIRST_BOT_DRAFT.instructions,
                    model: checkModel(input.model),
                });
                focus(config.id);
                return snapshotNow();
            });
        },

        /** `+ 新 bot`：建好即选中（点进去就是它的长期会话） */
        createBot(input: BotDraftInput): Promise<BotChatSnapshot> {
            return act(async () => {
                const name = input.name.trim();
                if (name === "") throw new Error("新 bot 必须有个名字");
                const existing = await botStore.list();
                if (existing.some((config) => config.name === name)) {
                    throw new Error(`已经有同名 bot「${name}」`);
                }
                const model = checkModel(input.model);
                const at = localISOString();
                const config: BotConfig = {
                    id: nextBotId(existing.map((item) => item.id)),
                    name,
                    instructions: input.instructions ?? "",
                    model,
                    ...(input.reasoningEffort === undefined || input.reasoningEffort === ""
                        ? {}
                        : { reasoningEffort: input.reasoningEffort }),
                    createdAt: at,
                    updatedAt: at,
                };
                await botStore.save(config);
                focus(config.id);
                return snapshotNow();
            });
        },

        /** 改配置：模型 / 指令变了 ⇒ 把打开中的会话丢掉重开（llm 与 system 都要重新装配） */
        updateBot(input: BotUpdateInput): Promise<BotChatSnapshot> {
            return act(async () => {
                const current = await botStore.load(input.id);
                if (current === null) throw new Error(`没有 bot ${input.id}`);
                const name = (input.name ?? current.name).trim();
                if (name === "") throw new Error("名字不能为空");
                const model = input.model === undefined ? current.model : checkModel(input.model);
                const instructions = input.instructions ?? current.instructions;
                const effort =
                    input.reasoningEffort === undefined
                        ? current.reasoningEffort
                        : input.reasoningEffort.trim() === ""
                          ? undefined
                          : input.reasoningEffort;
                const next: BotConfig = {
                    id: current.id,
                    name,
                    instructions,
                    model,
                    ...(current.primarySessionId === undefined
                        ? {}
                        : { primarySessionId: current.primarySessionId }),
                    ...(effort === undefined ? {} : { reasoningEffort: effort }),
                    ...(current.maxOutputTokens === undefined ? {} : { maxOutputTokens: current.maxOutputTokens }),
                    createdAt: current.createdAt,
                    updatedAt: localISOString(),
                };
                await botStore.save(next);
                if (model !== current.model || instructions !== current.instructions) {
                    if (current.primarySessionId !== undefined) open.delete(current.primarySessionId);
                }
                return snapshotNow();
            });
        },

        /** 删 bot（##498 判据 7：它的**会话一并删除**）—— 级联是应用策略，bot 包本身只删身份 */
        removeBot(id: string): Promise<BotChatSnapshot> {
            return act(async () => {
                const refs = await botStore.sessionsOf(id);
                for (const ref of refs) {
                    if (persistMeta) await rm(join(root, ref.id), { recursive: true, force: true });
                    else metaMemory.delete(ref.id);
                    compactMemory.delete(ref.id);
                    open.delete(ref.id);
                    lastStep.delete(ref.id);
                    messageQueues.delete(ref.id);
                }
                await botStore.remove(id);
                if (activeBotId === id) activeBotId = null;
                return snapshotNow();
            });
        },

        /** 切 bot = 打开它的长期会话（只改「上次选中」，也走队列） */
        selectBot(id: string): Promise<BotChatSnapshot> {
            return act(async () => {
                const config = await botStore.load(id);
                if (config === null) throw new Error(`没有 bot ${id}`);
                focus(id);
                return snapshotNow();
            });
        },

        /** 压缩点（旧宿主：从当前消息线推导，只供面板展示；旧宿主的压缩是自动的） */
        async compactInfo(): Promise<CompactInfo> {
            const snap = await snapshotNow()
            const rounds = snap.messages
                .filter((m) => m.role === "user")
                .map((m, i) => ({
                    label: `轮${i + 1}`,
                    title: ((m.blocks[0]?.data as { text?: string } | undefined)?.text ?? "").slice(0, 40),
                    tokens: 0,
                    kept: true,
                }))
            return { rounds, droppedCount: 0 }
        },

        /** 显式压缩：**旧宿主不支持**（它的压缩由窗口判据自动触发）—— 明确报错，不假装成功 */
        async compact(): Promise<BotChatSnapshot> {
            throw new Error("当前宿主不支持显式压缩：用 DIY_CHAT_AGENT=1 启动（Agent 宿主支持按轮压缩）")
        },

        send(text, onDelta): Promise<BotChatSnapshot> {
            // 消息也串行 —— 但**按会话**排：同一会话两条 send 不并发（否则 session 直接 busy），
            // 不同会话 / bot 增删改 互不阻塞（LLM 回复可能几十秒，不该把整个 UI 卡住）
            return (async () => {
                const active = await activeConfig();
                if (active === null) throw new Error("还没有 bot —— 先建一个（首启引导）");
                const ref = await handleOf(active).primary();
                return queueFor(ref.id)(async () => {
                    const { session, agent, meta, compactor } = await opened(ref.id);
                    const before = session.messages.length;
                    const usageBefore = session.usage;
                    // 失败必须让人看见（用户 2026-11-04：「对话很多次都没反应，但也没有卡住」——
                    // 真实原因是模型调了不存在的工具，错误进了日志却没进 UI）。
                    // 这里兜住一切异常：落一条 agent-notice 到会话里，人能看到「这轮为什么没结果」。
                    // 工具循环交给 ai-sdk（##514 教训 + 用户 2026-11-04：「diy-agent 已经有很完善的
                    // agent 对话核心，请参考撰写，不要重新发明」）。diy-app 一直是这么做的：
                    //   streamText({ tools, stopWhen: stepCountIs(n) })
                    // 这里只把 tools / maxSteps 透传给 session.send，循环与工具执行由 ai-sdk 负责。
                    try {
                        const tools = options.toolsFor?.(ref.id);
                        const effort = active.reasoningEffort;
                        for await (const delta of agent.stream(text, {
                            ...(tools === undefined ? {} : { tools }),
                            maxSteps: options.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
                            // 这两样 diy-app 一直传、bot 之前漏了 —— 用户 2026-11-04 指出
                            // 「老 app 没出现过（DSML），都是同样模型」，差异就出在这里：
                            // 不传 maxOutputTokens 时上游用默认值，可能小到把工具调用截断；
                            // 不传 reasoningEffort 时 reasoning 模型的行为也和 diy-app 不一致。
                            ...(active.maxOutputTokens === undefined
                                ? {}
                                : { maxOutputTokens: active.maxOutputTokens }),
                            ...(effort === undefined || effort === "default"
                                ? {}
                                : effort === "none"
                                  ? { providerOptions: { reasoning: "none" } }
                                  : { providerOptions: { openaiCompatible: { reasoningEffort: effort } } }),
                        })) {
                            if (delta.type === "text" || delta.type === "tool-call" || delta.type === "tool-result") {
                                onDelta(wireOf(session.messages));
                            }
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        session.append({
                            role: "assistant",
                            type: "agent-notice",
                            text: `本轮失败：${message}`,
                        });
                        onDelta(wireOf(session.messages));
                    }
                    const messages = wireOf(session.messages);
                    onDelta(messages);

                    // 上一步的桶 = 累计值的差（底部指标条要的是「这一步」，不是「这条会话」）
                    const usageAfter = session.usage;
                    lastStep.set(ref.id, {
                        inputTokens: usageAfter.inputTokens - usageBefore.inputTokens,
                        outputTokens: usageAfter.outputTokens - usageBefore.outputTokens,
                        ...(usageAfter.cacheReadTokens === undefined
                            ? {}
                            : { cacheReadTokens: usageAfter.cacheReadTokens - (usageBefore.cacheReadTokens ?? 0) }),
                    });
                    // ##517：下一轮的压缩阈值按「这一步实际撑开的上下文」判（实测优先）
                    compactor.noteStepTokens(
                        usageAfter.inputTokens - usageBefore.inputTokens + (usageAfter.outputTokens - usageBefore.outputTokens),
                    );

                    const grown = session.messages.length - before;
                    const next: SessionMeta = {
                        ...meta,
                        title: meta.title === "新会话" && messages.length > 0 ? titleFrom(text) : meta.title,
                        updatedAt: localISOString(),
                        messageCount: meta.messageCount + Math.max(grown, 0),
                    };
                    await writeMeta(next);
                    open.set(ref.id, { store: open.get(ref.id)!.store, session, agent, meta: next, compactor });
                    return { ...(await snapshotNow()), messages };
                });
            })();
        },
    };
}

/** 工具步缺省上限（##514：够一个中等任务，又不至于把一整晚烧进去） */
export const DEFAULT_MAX_TOOL_STEPS = 20;

/**
 * 一轮对话的**工具循环**（##514 第 3 步）：调模型 → 模型点工具 → 执行 → 结果喂回去 → 再调，
 * 直到模型不再调工具或步数上限。
 *
 * 为什么不用甲（在 bot 层反复调 `session.send`）：`send` 恒追加 **user** 消息，
 * 而工具结果在协议上必须是 `role:'tool'` 且按 `tool_call_id` 配对 —— 混成 user 正文
 * 上游会拒（或有模型行为不可预测）。所以用 session 的 `continueWithToolResults()`：
 * 落盘 / 压缩 / usage 统计与 `send` 完全同一套（两者共用 `runTurn()`）。
 *
 * 超限取舍（用户已确认口径）：**不报错、不静默死循环** ——
 * 剩余未执行的调用仍各落一条「未执行」结果（历史必须合法：assistant 的 tool-call
 * 不能没有对应结果），再追加一条 notice 说明截断原因，然后结束这一轮。
 */
async function runToolLoop(input: {
    readonly session: AgentSession;
    readonly text: string;
    readonly tools: BotToolSet | undefined;
    readonly maxTools: number;
    readonly onDelta: (messages: readonly WireMessage[]) => void;
}): Promise<void> {
    const { session, text, tools, maxTools, onDelta } = input;
    const push = (): void => onDelta(wireOf(session.messages));

    let stream = session.send(text);
    let usedTools = 0;
    for (;;) {
        const calls: PendingToolCall[] = [];
        for await (const delta of stream) {
            // 工具调用 / 结果也推 —— 否则「只调工具、不吐正文」的那几步在 UI 上是黑的
            if (delta.type === "text" || delta.type === "tool-call" || delta.type === "tool-result") push();
            if (delta.type === "tool-call") {
                calls.push({ id: delta.id, name: delta.name, input: toolArgsFromInput(delta.input) });
            }
        }
        if (calls.length === 0) return;

        if (tools === undefined || usedTools >= maxTools) {
            // 不能执行也必须回结果：assistant 的 tool-call 悬空会让下一轮请求不合法
            const reason =
                tools === undefined ? "[未执行] 本会话没有装工具" : `[未执行] 已达工具步上限 ${maxTools}`;
            const skipped = calls.map((call) => ({ id: call.id, name: call.name, content: reason }));
            for await (const delta of session.continueWithToolResults(skipped)) {
                if (delta.type === "text" || delta.type === "tool-call" || delta.type === "tool-result") push();
            }
            session.append({
                role: "assistant",
                type: "agent-notice",
                text:
                    tools === undefined
                        ? "模型要求调工具，但本会话没有装工具；调用未执行。"
                        : `工具循环已达上限（${maxTools} 步），本轮停止；剩余调用未执行。`,
            });
            push();
            return;
        }

        usedTools += 1;
        const results = await runToolCalls(calls, tools);
        stream = session.continueWithToolResults(results);
    }
}


function titleFrom(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine || "新会话";
}

async function readMeta(dir: string): Promise<SessionMeta | null> {
    try {
        const raw = await readFile(join(dir, "meta.json"), "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return null;
        const meta = parsed as Partial<Record<keyof SessionMeta, unknown>>;
        if (typeof meta.id !== "string" || typeof meta.title !== "string" || typeof meta.model !== "string")
            return null;
        return {
            id: meta.id,
            title: meta.title,
            model: meta.model,
            createdAt: typeof meta.createdAt === "string" ? meta.createdAt : localISOString(new Date(0)),
            updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : localISOString(new Date(0)),
            messageCount: typeof meta.messageCount === "number" ? meta.messageCount : 0,
        };
    } catch {
        return null;
    }
}
