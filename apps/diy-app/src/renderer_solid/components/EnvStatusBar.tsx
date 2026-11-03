/**
 * EnvStatusBar — 「环境感知」的**顶栏状态条**（##384）—— 磁盘满 / 网断从**沉默**变可见。
 *
 * 形态对齐 ModelUnavailableBar / DynamicBar（贴顶细条：`border-b` + 窄内边距 + `shrink-0`，
 * **不挡内容**、**只提示不阻断**、✕ 可关），而不是 daisyUI 的 alert：alert 语义是"消息块"，
 * 会挤占页面；这条是**状态条**，出现时把内容整体下推一行、关掉即消失。
 *
 * 为什么必须有它（问题本身）：2026-10-18 满盘把 ##166 正文写成 0 字节、2026-10-19 ##377 会话
 * 两次「脚本说成功、文件里却没有」—— 症状是**卡住**，用户与 agent 都只能靠 `du` / `lsof` 猜。
 *
 * 文案三件事（照 ModelUnavailableBar 的口径，少一件用户就得自己去翻日志）：
 *   ① **哪里坏了**（哪个卷 / 网络）
 *   ② **数字证据**（`可用 0.3 G / 共 466 G`、`连败 3 次`）——「更明确的识别」= 给数字，不是给形容词
 *   ③ **该干什么**（「腾空间」/「检查网络」）
 *
 * 多条并存：磁盘满与网断可以**同时**发生 → 堆叠展示（最多 3 条 + 超出折叠计数），
 * 不是只显示一条（只显示一条就会漏掉另一件同样急的事）。
 */
import { For, Show } from "solid-js";
import { fmtDiskBytes, type EnvNotice } from "../../shared/env-watch";
import { NoticeDetail } from "./NoticeDetail";
import type { NoticeMeta } from "../lib/notice";

/**
 * 每类通知的**机制说明**（##391 R2：详情面板要能介绍机制，而不是只重复那一句结论）。
 * 口径来源：`shared/env-watch.ts`（判据纯函数）+ `main/services/env-watch.ts`（轮询与自动消）。
 */
const DETAIL_DISK = [
    "在监测什么：每 30s 用 `statfs` 采一次磁盘可用字节（不 shell 出去跑 `df`）。阈值定死在 shared/env-watch.ts：可用 < 512 MiB = `disk-full`，< 2 GiB = `disk-low`。",
    "另一条触发路径：任何写入报 ENOSPC（磁盘满）时**立刻**升级为 disk-full，不必等下一次轮询 —— 那时文件可能已被写成 0 字节，提示里会点明「刚有写入失败」。",
    "为什么会弹：磁盘满/将满会让「脚本说成功、文件里却没有」（本仓 2026-10 已踩过两次：正文被写成 0 字节）。所以它是**进程级**事实，与具体任务无关。",
    "怎么消：腾出空间后 main 采到水位回到 ok 会**自动撤掉**这条（不用你手动关）；点 ✕ = 「这个条件我知道了」，条件不变不再弹（每 30s 重复弹等于没关），但条件恶化（low → full）仍会重新亮。",
    "对你的影响：出现 disk-full 时，先别信「刚保存成功」—— 去确认文件是否完整；`diy env ls` 可看 main 侧当前全部环境事实。",
].join("\n");

const DETAIL_NET = [
    "在监测什么：网络层错误码族（DNS / 连接被拒 / 不可达 / 超时 / 连接重置）**连续 3 次**才判为断网（阈值 `NETWORK_FAIL_STREAK`）。",
    "为什么不用 `navigator.onLine`：它只反映网卡，不反映上游可达 —— 本仓实测过「网卡好着但上游连不上」（IPv6 ENETUNREACH）。故它只能当辅助。",
    "为什么会弹：真发请求连续失败到阈值，说明此刻 app 做不了需要网络的事（模型调用 / 拉模型列表…），而这在界面上本来就只表现为「卡住」。",
    "怎么消：一旦有一次请求成功（网络恢复）main 自动撤掉；点 ✕ = 该类静音（条件不变不再弹），恢复后再坏才会重新提醒。",
    "对你的影响：`diy doctor` / `diy env ls` 可复核；别在这段时间里反复重试长任务 —— 会淹没真正的原因。",
].join("\n");

