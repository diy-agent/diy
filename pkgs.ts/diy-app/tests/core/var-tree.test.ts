// tests/core/var-tree.test.ts — 变量契约的两种派生（树 / 扁平清单）
import { describe, expect, it } from "vitest";
import { AssembleGlobalsSchema } from "../../src/shared/prompt-schema";
import { buildValueTree, buildVarTree, flattenVars, type VarNode } from "../../src/shared/var-tree";

/** 两种树（契约 VarNode / 值 ValueNode）共用：按名字深度优先找节点 */
function find<N extends { name: string; children?: N[] }>(nodes: N[], name: string): N | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = find(n.children ?? [], name);
    if (hit) return hit;
  }
  return undefined;
}

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

describe("值树（变量值 view 的数据源：契约结构 + 本次注入的实际值）", () => {
  const values = {
    diy: { cli: "/repo/diy.sh", home: "/tmp/home" },
    project: { path: "/repo" },
    task: {
      uri: "projects/1/tasks/2",
      title: "布局核对",
      state: "active",
      body: "多行\n正文",
      dir: "/tmp/home/projects/1/tasks/2",
    },
    cwd: { path: "/repo", note: "", isFallback: false, isTaskDir: true, isAppDir: false },
    chain: [
      { path: "/Users/ccc/AGENTS.md", scope: "/Users/ccc", content: "# 根规则" },
      { path: "/repo/AGENTS.md", scope: "/repo", content: "# 仓库规则" },
    ],
    skills: [],
  };
  const tree = buildValueTree(AssembleGlobalsSchema, values);

  it("叶子挂实际值（diy.cli 的值就是本 worktree CLI）；多行值折成一行", () => {
    expect(find(tree, "cli")?.value).toBe("/repo/diy.sh");
    expect(find(tree, "body")?.value).toBe("多行⏎正文");
    expect(find(tree, "isFallback")?.value).toBe("false");
  });

  it("数组按实际元素展开：[0]/[1]（类型 = 元素的 zod id）→ 字段各自带值", () => {
    const chain = find(tree, "chain");
    expect(chain?.value).toBe("2 项");
    expect(chain?.children?.map((c) => [c.name, c.type])).toEqual([
      ["[0]", "ChainEntry"],
      ["[1]", "ChainEntry"],
    ]);
    const el0 = chain!.children![0]!;
    expect(el0.children?.map((c) => [c.name, c.value])).toEqual([
      ["path", "/Users/ccc/AGENTS.md"],
      ["scope", "/Users/ccc"],
      ["content", "# 根规则"],
    ]);
  });

  it("空数组/未定义：值显示为空数组并标 missing（一眼看出这次没数据）", () => {
    const skills = find(tree, "skills");
    expect(skills?.value).toBe("空数组");
    expect(skills?.missing).toBe(true);
    expect(skills?.children).toEqual([]);
    const noTask = buildValueTree(AssembleGlobalsSchema, { ...values, task: undefined });
    expect(find(noTask, "task")?.missing).toBe(true);
  });
});
