// shared/xml-tags.ts 单测 —— 回答"新增标签会怎么样"：自动收集 + 独占一行放行
import { describe, expect, it } from "vitest";
import { collectTags, findTags } from "../../src/shared/xml-tags";

describe("collectTags（从模版正文收集已知标签）", () => {
    it("收集出现过的标签，排除控制标记 <template>", () => {
        const bodies = [
            "<template :if={{x}}>\n<task>\n内容\n</task>\n</template>\n",
            '<project_instructions path="安">\n# t\n</project_instructions>\n',
            "<guard>\n锁\n</guard>\n",
        ];
        expect([...collectTags(bodies)].sort()).toEqual([
            "guard",
            "project_instructions",
            "task",
        ]);
    });

    it("新增标签无需改代码：正文里出现即被收集", () => {
        expect([...collectTags(["<diy-new>\nx\n</diy-new>\n"])].sort()).toEqual(["diy-new"]);
    });

    it("正文里**行内**提到的 <pid>/<tid> 不算标签（实测 bug：曾把 diy.md 的示例路径当标签 → 满屏误染）", () => {
        const body = [
            "<diy>",
            "diy 是桌面管控台",
            "",
            "- `state.yaml` 由应用独占写入",
            "- `projects/<pid>/tasks/<tid>` 是任务本体",
            "</diy>",
            "",
        ].join("\n");
        expect([...collectTags([body])]).toEqual(["diy"]);
    });

    it("空集合不报错", () => {
        expect(collectTags([]).size).toBe(0);
    });
});

describe("findTags（决定哪些区间着色）", () => {
    const known = new Set(["task", "guard"]);

    it("已知标签：整段/名字/属性区间都给出", () => {
        const text = 'x <project_instructions path="安"> y';
        const spans = findTags(text, new Set(["project_instructions"]));
        expect(spans).toHaveLength(1);
        const s = spans[0]!;
        expect(text.slice(s.from, s.to)).toBe('<project_instructions path="安">');
        expect(text.slice(s.nameFrom, s.nameTo)).toBe("project_instructions");
        expect(text.slice(s.attrFrom!, s.attrTo!)).toBe(' path="安"');
    });

    it("闭合标签也认（名字区间跳过 </）", () => {
        const text = "</task>";
        const [s] = findTags(text, known);
        expect(text.slice(s!.nameFrom, s!.nameTo)).toBe("task");
    });

    it("未知标签夹在句子里 → 不着色（避免把正文里的 <pid> 误染）", () => {
        expect(findTags("见 projects/<pid>/tasks/<tid>/ 目录", known)).toEqual([]);
    });

    it("未知标签独占一行 → 着色（刚写下的 <diy-new> 立刻可见）", () => {
        const text = "前言\n<diy-new>\n内容\n</diy-new>\n";
        const names = findTags(text, known).map((s) => text.slice(s.nameFrom, s.nameTo));
        expect(names).toEqual(["diy-new", "diy-new"]);
    });

    it("独占一行但行内有别的内容 → 不着色", () => {
        expect(findTags('<diy-new>内容</diy-new>', known)).toEqual([]);
    });

    it("控制标记 <template> 永不作为输出标签着色", () => {
        expect(findTags("<template :if={{x}}>\n</template>\n", known)).toEqual([]);
    });

    it("a < b 这类比较不误判", () => {
        expect(findTags("a < b\n", known)).toEqual([]);
    });

    it("行内 <pid> 即使进了已知集合也不该被 collectTags 收集（双重保险）", () => {
        const text = "- `projects/<pid>/tasks/<tid>` 是任务本体\n<task>\n";
        // 模拟"错误收集"的集合：行内标签确实会被着色 —— 所以才必须在 collectTags 阶段挡住
        // 运行时会连 <task> 一起着色（它独占一行）——这里只关心行内 <pid> 确实会被着色，
        // 所以必须在 collectTags 阶段就挡住（下面的断言）
        expect(findTags(text, new Set(["pid"])).map((s) => text.slice(s.nameFrom, s.nameTo))).toEqual(["pid", "task"]);
        expect([...collectTags([text])]).toEqual(["task"]);
    });
});
