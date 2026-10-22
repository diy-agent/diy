// tests/helpers/hanging-model.ts
// 🎯 「吐两个 token 后挂住等 abort」的桩语言模型（##402）。
//
// 为什么有它：local-agent 的两条生命周期测试（stop-cut / turn-detach）需要制造
// 「轮次正在直播中」的窗口 —— 真实 LLM 做不到确定性（何时吐 token、何时结束不可控）。
// 旧做法是 `vi.mock("ai")` 整个替换 streamText；那改的是**全局模块表**，`isolate:false`
// 下会静默失效（谁先加载了 `ai` 谁的 mock 说了算）。现在走 `LocalAgentManager` 已有的
// **构造器注入点**（`new LocalAgentManager(() => stubModel)`，见 room-busy-steer）——
// 用哪份模型是调用点的显式输入，与文件落进哪个 worker 无关。
//
// 行为等价于旧 mock：
//   · 先吐 `start-step` + `text-delta`（下游据此进入"直播中"）
//   · 然后挂住，直到 abortSignal 触发；触发时**以 AbortError 失败**（不是优雅 finish）——
//     这样 local-agent 的 catch 分支与真实取消一致（写 `aborted{source}`，而不是 completed）。
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";

/** 挂住的模型：`text` 是挂在直播中的那段增量（默认与旧 mock 一致）。 */
export function hangingModel(text = "生成中…"): LanguageModel {
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-hang",
        doStream: ({ abortSignal }): Promise<LanguageModelV3StreamResult> =>
            Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ type: "text-start", id: "p1" });
                        controller.enqueue({ type: "text-delta", id: "p1", delta: text });
                        const fail = () =>
                            controller.error(new DOMException("The operation was aborted", "AbortError"));
                        if (!abortSignal) return; // 没有信号（不该发生）：流保持开口 = 等同挂住
                        if (abortSignal.aborted) return fail();
                        abortSignal.addEventListener("abort", fail, { once: true });
                    },
                }),
            }),
    }) as unknown as LanguageModel;
}
