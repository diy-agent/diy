// drafts.ts —— 未提交输入的客户端缓冲（无 React 依赖，方便单测）。
//
// 真源在服务端（GET/PUT/DELETE /api/rooms/:id/drafts）；这里只做三件事：
//   1. 内存镜像 + 订阅（输入框、侧栏 ✎ 共用）
//   2. 600ms 防抖写入，切房间 / 页面隐藏时 flush
//   3. 提交成功才清（clearIfMatches），失败保留并退避重试
//
// 它不是 inbox：草稿在 say() 之前，发送动作才把它变成 InboxItem。
//
// 一个容器里可以有多条草稿，用 field 区分：`composer`（发言框）、`ask:<askId>`（提问卡）。
// owner 就是 roomId —— 两种输入同属一个房间，切房间 / 刷新一起回填。

export type DraftStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

import * as React from 'react';

export interface DraftValue {
    text?: string;
    [key: string]: unknown;
}

interface StoredDraft {
    value: unknown;
    updatedAt: number;
}

interface OwnerState {
    entries: Map<string, StoredDraft>;
    /** 需要写回服务端的字段（entries 里没有 = 删除） */
    dirty: Set<string>;
    loaded: boolean;
    loading: boolean;
    loadPromise?: Promise<void>;
    loadAttempt: number;
    loadTimer?: ReturnType<typeof setTimeout>;
    timer?: ReturnType<typeof setTimeout>;
    retryTimer?: ReturnType<typeof setTimeout>;
    retryAttempt: number;
    writing: boolean;
    flushAgain: boolean;
    error?: string;
}

export interface DraftStoreOptions {
    /** API 前缀，默认 '/api' */
    base?: string;
    fetchImpl?: typeof fetch;
    /** 输入停顿多久后写服务端 */
    debounceMs?: number;
    /** 写失败重试基数（1s / 2s / 4s… 封顶 retryMaxMs） */
    retryBaseMs?: number;
    retryMaxMs?: number;
}

export interface DraftSeed {
    id: string;
    hasDraft?: boolean;
}

/** 一条草稿里是否还有"值得恢复"的内容：空串 / 空数组 / 全空对象都不算 */
export function hasDraftContent(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some((item) => hasDraftContent(item));
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some((item) => hasDraftContent(item));
    return false;
}

/** 按值比较用的稳定序列化：键顺序无关，数组保序 */
function stableKey(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`).join(',')}}`;
}

/**
 * 有 owner 才谈得上落盘。空串是"这个面不知道房间"（assistant-ui 的 meta 可能没带），
 * 这种输入只留在内存里，别去请求 /rooms//drafts。
 */
