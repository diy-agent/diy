// tests/core/prompt-cache.test.ts
// 🎯 ##486：opencode 网关的缓存保留期只在**该发的时候**发。
//
// 为什么要单测：这个字段决定「跨轮还命不命中」——390k 上下文冷一次就是 $0.056。
// 但补错地方会换来一次 400（直连上游没验证过这个字段），补错形状会静默不生效
// （网关认不出就被忽略，cacheRead 依旧掉到 0，不看数字根本发现不了）。
// 所以三条都锁死：**开关判据（host 不是名字）/ 不覆盖已有值 / 不改原对象**。

import { describe, expect, it } from "vitest";
import {
    PROMPT_CACHE_RETENTION,
    isOpencodeEndpoint,
    withPromptCacheRetention,
} from "../../src/shared/prompt-cache";

describe("isOpencodeEndpoint", () => {
    it("opencode 的两种端点都算（zen 与 go）", () => {
        expect(isOpencodeEndpoint("https://opencode.ai/inference/v1")).toBe(true);
        expect(isOpencodeEndpoint("https://opencode.ai/inference/go/openai/v1")).toBe(true);
    });

    it("直连上游不算 —— 没验证过的字段不发", () => {
        expect(isOpencodeEndpoint("https://api.deepseek.com")).toBe(false);
        expect(isOpencodeEndpoint("https://api.moonshot.cn/v1")).toBe(false);
    });

    it("子域名不冒充（只认 host 完全相等）", () => {
        expect(isOpencodeEndpoint("https://evil.opencode.ai/v1")).toBe(false);
        expect(isOpencodeEndpoint("https://opencode.ai.evil.com/v1")).toBe(false);
    });

    it("URL 解析不了 ⇒ false（不认识的端点，不补字段）", () => {
        expect(isOpencodeEndpoint("")).toBe(false);
        expect(isOpencodeEndpoint("not a url")).toBe(false);
    });
});

describe("withPromptCacheRetention", () => {
    it("补上 24h", () => {
        expect(withPromptCacheRetention({ model: "m" })).toEqual({
            model: "m",
            prompt_cache_retention: PROMPT_CACHE_RETENTION,
        });
    });

    it("已有值不覆盖（逐次覆盖是调用方的权利）", () => {
        expect(withPromptCacheRetention({ prompt_cache_retention: "1h" })).toEqual({
            prompt_cache_retention: "1h",
        });
    });

    it("不改原对象（transformRequestBody 可能被同一次请求复用）", () => {
        const body = { model: "m" };
        withPromptCacheRetention(body);
        expect(body).toEqual({ model: "m" });
    });
});
