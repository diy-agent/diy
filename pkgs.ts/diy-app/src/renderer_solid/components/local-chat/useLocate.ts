/**
 * useLocate — 对话区的两套「定位闭环」（##389 数据层检索 / ##408 刀 6 作业来源）。
 *
 * 从 `LocalChatPage` 逐字搬出（##448 刀 2：页面文件 ≤1200 行）。判据没动：
 *   · ① 在树、只在窗口外 → 纯滚动（`scrollToTurn`，不碰数据）
 *   · ② 不在树 → `localChatStore.jumpTo` 段跳取一段回来，再走 ①
 *   · ③ 正在流式 → 不抢滚动：记下目标，等这一轮收尾再定位
 * 到位后：目标轮高亮 800ms + 命中字用 Highlight API 点亮（都不改 DOM、不改 store 数据）。
 *
 * 依赖一律**传进来**（`LocateDeps`），Hook 内部不新建 store / 不复制状态 —— 占位与页面同源。
 */
import { createEffect, on, untrack } from "solid-js";
import { localChatStore } from "../../store/localChatStore";
import { chatNotice, DETAIL_CHAT_FIND } from "../../lib/notice-chat";
import { notificationStore } from "../../store/notificationStore";
import { chatFindStore, type ChatFindHit } from "../../store/chatFindStore";
import { chatNavStore, type ChatNavTarget } from "../../store/chatNavStore";
import { findStore } from "../../store/findStore";
import { clearHitHighlight, paintHitHighlight } from "../../lib/hit-highlight";
import type { BlockNode } from "../../../main/services/local-blocks";
import { turnRows } from "../../lib/chat-fold";
import { blockElOf, blockTopIn, containsBlockId } from "./MessageStream";

import type { Setter } from "solid-js";
import type { RowLayout } from "../../lib/chat-virtual";

export interface LocateDeps {
    /** 当前会话（页面的 `uri`） */
    uri: () => string | null;
    /** 块树滚动容器（页面的 `scrollRef`） */
    scrollEl: () => HTMLDivElement | undefined;
    /** 账面布局（行键 /  Heights 前缀和） */
    layout: () => RowLayout & { keys: string[]; heights: number[] };
    writeScrollTop: (el: HTMLDivElement, v: number) => number;
    anchorRowIndex: (blockId: string) => number;
    renderedTurnIds: () => Set<string>;
    /** 页面记下"本页认领过的 uri"（卸载时按它交还面板归属） */
    onClaim: (u: string | null) => void;
    setStick: Setter<boolean>;
    histOpenOf: (turnId: string) => boolean;
    setFoldMarks: Setter<Record<string, boolean>>;
    setPinned: Setter<Record<string, boolean>>;
}

