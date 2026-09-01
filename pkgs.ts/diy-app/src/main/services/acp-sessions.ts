// src/main/services/acp-sessions.ts
// 🎯 task 级 ACP session 池 — 每个 task 一个 ACP session（历史隔离，不串）
//
// 设计（与 acp-agent.ts 底层 client/session 配合）：
//   - 单例一个 AcpClient（hermes acp 子进程）
//   - Map<taskUri, AcpSession> —— 每个 task 独立一个 session
//   - 每个 session 的 cwd = 该 task 所属 project 的目标仓库目录（meta.yaml:path）
//   - sessionId 持久化到 project 的 meta.yaml（task 维度 key）：重启后 session/load 恢复
//
// 依赖：acp-agent.ts 的 AcpClient/AcpSession（自建轻量 ACP 客户端）
import { AcpClient, AcpSession, type AcpSessionInfo } from "./acp-agent";
import { projectFromUri, projectDir } from "../core/state";
import { getProjectPath } from "../core/project";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ═══════════════════════════════════════
// 持久化：project meta.yaml 的 acp_sessions 字段
//   结构：acp_sessions: { "<taskUri>": "<sessionId>" }
// ═══════════════════════════════════════

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

// ═══════════════════════════════════════
// TaskSessionPool — task 级 session 池
// ═══════════════════════════════════════

/**
 * 管理每个 task 的 ACP session。
 * - 单进程 AcpClient（hermes acp）
 * - 每 task 一个 AcpSession，cwd = 所属 project 目录
 * - 有持久化 sessionId → session/load 恢复；无 → session/new 创建并持久化
 */
export class AcpSessionPool {
  private client: AcpClient;
  /** taskUri → session */
  private sessions = new Map<string, AcpSession>();

  constructor(command = "hermes acp") {
    this.client = new AcpClient({ command, cwd: process.cwd() });
  }

  /** 取某 task 的 session：优先恢复，无则新建 */
  async ensure(taskUri: string): Promise<AcpSession> {
    const existing = this.sessions.get(taskUri);
    if (existing) return existing;

    const session = await this.loadOrCreate(taskUri);
    this.sessions.set(taskUri, session);
    return session;
  }

  /** 按 project 目录建/恢复 session */
  private async loadOrCreate(taskUri: string): Promise<AcpSession> {
    if (!this.client.capabilities) await this.client.initialize();

    const pid = projectFromUri(taskUri);
    const cwd = (pid ? getProjectPath(pid) : undefined) ?? process.cwd();

    // 尝试恢复持久化的 sessionId
    const savedId = readTaskSessionId(taskUri);
    if (savedId && this.client.capabilities?.loadSession) {
      try {
        const result = await this.client.request("session/load", {
          sessionId: savedId,
          metadata: { cwd },
        });
        const info = parseSessionInfo(result as Record<string, unknown>, this.client);
        return new AcpSession(this.client, info);
      } catch {
        // 恢复失败 → 回退新建
      }
    }

    // 新建
    const info = await this.ensureNewSession(taskUri, cwd);
    return new AcpSession(this.client, info);
  }

  private async ensureNewSession(taskUri: string, cwd: string): Promise<AcpSessionInfo> {
    const result = await this.client.request("session/new", { cwd, mcpServers: [] });
    const info = parseSessionInfo(result as Record<string, unknown>, this.client);
    writeTaskSessionId(taskUri, info.sessionId);
    return info;
  }

  /** 关闭某 task 的 session（可选，agent 可能不支持 close） */
  async closeSession(taskUri: string): Promise<void> {
    const s = this.sessions.get(taskUri);
    if (s) {
      try { await s.close(); } catch { /* close 可选 */ }
      this.sessions.delete(taskUri);
    }
    clearTaskSessionId(taskUri);
  }

  /**
   * 向某 task 的 session 流式对话：yield 文本增量。
   * 多次调用同一 task 的 prompt，session 上下文连续。
   */
  async *streamChat(
    taskUri: string,
    _model: string,
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const session = await this.ensure(taskUri);

    // 文本增量队列 + 完成/唤醒信号
    const queue: string[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const kick = () => { wake?.(); wake = null; };

    const unsub = session.onEvent((ev) => {
      if (ev.kind === "agent_message_chunk") {
        const text = (ev.data["content"] as { text?: string })?.text;
        if (text) { queue.push(text); kick(); }
      }
    });

    try {
      const promptDone = session
        .prompt(messages.map((m) => ({ type: "text", text: m.content })))
        .finally(() => { ended = true; kick(); });

      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) break;
        await new Promise<void>((r) => {
          wake = r;
          if (queue.length > 0 || ended) r();
        });
      }
      await promptDone;
    } finally {
      unsub();
    }
  }

  /** 非流式对话：聚合流式增量为完整回复。 */
  async chat(
    taskUri: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ role: string; content: string }> {
    const collected: string[] = [];
    for await (const t of this.streamChat(taskUri, model, messages)) collected.push(t);
    return { role: "assistant", content: collected.join("") };
  }

  /** 某 task 的 session 状态 */
  async status(taskUri: string): Promise<{ taskUri: string; state: string; model?: string }> {
    const session = await this.ensure(taskUri);
    return {
      taskUri,
      state: "ready",
      model: session.info.currentModelId,
    };
  }

  /** 列出模型：取池内已有 session 的模型列表；无 session 时新建一个探测 session */
  async listModels(): Promise<Array<{ modelId: string; name?: string }>> {
    if (this.sessions.size > 0) {
      const first = this.sessions.values().next().value as AcpSession | undefined;
      return first?.info.models ?? [];
    }
    const info = await this.ensureNewSession("__probe__", process.cwd());
    const sess = new AcpSession(this.client, info);
    this.sessions.set("__probe__", sess);
    return info.models;
  }

  /** 关闭所有进程（app 退出时） */
  async dispose(): Promise<void> {
    await this.client.close();
    this.sessions.clear();
  }
}

/** 解析 session/new 或 load 的 result → AcpSessionInfo（与 acp-agent 内部一致） */
function parseSessionInfo(result: Record<string, unknown>, client: AcpClient): AcpSessionInfo {
  const models = ((result["models"] as Record<string, unknown>)?.["availableModels"] ?? []) as Array<{ modelId: string; name?: string }>;
  const modes = ((result["modes"] as Record<string, unknown>)?.["availableModes"] ?? []) as Array<{ id: string; name?: string }>;
  return {
    sessionId: String(result["sessionId"]),
    models,
    currentModelId: (result["models"] as Record<string, unknown>)?.["currentModelId"] as string | undefined,
    modes,
    currentModeId: (result["modes"] as Record<string, unknown>)?.["currentModeId"] as string | undefined,
    capabilities: client.capabilities ?? { loadSession: false, resume: false, list: false, fork: false, promptImage: false, meta: {} },
    agentInfo: client.agentInfo ?? { name: "unknown" },
  };
}
