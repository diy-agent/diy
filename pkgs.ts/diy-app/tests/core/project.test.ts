// tests/core/project.test.ts
// 🎯 意图测试：project 创建、删除、查询

import { describe, it, expect } from "vitest";
import { createProject, removeProject, listProjects } from "../../src/main/core/project";
import { loadState } from "../../src/main/core/state";

describe("createProject", () => {
  it("创建后可通过 listProjects 查到", () => {
    createProject("test-proj", { label: "测试" });
    const projects = listProjects();
    const found = projects.find((p) => p.id === "test-proj");
    expect(found?.info.label).toBe("测试");
  });

  it("不传 label 也可创建", () => {
    createProject("minimal");
    const s = loadState();
    expect(s.projects.has("minimal")).toBe(true);
  });

  it("创建时带 path 会规范化为 ~/ 存储", () => {
    createProject("path-ed", { path: `${process.env.HOME}/diy` });
    const s = loadState();
    expect(s.projects.get("path-ed")?.path).toBe("~/diy");
  });
});

describe("removeProject", () => {
  it("删除后不可查", () => {
    createProject("del-me", { label: "待删除" });
    expect(listProjects().find((p) => p.id === "del-me")).toBeDefined();

    removeProject("del-me");
    expect(listProjects().find((p) => p.id === "del-me")).toBeUndefined();
  });

  it("删除不存在的 project 不抛异常", () => {
    expect(() => removeProject("nonexistent")).not.toThrow();
  });
});

describe("listProjects", () => {
  it("返回完整列表", () => {
    createProject("list-a", { label: "A" });
    createProject("list-b", { label: "B" });
    const all = listProjects();
    const ids = all.map((p) => p.id);
    expect(ids).toContain("list-a");
    expect(ids).toContain("list-b");
  });
});