function persistable(owner: string): boolean {
    return owner.trim() !== '';
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class DraftStore {
    private readonly owners = new Map<string, OwnerState>();
    /** owner 是否有草稿（侧栏 ✎）；服务端列表返回的种子 + 本端输入共同维护 */
    private readonly flags = new Map<string, boolean>();
    /** 本端改过的 owner：服务端快照不覆盖，避免"刚打的字被旧列表抹掉" */
    private readonly touched = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private readonly base: string;
    private readonly injected?: typeof fetch;
    private readonly debounceMs: number;
    private readonly retryBaseMs: number;
    private readonly retryMaxMs: number;

    constructor(options: DraftStoreOptions = {}) {
        this.base = options.base ?? '/api';
        this.injected = options.fetchImpl;
        this.debounceMs = options.debounceMs ?? 600;
        this.retryBaseMs = options.retryBaseMs ?? 1_000;
        this.retryMaxMs = options.retryMaxMs ?? 30_000;
    }

    get fetchImpl(): typeof fetch {
        // 浏览器里 fetch 不能当方法调用（Illegal invocation）
        return this.injected ?? fetch;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    private emit(): void {
        for (const listener of this.listeners) listener();
    }

    private stateOf(owner: string): OwnerState {
        let state = this.owners.get(owner);
        if (state === undefined) {
            state = {
                entries: new Map(),
                dirty: new Set(),
                loaded: false,
                loading: false,
                loadAttempt: 0,
                retryAttempt: 0,
                writing: false,
                flushAgain: false,
            };
            this.owners.set(owner, state);
        }
        return state;
    }

    /** 首次使用某个容器：把它的全部草稿一次拉回来（composer 与 ask 共用） */
    ensure(owner: string): Promise<void> {
        const state = this.stateOf(owner);
        if (state.loaded) return Promise.resolve();
        if (!persistable(owner)) {
            // 不知道房间就不问服务端；本端照常存内存，界面行为一致
            state.loaded = true;
            return Promise.resolve();
        }
        if (state.loadPromise !== undefined) return state.loadPromise;
        if (state.loadTimer !== undefined) {
            clearTimeout(state.loadTimer);
            state.loadTimer = undefined;
        }
        state.loading = true;
        state.loadPromise = this.load(owner, state).finally(() => {
            state.loading = false;
            state.loadPromise = undefined;
        });
        return state.loadPromise;
    }

    private async load(owner: string, state: OwnerState): Promise<void> {
        // 这次 GET 发出时已经在本地改过（或清空）的字段，不允许被服务端旧值盖回来
        const dirtyAtLoad = new Set(state.dirty);
        try {
            const data = await this.request<{ drafts?: Array<{ field: string; value: unknown; updatedAt: number }> }>(
                'GET',
                `/rooms/${encodeURIComponent(owner)}/drafts`,
            );
            for (const draft of data.drafts ?? []) {
                // 本地正在编辑 / 改过且更新的，不被服务端旧值覆盖
                if (dirtyAtLoad.has(draft.field) || state.dirty.has(draft.field)) continue;
                const local = state.entries.get(draft.field);
                if (local !== undefined && local.updatedAt > draft.updatedAt) continue;
                state.entries.set(draft.field, { value: draft.value, updatedAt: draft.updatedAt });
            }
            state.loaded = true;
            state.error = undefined;
            state.loadAttempt = 0;
            this.refreshFlag(owner);
            this.emit();
        } catch (error) {
            state.error = messageOf(error);
            state.loadAttempt += 1;
            this.emit();
            this.scheduleLoadRetry(owner);
        }
    }

    private scheduleLoadRetry(owner: string): void {
        const state = this.stateOf(owner);
        if (state.loadTimer !== undefined) return;
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(Math.max(0, state.loadAttempt - 1), 5));
        state.loadTimer = setTimeout(() => {
            state.loadTimer = undefined;
            if (!state.loaded) void this.ensure(owner);
        }, delay);
    }

    /** 首次打开时用 /rooms 的 hasDraft 给侧栏一个初始值（本端改过的 owner 不被覆盖） */
    seed(rooms: readonly DraftSeed[]): void {
        for (const room of rooms) {
            if (this.touched.has(room.id)) continue;
            this.flags.set(room.id, room.hasDraft === true);
        }
        this.emit();
    }

    valueOf(owner: string, field: string): unknown {
        return this.owners.get(owner)?.entries.get(field)?.value;
    }

    textOf(owner: string, field: string): string {
        const value = this.valueOf(owner, field);
        if (typeof value === 'object' && value !== null) {
            const text = (value as Record<string, unknown>)['text'];
            if (typeof text === 'string') return text;
        }
        return '';
    }

    loadedOf(owner: string): boolean {
        return this.owners.get(owner)?.loaded === true;
    }

    statusOf(owner: string): DraftStatus {
        const state = this.owners.get(owner);
        if (state === undefined) return 'idle';
        if (state.error !== undefined) return 'error';
        if (state.writing || state.dirty.size > 0) return 'saving';
        if (state.loading) return 'loading';
        if (state.loaded) return 'saved';
        return 'idle';
    }

    errorOf(owner: string): string | undefined {
        return this.owners.get(owner)?.error;
    }

    /** 侧栏用：这个容器有没有未提交输入（含种子值，不必打开过房间） */
    hasDraft(owner: string): boolean {
        if (this.flags.get(owner) === true) return true;
        const state = this.owners.get(owner);
        if (state === undefined) return false;
        for (const entry of state.entries.values()) {
            if (hasDraftContent(entry.value)) return true;
        }
        return false;
    }

    setValue(owner: string, field: string, value: unknown): void {
        const state = this.stateOf(owner);
        state.entries.set(field, { value, updatedAt: Date.now() });
        state.dirty.add(field);
        this.touched.add(owner);
        this.refreshFlag(owner);
        this.scheduleFlush(owner);
        this.emit();
        // 首次打开时可能还没拉完：dirty 会让加载结果跳过这个字段
        void this.ensure(owner);
    }

    setText(owner: string, field: string, text: string): void {
        this.setValue(owner, field, { text });
    }

    clear(owner: string, field: string): void {
        const state = this.stateOf(owner);
        state.entries.delete(field);
        state.dirty.add(field);
        this.touched.add(owner);
        this.refreshFlag(owner);
        this.emit();
        // 清空是"立即生效"的：不等防抖，避免切走时又把它写回来
        void this.flush(owner);
    }

    /** 提交成功后只清"还是我发出去那版"的草稿，别把运行期新输入的字清掉 */
    clearIfMatches(owner: string, field: string, expected: string): void {
        if (this.textOf(owner, field) === expected) this.clear(owner, field);
    }

    /** 按值清空（提问卡用）：草稿是对象，提交那版 = 当前这版才清 */
    clearIfValueMatches(owner: string, field: string, expected: unknown): void {
        const current = this.valueOf(owner, field);
        if (current === undefined) return;
        if (stableKey(current) === stableKey(expected)) this.clear(owner, field);
    }

    private refreshFlag(owner: string): void {
        const state = this.owners.get(owner);
        if (state === undefined) return;
        let any = false;
        for (const entry of state.entries.values()) {
            if (hasDraftContent(entry.value)) {
                any = true;
                break;
            }
        }
        this.flags.set(owner, any);
    }

    private scheduleFlush(owner: string): void {
        const state = this.stateOf(owner);
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = undefined;
            void this.flush(owner);
        }, this.debounceMs);
    }

    private scheduleRetry(owner: string): void {
        const state = this.stateOf(owner);
        if (state.retryTimer !== undefined) return;
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(Math.max(0, state.retryAttempt - 1), 5));
        state.retryTimer = setTimeout(() => {
            state.retryTimer = undefined;
            void this.flush(owner);
        }, delay);
    }

    /** 立即写（切房间 / 卸载 / pagehide 时调）；不传 owner = 全部 */
    flush(owner?: string, keepalive = false): Promise<void> {
        const owners = owner === undefined ? [...this.owners.keys()] : [owner];
        return Promise.all(owners.map((id) => this.flushOwner(id, keepalive))).then(() => undefined);
    }

    private async flushOwner(owner: string, keepalive: boolean): Promise<void> {
        const state = this.owners.get(owner);
        if (state === undefined) return;
        if (state.timer !== undefined) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        if (state.writing) {
            state.flushAgain = true;
            return;
        }
        const fields = [...state.dirty];
        if (fields.length === 0) return;
        if (!persistable(owner)) {
            state.dirty.clear();
            this.emit();
            return;
        }

        state.writing = true;
        try {
            for (const field of fields) {
                const entry = state.entries.get(field);
                const value = entry?.value;
                const serialized = JSON.stringify(value);
                const hasContent = entry !== undefined && hasDraftContent(value);
                try {
                    if (hasContent) {
                        await this.request(
                            'PUT',
                            `/rooms/${encodeURIComponent(owner)}/drafts/${encodeURIComponent(field)}`,
                            { value },
                            keepalive,
                        );
                    } else {
                        await this.request(
                            'DELETE',
                            `/rooms/${encodeURIComponent(owner)}/drafts/${encodeURIComponent(field)}`,
                            undefined,
                            keepalive,
                        );
                    }
                    // 写入期间用户又改了同一字段：保留 dirty，下一轮再写
                    const current = state.entries.get(field);
                    if (current === undefined || JSON.stringify(current.value) === serialized) {
                        state.dirty.delete(field);
                        if (!hasContent) state.entries.delete(field);
                    }
                    state.error = undefined;
                    state.retryAttempt = 0;
                    if (state.retryTimer !== undefined) {
                        clearTimeout(state.retryTimer);
                        state.retryTimer = undefined;
                    }
                } catch (error) {
                    state.error = messageOf(error);
                    state.retryAttempt += 1;
                    this.emit();
                    this.scheduleRetry(owner);
                    return;
                }
            }
        } finally {
            state.writing = false;
            this.refreshFlag(owner);
            this.emit();
            if (state.flushAgain) {
                state.flushAgain = false;
                void this.flushOwner(owner, keepalive);
            }
        }
    }

    private async request<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
        const init: RequestInit = {
            method,
            ...(body === undefined
                ? {}
                : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
            ...(keepalive ? { keepalive: true } : {}),
        };
        const res = await this.fetchImpl(`${this.base}${path}`, init);
        if (!res.ok) throw new Error(`草稿保存失败：HTTP ${res.status}`);
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
    }
}

