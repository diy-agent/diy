// src/main/core/state.ts
// 🎯 纯文件 I/O 操作：state.yaml R/W、AGENTS.md 解析
//    类型全显式，无 any，无 Record<string, unknown> 逃逸
//
//    数据布局（project 替代 subject）：
//      $DIY_HOME/projects/<id>/meta.yaml   ← 项目权威注册表 {id, path, label, desc, state}
//      $DIY_HOME/projects/<id>/tasks/<tid>/AGENTS.md  ← 任务数据（按项目聚合）
//      任务 URI = projects/<pid>/tasks/<tid>，project 由路径推导

import * as yaml from "js-yaml";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

// TaskState 单一真相源在 task-state.ts（此处 re-export 保持兼容） */
export type { TaskState } from "./task-state";
import type { TaskState } from "./task-state";

/** AGENTS.md frontmatter 字段（不含 body，body 单独提取） */
export interface TaskMeta {
  title?: string;
  state?: TaskState;
  parent?: string;
  body?: string;
  created?: string;
  updated?: string;
  source_type?: string;
  source_uri?: string;
  /** 变更性质。词表见 task-fields.ts；类型是 string —— 读侧宽容，见 parseTaskFile */
  change_type?: string;
  /** 模块（`/` 分层自由字符串） */
  module?: string;
  /** 优先级 P0-P3；缺省 = 未定级。同上，读侧是 string */
  priority?: string;
}

/** 完整任务数据（URI + frontmatter 字段 + body） */
export interface TaskData extends TaskMeta {
  uri: string;
  body: string;
  /**
   * 所属 project id —— **由 URI 路径推导**的投影，不落盘（URI 是唯一真相源）。
   * 与 TaskNode.num 同理：算一次给调用方用，避免 UI/CLI 各自 split 出偏差。
   */
  project?: string;
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

/** project 元数据。key = 系统自动生成的数字自增 id。 */
export interface ProjectInfo {
  readonly label?: string;
  readonly path?: string;
  readonly desc?: string;
  readonly state?: string;
}

export interface StateData {
  readonly profiles: Map<string, Profile>;
  readonly subjects: Map<string, SubjectInfo>;
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

/** 项目注册表根：$DIY_HOME/projects/<id>/ */
export function projectsRoot(): string {
  return join(diyHome(), "projects");
}

/** 项目数据目录：$DIY_HOME/projects/<id>/ */
export function projectDir(id: string): string {
  return join(projectsRoot(), id);
}

/** 任务 URI = projects/<pid>/tasks/<tid>，目录即 $DIY_HOME/<uri> */
export function taskDir(uri: string): string {
  return join(diyHome(), uri);
}

export function taskFilePath(uri: string): string {
  return join(taskDir(uri), "AGENTS.md");
}

/** 从任务 URI 推导所属 project id：projects/<pid>/tasks/<tid>
 *  实现在 shared/task-uri.ts（renderer 也用它，两份正则口径曾不一致）。 */
import { projectFromUri } from "../../shared/task-uri";
export { projectFromUri };

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

