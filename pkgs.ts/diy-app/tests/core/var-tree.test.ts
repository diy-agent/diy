// tests/core/var-tree.test.ts — 变量契约的两种派生（树 / 扁平清单）
import { describe, expect, it } from "vitest";
import { AssembleGlobalsSchema } from "../../src/shared/prompt-schema";
import { buildVarTree, flattenVars, type VarNode } from "../../src/shared/var-tree";

const find = (nodes: VarNode[], name: string): VarNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = find(n.children ?? [], name);
    if (hit) return hit;
  }
  return undefined;
};

describe("变量树（可用变量 view 的数据源）", () => {
  const tree = buildVarTree(AssembleGlobalsSchema);

  it("路径逐段成节点：diy → cli（两跳），而不是一行 diy.cli", () => {
    const diy = find(tree, "diy");
    expect(diy?.type).toBe("object");
    expect(diy?.children?.map((c) => c.name)).toEqual(["cli", "home"]);
    expect(find(tree, "cli")?.type).toBe("string");
    // 说明来自 zod .describe()
    expect(find(tree, "cli")?.desc).toContain("CLI 入口");
  });

  it("数组展开为元素类型节点（用 named schema 的 id）", () => {
    const chain = find(tree, "chain");
    expect(chain?.type).toBe("array");
    expect(chain?.children?.map((c) => c.name)).toEqual(["[ChainEntry]"]);
    // 元素字段也成节点
    const el = chain!.children![0]!;
    expect(el.children?.map((c) => c.name)).toEqual(["path", "scope", "content"]);

    const skills = find(tree, "skills");
    expect(skills?.children?.map((c) => c.name)).toEqual(["[Skill]"]);
    expect(skills!.children![0]!.children?.map((c) => c.name)).toEqual(["name", "desc"]);
  });

  it("cwd 的布尔字段（含 optional/nullable 之外的普通叶子）", () => {
    const cwd = find(tree, "cwd");
    expect(cwd?.children?.map((c) => c.name)).toEqual([
      "path",
      "note",
      "isFallback",
      "isTaskDir",
      "isAppDir",
    ]);
    expect(find(tree, "isFallback")?.type).toBe("boolean");
  });
});

describe("扁平清单（引擎静态校验的数据源）", () => {
  const flat = flattenVars(AssembleGlobalsSchema);
  const paths = flat.map((v) => v.path);

  it("叶子与容器都在，根对象不算路径", () => {
    expect(paths).toContain("diy.cli");
    expect(paths).toContain("cwd.isFallback");
    expect(paths).toContain("chain");
    expect(paths).toContain("diy"); // 对象自身也在（{{diy}} → "是对象，不能插值"）
    expect(paths).not.toContain(""); // 根不是路径
    expect(paths.some((p) => p.includes("[]"))).toBe(false); // 不下钻元素（粗类型不建模）
  });

  it("类型是粗粒度枚举（引擎只看这五种）", () => {
    const types = new Set(flat.map((v) => v.type));
    for (const t of types) expect(["string", "number", "boolean", "array", "object"]).toContain(t);
    expect(flat.find((v) => v.path === "chain")?.type).toBe("array");
    expect(flat.find((v) => v.path === "skills")?.type).toBe("array");
  });
});
