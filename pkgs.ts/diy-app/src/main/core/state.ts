// src/main/core/state.ts
// 🎯 纯文件 I/O 操作：state.yaml R/W、AGENTS.md 解析、star/unstar
//    类型全显式，无 any，无 Record<string, unknown> 逃逸

import * as yaml from "js-yaml";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

export type TaskState =
  | "pending"
  | "active"
  | "done"
  | "cancelled"
  | "blocked"
  | "shelved"
  | "new"
  | "open"
  | "closed";

/** AGENTS.md frontmatter 字段（不含 body，body 单独提取） */
export interface TaskMeta {
  title?: string;
  state?: TaskState;
  /** 所属 project id。兼容读取旧字段 subject。 */
  project?: string;
  parent?: string;
  detail?: string;
  body?: string;
  created?: string;
  updated?: string;
  source_type?: string;
  source_uri?: string;
}

/** 完整任务数据（URI + frontmatter 字段 + body） */
export interface TaskData extends TaskMeta {
  uri: string;
  body: string;
}

export interface Profile {
  readonly area: string;
  readonly merge: string;
  readonly approval: string | null;
}

export interface SubjectInfo {
  readonly label?: string;
  readonly desc?: string;
}

/** project 元数据。key = project id（短标识）。 */
export interface ProjectInfo {
  readonly label?: string;
  readonly path?: string;
  readonly desc?: string;
  readonly state?: string;
}

export interface StateData {
  readonly profiles: Map<string, Profile>;
  readonly subjects: Map<string, SubjectInfo>;
  readonly projects: Map<string, ProjectInfo>;
}

// ═══════════════════════════════════════
// 默认值 & 路径
// ═══════════════════════════════════════

const DEFAULT_PROFILES: Record<string, Profile> = {
  quick: { area: "main", merge: "direct", approval: null },
  standard: { area: "branch", merge: "pr", approval: "self" },
  reviewed: { area: "worktree", merge: "pr", approval: "human" },
} as const;

/** 获取 DIY_HOME。测试环境通过 setup.ts 的 process.env.DIY_HOME 隔离。 */
export function diyHome(): string {
  return process.env["DIY_HOME"] ?? join(homedir(), ".diy");
}

function stateFilePath(): string {
  return join(diyHome(), "state.yaml");
}

function dataRoot(): string {
  const r = join(diyHome(), "task");
  mkdirSync(r, { recursive: true });
  return r;
}

export function taskDir(uri: string): string {
  return join(dataRoot(), uri);
}

export function taskFilePath(uri: string): string {
  return join(taskDir(uri), "AGENTS.md");
}

// ═══════════════════════════════════════
// state.yaml 读写
// ═══════════════════════════════════════

/** 加载 state.yaml。文件不存在时返回默认 profiles + 空 subjects。 */
export function loadState(): StateData {
  const p = stateFilePath();
  let raw: Record<string, unknown> = {};
  if (existsSync(p)) {
    const loaded = yaml.load(readFileSync(p, "utf-8"));
    if (loaded && typeof loaded === "object") {
      raw = loaded as Record<string, unknown>;
    }
  }

  const profilesRaw = raw["profiles"] as Record<string, Profile> | undefined;
  const profiles = new Map<string, Profile>(
    Object.entries({ ...DEFAULT_PROFILES, ...profilesRaw }),
  );

  const subjectsRaw = raw["subjects"] as Record<string, SubjectInfo> | undefined;
  const subjects = new Map<string, SubjectInfo>(Object.entries(subjectsRaw ?? {}));

  const projectsRaw = raw["projects"] as Record<string, ProjectInfo> | undefined;
  const projects = new Map<string, ProjectInfo>(Object.entries(projectsRaw ?? {}));

  return { profiles, subjects, projects };
}

/** 保存 state.yaml。原子写入（tmp → rename）。
 *
 * 注意：profiles 和 subjects 会完全替换对应字段（不是 merge），
 * 所以调用方必须传入完整数据。addSubject/removeSubject 等已正确处理。
 */
