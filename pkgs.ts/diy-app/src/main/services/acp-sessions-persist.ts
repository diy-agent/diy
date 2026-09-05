// src/main/services/acp-sessions-persist.ts
// ACP session 持久化：taskUri → sessionId 存储于 project meta.yaml

import { projectFromUri, projectDir } from "../core/state";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

/** 安全读取 YAML 文件，解析失败返回空对象 */
function safeLoadYaml(filePath: string): Record<string, unknown> {
  try {
    const raw = yaml.load(readFileSync(filePath, "utf-8"));
    return (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 安全写入 YAML 文件，写入失败静默（不崩溃） */
function safeWriteYaml(filePath: string, data: Record<string, unknown>): void {
  try {
    writeFileSync(filePath, yaml.dump(data, { indent: 2, noRefs: true }), "utf-8");
  } catch {
    // 写入失败（磁盘满/权限）静默，不崩溃
  }
}

/** 读某 task 的持久化 sessionId（存于所属 project meta.yaml） */
export function readTaskSessionId(taskUri: string): string | undefined {
  const pid = projectFromUri(taskUri);
  if (!pid) return undefined;
  const metaFile = join(projectDir(pid), "meta.yaml");
  if (!existsSync(metaFile)) return undefined;
  const raw = safeLoadYaml(metaFile);
  const sessions = (raw["acp_sessions"] ?? {}) as Record<string, string>;
  return sessions[taskUri];
}

/** 持久化某 task 的 sessionId */
export function writeTaskSessionId(taskUri: string, sessionId: string): void {
  const pid = projectFromUri(taskUri);
  if (!pid) return;
  const dir = projectDir(pid);
  mkdirSync(dir, { recursive: true });
  const metaFile = join(dir, "meta.yaml");
  const raw = safeLoadYaml(metaFile);
  const sessions = (raw["acp_sessions"] ?? {}) as Record<string, string>;
  sessions[taskUri] = sessionId;
  raw["acp_sessions"] = sessions;
  safeWriteYaml(metaFile, raw);
}

/** 删除某 task 的持久化 sessionId（session 关闭时清理） */
export function clearTaskSessionId(taskUri: string): void {
  const pid = projectFromUri(taskUri);
  if (!pid) return;
  const metaFile = join(projectDir(pid), "meta.yaml");
  if (!existsSync(metaFile)) return;
  const raw = safeLoadYaml(metaFile);
  const sessions = (raw["acp_sessions"] ?? {}) as Record<string, string>;
  if (taskUri in sessions) {
    delete sessions[taskUri];
    raw["acp_sessions"] = sessions;
    safeWriteYaml(metaFile, raw);
  }
}
