// tests/core/task-lineage.test.ts
// 🎯 任务详情「任务树」块的行生成 —— 纯函数单测（无 DOM，无 Electron）
//
// 契约（##233 / ##183 第 4 点）：以当前任务所在**根任务**为根，展开**整颗树**
// （含所有兄弟分支），树序 + 带深度，当前任务标 current。
// 旧实现只产出「祖先链 + 自己 + 子孙」一条线 —— 本用例锁住回退。

import { describe, it, expect } from "vitest";
import { lineageRows, isAncestorOf } from "../../src/renderer_solid/lib/task-lineage";
import type { TreeNode } from "../../src/renderer_solid/store/taskStore";

function task(num: string, over: Partial<TreeNode> = {}): TreeNode {
  return {
    kind: "task",
    uri: `projects/1/tasks/${num}`,
    num,
    title: `任务${num}`,
    state: "pending",
    children: [],
    ...over,
  };
}

/**
 * 一棵有兄弟分支的树（挂在项目节点下，模拟真实顶层）：
 *
 *   root(#1)
 *   ├── a(#2)
 *   │   └── a1(#4)
 *   └── b(#3)        ← 兄弟分支（旧实现不显示）
 *       └── b1(#5)
 */
function sampleTree(): TreeNode[] {
  const a1 = task("4", { parentUri: "projects/1/tasks/2" });
  const b1 = task("5", { parentUri: "projects/1/tasks/3" });
  const a = task("2", { parentUri: "projects/1/tasks/1", children: [a1] });
  const b = task("3", { parentUri: "projects/1/tasks/1", children: [b1] });
  const root = task("1", { children: [a, b] });
  // 项目节点没有 uri（只有 project id）—— real 数据里任务挂它下面
  const proj: TreeNode = { kind: "project", project: "1", children: [root] };
  return [proj];
}

const uris = (rows: { uri: string }[]) => rows.map((r) => r.uri);
const depthOf = (rows: { uri: string; depth: number }[], uri: string) => rows.find((r) => r.uri === uri)?.depth;

describe("lineageRows：整颗树（##233）", () => {
  it("以根任务为根、DFS 树序输出全部节点（含兄弟分支）", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/4"); // 当前 = a1（深层）
    expect(uris(rows)).toEqual([
      "projects/1/tasks/1",
      "projects/1/tasks/2",
      "projects/1/tasks/4",
      "projects/1/tasks/3",
      "projects/1/tasks/5",
    ]);
  });

  it("兄弟分支在行里（旧实现只给父链+子孙，此断言即防回退）", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/4");
    // b 与 b1 与 a1 不同链（是父节点下的另一棵子树），整树模式下必须出现
    expect(uris(rows)).toContain("projects/1/tasks/3");
    expect(uris(rows)).toContain("projects/1/tasks/5");
  });

  it("深度按树层级（根=0，逐级 +1），与 URI 末段无关", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/4");
    expect(depthOf(rows, "projects/1/tasks/1")).toBe(0);
    expect(depthOf(rows, "projects/1/tasks/2")).toBe(1);
    expect(depthOf(rows, "projects/1/tasks/4")).toBe(2);
    expect(depthOf(rows, "projects/1/tasks/3")).toBe(1);
    expect(depthOf(rows, "projects/1/tasks/5")).toBe(2);
  });

  it("恰好一行标 current，且是传入的 uri", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/4");
    const current = rows.filter((r) => r.current);
    expect(current).toHaveLength(1);
    expect(current[0].uri).toBe("projects/1/tasks/4");
  });

  it("对根任务调用 → 同一整树，current 落在根", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/1");
    expect(uris(rows)[0]).toBe("projects/1/tasks/1");
    expect(rows[0].current).toBe(true);
    expect(uris(rows)).toContain("projects/1/tasks/5"); // 兄弟分支仍在
  });

  it("树里找不到该任务 → 只回自己一行（不空白）", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/999");
    expect(rows).toEqual([{ uri: "projects/1/tasks/999", depth: 0, current: true }]);
  });

  it("parent 悬空（指向不存在任务）→ 视自己为根，不死循环、不丢失", () => {
    const orphan = task("9", { parentUri: "projects/1/tasks/404" });
    const rows = lineageRows([orphan], "projects/1/tasks/9");
    expect(uris(rows)).toEqual(["projects/1/tasks/9"]);
    expect(rows[0].current).toBe(true);
  });

  it("当前任务是顶级 → 兄弟顶级分支也在（RV-04 边界：项目下两个顶级）", () => {
    const proj: TreeNode = { kind: "project", project: "1", children: [task("1"), task("2")] };
    const rows = lineageRows([proj], "projects/1/tasks/1");
    // 修前实测只回 ['projects/1/tasks/1']，兄弟 #2 丢失
    expect(uris(rows)).toEqual(["projects/1/tasks/1", "projects/1/tasks/2"]);
    expect(rows[0].current).toBe(true);
    expect(rows.every((r) => r.depth === 0)).toBe(true); // 顶级之间同层
  });

  it("深层任务行为不变：根仍是其所在根任务，不扩到项目全部顶级", () => {
    const rows = lineageRows(sampleTree(), "projects/1/tasks/4");
    expect(uris(rows)[0]).toBe("projects/1/tasks/1");
    // sampleTree 根 #1 就是唯一顶级，不出现「项目其他顶级」的语义漂移
    expect(uris(rows)).not.toContain("projects/1/tasks/9");
  });

  it("isAncestorOf：隔代祖先是、子孙不是、自己算（RV-07 拖拽防环预检）", () => {
    const nodes = sampleTree();
    expect(isAncestorOf(nodes, "projects/1/tasks/1", "projects/1/tasks/4")).toBe(true); // 根是孙的祖先
    expect(isAncestorOf(nodes, "projects/1/tasks/2", "projects/1/tasks/4")).toBe(true); // 直接父
    expect(isAncestorOf(nodes, "projects/1/tasks/4", "projects/1/tasks/1")).toBe(false); // 反向
    expect(isAncestorOf(nodes, "projects/1/tasks/3", "projects/1/tasks/4")).toBe(false); // 旁系
    expect(isAncestorOf(nodes, "projects/1/tasks/99", "projects/1/tasks/4")).toBe(false); // 不存在
  });

  it("脏数据成环（互相认父）不把遍历转死", () => {
    const x = task("7", { parentUri: "projects/1/tasks/8" });
    const y = task("8", { parentUri: "projects/1/tasks/7", children: [x] });
    // 构造：x 与 y 互相认父（y.children 又含 x），DFS 必须有 seen 兜住
    const nodes: TreeNode[] = [{ kind: "project", project: "1", children: [y] }];
    expect(() => lineageRows(nodes, "projects/1/tasks/7")).not.toThrow();
  });
});
