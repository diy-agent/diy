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
                            <button
                                class="btn btn-xs btn-ghost"
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
