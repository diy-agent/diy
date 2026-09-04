// src/main/services/acp-sessions-persist.ts
// ACP session 持久化：taskUri → sessionId 存储于 project meta.yaml

import { projectFromUri, projectDir } from "../core/state";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

/** 读某 task 的持久化 sessionId（存于所属 project meta.yaml） */
export function readTaskSessionId(taskUri: string): string | undefined {
  const pid = projectFromUri(taskUri);
  if (!pid) return undefined;
  const metaFile = join(projectDir(pid), "meta.yaml");
  if (!existsSync(metaFile)) return undefined;
  const raw = yaml.load(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
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
  const raw = (existsSync(metaFile)
    ? yaml.load(readFileSync(metaFile, "utf-8"))
    : {}) as Record<string, unknown>;
  const sessions = (raw["acp_sessions"] ?? {}) as Record<string, string>;
  sessions[taskUri] = sessionId;
  raw["acp_sessions"] = sessions;
  writeFileSync(metaFile, yaml.dump(raw, { indent: 2, noRefs: true }), "utf-8");
}

/** 删除某 task 的持久化 sessionId（session 关闭时清理） */
export function clearTaskSessionId(taskUri: string): void {
  const pid = projectFromUri(taskUri);
  if (!pid) return;
  const metaFile = join(projectDir(pid), "meta.yaml");
  if (!existsSync(metaFile)) return;
  const raw = yaml.load(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
  const sessions = (raw["acp_sessions"] ?? {}) as Record<string, string>;
  if (taskUri in sessions) {
    delete sessions[taskUri];
    raw["acp_sessions"] = sessions;
    writeFileSync(metaFile, yaml.dump(raw, { indent: 2, noRefs: true }), "utf-8");
  }
}
