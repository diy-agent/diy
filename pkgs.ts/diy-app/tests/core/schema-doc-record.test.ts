// 结构说明派生：**record 的值结构必须进 help**（##404）
//
// 起因（用户：「数据结构也需要按系统变量树的规范 zod 定义声明，并提供到 help 区域」）：
// `facts.task` / `facts.project` 是 `z.record(z.string(), FactsCellSchema)`，
// 从前 simplifyBit 只把 record 标成 `type: object` —— 值里的 value / resolvedBy /
// variants 三个字段**整段丢失**。模型读 help 只知"是个 map"，不知道 map 的值长什么样。

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeSchema } from "@diy/context/schema/schema-doc";

describe("describeSchema · record", () => {
  it("record 的值结构进 `values:`（key 动态、值有形状）", () => {
    const cell = z.object({
      value: z.string().describe("已解析的值"),
      variants: z.number().describe("变体数"),
    });
    const doc = describeSchema(z.object({ task: z.record(z.string(), cell).describe("任务库") }));
    const task = doc["task"] as Record<string, unknown>;
    expect(task["type"]).toBe("object");
    const values = task["values"] as Record<string, unknown>;
    expect(values["value"]).toMatchObject({ desc: "已解析的值", type: "string" });
    expect(values["variants"]).toMatchObject({ type: "number" });
  });

  it("值是 any / unknown → 只标类型，不造空节点", () => {
    const doc = describeSchema(z.object({ m: z.record(z.string(), z.unknown()) }));
    const m = doc["m"] as Record<string, unknown>;
    expect(m["type"]).toBe("object");
    expect(m["values"]).toBeUndefined();
  });

  it("具名子 schema（.meta({id})，$defs + $ref）也能展开值结构", () => {
    const named = z.object({ v: z.string().describe("值") }).meta({ id: "NamedCell" });
    const doc = describeSchema(z.object({ rows: z.record(z.string(), named) }));
    const rows = doc["rows"] as Record<string, unknown>;
    const values = rows["values"] as Record<string, unknown>;
    expect(values["v"]).toMatchObject({ desc: "值" });
  });

  it("真实契约：AssembleGlobalsSchema.facts.task 的值结构可见", async () => {
    const { AssembleGlobalsSchema } = await import("@diy/context/schema/prompt-schema");
    const doc = describeSchema(AssembleGlobalsSchema);
    const facts = doc["facts"] as Record<string, unknown>;
    const task = facts["task"] as Record<string, unknown>;
    const values = task["values"] as Record<string, unknown>;
    // 这三个字段就是模型解析一条投影时需要的全部信息
    expect(values["value"]).toBeDefined();
    expect(values["resolvedBy"]).toBeDefined();
    expect(values["variants"]).toBeDefined();
  });
});
