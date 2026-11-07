/**
 * api-domains/cacheHint/impl.ts —— `cacheHint` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { cacheHintService } from "./api";
import { cacheHint } from "../../cache-hint";
import { readRuntimeConfig } from "../../../../runtime";

export function bindCacheHint(server: ServerBinding): void {
    cacheHintService.bind(server, {
      // 用量面板的「缓存时效柱」走 stats（按模型解析出渠道，返回两个边界 + **本会话**上次请求时刻）。
      // 两个维度分开：边界按渠道、时刻按会话（##492；曾经共用一个渠道键 ⇒ 任意任务都能刷热别的任务）。
      current: async () => cacheHint.currentOf(),
      stats: async ({ input }) => cacheHint.viewOf(input.model, input.session ?? null),
      simulate: async ({ input }) => {
        // 与 env simulate 同一条线：探针只改"事实来源"，不放宽任何开关
        if (readRuntimeConfig().env === "production") {
          // error-code-ok: 探针拒绝（用户主动触发、非缺陷链，没有可比判据）
          throw new Error("cacheHint simulate 是探针命令，生产环境一律拒绝（DIY_ENV=production）");
        }
        return cacheHint.simulate(input);
      },
      dismiss: async ({ input }) => {
        cacheHint.dismiss(input.id);
        return { status: "ok" };
      },
      watch: async function* ({ signal }) {
        for await (const ev of cacheHint.subscribe(signal)) yield ev;
      },
    });
}