/** 全局单例：三个 surface + 侧栏共用同一份镜像 */
export const drafts = new DraftStore();

if (typeof window !== 'undefined') {
    // 关闭 / 刷新时把还没写出去的字用 keepalive 带出去（正常切房间由组件 flush）
    window.addEventListener('pagehide', () => {
        void drafts.flush(undefined, true);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void drafts.flush(undefined, true);
    });
}

// ─── React 适配（hook 放这里，避免再拆一个文件）────────────────────

export function useDraft(owner: string, field = 'composer'): {
    text: string;
    setText: (text: string) => void;
    clear: () => void;
    clearIfMatches: (expected: string) => void;
    status: DraftStatus;
    error?: string;
    loaded: boolean;
} {
    React.useEffect(() => {
        void drafts.ensure(owner);
    }, [owner]);

    const text = React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.textOf(owner, field),
        () => '',
    );
    const status = React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.statusOf(owner),
        () => 'idle' as DraftStatus,
    );
    const loaded = React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.loadedOf(owner),
        () => false,
    );
    const error = React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.errorOf(owner),
        () => undefined,
    );

    return {
        text,
        setText: (next) => drafts.setText(owner, field, next),
        clear: () => drafts.clear(owner, field),
        clearIfMatches: (expected) => drafts.clearIfMatches(owner, field, expected),
        status,
        ...(error === undefined ? {} : { error }),
        loaded,
    };
}

