// Diy2Client —— ChatClient 的 **RPC 实现**（命令走 `diy2.*`，事件走同一条 WS 的 room 流）。
//
// 历史：这个包以前叫 chat-transport-http，命令是 REST；P2 之后浏览器侧不再有 REST
// （只留 `/api/info` 给探活）。包名暂时保留，避免一次跨包重命名掩盖真正的改动。
//
// 一条连接两用：
//   · 命令：`diy2.rooms.list` / `diy2.chat.chat` …（unary，受理即返）
//   · 事件：`room({ room })` 的 server-stream（见 ./hub）
// 断线重连、等待首次连接、取消都在 StreamHub 里；这里只做「方法名 + 类型」。

import type {
    AskAnswer,
    Bot,
    ChatClient,
    Command,
    CompactOutcome,
    Delivery,
    Item,
    Room,
    SessionInfo,
    Snapshot,
    StreamEvent,
} from '@diy-agent/chat-core';

import type {
    ModelCatalogModel,
    ModelCatalogProvider,
    ModelCatalogSnapshot,
    ModelCostView,
} from '@diy-agent/protocol';

import { StreamHub } from './hub';

export interface RpcChatClientOptions {
    /**
     * 事件流 + 命令的 WS 端点；缺省按当前页推导（`ws(s)://<host>/rpc`）。
     * 非浏览器环境（测试）必须显式给。
     */
    rpcUrl?: string;
    /** 兼容旧参数：已不再使用（REST 已删） */
    base?: string;
    /** 兼容旧参数：已不再使用 */
    fetchImpl?: typeof fetch;
}

/** 房间 → 话题名（与 server 的 `room:<id>` 一一对应） */
const topicOf = (entityId: string): string => `room:${entityId}`;

/** 一条草稿（服务端 rooms/drafts 的返回项） */
export interface DraftEntry {
    field: string;
    value: unknown;
    updatedAt: number;
}

/** 侧栏投影：列表接口比 Room 多这几个字段（pendingAskTitles = 未结提问的题干，给侧栏 ? 的 tooltip） */
export type RoomRow = Room & {
    hasDraft?: boolean;
    pendingAsks?: number;
    pendingAskTitles?: string[];
    lastActivityAt?: number;
};

export class RpcChatClient implements ChatClient {
    private readonly hub: StreamHub;

