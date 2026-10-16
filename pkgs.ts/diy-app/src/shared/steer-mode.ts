// src/shared/steer-mode.ts
// 🎯 插话投递时机的**展示层**归一与文案 + **缺省时机**常量（UI / main / 测试共用）
//
// 为什么归一放在读侧：入参来自 **ops 日志里的块 meta**，而那份日志是 append-only 的史书 ——
// 枚举最初叫 `step` / `turn`，后改名 `next-step` / `next-turn`（与 dsh 的两个 inbox 对齐），
// 两种值会长期共存于历史日志。不归一就会把旧的 `step` 落进 else 分支
// → 显示成「下一轮」，**语义正好相反**。
//
// 映射不了的（未来新值 / 手改的怪值）**原样呈现**，不猜 —— 显示得难看但不说谎。

/**
 * 插话提交时的**缺省投递时机**：排到**下一步**（提交后可在横条上切回下一轮）。
 *
 * 为什么缺省是「下一步」：用户经验是 **95% 的插话都是"立刻补一句 / 纠正"**，要的是马上生效；
 * 「排在这一轮之后」是少数派，留给横条开关（`toggleSteerMode`）去选。
 * 「下一步」自带降级：本轮已收尾则作为下一轮开场立刻发出（不是丢回队列，见 `steerModeTip`）。
 *
 * 为什么这个常量放 shared 而不是写入侧 `main/core/drafts.ts`：同一队列有**两个入口**
 * —— UI 的「留言」按钮与「会话生成中再发消息」的自动排队（`local-agent.ts`），
 * 缺省时机必须一致（否则同一条队列里两种语义）。而 UI **不能**从 main 取运行时值
 * （main 模块碰 fs，进 renderer 包即破），故落跨层契约层，两处 import 同一份。
 */
export const DEFAULT_STEER_MODE = "next-step" as const;

/** 历史 mode 值 → 现值（只做展示归一；写入侧永远只写现值，见 core/drafts.ts）。 */
export function normalizeSteerMode(mode: string): string {
  return mode === "step" ? "next-step" : mode === "turn" ? "next-turn" : mode;
}

/** 投递时机的短标签：说人话（next-step/next-turn 是给代码看的枚举名）。 */
export function steerModeLabel(mode: string): string {
  const m = normalizeSteerMode(mode);
  return m === "next-step" ? "下一步" : m === "next-turn" ? "下一轮" : m;
}

/**
 * 详细说明（tooltip）必须说清**降级**：选「下一步」时模型可能已经给出最终答复
 * （没有下一步了），此时它会成为下一轮的开场白 —— 承诺"下一次请求前一定生效"就是撒谎。
 */
export function steerModeTip(mode: string): string {
  const m = normalizeSteerMode(mode);
  if (m === "next-step") {
    return "插入到下一步：模型下一次模型步之前生效；本轮已收尾则作为下一轮的开场立刻发出";
  }
  if (m === "next-turn") {
    return "插入到下一次对话后：本轮跑完，自动接着开新一轮";
  }
  return "";
}
