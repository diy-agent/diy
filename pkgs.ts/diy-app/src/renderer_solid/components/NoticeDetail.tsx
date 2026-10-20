/**
 * NoticeDetail — 任何用户可见提示的 **`[详情]` 按钮 + 二级面板**（##391 R2）。
 *
 * 用户原话：「需提供详情按钮展开 2 级信息，不然我也不知道 app 在干啥，提示这个是啥意思，
 * 详情里需要介绍机制。」于是**一级**只留一句话（不打扰），**二级**必须能答完三问：
 *   来源（谁发的 + 代码位置）/ 原因（带数字与时刻）/ 机制（在监测什么·何时有·怎么消·意味着什么）。
 *
 * 形态与取舍：
 *   · 面板 `absolute` 定位在按钮下方、白底（提示本身可能是深色 alert，面板要在任何底色上都读得清）；
 *   · 面板**不占布局**：顶栏 bar / 角标 toast 都贴着内容，撑开一行会把页面顶下去，反而更打扰；
 *   · 「复制」给的是 `noticeCopyText` 的固定格式 —— 用户反馈时贴回来，agent 一眼看到来源与机制。
 *
 * 不是业务组件：它只认识 `NoticeMeta`，所以 toast / 常驻条 / env bar / model bar 共用同一个。
 */
import { createSignal, For, Show } from "solid-js";
import { noticeCopyText, NOTICE_FIELDS, NOTICE_FIELD_LABEL, type NoticeMeta } from "../lib/notice";

export function NoticeDetail(props: {
    meta: NoticeMeta;
    /** 一级文案（复制时带上，避免"复制了机制却不知道是哪条提示"） */
    message?: string;
    /** 提示产生的时刻（复制时带上） */
    when?: number;
    /** 按钮文案（缺省「详情」；常驻条用它写「详情」即可） */
    label?: string;
}) {
    const [open, setOpen] = createSignal(false);
    const [copied, setCopied] = createSignal(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(noticeCopyText(props.meta, { message: props.message, when: props.when }));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch {
            // 剪贴板不可用时**不弹新提示**（那会变成"提示的提示"）；面板本身可选中复制。
            setCopied(false);
        }
    };

    return (
        <div class="relative shrink-0" data-notice-detail>
            <button
                class="btn btn-ghost btn-xs"
                data-notice-detail-toggle="1"
                aria-expanded={open()}
                title="详情：谁发的 / 为什么现在发 / 机制说明（可复制）"
                onClick={() => setOpen((v) => !v)}
            >
                {props.label ?? "详情"}
            </button>
            <Show when={open()}>
                <div
                    data-notice-detail-panel="1"
                    class="absolute right-0 top-full z-[10000] mt-1 w-[min(92vw,36rem)] max-h-[60vh] overflow-auto rounded-box border border-base-300 bg-base-100 p-3 text-left text-xs text-base-content shadow-2xl"
                >
                    <div class="mb-2 flex items-center gap-2">
                        <span class="font-semibold">这条提示的来龙去脉</span>
                        <button class="btn btn-ghost btn-xs ml-auto" data-notice-detail-copy="1" onClick={() => void copy()}>
                            {copied() ? "已复制" : "复制"}
                        </button>
                        <button class="btn btn-ghost btn-xs" onClick={() => setOpen(false)}>
                            ✕
                        </button>
                    </div>
                    <Show when={props.message}>
                        <div class="mb-2 rounded-field bg-base-200 px-2 py-1 font-mono text-[11px] opacity-80">
                            {props.message}
                        </div>
                    </Show>
                    <For each={NOTICE_FIELDS}>
                        {(f) => (
                            <div class="mb-2" data-notice-field={f}>
                                <div class="mb-0.5 font-semibold opacity-70">{NOTICE_FIELD_LABEL[f]}</div>
                                <div class={f === "detail" ? "whitespace-pre-wrap leading-relaxed" : "break-words"}>
                                    {props.meta[f]}
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}
