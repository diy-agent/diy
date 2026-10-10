// tests/core/local-models-api.test.ts
// 🎯 API 面契约：面**由 npm 解析**（与 models.dev 对齐），provider.npm 默认 + 模型级
// provider.npm 覆写。opencode-go 的 gpt-5.6-luna / gpt-6-luna 在 models.dev 里就是
// `provider.npm: "@ai-sdk/openai"`（responses），打 chat 面必 503 —— 靠数据表达，不硬编码名单。
import { describe, it, expect } from "vitest";
import { faceOfNpm } from "../../src/shared/models";
import { npmOfEndpoints } from "../../src/shared/model-config";
import { apiOf } from "../../src/main/services/local-agent";

describe("npm → API 面白名单", () => {
    it("只认两家；其余（anthropic/google/…）返回 null", () => {
        expect(faceOfNpm("@ai-sdk/openai-compatible")).toBe("chat");
        expect(faceOfNpm("@ai-sdk/openai")).toBe("responses");
        expect(faceOfNpm("@ai-sdk/anthropic")).toBeNull();
        expect(faceOfNpm("@ai-sdk/google")).toBeNull();
        expect(faceOfNpm(undefined)).toBeNull();
        expect(faceOfNpm("")).toBeNull();
    });
});

describe("apiOf：按目录里解析出的面", () => {
    it("已知模型按注入元数据；未知模型回退 chat（不静默换面）", () => {
        expect(apiOf("gpt-5.6-luna")).toBe("responses");
        expect(apiOf("mimo-v2.6-flash")).toBe("chat");
        expect(apiOf("不存在的模型")).toBe("chat");
    });
});

describe("npmOfEndpoints：/models 的 supported_endpoints → 面", () => {
    it("chat 优先；只 responses 则 responses；只 /messages 等未支持面 → null", () => {
        expect(npmOfEndpoints(["/chat/completions", "/responses"])).toBe("@ai-sdk/openai-compatible");
        expect(npmOfEndpoints(["/responses"])).toBe("@ai-sdk/openai");
        expect(npmOfEndpoints(["/messages"])).toBeNull();
        expect(npmOfEndpoints([])).toBeNull();
    });
});
