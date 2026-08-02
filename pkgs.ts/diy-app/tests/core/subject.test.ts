// tests/core/subject.test.ts
// 🎯 意图测试：subject 注册、删除、查询

import { describe, it, expect } from "vitest";
import { addSubject, removeSubject, listSubjects } from "../../src/main/core/subject";
import { loadState } from "../../src/main/core/state";

describe("addSubject", () => {
  it("添加后可通过 listSubjects 查到", () => {
    addSubject("~/test-subj", "测试");
    const subjects = listSubjects();
    const found = subjects.find((s) => s.path === "~/test-subj");
    expect(found?.info.label).toBe("测试");
  });

  it("不传 label 也可添加", () => {
    addSubject("~/minimal");
    const s = loadState();
    expect(s.subjects.has("~/minimal")).toBe(true);
  });
});

describe("removeSubject", () => {
  it("删除后不可查", () => {
    addSubject("~/del-me", "待删除");
    expect(listSubjects().find((s) => s.path === "~/del-me")).toBeDefined();

    removeSubject("~/del-me");
    expect(listSubjects().find((s) => s.path === "~/del-me")).toBeUndefined();
  });

  it("删除不存在的 subject 不抛异常", () => {
    expect(() => removeSubject("~/nonexistent")).not.toThrow();
  });
});

describe("listSubjects", () => {
  it("返回完整列表", () => {
    addSubject("~/list-a", "A");
    addSubject("~/list-b", "B");
    const all = listSubjects();
    const paths = all.map((s) => s.path);
    expect(paths).toContain("~/list-a");
    expect(paths).toContain("~/list-b");
  });
});
