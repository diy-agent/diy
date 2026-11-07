/**
 * core/llm-proxy-instance.ts — LlmProxy 的单例
 *
 * 2026-11-06 从 `services/api-impl.ts` 提出来：`llmProxy` 域拆成
 * `api-domains/llmProxy/impl.ts` 后，这个单例两边都要用。
 *
 * 为什么懒加载（`await import`）：LlmProxy 依赖 http server，启动时要它就得等 IO；
 * 只有真调 `diy.llmProxy.*` 才实例化。
 */
let instance: { isRunning: boolean; start(): void; stop(): void } | null = null;

export async function getLlmProxy(): Promise<{ isRunning: boolean; start(): void; stop(): void }> {
    if (!instance) {
        const { LlmProxy } = await import("../services/llm-proxy");
        instance = new LlmProxy() as { isRunning: boolean; start(): void; stop(): void };
    }
    return instance;
}
