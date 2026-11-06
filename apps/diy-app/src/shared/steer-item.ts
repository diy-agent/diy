/**
 * shared/steer-item.ts — 一条 steer 指令（`agent.local.steer.*` 的返回项）
 */
import { z } from "zod";

export const SteerItemSchema = z.object({
  id: z.string(),
  mode: z.enum(["next-step", "next-turn"]),
  text: z.string(),
  created: z.string(),
});