export function useLocate(d: LocateDeps) {
    // 依赖一律按名解构：搬出来的正文**逐字不动**（只把 `scrollRef` 换成 `d.scrollEl()`）。
    const { uri, layout, writeScrollTop, anchorRowIndex, renderedTurnIds, setStick, histOpenOf, setFoldMarks, setPinned } = d;
    // ─── 数据层检索的定位（##389）──────────────────────────────────────────────
    // 三条路（判据 = 目标轮在不在块树里 / 在不在窗口里）：
    //   ① 在树、只在窗口外 → 纯滚动（`scrollToTurn`，不碰数据）；
    //   ② 不在树（早于最老段）→ `localChatStore.jumpTo` 段跳取一段回来，再走 ①；
    //   ③ 正在流式 → **不抢滚动**：记下目标，等这一轮收尾（`view.live` 下降沿）再定位。
    // 到位后：目标轮高亮 800ms + 该轮内的命中字用 Highlight API 点亮（都不改 DOM、不改 store 数据）。
    let pendingLocate: { turnId: string; hit: ChatFindHit } | null = null;
    /** 定位闭环的"手"柄：用户一滚就收手（别和目标轮较劲） */
    let locateLatch = 0;
    /**
     * 定位闭环上一拍**我们自己写的** scrollTop —— 跟它比对就知道这一拍是不是人滚的
     * （`progWriteTop` 是同一思路：区分"谁写的滚动"）。`null` = 闭环没在跑。
     */
    let locateOwnTop: number | null = null;

    const flashTurn = (turnId: string) => {
        const el = d.scrollEl();
        if (!el) return;
        const node = el.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
        if (!node) return;
        node.setAttribute("data-hit-flash", "1");
        paintHitHighlight(node, chatFindStore.query);
        window.setTimeout(() => {
            // 用户可能已经滚走/该轮已被虚拟化摘掉：属性留在离屏节点上无害，故不做存在性判断
            node.removeAttribute("data-hit-flash");
        }, 800);
    };

    /**
     * 滚到某一轮（**闭环校正**，与 `applyAnchor` 同一手法）：
     * 先按账面顶边把窗口挪过去（`writeScrollTop` 会同步窗口信号 ⇒ 那一轮这一帧就上屏），
     * 再量真实位置、把偏差补掉，两三帧内收敛（未实测行的高度估算会在这儿被实测值替换）。
     * 硬上限 12 帧（200ms）：收敛不了也不再拉扯（估算高度抖动的极端情形），宁可差几像素。
     *
     * **用户接管即收手**（R1）：每一拍拿 `locateOwnTop`（上一拍我们写的位置）与当前 `scrollTop`
     * 比对 —— 对不上就是人滚了（滚轮 / 拖条 / 触控板），当场作废闭环，**不再把人拽回去、也不闪**。
     * 唯一豁免：内容变矮时浏览器把 `scrollTop` **收口**到新的 max（那不是人滚的），否则
     * 「定位到靠近末尾的轮」会被自己的布局变化取消掉。
     */
    const scrollToTurn = (turnId: string) => {
        const el = d.scrollEl();
        if (!el) return;
        setStick(false); // 定位到历史 = 用户要看的那一轮，别让"贴底跟随"再把视口拽走
        const token = ++locateLatch;
        locateOwnTop = el.scrollTop; // 起点：第一拍之前（~16ms 内）人滚了也要能认出来
        let stable = 0;
        let left = 12;
        const tick = () => {
            if (token !== locateLatch) return; // 又点了一次结果 / 用户手动接管
            // 用户接管：这一拍的位置不是我们上一拍写的那儿 ⇒ 收手（判据见函数头注）
            const own = locateOwnTop;
            if (own !== null && Math.abs(el.scrollTop - own) > 1.5) {
                const max = el.scrollHeight - el.clientHeight;
                const clamped = el.scrollTop < own && el.scrollTop >= max - 1;
                if (!clamped) {
                    locateLatch++;
                    return;
                }
            }
            const L = layout();
            const ri = L.keys.indexOf(turnId);
            if (ri < 0) return; // 这一轮已不在树里（日志被改写）⇒ 放弃，不猜位置
            const node = el.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
            if (node) {
                // 目标轮顶离容器顶 8px：轮首的用户气泡整条可见，且明确"这一轮从这儿开始"
                const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
                const d = top - 8;
                if (Math.abs(d) > 1) writeScrollTop(el, el.scrollTop + d);
                stable = Math.abs(d) <= 1 ? stable + 1 : 0;
            } else {
                // 还没上屏：按账面顶边把它挪进窗口（下一帧它就有 DOM 了）
                writeScrollTop(el, L.tops[ri] ?? 0);
                stable = 0;
            }
            if (stable >= 2 || left-- <= 0) {
                flashTurn(turnId);
                return;
            }
            locateOwnTop = el.scrollTop; // 下一拍拿它判「是不是人滚了」
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    const locateHit = (hit: ChatFindHit) => {
        const u = uri();
        if (!u) return;
        clearHitHighlight();
        // ③ 流式中：先稳态（口径 4）—— 此刻抢滚动会和"跟随新内容"互相拉扯
        if (localChatStore.view.live) {
            pendingLocate = { turnId: hit.turnId, hit };
            notificationStore.addToast(
                "info",
                "这一轮正在生成：结束后自动定位到命中处",
                chatNotice(
                    "检索定位 · locateHit（##389）",
                    `命中处落在本轮 ${hit.turnId} 尚未写完的内容里；此刻抢滚动会与「跟随新内容」互相拉扯 → 已记下命中位置，轮结束后自动滚过去`,
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        void (async () => {
            const inTree = localChatStore.trees.some((t) => t.id === hit.turnId);
            if (!inTree) {
                const ok = await localChatStore.jumpTo(u, hit.at);
                if (!ok) {
                    notificationStore.addToast(
                        "error",
                        "定位失败：会话日志已被改写（这一轮的字节位置不再有效），请重新检索",
                        chatNotice(
                            "检索定位 · jumpTo（##389）",
                            `命中记录的轮 ${hit.turnId} 在盘上的字节位置 ${hit.at} 已失效（日志被改写/清空）→ 视图**未移动**（不会跳到错的地方）；重新检索可拿到新位置`,
                            DETAIL_CHAT_FIND,
                        ),
                    );
                    return;
                }
            }
            scrollToTurn(hit.turnId);
        })();
    };

    // ─── 作业来源定位（##408 刀 6）────────────────────────────────────────────
    // 用户从「作业」面板点「来源」⇒ 这里把视口送到那次 tool_call 块并高亮。
    // 与检索定位（##389）**同一套手法**（`anchorRowIndex` + 闭环校正 + 用户接管即收手），
    // 差别只在终点粒度：检索要跳的是「这一轮的命中字」，作业要跳的是「这一轮里的某一个块」。
    let pendingBlockLocate: ChatNavTarget | null = null;

    /** 高亮一个块（沿用 `data-hit-flash`：轮级高亮与块级高亮同一条通道，样式在 index.css） */
    const flashBlock = (blockId: string) => {
        const el = d.scrollEl();
        if (!el) return;
        const node = blockElOf(el, blockId);
        if (!node) return;
        node.setAttribute("data-hit-flash", "1");
        window.setTimeout(() => node.removeAttribute("data-hit-flash"), 1600);
    };

    /**
     * 滚到**某一块**（不是某一轮）：闭环校正的靶子是块顶，行索引用 `anchorRowIndex(blockId)`
     * —— 它返回的是**包含该块的那一轮**的行号，故"轮还没上屏"时仍能按账面顶边把窗口挪过去。
     * 用户接管即收手（与 `scrollToTurn` 同一判据，含「内容变矮被浏览器收口」的豁免）。
     */
    const scrollToBlock = (turnId: string, blockId: string) => {
        const el = d.scrollEl();
        if (!el) return;
        setStick(false); // 定位到历史 = 用户要看的那一处，别让"贴底跟随"再把视口拽走
        const token = ++locateLatch;
        locateOwnTop = el.scrollTop;
        let stable = 0;
        let left = 12;
        const tick = () => {
            if (token !== locateLatch) return;
            const own = locateOwnTop;
            if (own !== null && Math.abs(el.scrollTop - own) > 1.5) {
                const max = el.scrollHeight - el.clientHeight;
                const clamped = el.scrollTop < own && el.scrollTop >= max - 1;
                if (!clamped) {
                    locateLatch++;
                    return;
                }
            }
            const L = layout();
            const ri = anchorRowIndex(blockId);
            const rowIdx = ri >= 0 ? ri : L.keys.indexOf(turnId);
            if (rowIdx < 0) return; // 这一轮已不在树里（日志被改写）⇒ 放弃，不猜位置
            const node = blockElOf(el, blockId);
            if (node) {
                // 块顶留 32px：过程行的行头（时间 / 工具名）整条可见——"从这儿开始"要看得见主语
                const top = blockTopIn(el, node) - el.scrollTop;
                const d = top - 32;
                if (Math.abs(d) > 1) writeScrollTop(el, el.scrollTop + d);
                stable = Math.abs(d) <= 1 ? stable + 1 : 0;
            } else {
                writeScrollTop(el, L.tops[rowIdx] ?? 0);
                stable = 0;
            }
            if (stable >= 2 || left-- <= 0) {
                flashBlock(blockId);
                return;
            }
            locateOwnTop = el.scrollTop;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    /**
     * 定位到作业的来源块。
     *
     * 三级降级（与 job-run 的硬约束 2 一致：origin 是**引用**，点开时去读那边真源）：
     *   ① 这一轮在块树里 → 滚过去 + 高亮该块；
     *   ② 正在流式 → 记下，轮末再跳（此刻抢滚动会与"跟随新内容"打架）；
     *   ③ 不在块树（历史被压缩 / 未加载 / 日志已轮转）→ **视图不动**，如实说"原文不可用"，
     *      并指向作业面板里的落盘输出。绝不跳到一个"看起来像"的位置（那是假导航）。
     */
    /**
     * 拿插话队列项 id 反查块（##436）：留言投递时块还没生成，只有 `steerId` 是当时就有的锚点。
     *
     * 判据：块树的 `attrs.steerId`（`local-agent.steerBlockOps` 落盘时就带上，见
     * `shared/room.RoomDelivery.steerId`）；找不到 = 那一轮还没跑 / 历史被压缩。
     */
    const steerAnchorOf = (steerId: string): { turnId: string; blockId: string } | null => {
        const walk = (n: BlockNode): BlockNode | null => {
            if (n.attrs["steerId"] === steerId) return n;
            for (const c of n.children) {
                const hit = walk(c);
                if (hit) return hit;
            }
            return null;
        };
        for (const tr of localChatStore.trees) {
            const hit = walk(tr);
            if (hit) return { turnId: tr.id, blockId: hit.id };
        }
        return null;
    };

    const locateJobTarget = (t: ChatNavTarget) => {
        clearHitHighlight();
        // steer 锚点先翻译成 轮/块 —— 之后**只有一条**定位路径（不另写一套滚动/展开逻辑）
        const resolved = t.turnId && t.blockId ? { turnId: t.turnId, blockId: t.blockId } : t.steerId ? steerAnchorOf(t.steerId) : null;
        const fromInbox = t.origin === "inbox";
        if (localChatStore.view.live) {
            pendingBlockLocate = t;
            notificationStore.addToast(
                "info",
                resolved ? `这一轮正在生成：结束后自动定位到${fromInbox ? "那条留言" : "那次工具调用"}` : "这一轮正在生成：结束后再看你的留言",
                chatNotice(
                    fromInbox ? "通知信箱 · 去来源会话（##436）" : "作业来源 · locateJobTarget（##408）",
                    resolved
                        ? `锚点落在本轮 ${resolved.turnId} 仍在写入的内容里 → 已记下，轮结束后再滚过去（流式中抢滚动会与跟随打架）`
                        : "这一轮还在跑，块还没落盘 ⇒ 此刻定位不到；轮末自动再试一次（原文在信箱面板里，随时可读）",
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        if (!resolved) {
            // 说清楚"为什么没定位"——body 硬要求：不许只开 tab 还不说
            notificationStore.addToast(
                "info",
                fromInbox ? "已打开会话；这条留言还没有轮次锚点（可能尚未被投递）" : "原文已不可用：这一轮不在当前窗口",
                chatNotice(
                    fromInbox ? "通知信箱 · 去来源会话（##436）" : "作业来源 · locateJobTarget（##408）",
                    fromInbox
                        ? `留言锚点（steerId=${t.steerId ?? "无"}）在已加载的块树里找不到 —— 它插进的那一轮可能还没跑，或历史被压缩。` +
                          "**视图未移动**；原文请回信箱面板读（那里存了未截断的留言）。"
                        : `锚点 轮 ${t.turnId ?? "?"} / 块 ${t.blockId ?? "?"} 不在已加载的块树里（压缩历史或日志轮转）⇒ 视图**未移动**；` +
                          "作业面板里的 settle 输出与 logs/<runId>.log 才是这次的原文",
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        const inTree = localChatStore.trees.some((tr) => tr.id === resolved.turnId || containsBlockId(tr, resolved.blockId));
        if (!inTree) {
            notificationStore.addToast(
                "info",
                "原文已不可用：这一轮不在当前窗口（历史被压缩或未加载）→ 输出请看作业详情",
                chatNotice(
                    "作业来源 · locateJobTarget（##408）",
                    `锚点 轮 ${t.turnId} / 块 ${t.blockId} 不在已加载的块树里（压缩历史或日志轮转）⇒ 视图**未移动**；` +
                        `作业面板里的 settle 输出与 logs/<runId>.log 才是这次的原文`,
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        revealBlock(resolved.turnId, resolved.blockId);
        scrollToBlock(resolved.turnId, resolved.blockId);
    };

    /**
     * 让目标块**真的进 DOM**（否则滚动没靶子，高亮也无处可画）。
     *
     * 两道门（默认 3 级下都可能挡着）：
     *   ① 过程历史整段关着（1-2 级，或用户收拢了这轮）⇒ 只把**这一轮**的历史打开；
     *   ② 目标块在某个「过程 bar」里（3 级下 bar 是折叠的）⇒ pin 开**那一段**
     *      （键 `row:<段首叶子 id>`，与组件里 `rowOpen` 同一口径）。
     * 都不动全局级别 —— 为了看一条工具调用把整页铺成 4 级，会把用户正在读的地方全改掉。
     */
    const revealBlock = (turnId: string, blockId: string) => {
        const turn = localChatStore.trees.find((tr) => tr.id === turnId || containsBlockId(tr, blockId));
        if (!turn) return;
        if (!histOpenOf(turnId)) setFoldMarks((p) => ({ ...p, [turnId]: false }));
        for (const row of turnRows(turn, null)) {
            if (row.kind !== "proc") continue;
            if (!row.parts.some((n) => n.id === blockId)) continue;
            setPinned((p) => ({ ...p, [`row:${row.key}`]: true }));
            break;
        }
    };

    /**
     * 消费「作业面板 / 通知信箱发来的待定位请求」（同一条通道，`chatNavStore`）。
     *
     * 为什么放在会话页而不是面板里：只有这里拿得到滚动容器与块树（与 `chatFindStore.claim` 同一理由）。
     * 三个条件（等任务切过来 + 等会话数据到位 + 等块树非空）都是必需的：
     * 面板点「来源」时先 `openTaskRun` 切页，本页**可能整页新挂**，那一刻 trees 还是空的。
     */
    createEffect(() => {
        const target = chatNavStore.pending;
        if (!target) return;
        const u = uri();
        if (!u || u !== target.taskUri) return;
        if (localChatStore.currentUri !== u) return;
        if (localChatStore.trees.length === 0) return;
        const taken = chatNavStore.take(u);
        if (taken) locateJobTarget(taken);
    });

    /** 流式收尾后补做待定的定位（只做一次：轮末下降沿是"现在可以抢滚动"的唯一时机） */
    createEffect(
        on(
            () => localChatStore.view.live,
            (live) => {
                if (live) return;
                if (pendingLocate) {
                    const p = pendingLocate;
                    pendingLocate = null;
                    locateHit(p.hit);
                    return;
                }
                if (pendingBlockLocate) {
                    const b = pendingBlockLocate;
                    pendingBlockLocate = null;
                    locateJobTarget(b);
                }
            },
        ),
    );

    // 面板归属哪个任务：跟着 uri 走（首挂时 uri 可能还没到，故不能只靠 onMount 那一次）。
    // `ownerUri` 记下**本页认领过的**那个 uri：卸载时按它交还（不能拿卸载那一刻的 uri() 去比
    // —— 那时 props 可能已被上层置空，会比不上，于是"永不清空"或者"错清别人"）。
    createEffect(
        on(uri, (u) => {
            d.onClaim(u);
            chatFindStore.claim(u, locateHit);
        }),
    );

    // 桥接探针（口径 1）：页内查找 0/0 时对数据层探一次，让 FindBar 能说出「本会话另有 N 处」。
    // 只在「页内没找到**且**查询非空」时探 —— 页内找到了就没必要再扫一遍数据层。
    createEffect(() => {
        const q = findStore.query;
        const n = findStore.count;
        const open = findStore.open;
        const u = uri();
        // ⚠️ **untrack**：`renderedTurnIds()` 依赖虚拟窗口，直接读会让"每滚一帧就整份重扫"
        // （74MB 会话 = 滚动时主进程反复从头读文件，且边滚边重扫永远探不出结论）。
        // 「其中几处未渲染」只是**探针那一刻**的快照 —— 它是一句提示，不必逐帧精确。
        const rendered = untrack(renderedTurnIds);
        if (!open || !u || !q.trim() || n > 0) {
            chatFindStore.clearProbe();
            return;
        }
        chatFindStore.probeDeep(u, q, rendered, chatFindStore.scopes);
    });

    return {
        flashTurn,
        flashBlock,
        locateHit,
        locateJobTarget,
        revealBlock,
        scrollToBlock,
        scrollToTurn,
    };
}
