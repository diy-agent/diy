// src/main/core/project.ts
// 🎯 project 管理：创建、删除、查询。
//    project 是 task 的组织单元（替代历史 subject）。id = 系统自动生成的数字自增；
//    权威注册表 = $DIY_HOME/projects/<id>/meta.yaml（id→path/元数据），
//    并在目标仓库 diy.yaml 写 project 名片（自描述/共享）。
//    任务数据按项目聚合在 $DIY_HOME/projects/<id>/tasks/，删项目连带任务一次清空。

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { projectsRoot, projectDir, norm, nextNumericId } from "./state";
import type { ProjectInfo } from "./state";

// ═══════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════

/** 读取 YAML 文件，损坏/不存在时返回空对象（不抛） */
function readYaml(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const loaded = yaml.load(readFileSync(path, "utf-8"));
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      return loaded as Record<string, unknown>;
    }
  } catch {
    /* 忽略损坏文件 */
  }
  return {};
}

/** 展开 ~ 前缀为绝对路径 */
function expandPath(p: string): string {
  return resolve(p.replace(/^~/, homedir()));
}

/** 扫描 projects 根下数字目录，得到现有 project id */
function existingProjectIds(): string[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((e) => /^\d+$/.test(e));
}

/** 往目标仓库 diy.yaml 写（合并）project 名片：project: { id, name } */
function writeNamecard(repoPath: string, id: string, name?: string): void {
  const target = expandPath(repoPath);
  if (!existsSync(target)) return; // 目录不存在则跳过名片（best-effort，不阻塞建项目）

  const yamlPath = join(target, "diy.yaml");
  const data = readYaml(yamlPath);
  data["project"] = { id, name: name ?? basename(target) };
  writeFileSync(yamlPath, yaml.dump(data, { indent: 2, noRefs: true, sortKeys: false }), "utf-8");
}

/** 摘除目标仓库 diy.yaml 的 project 名片（连同 ref 等保留） */
function removeNamecard(repoPath: string): void {
  const target = expandPath(repoPath);
  const yamlPath = join(target, "diy.yaml");
  if (!existsSync(yamlPath)) return;

  const data = readYaml(yamlPath);
  if (!("project" in data)) return;
  delete data["project"];

  if (Object.keys(data).length === 0) {
    unlinkSync(yamlPath);
  } else {
    writeFileSync(yamlPath, yaml.dump(data, { indent: 2, noRefs: true, sortKeys: false }), "utf-8");
  }
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ═══════════════════════════════════════
// project CRUD
// ═══════════════════════════════════════

/**
 * 创建 project：id 自动数字自增，建 $DIY_HOME/projects/<id>/tasks/，
 * 写 meta.yaml 权威注册表，并在 <path> 目录写 diy.yaml 名片。返回新 id。
 */
export function createProject(
  path: string,
  opts: { label?: string; desc?: string; state?: string } = {},
): string {
  const id = nextNumericId(existingProjectIds());
  const pid = projectDir(id);
  mkdirSync(join(pid, "tasks"), { recursive: true });

  const meta: Record<string, unknown> = { id, path: norm(path), created: new Date().toISOString() };
  if (opts.label !== undefined) meta["label"] = opts.label;
  if (opts.desc !== undefined) meta["desc"] = opts.desc;
  if (opts.state !== undefined) meta["state"] = opts.state;
  writeFileSync(join(pid, "meta.yaml"), yaml.dump(meta, { indent: 2, noRefs: true }), "utf-8");

  writeNamecard(path, id, opts.label);
  return id;
}

/** 删除 project：摘除目标仓库名片 + 删除数据目录（连带任务） */
export function removeProject(id: string): void {
  const pid = projectDir(id);
  if (existsSync(pid)) {
    const meta = readYaml(join(pid, "meta.yaml"));
    const repoPath = meta["path"] as string | undefined;
    if (repoPath) removeNamecard(repoPath);
    rmSync(pid, { recursive: true, force: true });
  }
}

/** 列出所有 project（按 id 数值排序） */
export function listProjects(): Array<{ id: string; info: ProjectInfo }> {
  const root = projectsRoot();
  if (!existsSync(root)) return [];

  return existingProjectIds()
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => {
      const raw = readYaml(join(projectDir(id), "meta.yaml"));
      return {
        id,
        info: {
          label: raw["label"] as string | undefined,
          path: raw["path"] as string | undefined,
          desc: raw["desc"] as string | undefined,
          state: raw["state"] as string | undefined,
        },
      };
    });
}

/** 取 project 注册信息（展示用：path/label；未注册返回 undefined）。
 *  调用方用它把裸 pid 解析成实际路径（home 内 ~/…，之外绝对路径，存盘时已由 norm 定好）。 */
export function getProjectInfo(id: string): ProjectInfo | undefined {
  return listProjects().find((p) => p.id === id)?.info;
}

/** project 是否存在（task create 校验用） */
/** 取 project 的目标仓库绝对路径（meta.yaml:path 展开后） */
export function getProjectPath(id: string): string | undefined {
  const meta = readYaml(join(projectDir(id), "meta.yaml"));
  const p = meta["path"] as string | undefined;
  return p ? expandPath(p) : undefined;
}

export function projectExists(id: string): boolean {
  return existsSync(projectDir(id));
}