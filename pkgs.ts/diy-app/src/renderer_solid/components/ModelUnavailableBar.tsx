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
import { MODEL_UNAVAILABLE_KIND_LABEL as KIND_LABEL, type ModelUnavailableNotice } from "../../shared/model-unavailable";
import { remedyOf, type Remedy } from "../../shared/error-remedy";
import { NoticeDetail } from "./NoticeDetail";
import type { NoticeMeta } from "../lib/notice";

/**
 * 机制说明（##391 R2）：这条 bar 为什么存在 / 判据是什么 / 关掉意味着什么。
 * 口径来源：`shared/model-unavailable.ts`（四类判据，纯函数）+ `main/services/model-notice.ts`（谁把失败送进来）。
 */
const DETAIL_MODEL = [
    "在监测什么：真发（真 LLM 实验）失败那一刻的上游语义 —— 状态码 + 上游原文 + SDK 消息，交给 shared/model-unavailable.ts 的四类判据：模型未上架 / id 不认识 / 认证失败 / 配额限流（顺序即优先级）。",
    "不在这里面的：上游 5xx、网络超时、连接中断 —— 那是「服务端此刻不稳」，不是「这个模型不能用」。混进来会让 bar 天天亮，用户就不看了，也分不清该去配模型还是等一会儿。",
    "为什么会弹：这类失败原本只落在会话流里，你不看会话就不知道「实验其实一次都没跑成」，agent 也可能悄悄换模型乱试 —— 故把事实提到最显眼处，且**只提示不阻断**（不禁用按钮、不遮罩，实验该跑还跑）。",
    "怎么消：点 ✕ /「知道了」= 关掉当前这一波（main 侧一并记住，重连回放不会再弹同一条）；模型恢复可用或换一个可用模型后自然不再出现。",
    "对你的影响：顶栏出现它时，先按「🛠 去…」处理（改 key / 换模型 id / 等配额）；期间真发不会成功，别再重复试同一件事。",
    "修复引导（##407）：按钮去哪、改哪个字段、填什么，由 shared/error-remedy.ts 的静态判据给出（不调用任何模型）；没有映射的错**不给按钮**（不造假入口）。",
].join("\n");

/** 这条 bar 的二级信息（来源 / 原因 / 机制） */
function metaOf(n: ModelUnavailableNotice): NoticeMeta {
    return {
        source: "模型可用性 · modelNotice（shared/model-unavailable.ts 四类判据 · main/services/model-notice.ts）",
        reason:
            `判据命中 ${n.kind}（${KIND_LABEL[n.kind]}）：模型 ${n.model}` +
            `${n.provider ? `（provider ${n.provider}）` : ""} · 人物 ${n.personaName}` +
            `${n.reason ? ` · ${n.reason}` : ""}${n.upstream ? ` · 上游原文「${n.upstream}」` : ""}`,
        detail: DETAIL_MODEL,
    };
}

export function ModelUnavailableBar(props: {
    notice: ModelUnavailableNotice;
    /** ✕ /「知道了」：关掉当前这波提示（不关实验） */
    onDismiss: () => void;
    /** 「去配置模型」：跳到 设置 → 模型 页（无修复映射时的兜底动作） */
    onConfigure: () => void;
    /**
     * 「🛠 去修复」（##407）：带着**具体锚点**跳到配置页并高亮该字段。
     * 判据在 shared/error-remedy.ts（喂 kind / provider / 状态码），本组件不猜。
     */
    onRemedy: (remedy: Remedy) => void;
}) {
    /** 这条通知的修复动作（null = 表里没有映射 ⇒ 不出现入口） */
    const remedy = () =>
        remedyOf({
            reason: props.notice.reason,
            ctx: {
                kind: props.notice.kind,
                provider: props.notice.provider,
                model: props.notice.model,
                httpStatus: props.notice.statusCode,
            },
        });
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
            {/* ##391：一级说「哪个模型 / 谁在用 / 上游原话」，二级给判据口径与开关语义 */}
            <NoticeDetail
                meta={metaOf(props.notice)}
                message={`${KIND_LABEL[props.notice.kind]} · ${props.notice.model}`}
                label="详情"
                remedy={remedy()}
                onRemedy={props.onRemedy}
            />
            {/* 有映射 → 带着锚点去（真的滚到该字段并高亮）；没有 → 只能开到页面顶部 */}
            <button
                class="btn btn-xs ml-auto"
                data-model-bar-goto
                onClick={() => {
                    const r = remedy();
                    if (r) props.onRemedy(r);
                    else props.onConfigure();
                }}
            >
                {remedy()?.label ?? "去配置模型"}
            </button>
            <button class="btn btn-xs btn-ghost" title="关闭提示（不影响正在跑的流程）" onClick={props.onDismiss}>
                ✕
            </button>
        </div>
    );
}
