/**
 * draftStore — 半编辑草稿（用户未提交的输入）的 renderer 侧门面
 *
 * 定位：草稿是**非缓存数据**（丢了 = 用户白打），权威在任务目录 `.diy/drafts.yaml`，
 * 由 main 落盘（core/drafts.ts）。本 store 只是「内存镜像 + 防抖写 + 错误可见」，
 * 重启/reload 后由 `task.show` 返回的 `ui_drafts` 重新灌入（seed）。
 *
 * 与 localChatStore 的分工：那边管会话（可重建的 op 流），这边管「还没提交的输入」。
 * 之所以独立成 store：同一个草稿文件被两个组件消费（详情面板的标题/详情、聊天页的输入框），
 * 且都必须按 taskUri 隔离。
 *
 * 为什么不用 localStorage：serve 模式与 Electron 模式各持一份 localStorage，
 * 同一条草稿在另一个模式看不到；落任务目录则两模式共用，且随任务删除/迁移。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "./notificationStore";

/** 草稿字段白名单 — 与 main 侧 core/drafts.ts 的 DRAFT_FIELDS 保持一致 */
export type DraftField = "title" | "body" | "agent_input";

/** 服务端返回的草稿结构（task.show 的 ui_drafts 同形） */
export interface DraftsPayload {
    base_updated?: string;
    saved?: string;
    fields: Partial<Record<DraftField, string>>;
}

/** 写失败提示的节流窗口：草稿落盘失败会持续发生，不能每敲一键弹一个 toast */
const ERROR_TOAST_THROTTLE_MS = 10_000;
/** 输入防抖：停止输入后多久落盘。太短会频繁写文件，太长则崩溃时丢字多 */
const SAVE_DEBOUNCE_MS = 600;

interface DraftState {
    fields: Partial<Record<DraftField, string>>;
    base_updated?: string;
    /** 该任务草稿是否已从服务端灌入过（避免第二次进入用空值覆盖已有草稿） */
    seeded: boolean;
    /** 防抖计时器（每任务一个，切任务不互相干扰） */
    timer?: ReturnType<typeof setTimeout>;
    /** 待落盘的字段（防抖窗口内累积） */
    pending: Partial<Record<DraftField, string>>;
}

const states = new Map<string, DraftState>();
/** 变更计数：订阅方（组件）读它来建立响应式依赖 */
const [version, setVersion] = createSignal(0);
/**
 * 灌入计数：**只在 seed 时**自增。
 *
 * 组件不能用 version 决定「何时把草稿回填进 DOM」—— 那样每敲一键都会把值写回
 * textarea，光标/输入法组词会被打断。回填只应在「换任务 / 服务端草稿刚到」时发生。
 */
const [seedTick, setSeedTick] = createSignal(0);
let lastErrorToastAt = 0;

function stateFor(uri: string): DraftState {
    let s = states.get(uri);
    if (!s) {
        s = { fields: {}, seeded: false, pending: {} };
        states.set(uri, s);
    }
    return s;
}

function bump() {
    setVersion((v) => v + 1);
}

/** 写失败必须可见：半编辑数据不许静默丢（这与视图 cache 的策略相反） */
function reportError(err: unknown, uri: string) {
    console.error(`[draftStore] 草稿落盘失败 ${uri}:`, err);
    const now = Date.now();
    if (now - lastErrorToastAt > ERROR_TOAST_THROTTLE_MS) {
        lastErrorToastAt = now;
        notificationStore.addToast("error", "草稿保存失败，输入可能未落盘（详见控制台）");
    }
}

/** 真正落盘（失败不回滚内存：内存里留着至少本进程内还看得见，且下次输入会重试） */
async function flush(uri: string) {
    const st = states.get(uri);
    if (!st) return;
    const pending = st.pending;
    if (Object.keys(pending).length === 0) return;
    st.pending = {};
    if (st.timer) {
        clearTimeout(st.timer);
        st.timer = undefined;
    }
    try {
        const r = await diyService.diy.task.drafts.set({
            uri,
            title: pending.title,
            body: pending.body,
            agent_input: pending.agent_input,
            base_updated: st.base_updated,
        });
        if (r?.data) st.base_updated = r.data.base_updated;
    } catch (e) {
        // 把待写字段还回去，下次输入时连同新值一起重试
        st.pending = { ...pending, ...st.pending };
        reportError(e, uri);
    }
}