/** 一条 env bar 通知的二级信息（##391）：来源 / 原因（带数字与判据）/ 机制 */
function metaOf(n: EnvNotice): NoticeMeta {
    if (n.type === "network-down") {
        const { code, streak, message } = n.data;
        return {
            source: "环境感知 · envWatch 网络（shared/env-watch.ts::classifyNetworkError · main/services/env-watch.ts）",
            reason: `连续 ${streak} 次网络层失败（阈值 3）${code ? `，错误码 ${code}` : ""}${message ? `：${message}` : ""}`,
            detail: DETAIL_NET,
        };
    }
    const { mount, availBytes, totalBytes, source } = n.data;
    const level = n.type === "disk-full" ? "可用 < 512 MiB（disk-full）" : "可用 < 2 GiB（disk-low）";
    const evidence =
        availBytes < 0 || totalBytes < 0
            ? "可用空间读不到（卷可能已不可访问）"
            : `可用 ${fmtDiskBytes(availBytes)} / 共 ${fmtDiskBytes(totalBytes)}`;
    return {
        source: "环境感知 · envWatch 磁盘水位（shared/env-watch.ts::envNoticeFromDisk · main/services/env-watch.ts）",
        reason: `卷 ${mount} ${evidence}，命中 ${level}；采样来源 = ${source === "write-error" ? "写入失败 ENOSPC（被动升级）" : "30s 轮询 statfs"}`,
        detail: DETAIL_DISK,
    };
}

/** 一条通知的展示素材（标签 / 数字证据 / 该干什么），由 type + data 派生 */
function describe(n: EnvNotice): { icon: string; title: string; evidence: string; action: string } {
    switch (n.type) {
        case "disk-full":
        case "disk-low": {
            const { mount, availBytes, totalBytes, source } = n.data;
            // 读不到水位（写失败时 statfs 也失败）→ 明确说"读不到"，绝不编数字
            const evidence =
                availBytes < 0 || totalBytes < 0
                    ? "可用空间：读不到（卷可能已不可访问）"
                    : `可用 ${fmtDiskBytes(availBytes)} / 共 ${fmtDiskBytes(totalBytes)}`;
            const title = n.type === "disk-full" ? "磁盘已满" : "磁盘空间不足";
            const where = mount ? `卷 ${mount}` : "本地磁盘";
            return {
                icon: n.type === "disk-full" ? "⛔" : "⚠️",
                title,
                // 被动来源要点明"这次写入没成功"：用户据此知道要不要复核刚写的东西
                evidence: `${where} · ${evidence}${source === "write-error" ? " · 刚有写入失败（ENOSPC）" : ""}`,
                action: "腾空间",
            };
        }
        case "network-down": {
            const { code, streak, message } = n.data;
            return {
                icon: "⛔",
                title: "网络不可达",
                evidence: `连续 ${streak} 次失败${code ? ` · ${code}` : ""}${message ? ` · ${message}` : ""}`,
                action: "检查网络",
            };
        }
    }
}

export function EnvStatusBar(props: {
    /** 当前要显示的通知（时间升序；超出 MAX_BARS 的已由调用方折叠） */
    notices: EnvNotice[];
    /** 被折叠的条数（>0 时显示 `+N`） */
    overflow: number;
    /** ✕：关掉这一条（main 侧同时静音该类，条件不变不再弹） */
    onDismiss: (id: string) => void;
}) {
    return (
        // 容器本身不占位：没有通知时调用方不渲染（见 App.tsx 的 <Show>）
        <div data-env-status-bar class="flex shrink-0 flex-col">
            <For each={props.notices}>
                {(n) => {
                    const d = describe(n);
                    // 红系（error）是硬要求（用户原话「弹红色 error 提示」）；disk-low 是提醒 → 黄系。
                    // 两者共用同一形态：只换配色，不换结构（bar 层不长两套逻辑）。
                    const tone = n.level === "error" ? "border-error/40 bg-error/15" : "border-warning/40 bg-warning/15";
                    return (
                        <div
                            data-env-status-bar-item={n.type}
                            class={`flex shrink-0 flex-wrap items-center gap-2 border-b ${tone} px-2 py-1 text-body`}
                            role="status"
                        >
                            <span class="font-semibold">
                                {d.icon} {d.title}
                            </span>
                            {/* 数字证据：允许截断（长错误消息），全文进 title */}
                            <span class="max-w-[60%] truncate font-mono text-xs opacity-80" title={d.evidence}>
                                {d.evidence}
                            </span>
                            <span class="ml-auto text-xs opacity-70">→ {d.action}</span>
                            {/* ##391：一级只给结论（哪里坏 / 数字 / 该干什么），二级给来源·原因·机制 */}
                            <NoticeDetail meta={metaOf(n)} message={`${d.title} · ${d.evidence}`} label="详情" />
                            <button
                                class="btn btn-xs btn-ghost"
                                data-env-dismiss="1"
                                title="关闭提示（条件不变不再弹；条件恢复后自动消）"
                                onClick={() => props.onDismiss(n.id)}
                            >
                                ✕
                            </button>
                        </div>
                    );
                }}
            </For>
            <Show when={props.overflow > 0}>
                {/* 超出折叠：不逐条铺（3 条以上用户就不看了），给一个计数即可 */}
                <div class="shrink-0 border-b border-error/40 bg-error/10 px-2 py-0.5 text-xs opacity-70">
                    还有 {props.overflow} 条环境提示（`diy env ls` 看全部）
                </div>
            </Show>
        </div>
    );
}
