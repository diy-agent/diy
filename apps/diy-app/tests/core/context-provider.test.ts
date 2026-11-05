// 上下文树的**提供器机制**（2026-11-05 用户裁：「context 本质是业务无关的机制 … 拆成机制 + 提供器」）。
//
// 这里只测机制本身：拼树 / 契约校验 / 缺席语义 / 覆盖顺序。
// 各 provider 怎么读盘、读什么，归 provider 自己的测试（`context-providers.ts` 是纯组装，行为由
// `context-tree.test.ts` / `context-request.test.ts` 的「装配结果逐字节不变」守着）。

import { describe, expect, it } from "vitest";
import { reqlogValue } from "@diy-agent/context/schema/reqlog";
import { assembleFromProviders, type ContextProvider } from "@diy-agent/context";

/** 一份满足契约的最小树（11 个必填键；facts/kb/docs/room/self 可选） */
function minimalProviders(): ContextProvider[] {
    return [
        { key: "persona", provide: () => ({ name: "p", instructions: "" }) },
        { key: "diy", provide: () => ({ cli: "diy", home: "/tmp" }) },
        { key: "project", provide: () => ({ path: "" }) },
        {
            key: "task",
            provide: () => ({
                uri: "",
                title: "",
                state: "",
                parent: "",
                created: "",
                updated: "",
                change_type: "",
                module: "",
                priority: "",
                persona: "",
                body: "",
                dir: "",
            }),
        },
        { key: "cwd", provide: () => ({ path: "/tmp", note: "", isFallback: false, isTaskDir: false, isAppDir: false }) },
        { key: "chain", provide: () => [] },
        { key: "skills", provide: () => [] },
        { key: "identity", provide: () => "" },
        { key: "rules", provide: () => "" },
        { key: "guard", provide: () => "" },
        { key: "reqlog", provide: () => reqlogValue({ home: "/tmp", dirRel: "log", fileName: "x.jsonl" }) },
    ];
}

const provider = (key: string, value: unknown): ContextProvider => ({ key, provide: () => value });

describe("提供器机制", () => {
    it("按 key 拼成一棵树（值原样进，不加工）", () => {
        const tree = assembleFromProviders(minimalProviders());
        expect(tree).toMatchObject({ persona: { name: "p", instructions: "" }, skills: [], chain: [] });
    });

    it("可选节 provide 返回 undefined ⇒ 整节缺席（不往树里塞空键）", () => {
        // 判据是「`{}` 会被渲染成 `facts: {}`，看着像『库在但没有事实』，与『没接库』不是一回事」
        // —— 所以 provider 用 undefined 表达「本节没有」，机制层必须真的不塞这个键。
        const tree = assembleFromProviders([...minimalProviders(), provider("facts", undefined)]);
        expect(tree).not.toHaveProperty("facts");
        expect(tree).not.toHaveProperty("kb");
    });

    it("同 key 后注册的覆盖先注册的（允许「兜底 + 覆盖」装配）", () => {
        const tree = assembleFromProviders([
            ...minimalProviders(),
            provider("persona", { name: "first", instructions: "" }),
            provider("persona", { name: "second", instructions: "" }),
        ]);
        expect(tree.persona.name).toBe("second");
    });

    it("契约外的 key ⇒ 直接抛（provider 与 schema 漂移必须暴露，不能静默吃）", () => {
        expect(() => assembleFromProviders([...minimalProviders(), provider("nope", 1)])).toThrow(/不在契约里/);
    });

    it("缺必填键 ⇒ schema 校验失败（宁可发不出去，也不发一份残缺的 system）", () => {
        const got = minimalProviders().filter((p) => p.key !== "guard");
        expect(() => assembleFromProviders(got)).toThrow();
    });
});