/**
 * 用服务端草稿灌入内存（task.show 拿到 ui_drafts 后调用）。
 *
 * 只在首次灌入（未 seeded）时生效：否则用户在面板里刚打的字会被一次
 * 迟到的 task.show 响应覆盖掉。已 seeded 后仅补充 base_updated。
 */
function seed(uri: string, drafts: DraftsPayload | null | undefined, taskUpdated?: string) {
    const st = stateFor(uri);
    if (st.seeded) {
        if (drafts?.base_updated !== undefined) st.base_updated = drafts.base_updated;
        return;
    }
    st.fields = { ...drafts?.fields };
    // 基点：已有草稿用它自己记的（草稿期间任务被外部改过时才能判定过期）；
    // 新建草稿则取任务当前的 updated —— 表示「这条草稿基于这个版本」。
    st.base_updated = drafts?.base_updated ?? taskUpdated;
    st.seeded = true;
    setSeedTick((t) => t + 1);
    bump();
}

/** 读某任务的某字段草稿（无则空串） */
function get(uri: string | null, field: DraftField): string {
    if (!uri) return "";
    return states.get(uri)?.fields[field] ?? "";
}

/** 该任务是否有草稿（任意字段） */
function has(uri: string | null): boolean {
    if (!uri) return false;
    const f = states.get(uri)?.fields;
    return !!f && Object.keys(f).length > 0;
}

/**
 * 指定字段中是否有草稿。
 *
 * 必须按字段问，不能问「有没有草稿」——不同字段归不同组件管：
 * agent 输入框的草稿与任务详情的编辑态毫无关系，用 has() 会让
 * 「聊到一半的输入」把详情面板误判成「编辑中」。
 */
function hasAny(uri: string | null, fields: DraftField[]): boolean {
    if (!uri) return false;
    const f = states.get(uri)?.fields;
    if (!f) return false;
    return fields.some((k) => f[k] !== undefined);
}

/** 读该任务的全部草稿字段（详情面板初始化用） */
function fieldsOf(uri: string | null): Partial<Record<DraftField, string>> {
    if (!uri) return {};
    return { ...states.get(uri)?.fields };
}

/**
 * 写草稿：内存立即生效（UI 无延迟），落盘防抖。
 * 传空串 = 清除该字段（与 main 侧语义一致）。
 */
function set(uri: string, field: DraftField, value: string) {
    const st = stateFor(uri);
    if (value === "") delete st.fields[field];
    else st.fields[field] = value;
    st.pending[field] = value;
    bump();
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => void flush(uri), SAVE_DEBOUNCE_MS);
}

/** 批量写（详情面板一次提交多个字段） */
function setMany(uri: string, patch: Partial<Record<DraftField, string>>) {
    for (const [k, v] of Object.entries(patch)) {
        if (typeof v === "string") set(uri, k as DraftField, v);
    }
}

/**
 * 清除草稿：立即落盘（不等防抖）。
 * 用于「已提交」与「取消编辑」两个时机 —— 草稿留着会盖住新数据。
 */
async function clear(uri: string, fields?: DraftField[]) {
    const st = stateFor(uri);
    const targets = fields ?? (Object.keys(st.fields) as DraftField[]);
    for (const f of targets) {
        delete st.fields[f];
        delete st.pending[f];
    }
    bump();
    // 先冲掉防抖中的待写值，否则「刚敲的字」会在 clear 之后落盘，把草稿又写回来
    st.pending = {};
    if (st.timer) {
        clearTimeout(st.timer);
        st.timer = undefined;
    }
    try {
        await diyService.diy.task.drafts.clear({ uri, fields });
        if (Object.keys(st.fields).length === 0) st.seeded = false;
    } catch (e) {
        reportError(e, uri);
    }
}

/** 强制把待写内容落盘（组件卸载 / 切换任务 / 提交前调用） */
function flushNow(uri: string): Promise<void> {
    const st = states.get(uri);
    if (!st) return Promise.resolve();
    return flush(uri);
}

export const draftStore = {
    /** 订阅用：在响应式上下文里读一次即可建立依赖 */
    get version() {
        return version();
    },
    /** 订阅用（仅 seed 时变化）：组件据此回填输入框，避免逐键回写打断光标 */
    get seedTick() {
        return seedTick();
    },
    seed,
    get,
    has,
    hasAny,
    fieldsOf,
    set,
    setMany,
    clear,
    flushNow,
};