/** 侧栏 ✎：订阅"这个容器有没有未提交输入" */
export function useHasDraft(owner: string): boolean {
    return React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.hasDraft(owner),
        () => false,
    );
}

/** 通用版（草稿是任意结构时用，比如提问卡的 { selected, fields, text }）*/
export function useDraftValue<T>(
    owner: string,
    field: string,
): {
    /** undefined = 还没输入过（或服务端没有）；结构归一化交给调用方 */
    value: T | undefined;
    setValue: (value: T) => void;
    update: (fn: (previous: T | undefined) => T) => void;
    clear: () => void;
    clearIfValueMatches: (expected: unknown) => void;
    loaded: boolean;
} {
    React.useEffect(() => {
        void drafts.ensure(owner);
    }, [owner]);

    const value = React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.valueOf(owner, field) as T | undefined,
        () => undefined,
    );
    const loaded = React.useSyncExternalStore(
        drafts.subscribe,
        () => drafts.loadedOf(owner),
        () => false,
    );

    // 回调按 owner+field 稳定：AskCard 的 effect 拿它当依赖不会每帧重跑
    const setValue = React.useCallback((next: T) => drafts.setValue(owner, field, next), [owner, field]);
    const update = React.useCallback(
        (fn: (previous: T | undefined) => T) => drafts.setValue(owner, field, fn(drafts.valueOf(owner, field) as T | undefined)),
        [owner, field],
    );
    const clear = React.useCallback(() => drafts.clear(owner, field), [owner, field]);
    const clearIfValueMatches = React.useCallback(
        (expected: unknown) => drafts.clearIfValueMatches(owner, field, expected),
        [owner, field],
    );

    return { value, setValue, update, clear, clearIfValueMatches, loaded };
}
