// 结构说明派生：**desc 只在浅层发**（##5 上下文减负）
//
// 起因（实测）：信封的 `help:` 11.2 KB 里 85% 是 `.describe()` 文本，结构骨架只 1.6 KB，
// 而这份 help **每轮都随 system 重发**。深层叶子字段（`path` / `value` / `variants`）的
// 名字本就自解释，解释它们的代价是每轮重复付 → `descMaxDepth` 只留前两层「这组是什么」。
//
// 关键取舍：**结构（键名 / type）一个都不删**，只删深层 desc —— 读侧永远知道有什么字段，
// 只是不再知道每个叶子字段的一句话解释（那属于 `--help` / 文档的职责）。

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeSchema } from "@diy-agent/context/schema/schema-doc";

const schema = z
    .object({
        outer: z
            .object({
                inner: z
                    .object({
                        leaf: z.string().describe("叶子的说明（深层，会被裁掉）"),
                    })
                    .describe("第二层"),
            })
            .describe("第一层"),
    })
    .describe("顶层");

describe("describeSchema · descMaxDepth", () => {
    it("缺省不限深度（老消费者行为不变）", () => {
        const doc = describeSchema(schema);
        const leaf = ((doc["outer"] as any)["inner"] as any)["leaf"] as Record<string, unknown>;
        expect(leaf["desc"]).toBe("叶子的说明（深层，会被裁掉）");
    });

    it("descMaxDepth 之内保留 desc，之外只留结构", () => {
        const doc = describeSchema(schema, { descMaxDepth: 1 });
        expect(doc["desc"]).toBe("顶层");
        const outer = doc["outer"] as Record<string, unknown>;
        expect(outer["desc"]).toBe("第一层");
        const inner = outer["inner"] as Record<string, unknown>;
        expect(inner["desc"]).toBeUndefined();
        expect(inner["leaf"]).toMatchObject({ type: "string" }); // 结构一个都不删
        expect((inner["leaf"] as Record<string, unknown>)["desc"]).toBeUndefined();
    });

    it("裁掉的只有 desc，children 全在（读侧不会以为字段没了）", () => {
        const doc = describeSchema(schema, { descMaxDepth: 0 });
        expect(doc["desc"]).toBe("顶层");
        const outer = doc["outer"] as Record<string, unknown>;
        expect(outer["desc"]).toBeUndefined();
        expect(outer["inner"]).toBeTruthy();
    });
});