    constructor(options: RpcChatClientOptions = {}) {
        this.hub = new StreamHub({
            ...(options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl }),
        });
    }

    /** 收掉那条连接（测试 / 应用卸载时用） */
    close(): void {
        this.hub.close();
    }

    /** 命令面：`diy2.<method>` */
    private call<T>(method: string, input: unknown): Promise<T> {
        return this.hub.invoke<T>(`diy2.${method}`, input);
    }

    // ── 命令面（UI 直接用：store / drafts / TaskPanel）──────────────

    readonly rooms = {
        list: (): Promise<RoomRow[]> => this.call('rooms.list', {}),
        create: (input: {
            name: string;
            type?: 'project' | 'task';
            modelKey?: string;
            data?: Record<string, unknown>;
        }): Promise<Room> => this.call('rooms.create', input),
        update: (input: {
            id: string;
            name?: string;
            modelKey?: string;
            data?: Record<string, unknown>;
        }): Promise<Room> => this.call('rooms.update', input),
        remove: (id: string): Promise<{ deleted?: string[] }> => this.call('rooms.remove', { id }),
        addMember: (id: string, botId: string): Promise<Room> => this.call('rooms.addMember', { id, botId }),
    };

    readonly bots = {
        list: (): Promise<Bot[]> => this.call('bots.list', {}),
        create: (input: { name: string; homeRoomId?: string; modelKey?: string }): Promise<Bot> =>
            this.call('bots.create', input),
        update: (input: {
            id: string;
            name?: string;
            color?: string;
            persona?: string;
            modelKey?: string;
            homeRoomId?: string;
        }): Promise<Bot> => this.call('bots.update', input),
        remove: (id: string): Promise<unknown> => this.call('bots.remove', { id }),
    };

    readonly drafts = {
        list: (owner: string): Promise<{ drafts: DraftEntry[] }> => this.call('drafts.list', { owner }),
        put: (owner: string, field: string, value: unknown): Promise<{ updatedAt: number }> =>
            this.call('drafts.put', { owner, field, value }),
        remove: (owner: string, field: string): Promise<unknown> => this.call('drafts.remove', { owner, field }),
    };

    readonly journal = {
        list: (id: string, limit?: number): Promise<{ entries: unknown[] }> =>
            this.call('journal.list', { id, ...(limit === undefined ? {} : { limit }) }),
    };

    /** 模型目录（选模型器 / 新建房间的缺省值）；服务端保证不含 key 值 */
    readonly models = {
        list: (): Promise<ModelCatalogSnapshot> => this.call('models.list', {}),
    };

    readonly links = {
        list: (id: string): Promise<{ out: unknown[]; in: unknown[] }> => this.call('links.list', { id }),
        add: (id: string, to: string, kind: string): Promise<unknown> => this.call('links.add', { id, to, kind }),
        remove: (id: string, to: string, kind: string): Promise<{ removed: boolean }> =>
            this.call('links.remove', { id, to, kind }),
    };

    // ── ChatClient ──────────────────────────────────────────────

    async load(entityId: string): Promise<Snapshot> {
        const history = await this.call<{
            items: Item[];
            deliveries: Delivery[];
            asks: Snapshot['asks'];
            answered: Snapshot['answeredAsks'];
        }>('chat.history', { id: entityId });
        return {
            items: history.items,
            deliveries: history.deliveries,
            asks: history.asks ?? [],
            answeredAsks: history.answered ?? [],
        };
    }

    /** 常驻订阅：重连 / 退避 / `ready` 全在 StreamHub；这里只说「我要看哪个房间」 */
    watch(entityId: string, onEvent: (event: StreamEvent) => void): () => void {
        return this.hub.subscribe(topicOf(entityId), onEvent);
    }

    async sessions(entityId: string): Promise<SessionInfo[]> {
        const data = await this.call<{ sessions: SessionInfo[] }>('chat.sessions', { id: entityId });
        return data.sessions;
    }

    async compact(
        entityId: string,
        botId: string,
        options: { keepLast?: number; maxChars?: number } = {},
    ): Promise<CompactOutcome> {
        return this.call<CompactOutcome>('chat.compact', { id: entityId, botId, ...options });
    }

    async answerAsk(entityId: string, askId: string, answer: AskAnswer): Promise<void> {
        await this.call('asks.answer', { id: entityId, askId, answer });
    }

    async cancelAsk(entityId: string, askId: string): Promise<void> {
        await this.call('asks.cancel', { id: entityId, askId });
    }

    async post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void): Promise<void> {
        if (command.kind === 'cancel') {
            await this.call('chat.cancel', {
                id: entityId,
                keepQueue: command.keepQueue === true,
                ...(command.botId === undefined ? {} : { botId: command.botId }),
            });
            onEvent({ kind: 'done' });
            return;
        }
        if (command.kind !== 'send') return;

        // 先确保这个房间的流已经开着再发：否则「受理即返」之后的第一条事件可能没人接。
        // 失败也无所谓 —— 消息必须送到，事件由重连后的 ready + 补拉快照兜。
        await this.hub.ensure(topicOf(entityId));
        await this.call('chat.chat', { id: entityId, text: command.text });
    }
}

export { StreamHub, topicOfRoom, type StreamHubOptions } from './hub';
/** 目录视图形状在 protocol（服务端与界面共用一份），这里顺手透出，界面不用多装一个依赖 */
export type { ModelCatalogModel, ModelCatalogProvider, ModelCatalogSnapshot, ModelCostView };
