// tests/core/context-request.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 请求预览（request.ts）：**真实请求体 → 一份大 YAML**。
//
// 取舍（第二版上下文）：
//   · wire 不动 —— 请求体里的 system 段本身就是一个文本字符串；
//   · 视图把它**拿出来就地解析**：与内嵌文本逐字相等处展开为 YAML 子节点；
//   · 行号映射由本次产出直接收集（与文本同源），选中联动才指得准。
//
// 两份投递文本（system 份含说明头 / runtime 份）走**真实渲染链**产出，
// 不手拼样例 —— 手拼的字符串测不出"行号映射对不对"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import {
    applyFacts,
    createTree,
    runtimeText,
    setPlacement,
    setPlaces,
    systemText,
    type ContextTreeState,
} from "../../src/shared/context/index";
import { requestYaml } from "../../src/shared/context/request";

/** 基准树：system = diy + chain；runtime = task（title + body） */
function fixture(): ContextTreeState {
    let t = createTree();
    t = applyFacts(t, [
        { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
        {
            type: "patch",
            path: "chain",
            op: "set",
            value: [{ path: "/home/AGENTS.md", scope: "/home", content: "家目录规范\n第二行" }],
        },
        { type: "patch", path: "task.title", op: "set", value: "任务 148" },
        { type: "patch", path: "task.body", op: "set", value: "正文第一行\n正文第二行" },
    ]).state;
    t = setPlaces(t, ["diy", "chain", "task"]);
    t = setPlacement(t, "diy", "system");
    t = setPlacement(t, "chain", "system");
    t = setPlacement(t, "task", "runtime");
    return t;
}

const t = fixture();
const sys = systemText(t);
const run = runtimeText(t);

/** chat 面请求体（与真发同形：messages[0]=system、末条 user=runtime、中间是历史） */
const chatBody = {
    model: "mimo-v2.5",
    max_tokens: 128000,
    messages: [
        { role: "system", content: sys },
        { role: "user", content: "上一轮用户消息\n第二行" },
        { role: "user", content: run },
    ],
    tools: [{ type: "function", function: { name: "bash", description: "跑命令" } }],
    tool_choice: "auto",
    stream: true,
};

const view = requestYaml(chatBody, [sys, run]);
const L = view.text.split("\n");
const at = (p: string): string => {
    const s = view.lines[p];
    expect(s, `缺行号映射：${p}`).toBeTruthy();
    return L.slice(s!.from - 1, s!.to).join("\n");
};

describe("请求预览：内嵌文本就地解析展开", () => {
    it("整份预览是合法 YAML —— 内嵌块成了子节点（不是转义字符串）", () => {
        const loaded = yaml.load(view.text, { schema: yaml.JSON_SCHEMA }) as any;
        expect(loaded.model).toBe("mimo-v2.5");
        // system 份：说明头是注释（读回不可见），数据是对象
        expect(loaded.messages[0].content.diy.cli).toBe("/repo/diy.sh");
        expect(loaded.messages[0].content.chain[0].path).toBe("/home/AGENTS.md");
        // runtime 份：末条 user 同样展开
        expect(loaded.messages[2].content.task.title).toBe("任务 148");
        expect(loaded.messages[2].content.task.body).toContain("正文第二行");
        // 普通历史消息保持字符串（只有内嵌文本被解析，别的文本不动）
        expect(loaded.messages[1].content).toContain("上一轮用户消息");
    });

    it("说明头在预览里是注释（内容不丢、仍是 YAML），数据紧跟其后", () => {
        expect(view.text).toContain("# 系统上下文（Context Tree）");
        expect(view.text).toContain("# 以下是本次会话的系统上下文");
        expect(view.text).toMatch(/# - 路径是稳定标识[\s\S]{0,120}?\bchain:/);
    });

    it("行号映射与文本同源：每个 path 的区间**只含该 path 的内容**", () => {
        expect(at("diy.cli").trim()).toBe("cli: /repo/diy.sh");
        expect(at("chain.0.path").trim()).toBe("- path: /home/AGENTS.md");
        expect(at("chain.0.content")).toContain("家目录规范");
        expect(at("chain.0.content")).toContain("第二行");
        expect(at("task.body")).toContain("正文第二行");
    });

    it("responses 面同形：input[0]=developer 文本、runtime 在嵌套 content[].text 里", () => {
        const respBody = {
            model: "gpt-5.6-luna",
            input: [
                { role: "developer", content: sys },
                { role: "user", content: [{ type: "input_text", text: run }] },
            ],
            max_output_tokens: 128000,
            tools: [],
            tool_choice: "auto",
            stream: true,
        };
        const v2 = requestYaml(respBody, [sys, run]);
        const loaded = yaml.load(v2.text, { schema: yaml.JSON_SCHEMA }) as any;
        expect(loaded.input[0].content.chain[0].path).toBe("/home/AGENTS.md");
        expect(loaded.input[1].content[0].text.task.title).toBe("任务 148");
        expect(v2.lines["task.title"]).toBeTruthy();
    });

    it("解析不了的内嵌文本不强行展开：按原文输出（原文不丢）", () => {
        const bad = "[这不是 yaml";
        const body = { model: "x", messages: [{ role: "user", content: bad }] };
        const v = requestYaml(body, [bad]);
        const loaded = yaml.load(v.text, { schema: yaml.JSON_SCHEMA }) as any;
        expect(loaded.messages[0].content).toBe(bad);
    });

    it("说明头变化的兜底：仍按第一个顶层键拆出数据（不因文案调整而放弃解析）", () => {
        const custom = "# 别的说明头\n\n这里也是说明文字\n\nchain: []";
        const v = requestYaml({ x: custom }, [custom]);
        const loaded = yaml.load(v.text, { schema: yaml.JSON_SCHEMA }) as any;
        expect(loaded.x.chain).toEqual([]);
    });

    it("数组元素本身就是内嵌文本：`-` 单独一行、块缩进对齐（仍合法 YAML）", () => {
        const body = { model: "x", input: [sys, "普通字符串"] };
        const v = requestYaml(body, [sys]);
        const loaded = yaml.load(v.text, { schema: yaml.JSON_SCHEMA }) as any;
        expect(loaded.input[0].diy.cli).toBe("/repo/diy.sh");
        expect(loaded.input[1]).toBe("普通字符串");
        expect(v.lines["input.0"]).toBeTruthy();
        expect(v.lines["diy.cli"]).toBeTruthy();
    });

    it("空文本/无内嵌时不启用展开，照常输出", () => {
        const v = requestYaml({ a: "x" }, ["", ""]);
        expect(v.text).toBe("a: x");
    });
});