  return { profiles, subjects };
}

/** 保存 state.yaml。原子写入（tmp → rename）。
 *
 * 注意：profiles 和 subjects 会完全替换对应字段（不是 merge），
 * 所以调用方必须传入完整数据。addSubject/removeSubject 等已正确处理。
 */
export function saveState(data: {
  profiles?: ReadonlyMap<string, Profile> | Record<string, Profile>;
  subjects?: ReadonlyMap<string, SubjectInfo> | Record<string, SubjectInfo>;
}): void {
  const current = loadState();
  const merged: Record<string, unknown> = {};

  if (data.profiles !== undefined) {
    const src = data.profiles instanceof Map ? Object.fromEntries(data.profiles) : data.profiles;
    merged["profiles"] = src;
  } else {
    merged["profiles"] = Object.fromEntries(current.profiles);
  }

  // TODO subjects 应清理
  if (data.subjects !== undefined) {
    const src = data.subjects instanceof Map ? Object.fromEntries(data.subjects) : data.subjects;
    merged["subjects"] = src;
  } else {
    merged["subjects"] = Object.fromEntries(current.subjects);
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

/**
 * 计算下一个自增数字 id：取传入现有 id 中数字 id 的最大值 + 1，从 start 起。
 * 非数字 id（历史遗留字符串 key）忽略，不影响计数。
 */
export function nextNumericId(existing: Iterable<string>, start = 1): string {
  let max = start - 1;
  for (const key of existing) {
    if (/^\d+$/.test(key)) {
      const n = Number(key);
      if (n > max) max = n;
    }
  }
  return String(max + 1);
}

const FM_SEP = "---";

/**
 * 把 AGENTS.md 原始文本拆成「原始 frontmatter 对象 + body」，不做字段白名单过滤。
 *
 * 为什么单独导出原始 frontmatter：`updateTask` 必须能拿到**未过滤**的键集合，
 * 才能做到「只覆盖我们管的字段，其余原样保留」（否则用户/外部工具加的自定义字段：
 * tags / priority / note / source_type / source_uri… 会在任何一次编辑时被静默丢弃）。
 * 解析逻辑只此一处，parseTaskFile 与 updateTask 共用，避免两处漂移。
 */
export function splitTaskFile(raw: string): { front: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith(FM_SEP)) return null;
  const endIdx = raw.indexOf(FM_SEP, 3);
  if (endIdx === -1) return null;

  const headRaw = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 3).trim();
  // 空 frontmatter 是合法情况（yaml.load('') 返回 null）
  const front = (yaml.load(headRaw || "{}") as Record<string, unknown>) ?? {};
  return { front, body };
}

/** 从 AGENTS.md 原始文本中提取 frontmatter (YAML) + body (markdown)。 */
export function parseTaskFile(raw: string): TaskMeta | null {
  const split = splitTaskFile(raw);
  if (!split) return null;
  const { front, body } = split;

  return {
    title: front["title"] as string | undefined,
    state: front["state"] as TaskState | undefined,
    parent: front["parent"] as string | undefined,
    body,
    created: front["created"] as string | undefined,
    updated: front["updated"] as string | undefined,
    source_type: front["source_type"] as string | undefined,
    source_uri: front["source_uri"] as string | undefined,
    // 结构化字段：**只读不校验**，故类型是 string 而非 task-fields 的枚举 —— 值不在词表内
    // （如历史手写的 priority: high）也原样带出，交给展示层兜底。这与「不改写用户手写内容」
    // 的原则一致：若在此丢弃或归一化，用户手工写的值会在下一次编辑时被静默改写。
    // 枚举校验只发生在**写入侧**（task.create / task.edit 的 zod input）。
    change_type: front["change_type"] as string | undefined,
    module: front["module"] as string | undefined,
    priority: front["priority"] as string | undefined,
  };
}

/** 读取并解析一条任务文件 */
export function getTask(uri: string): TaskData | null {
  const fp = taskFilePath(uri);
  if (!existsSync(fp)) return null;
  const meta = parseTaskFile(readFileSync(fp, "utf-8"));
  if (!meta) return null;
  // project 一律从 URI 路径推导（路径即分组）。历史上存在 frontmatter project 字段，
  // 那是冗余副本（可能路径不同步），已由 scripts/migrate-task-fields.mts 清除，此处不再读。
  return { uri, body: meta.body ?? "", ...meta, project: projectFromUri(uri) };
}

/** 检查任务文件是否存在 */
export function taskExists(uri: string): boolean {
  return existsSync(taskFilePath(uri));
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

// ═══════════════════════════════════════
// 任务系统目录（.diy/）
// ═══════════════════════════════════════

/**
 * 任务目录内的系统自留地：`$DIY_HOME/<uri>/.diy/`。
 *
 * 所有权分层（新增规矩，勿越界）：
 *   AGENTS.md  ← 面向用户，允许直接编辑
 *   .diy/**    ← 系统独占，仅 main 进程经 RPC 写入，不承诺格式稳定
 *
 * 为什么用点前缀而非 `data/`：
 *   1. 仓库已有先例（pkgs.ts/diy-app/.diy/ref.lock.yaml，见 core/ref.ts）
 *   2. `ls` / shell 通配 / Finder 默认跳过 dotfile → 用户脚本不会误吞系统文件
 *   3. `$` 前缀目录名（如 `$data`）在 shell 里会展开，是事故隐患
 *
 * 扫描安全性：listTasks 按 `^\d+$` 过滤、task-tree 的 scanAllDirs 见 AGENTS.md 即停，
 * 故任务目录内多一个 .diy/ 不会被误认成任务。
 */
export function taskSystemDir(uri: string): string {
  return join(taskDir(uri), ".diy");
}
