// tests/core/project.test.ts
// 🎯 意图测试：project 创建、删除、查询
//    id 系统自动数字自增；权威注册表 $DIY_HOME/projects/<id>/meta.yaml；
//    目标仓库写 diy.yaml 名片（project: {id, name}）

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
  createProject,
  removeProject,
  listProjects,
  projectExists,
} from "../../src/main/core/project";
import { diyHome, projectsRoot } from "../../src/main/core/state";

/** 模拟目标仓库路径（隔离在了 DIY_HOME 下，不碰真实目录） */
function repo(name: string): string {
  return join(diyHome(), "repos", name);
}

describe("createProject", () => {
  it("返回自动生成的数字 id，并建 $DIY_HOME/projects/<id>/ 数据目录", () => {
    mkdirSync(repo("a"), { recursive: true });
    const id = createProject(repo("a"), { label: "项目A" });

    expect(id).toMatch(/^\d+$/);
    expect(existsSync(join(projectsRoot(), id, "meta.yaml"))).toBe(true);
    expect(existsSync(join(projectsRoot(), id, "tasks"))).toBe(true);
  });

  it("id 数字自增：连续创建得到相邻 id", () => {
    const a = createProject(repo("b"));
    const b = createProject(repo("c"));
    expect(Number(b)).toBe(Number(a) + 1);
  });

  it("写目标仓库 diy.yaml 名片（含 id、name，且不覆盖已有 ref 配置）", () => {
    mkdirSync(repo("d"), { recursive: true });
    writeFileSync(repo("d") + "/diy.yaml", yaml.dump({ ref: { source: [] } }));

    const id = createProject(repo("d"), { label: "名片" });
    const doc = yaml.load(readFileSync(join(repo("d"), "diy.yaml"), "utf-8")) as Record<string, any>;

    expect(doc["project"]["id"]).toBe(id);
    expect(doc["project"]["name"]).toBe("名片");
    expect(doc["ref"]).toEqual({ source: [] });
  });

  it("创建时不传 label 也可建（名片 name 回退目录名）", () => {
    mkdirSync(repo("e"), { recursive: true });
    const id = createProject(repo("e"));
    expect(projectExists(id)).toBe(true);
  });
});

describe("removeProject", () => {
  it("删除数据目录 + 摘除目标仓库名片", () => {
    mkdirSync(repo("f"), { recursive: true });
    writeFileSync(repo("f") + "/diy.yaml", yaml.dump({ ref: { source: [] } }));

    const id = createProject(repo("f"), { label: "删我" });
    expect(projectExists(id)).toBe(true);

    removeProject(id);
    expect(projectExists(id)).toBe(false);
    expect(existsSync(join(projectsRoot(), id))).toBe(false);

    // 名片已摘除，ref 保留
    const doc = yaml.load(readFileSync(join(repo("f"), "diy.yaml"), "utf-8")) as Record<string, any>;
    expect(doc["project"]).toBeUndefined();
    expect(doc["ref"]).toEqual({ source: [] });
  });

  it("删除不存在的 project 不抛异常", () => {
    expect(() => removeProject("999")).not.toThrow();
  });
});

describe("listProjects", () => {
  it("返回完整列表（含 label/path）", () => {
    const a = createProject(repo("l1"), { label: "L1" });
    const b = createProject(repo("l2"), { label: "L2" });
    const ids = listProjects().map((p) => p.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});