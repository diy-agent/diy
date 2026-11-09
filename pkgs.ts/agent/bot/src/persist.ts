// src/persist.ts
// 🎯 **内存优先的持久化**（##519 / docs/plans/2026-11-07-agent-aggregate.md）：
//   内存是唯一真源；磁盘只做两件事——**快照**（重启恢复）和**审计日志**（append-only，不参与逻辑）。
//
// 为什么快照而不是回放：用户 2026-11-07 定「ops 只是 log，只做审计，不作为核心逻辑」。
// 回放式推导是 diy-app 里一半复杂度的来源（边界锚点 / schema 断代 / 降级 / 探活）。
// 快照是 `JSON.stringify(state)`——**形状随便改**，因为没有任何读取方按格式解析它。
//
// 写入顺序（不能反）：改内存 → 分配 seq → 发事件 → **异步**落盘。
// 反过来会让磁盘 I/O 卡住状态机，且磁盘失败时状态已经生效，两边不一致更难解释。

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PersistState {
  /** 已分配的最大 seq */
  seq: number
  /** 历史条目（内存投影的持久化形态，字段随实现演进而变） */
  entries: unknown[]
  /** 已完成的轮数 */
  turns: number
  /** 每个 job 的状态 */
  jobs: Record<string, unknown>
}

export interface PersistPorts {
  load(): PersistState | null
  /** 原子写（先写临时文件再 rename）：崩溃时不会留下半个 JSON */
  save(state: PersistState): void
  /** 审计日志：append 一行，失败不抛（审计不该拖垮业务） */
  audit(line: Record<string, unknown>): void
}

/**
 * 文件版持久化。目录由调用方给（diy 里是 `$DIY_HOME/<task>/agent/`）。
 * 两个文件：`state.json`（快照）+ `audit.jsonl`（只追加）。
 */
export function filePersist(dir: string): PersistPorts {
  const statePath = join(dir, "state.json");
  const auditPath = join(dir, "audit.jsonl");
  return {
    load() {
      try {
        if (!existsSync(statePath)) return null;
        return JSON.parse(readFileSync(statePath, "utf-8")) as PersistState;
      } catch {
        // 快照坏了就当没有（审计日志仍在，可人工查）—— 不阻断启动
        return null;
      }
    },
    save(state) {
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = `${statePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(state), "utf-8");
        renameSync(tmp, statePath);
      } catch (e) {
        console.error("[agent] 快照写入失败：", e);
      }
    },
    audit(line) {
      try {
        mkdirSync(dirname(auditPath), { recursive: true });
        appendFileSync(auditPath, `${JSON.stringify(line)}\n`, "utf-8");
      } catch (e) {
        console.error("[agent] 审计写入失败：", e);
      }
    },
  };
}

/** 内存版（测试用）：什么都没有，什么都不写 */
export function memoryPersist(initial: PersistState | null = null): PersistPorts & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    load: () => initial,
    save: () => undefined,
    audit: (line) => {
      lines.push(line);
    },
  };
}
