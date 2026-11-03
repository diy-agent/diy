/**
 * CacheHintBar — 「缓存可能已冷」的**顶栏单行条**（##477）。
 *
 * 形态对齐 EnvStatusBar / ModelUnavailableBar（贴顶细条：`border-b` + 窄内边距 + `shrink-0`，
 * 不挡内容、只提示不阻断、✕ 可关），但**只有一行**：
 *   用户硬要求「绝不叠加、绝不弹窗」。多条只更新那一行 —— 新提示替换旧的，DOM 里始终最多
 *   一个 `[data-cache-hint-bar]`。逐条排队弹会刷屏，而这一行的动作（换模型 / 先压缩）对每个
 *   渠道都一样，说最新那条就够。
 *
 * 文案三件事（照既有 bar 的口径）：
 *   ① **哪个事实**（缓存可能已冷）
 *   ② **数字证据**（距上次 42min、越过的边界是 15min 失效点、今日第 3 次）
 *   ③ **该干什么**（换个模型或先压缩）
 * 二级信息（来源 / 原因 / 机制）走 NoticeDetail（##391）—— 这里只渲染，不猜判据。
 */
import type { CacheHint } from "../../shared/cache-hint";
import { cacheHintText, formatGap } from "../../shared/cache-hint";
import { NoticeDetail } from "./NoticeDetail";
import type { NoticeMeta } from "../lib/notice";

/** 这条 bar 的机制说明（二级信息：详情面板要能介绍机制，而不只重复结论） */
const DETAIL_CACHE = [
    "在监测什么：每轮**首步请求发出前**的间隔（距同一渠道上一次首步请求多久）。轮内后续步挨着发（秒级），不参与统计 —— 那会把 P90 拖歪。",
    "两个边界怎么来：safePoint = 最近 100 次首步**真命中**（cacheRead / 输入 > 0.9）请求的 gap 的 P90；failPoint = 首步**几乎全未命中**（< 5%）的那次 gap，只降不升。维度是 provider × model —— 同模型换渠道（opencode-go / 直连）缓存行为差一个量级。",
    "为什么是 max(safePoint, failPoint)：safePoint 更高时说明有更多成功案例支持更长安全期，那次失败更可能是异常 ⇒ 不提示。failPoint 仍照实记着（事实），只是不触发提示。",
    "什么时候不提示：没有失败记录（failPoint = +∞）时不提示 —— 没有证据就不猜；间隔 ≤ 60s 时也不提示。",
    "怎么消：点 ✕ = 关掉这一条（它描述的是**已经发生**的那次请求，不会再自己冒出来）；下一次越界是一条新事实，该亮还是会亮。",
    "对你的影响：出现它说明这一轮整段上下文按全价重付了。想省钱：换一个缓存更耐用的渠道（或先压缩再发），或者别隔太久再发。",
].join("\n");

export function CacheHintBar(props: {
    hint: CacheHint;
    /** ✕：关掉当前这一条（main 侧一并清，重连不再回放） */
    onDismiss: () => void;
}) {
    const meta = (): NoticeMeta => {
        const h = props.hint;
        return {
            source: "冷缓存提示 · cacheHint（shared/cache-hint.ts 判据 · main/services/cache-hint.ts）",
            reason:
                `渠道 ${h.channel} · 距上次首步请求 ${formatGap(h.gapMs)}，` +
                `越过 ${formatGap(h.thresholdMs)}（${h.thresholdKind === "fail" ? "记录过的失效点" : "成功样本撑出来的安全期"}）；` +
                `safePoint ${formatGap(h.safePointMs)} / failPoint ${h.failPointMs === null ? "+∞（还没失败过）" : formatGap(h.failPointMs)}`,
            detail: DETAIL_CACHE,
        };
    };
    return (
        <div
            data-cache-hint-bar="1"
            role="status"
            aria-live="polite"
            class="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-2 py-1 text-body"
        >
            <span class="min-w-0 flex-1 truncate" title={cacheHintText(props.hint)}>
                {cacheHintText(props.hint)}
            </span>
            <span class="shrink-0 text-xs opacity-60">{props.hint.model}</span>
            <NoticeDetail
                meta={meta()}
                message={cacheHintText(props.hint)}
                when={Date.parse(props.hint.ts)}
                label="详情"
            />
            <button
                type="button"
                class="btn btn-ghost btn-xs shrink-0"
                data-cache-hint-dismiss="1"
                title="关掉这一条（描述的是已发生的那次请求，不会再自己冒出来）"
                onClick={() => props.onDismiss()}
            >
                ✕
            </button>
        </div>
    );
}
