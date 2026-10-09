/**
 * 推理强度（Reasoning Effort）词表 —— **显示层唯一入口**。
 *
 * 契约：可选值由 provider / 模型决定（`LocalModelReasoning.supported`），diy 不假定档位。
 * 各家集合并不相同（opencode-go 侧就有 none/minimal/low/medium/high/xhigh/ultra/max，
 * 「supported reasoning efforts vary by model」）。逐模型的 supported 来源见
 * shared/model-config.reasoningFromSpec：spec 声明的 effort 词表，或未登记枚举时的**通用兜底集**。
 * 所以这里只做**翻译**（词表只收录**至少一个在册模型真支持**的值）：
 *   · 词表里有的值 → 显示中文
 *   · 词表里没有的值 → 原样显示（provider 新增档位时 UI 不会丢失、也不会错译成别的档）
 *
 * 不改写取值：发给上游的始终是原始 provider 值（见 local-agent.ts 的 reasoning 参数）。
 */
export const REASONING_EFFORT_LABELS: Record<string, string> = {
  /** 哨兵：不发送任何推理参数（平台默认；见 shared/model-config.DEFAULT_EFFORT） */
  default: "平台默认",
  none: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  ultra: "极高",
  max: "最大",
};

/** provider 值 → 界面文案（未知值原词显示） */
export function reasoningEffortLabel(effort: string): string {
  return REASONING_EFFORT_LABELS[effort] ?? effort;
}
