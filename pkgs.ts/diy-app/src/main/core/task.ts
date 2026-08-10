// src/main/core/task.ts
// 🎯 任务 CRUD + 校验。纯函数，无全局状态。
//    所有输入验证用 zod，收集全部错误再抛出（不短路）。

import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { getTask, taskDir, taskFilePath, starTask, diyHome, loadState } from "./state";
import type { TaskMeta } from "./state";

// ═══════════════════════════════════════
// 字段验证 schema
// ═══════════════════════════════════════

export const TaskStateSchema = z.enum([
  "pending",
  "active",
  "done",
  "cancelled",
  "blocked",
  "shelved",
  "new",
  "open",
  "closed",
]);

// ═══════════════════════════════════════
// 错误类型
// ═══════════════════════════════════════

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly msg: string;
}

export class ValidationError extends Error {
  override readonly name = "ValidationError" as const;

  constructor(readonly errors: readonly FieldError[]) {
    super(errors.map((e) => e.msg).join("; "));
  }
}

const FM_SEP = "---";

// ═══════════════════════════════════════
// 创建任务
// ═══════════════════════════════════════

export interface CreateTaskParams {
  title: string;
  subject: string;
  parent?: string;
  detail?: string;
  body?: string;
  source_type?: string;
  source_uri?: string;
}

const CreateTaskSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(200, "标题不超过 200 字符"),
  subject: z.string().min(1, "subject 不能为空"),
  parent: z.string().optional(),
  detail: z.string().optional(),
  body: z.string().optional(),
  source_type: z.string().optional(),
  source_uri: z.string().optional(),
});

/**
 * 创建一条任务，写入 AGENTS.md，自动 star。
 * 抛出 ValidationError（校验失败）或 Error（业务冲突）。
 */
export function createTask(params: CreateTaskParams): string {
  const parsed = CreateTaskSchema.safeParse(params);
  if (!parsed.success) {
    const errors: FieldError[] = parsed.error.issues.map((iss) => ({
      field: iss.path.join("."),
      code: iss.code,
      msg: iss.message,
    }));
    throw new ValidationError(errors);
  }

  const { title, subject, parent, detail, body, source_type, source_uri } = parsed.data;

  // 校验 subject 是否注册
  const state = loadState();
  if (!state.subjects.has(subject)) {
    throw new ValidationError([
      { field: "subject", code: "not_found", msg: `subject ${subject} 未注册` },
    ]);
  }

  // 校验父任务存在
  if (parent && !getTask(parent)) {
    throw new ValidationError([
      { field: "parent", code: "not_found", msg: `parent ${parent} 不存在` },
    ]);
  }

  // 生成 URI：时间戳 base36
  const ts = Date.now().toString(36);
  const uri = `local/${ts}`;

  const dir = taskDir(uri);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const meta: TaskMeta = {
    title,
    subject,
    state: "pending",
    parent,
    detail,
    created: now,
    updated: now,
    source_type,
    source_uri,
  };

  const front = yaml.dump(meta, { indent: 2, noRefs: true });
  writeFileSync(taskFilePath(uri), `${FM_SEP}\n${front}${FM_SEP}\n${body ?? ""}`, "utf-8");

  // 自动 star
  starTask(uri);

  return uri;
}

// ═══════════════════════════════════════
// 更新任务
// ═══════════════════════════════════════

export interface UpdateTaskChanges {
  title?: string;
  state?: string;
  detail?: string;
  body?: string;
}

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  state: TaskStateSchema.optional(),
  detail: z.string().optional(),
  body: z.string().optional(),
});

/** 更新任务指定字段 */
export function updateTask(uri: string, changes: UpdateTaskChanges): void {
  const existing = getTask(uri);
  if (!existing) throw new Error(`任务 ${uri} 不存在`);

  const parsed = UpdateTaskSchema.safeParse(changes);
  if (!parsed.success) {
    const errors: FieldError[] = parsed.error.issues.map((iss) => ({
      field: iss.path.join("."),
      code: iss.code,
      msg: iss.message,
    }));
    throw new ValidationError(errors);
  }

  const now = new Date().toISOString();
  const updated: TaskMeta = {
    title: parsed.data.title ?? existing.title,
    state: (parsed.data.state ?? existing.state) as TaskMeta["state"],
    detail: parsed.data.detail ?? existing.detail,
    body: parsed.data.body ?? existing.body,
    subject: existing.subject,
    parent: existing.parent,
    created: existing.created,
    updated: now,
  };

  const { body: b, ...front } = updated;
  const frontStr = yaml.dump(front, { indent: 2, noRefs: true });
  writeFileSync(taskFilePath(uri), `${FM_SEP}\n${frontStr}${FM_SEP}\n${b ?? ""}`, "utf-8");
}

// ═══════════════════════════════════════
// 删除任务
// ═══════════════════════════════════════

/** 删除任务目录（含 AGENTS.md） */
export function deleteTask(uri: string): void {
  const dir = taskDir(uri);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════
// 列出任务
// ═══════════════════════════════════════

/** 列出所有任务 URI（可选按 subject 筛选） */
export function listTasks(subject?: string): string[] {
  const taskRoot = join(diyHome(), "task");
  if (!existsSync(taskRoot)) return [];

  const uris: string[] = [];

  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;

      const relPath = prefix ? `${prefix}/${entry}` : entry;
      const agPath = join(fullPath, "AGENTS.md");

      if (existsSync(agPath)) {
        // 按 subject 前缀过滤
        if (subject === undefined || relPath.startsWith(subject)) {
          uris.push(relPath);
        }
      } else {
        // 递归往下找
        walk(fullPath, relPath);
      }
    }
  }

  walk(taskRoot, "");
  return uris;
}
