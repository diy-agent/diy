/**
 * ModelUnavailableBar — 真 LLM 实验里「模型不可用」的**顶栏 bar**（##369 ①）。
 *
 * 形态对齐 DynamicBar（贴顶细条：`border-b` + 窄内边距 + `shrink-0`，**不挡内容**），
 * 而不是 daisyUI 的 alert：alert 的语义是"消息块"，会挤占页面；这条是**状态提示条**，
 * 出现时把内容整体下推一行、关掉即消失。
 *
 * 为什么必须有它（问题本身）：模型挂掉时失败只落在会话流里 —— 用户不看会话就不知道
 * "实验其实一次都没跑成"，agent 则可能悄悄换模型乱试。这条 bar 把事实摆到最显眼处。
 *
 * 只提示、不阻断：没有禁用按钮、没有遮罩，实验该跑还跑（用户的 `停止/中断` 口径也是
 * "不要 block 实验"）。文案三件事：**哪个模型**（model）+ **哪个任务/人物在用** +
 * **上游原话**（upstream）—— 少了任何一件，用户都得自己去翻日志才知道发生了什么。
 */
import type { ModelUnavailableNotice } from "../../shared/model-unavailable";

/** 四类判据 → 一句话标签（用户不必知道判据名，只需知道"该干什么"） */
const KIND_LABEL: Record<ModelUnavailableNotice["kind"], string> = {
    "coming-soon": "模型未上架",
    "unknown-model": "模型 id 不认识",
    auth: "认证失败",
    quota: "配额或限流",
};

export function ModelUnavailableBar(props: {
    notice: ModelUnavailableNotice;
    /** ✕ /「知道了」：关掉当前这波提示（不关实验） */
    onDismiss: () => void;
    /** 「去配置模型」：跳到 设置 → 模型 页（用户要做的动作就这一件事） */
    onConfigure: () => void;
}) {
    return (
        <div
            data-model-unavailable-bar
            // 红系（error）而不是黄系：这是"实验跑不成"的硬失败，不是"建议看一眼"的提醒。
            class="flex shrink-0 flex-wrap items-center gap-2 border-b border-error/40 bg-error/15 px-2 py-1 text-body"
            role="status"
        >
            <span class="font-semibold">⛔ {KIND_LABEL[props.notice.kind]}</span>
            <code class="rounded-field bg-base-100 px-1.5 py-0.5 font-mono text-xs">{props.notice.model}</code>
            <span class="opacity-80">
                人物 <span class="font-mono">{props.notice.personaName}</span> 的这次真发失败：
                {props.notice.reason}
            </span>
            {/* 上游原文：用户最需要看到的"到底说了什么"。超长已由判据侧截断（300 字），
                这里再 truncate 一行 + title 全文，避免把 bar 撑成三行。 */}
            <span class="max-w-[40%] truncate font-mono text-xs opacity-70" title={props.notice.upstream}>
                {props.notice.upstream || "(上游未回正文)"}
            </span>
            <button class="btn btn-xs ml-auto" onClick={props.onConfigure}>
                去配置模型
            </button>
            <button class="btn btn-xs btn-ghost" title="关闭提示（不影响正在跑的流程）" onClick={props.onDismiss}>
                ✕
            </button>
        </div>
    );
}