export function saveState(data: {
  profiles?: ReadonlyMap<string, Profile> | Record<string, Profile>;
  subjects?: ReadonlyMap<string, SubjectInfo> | Record<string, SubjectInfo>;
  projects?: ReadonlyMap<string, ProjectInfo> | Record<string, ProjectInfo>;
}): void {
  const current = loadState();
  const merged: Record<string, unknown> = {};

  if (data.profiles !== undefined) {
    const src = data.profiles instanceof Map ? Object.fromEntries(data.profiles) : data.profiles;
    merged["profiles"] = src;
  } else {
    merged["profiles"] = Object.fromEntries(current.profiles);
  }

  if (data.subjects !== undefined) {
    const src = data.subjects instanceof Map ? Object.fromEntries(data.subjects) : data.subjects;
    merged["subjects"] = src;
  } else {
    merged["subjects"] = Object.fromEntries(current.subjects);
  }

  if (data.projects !== undefined) {
    const src = data.projects instanceof Map ? Object.fromEntries(data.projects) : data.projects;
    merged["projects"] = src;
  } else {
    merged["projects"] = Object.fromEntries(current.projects);
  }

  const p = stateFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, yaml.dump(merged, { indent: 2, noRefs: true }), "utf-8");
  renameSync(tmp, p);
}

// ═══════════════════════════════════════
// AGENTS.md frontmatter 解析
// ═══════════════════════════════════════

const FM_SEP = "---";

/** 从 AGENTS.md 原始文本中提取 frontmatter (YAML) + body (markdown)。 */
export function parseTaskFile(raw: string): TaskMeta | null {
  if (!raw.startsWith(FM_SEP)) return null;
  const endIdx = raw.indexOf(FM_SEP, 3);
  if (endIdx === -1) return null;

  const headRaw = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 3).trim();
  // 空 frontmatter 是合法情况（yaml.load('') 返回 null）
  const front = yaml.load(headRaw || "{}") as Record<string, unknown>;

  return {
    title: front["title"] as string | undefined,
    state: front["state"] as TaskState | undefined,
    project: (front["project"] as string | undefined) ?? (front["subject"] as string | undefined),
    parent: front["parent"] as string | undefined,
    detail: front["detail"] as string | undefined,
    body,
    created: front["created"] as string | undefined,
    updated: front["updated"] as string | undefined,
    source_type: front["source_type"] as string | undefined,
    source_uri: front["source_uri"] as string | undefined,
  };
}

/** 读取并解析一条任务文件 */
export function getTask(uri: string): TaskData | null {
  const fp = taskFilePath(uri);
  if (!existsSync(fp)) return null;
  const meta = parseTaskFile(readFileSync(fp, "utf-8"));
  if (!meta) return null;
  return { uri, body: meta.body ?? "", ...meta };
}

/** 检查任务文件是否存在 */
export function taskExists(uri: string): boolean {
  return existsSync(taskFilePath(uri));
}

// ═══════════════════════════════════════
// Star / Unstar（基于 symlink）
// ═══════════════════════════════════════

function starLinkName(uri: string): string {
  return uri.replace(/\//g, "__");
}

function starLinkPath(uri: string): string {
  return join(diyHome(), "star", starLinkName(uri));
}

/** 关注任务：在 ~/.diy/star/ 下创建 symlink */
export function starTask(uri: string): void {
  const starDir = join(diyHome(), "star");
  mkdirSync(starDir, { recursive: true });
  const link = starLinkPath(uri);
  if (!existsSync(link)) {
    symlinkSync(taskDir(uri), link);
  }
}

/** 取消关注：删除 symlink，数据不动 */
export function unstarTask(uri: string): void {
  const link = starLinkPath(uri);
  if (existsSync(link)) unlinkSync(link);
}

/** 检查任务是否被关注 */
export function isStarred(uri: string): boolean {
  return existsSync(starLinkPath(uri));
}

// ═══════════════════════════════════════
// 路径规范化
// ═══════════════════════════════════════

/** 将路径统一为 ~/... 格式存储 */
export function norm(p: string): string {
  const home = homedir();
  const expanded = resolve(p.replace(/^~/, home));
  if (expanded === home) return "~";
  if (expanded.startsWith(home + "/")) {
    return "~" + expanded.slice(home.length);
  }
  return expanded;
}
