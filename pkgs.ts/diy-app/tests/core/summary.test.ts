// tests/core/summary.test.ts
// 🎯 历史摘要：结构化解析 / 兜底渲染 / summary.md 模版渲染（承接形式定稿的验收）
import { describe, it, expect } from "vitest";
import {
    emptySummary,
    parseSummary,
    renderSummaryFallback,
    summaryExtractionPrompt,
    summaryHasContent,
    summaryPlaceholder,
    type SummaryData,
} from "../../src/shared/context/summary";
import { renderSystemDsl } from "../../src/main/services/prompt-registry";
import { PROMPT_DEFAULTS } from "../../src/main/prompts/defaults";

const sample: SummaryData = {
    turns: 3,
    conclusions: ["缓存按内容前缀匹配，跨 session 共享"],
    changes: [{ path: "src/main/services/local-agent.ts", what: "加压缩边界" }],
    todos: ["补意图测试"],
    open: ["摘要要不要默认开"],
};

describe("parseSummary", () => {
    it("裸 JSON 直接解析", () => {
        const r = parseSummary(JSON.stringify({ conclusions: ["a"], changes: [], todos: [], open: [] }));
        expect(r?.conclusions).toEqual(["a"]);
    });
    it("剥 ```json 代码块围栏", () => {
        const r = parseSummary('```json\n{"conclusions":["x"],"turns":2}\n```');
        expect(r?.conclusions).toEqual(["x"]);
    });
    it("前后有解释文字 → 取第一个 {...}", () => {
        const r = parseSummary('好的，结果如下：\n{"todos":["t1"]}\n希望有帮助');
        expect(r?.todos).toEqual(["t1"]);
    });
    it("非法 JSON / 非对象 → null（不冒充成功）", () => {
        expect(parseSummary("not json at all")).toBeNull();
        expect(parseSummary("{}")).not.toBeNull(); // 空对象 = 合法空摘要
    });
    it("字段类型容错：非数组字段丢弃、changes 缺 path 丢弃", () => {
        const r = parseSummary('{"conclusions":"nope","changes":[{"what":"x"},{"path":"p","what":"w"}]}');
        expect(r?.conclusions).toEqual([]);
        expect(r?.changes).toEqual([{ path: "p", what: "w" }]);
    });
});

describe("summaryHasContent / emptySummary", () => {
    it("全空 → 无内容（不投递）", () => {
        expect(summaryHasContent(emptySummary(5))).toBe(false);
    });
    it("任一字段非空 → 有内容", () => {
        expect(summaryHasContent({ ...emptySummary(), open: ["q"] })).toBe(true);
    });
});

describe("renderSummaryFallback（模版缺失时的兜底）", () => {
    it("有内容 → 带 <summary> 包裹、只出非空段", () => {
        const t = renderSummaryFallback(sample);
        expect(t).toContain("<summary turns=\"3\">");
        expect(t).toContain("关键结论：");
        expect(t).toContain("src/main/services/local-agent.ts：加压缩边界");
        expect(t).toContain("未完成：");
        expect(t).toContain("</summary>");
    });
    it("全空 → 空串", () => {
        expect(renderSummaryFallback(emptySummary())).toBe("");
    });
});

describe("summaryExtractionPrompt", () => {
    it("要求 JSON-only，且把被丢弃文本与轮数带上", () => {
        const p = summaryExtractionPrompt("[user] hi", 4);
        expect(p).toContain("只输出一个 JSON 对象");
        expect(p).toContain("[user] hi");
        expect(p).toContain("被压缩的轮数：4");
    });
});

describe("summaryPlaceholder", () => {
    it("给出模版骨架与变量名（预览里先生成前可见）", () => {
        const t = summaryPlaceholder(emptySummary(2));
        expect(t).toContain("<summary turns=\"2\">");
        expect(t).toContain("{{summary.conclusions}}");
    });
});

describe("summary.md 模版渲染（引擎）", () => {
    it("变量齐全 → 四段按序渲染，节标签完整", () => {
        const text = renderSystemDsl({ globals: { summary: sample }, entry: "summary.md" });
        expect(text).toContain('<summary turns="3">');
        expect(text).toContain("关键结论：");
        expect(text).toContain("- 缓存按内容前缀匹配，跨 session 共享");
        expect(text).toContain("改动文件：");
        expect(text).toContain("- src/main/services/local-agent.ts：加压缩边界");
        expect(text).toContain("未完成：");
        expect(text).toContain("未决问题：");
        expect(text).toContain("</summary>");
    });
    it("空段整段不出现（:if 生效）", () => {
        const t = renderSystemDsl({ globals: { summary: { ...emptySummary(1), conclusions: ["只此一条"] } }, entry: "summary.md" });
        expect(t).toContain("关键结论：");
        expect(t).not.toContain("改动文件：");
        expect(t).not.toContain("未完成：");
    });
    it("summary.md 不进 _system.md 装配（摘要不是 system 的一部分）", () => {
        expect(PROMPT_DEFAULTS["_system.md"]).not.toContain("summary.md");
    });
});
