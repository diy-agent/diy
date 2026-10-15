// tests/core/context-reqlog.test.ts
// 🎯 `reqlog` 节点（变量树里的"真发请求日志在哪、怎么找"）
//
// ##310 六轮拍板后：**值只有 `file` 一个字段**（纯数据），全部解释在 `ReqlogSchema` 的
// `.describe()` 里 → 派生进信封 `help.reqlog`（值节点里禁出现解释性字段）。
// 关键断言：那串 desc 里给的是**可照抄的命令**（模型知道 task.uri、不知道 turnId），
// 且不编行号（记录在请求发出之后才落盘，组装时它还不存在）。

import { describe, expect, it } from "vitest";
import { ReqlogSchema, reqlogValue } from "../../src/shared/context/reqlog";
import { describeSchema } from "../../src/shared/schema-doc";

describe("reqlog 节点", () => {
    it("值只有一个字段 file（绝对路径 = 今天的按天文件）", () => {
        const v = reqlogValue({ home: "/tmp/diy-home", dirRel: "log/network", fileName: "2026-10-15.jsonl" });
        expect(v).toEqual({ file: "/tmp/diy-home/log/network/2026-10-15.jsonl" });
    });

    it("解释在 zod 的 desc 里：路径规则 / 定位命令 / 行号含义 / 截断策略", () => {
        const desc = ReqlogSchema.shape.file.description ?? "";
        expect(desc).toContain("log/network");
        expect(desc).toContain("按天切分");
        expect(desc).toContain("grep -n");
        expect(desc).toContain("task.uri");
        expect(desc).toContain("attempt"); // 是重试序号、不是步序
        expect(desc).toContain("truncated"); // 默认裁剪 + 怎么开全文
    });

    it("desc 由 schema 派生进 help（describeSchema 递归产出 desc + type）", () => {
        const doc = describeSchema(ReqlogSchema);
        expect(doc["desc"]).toBe(ReqlogSchema.description);
        expect((doc["file"] as { type?: string }).type).toBe("string");
    });
});
