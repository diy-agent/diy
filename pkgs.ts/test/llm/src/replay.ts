// replay.ts — 把录制的 fixture 变成可用的 LanguageModel
//
// 一个 fixture 能被**任意层**复用：
//   · 单元：直接读 parts 断言变换函数（`toBlocks(parts)`）
//   · DOM：`replayModel(name)` 喂给渲染层，断言出现什么块
//   · 意图 / E2E：`replayModel(name)` 注入装配，跑整条链路
//
// 这就是「黄金测试是一种能力，不是一层」的落点 —— 和 clock mock 同一个位置。

import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

/** 回放器：可重复调用，每次得到一份新的流（fixture 本身不消费） */
export interface Replay {
    readonly parts: LanguageModelV3StreamPart[];
    /** 包成 ai-sdk 的 LanguageModel，供 streamText / generateText 用 */
    asModel(): LanguageModel;
}

export function replay(parts: LanguageModelV3StreamPart[]): Replay {
    return {
        parts,
        asModel(): LanguageModel {
            return new MockLanguageModelV3({
                doStream: async () => ({
                    stream: new ReadableStream<LanguageModelV3StreamPart>({
                        start(controller) {
                            for (const p of parts) controller.enqueue(p);
                            controller.close();
                        },
                    }),
                }),
                doGenerate: async () => {
                    throw new Error("replay 只实现了 doStream；要 doGenerate 请用 generateText({ model }) 里的 streamText 路径");
                },
            }) as unknown as LanguageModel;
        },
    };
}
