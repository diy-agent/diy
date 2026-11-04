/**
 * model-unavailable.ts — ⚠️ 实现已迁到 `@diy-agent/llm-provider`。
 *
 * 为什么迁：这是**协议判据**（上游把「模型不可用」混在 400/404/401/429 里，状态码不足以判），
 * 不是 diy-app 的业务。留在要废弃的 app 里 ⇒ 新架构接真模型后同样分不清
 * 「该去配模型」还是「等一会儿再试」，会重演 ##369（agent 悄悄失败 / 换模型乱试）。
 *
 * 这里只做转发，保住 diy-app 里所有调用点。
 * 判据表与四类边界见 `pkgs.ts/model/provider/src/model-unavailable.ts` 头注。
 */
export {
    MODEL_UNAVAILABLE_KIND_LABEL,
    MAX_UPSTREAM_CHARS,
    ModelUnavailableKindSchema,
    classifyModelUnavailable,
    probeModelError,
    ModelUnavailableNoticeSchema,
    type ModelUnavailableNotice,
    upstreamText,
    type ModelErrorProbe,
    type ModelUnavailableHit,
    type ModelUnavailableKind,
    type ModelUnavailableMiss,
    type ModelUnavailableVerdict,
} from "@diy-agent/llm-provider";
