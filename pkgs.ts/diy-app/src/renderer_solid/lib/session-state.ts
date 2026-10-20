// lib/session-state.ts — 会话状态的**唯一合成层**（renderer 侧）：把四处真源喂进
// `shared/session-state` 的纯判据。渲染组件只调本文件，谁也不许自己拼状态（##393）。
//
// 数据源（逐项指名，禁止猜测；判据本身在 shared/session-state.ts 头注）：
//   · turn / queue / viewers / turnCount / lastEndReason ← store/sessionStore（全局唯一的注册表订阅，##308）
//   · 未读条数      ← `sessionStore.unreadTurnsOf`（尺子 = max(注册表, 账本)，跨启动；1 轮 = 1 条）
//   · 聊过没有      ← 落盘快照 `has_session`（任务树 / 详情载荷）**或** 账本 `startedOf`（跨启动）
//   · 草稿          ← store/draftStore（权威在任务目录 .diy/drafts.yaml；本 store 是内存镜像）
//
// 为什么合成在这里而不是塞进某个 store：sessionStore 只认注册表（进程性），
// 本函数是**跨源合成**（注册表 + 账本 + 草稿 + 任务树），拉进任一 store 都是循环依赖的温床。
import { draftStore } from "../store/draftStore";
import { sessionStore } from "../store/sessionStore";
import { taskStore } from "../store/taskStore";
import { usageLedgerStore } from "../store/usageLedgerStore";
import {
    glyphOf,
    sessionStateOf,
    type SessionGlyphView,
    type SessionState,
} from "../../shared/session-state";
import { findNode } from "./task-lineage";

/** 已完成的任务不再挂会话标记（用户明确：**任务没 done 才显示**） */
const SILENT_STATES = new Set(["done", "cancelled"]);

/** 渲染端能拿到的落盘快照（任务树行 / 任务详情二选一，字段同义） */
export interface SessionStateFallback {
    hasSession?: boolean;
    hasDraft?: boolean;
}

/** 这个任务**聊过没有**：落盘对话存在 / 账本有内容（两者取或 —— 各自覆盖对方看不到的那段时间） */
export function sessionStartedOf(uri: string): boolean {
    if (sessionStore.byUri(uri)) return true;
    return usageLedgerStore.startedOf(uri) === true;
}

/**
 * 会话状态（**唯一入口**）。
 *
 * ⚠️ 草稿的落盘快照是**兜底**不是主源：快照来自任务树/详情那一次 RPC，清空草稿后要等下一次
 * reload 才更新 —— 若拿它压过 draftStore 的活值，用户清掉草稿后会看到"有草稿"这种假事实。
 * 故 **draftStore 灌入过该任务就以它为准**（isSeeded 是判据）。
 */
export function sessionStateFor(uri: string, fallback: SessionStateFallback = {}): SessionState {
    const hasDraft = draftStore.isSeeded(uri)
        ? draftStore.hasAny(uri, ["agent_input"])
        : fallback.hasDraft === true;
    return sessionStateOf({
        entry: sessionStore.byUri(uri),
        hasSession: fallback.hasSession === true,
        totalTurns: sessionStore.turnsOf(uri),
        hasDraft,
        unread: sessionStore.unreadTurnsOf(uri),
        now: sessionStore.nowMs,
    });
}

/**
 * 会话图标视图（**四处共用的唯一呈现输入**：nav 行 / 任务表行 / 详情+任务树 / 总览表格）。
 *
 * `null` = 不渲染：任务已 done / cancelled（用户：任务没做完才提示）。
 * 其余一律给（含「未运行」的空心圆 —— 它是状态，不是噪音）。
 */
export function sessionGlyphFor(uri: string, fallback: SessionStateFallback = {}): SessionGlyphView | null {
    const state = sessionStateFor(uri, fallback);
    const node = findNode(taskStore.nodes, uri);
    if (node?.state && SILENT_STATES.has(node.state) && state.run !== "running") return null;
    return glyphOf(state, uri);
}

/** 直接给状态（测试 / 非渲染用途）；同 `sessionStateFor` */
export function sessionGlyphViewOf(state: SessionState, uri = ""): SessionGlyphView {
    return glyphOf(state, uri);
}
