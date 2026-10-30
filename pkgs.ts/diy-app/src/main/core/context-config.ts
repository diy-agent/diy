// src/main/core/context-config.ts
// 🎯 上下文划分规则的**文件层**：全局一份 $DIY_HOME/context.yaml 的读写。
//
// 分层：契约与净化在 shared/context/config.ts（纯函数、可单测），本文件只做文件 I/O。
// 与 core/persona.ts 同一套做法（existsSync → yaml.load → schema.safeParse → 出声回落 → 原子写）。
//
// 为什么单独一个文件而不是塞进 state.yaml：state.yaml 由运行中的应用**独占写入**（见提示词里的
// 硬规则），而这份是**用户配置**（可以手改、可以版本管理），两者混在一处会互相踩。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import * as yaml from "js-yaml";
import { sanitizeInputLimitChars, sanitizeSystemPlaces } from "../../shared/context/config";
import { ContextConfigSchema } from "../../shared/context/config";
import { defaultSystemPlaces } from "@diy-agent/context/delivery";
import { DEFAULT_INPUT_LIMIT_CHARS } from "../../shared/context/input-limit";

export function contextConfigFile(home: string): string {
  return join(home, "context.yaml");
}

/**
 * 读整份 context.yaml 的**原始文档**（不做净化；文件缺失 / 解析失败 / 结构不符 → null）。
 * 用途：写回时**保住别人的键**（写 `systemPlaces` 不该顺手把 `inputLimitChars` 抹掉）。
 */
function readRawDoc(home: string): Record<string, unknown> | null {
  const p = contextConfigFile(home);
  if (!existsSync(p)) return null; // sync-io-ok: 与 loadSystemPlaces 同一条读侧同步路径（真发前要同步拿到名单）
  try {
    const doc = yaml.load(readFileSync(p, "utf-8")); // sync-io-ok: 同上 —— 读侧本来就同步，不在这里新造异步链
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 读用户单条消息的字符上限（##426 B）。
 * 文件缺失 / 键缺失 / 值非法 → 缺省（**不是 0、不是 null**：门禁永远有一个可用阈值）。
 */
export function loadInputLimitChars(home: string): number {
  const doc = readRawDoc(home);
  if (!doc) return DEFAULT_INPUT_LIMIT_CHARS;
  return sanitizeInputLimitChars(doc["inputLimitChars"]);
}

/**
 * 读划分规则（**真发与页面共用这一份**）。
 * 文件缺失 → 推荐名单（开箱即用，与旧行为逐字节一致）；
 * 文件不可解析/结构不符 → 推荐名单 + 出声；内容能读但有个别坏项 → 丢掉坏项 + 出声（见 sanitize）。
 */
export function loadSystemPlaces(home: string): string[] {
  const p = contextConfigFile(home);
  if (!existsSync(p)) return defaultSystemPlaces();
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(p, "utf-8"));
  } catch (e) {
    console.warn(`[context] ${p} 解析失败，用推荐名单:`, e);
    return defaultSystemPlaces();
  }
  const parsed = ContextConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[context] ${p} 结构不符（${parsed.error.issues.map((i) => i.path.join(".")).join(",")}），用推荐名单`,
    );
    return defaultSystemPlaces();
  }
  const { places, dropped } = sanitizeSystemPlaces(parsed.data.systemPlaces);
  if (dropped.length > 0) {
    console.warn(`[context] ${p} 丢弃了 ${dropped.length} 个无效单元：${dropped.join(", ")}`);
  }
  return places;
}

/** 写划分规则（原子：tmp → rename）。结构非法直接抛（写侧不允许存下坏数据）。 */
export function saveSystemPlaces(home: string, systemPlaces: readonly string[]): string[] {
  const { places, dropped } = sanitizeSystemPlaces(systemPlaces);
  if (dropped.length > 0) {
    throw new Error(
      `非法投递单元：${dropped.join(", ")}（路径要合法，且两两不可互为祖先/后代）`,
    );
  }
  const header =
    "# agent 系统上下文的投递划分 —— 唯一运行时真源\n" +
    "# 读写入口：上下文树页的 ⇄ 开关（或直接改本文件；下一轮真发生效）\n" +
    "# 结构：只声明**进 system** 的单元，其余自动归 runtime；两两不可互为祖先/后代\n" +
    "# 契约：pkgs.ts/diy-app/src/shared/context/config.ts 的 ContextConfigSchema\n";
  // 保住**别的键**（如 inputLimitChars）：只写 systemPlaces 会把它们静默抹掉，
  // 而「改一次划分就丢了输入阈值」是本任务最不能犯的那类静默损失。
  const prev = readRawDoc(home) ?? {};
  const next: Record<string, unknown> = { ...prev, systemPlaces: [...places] };
  writeFileAtomic(contextConfigFile(home), header + yaml.dump(next, { indent: 2, noRefs: true }));
  return places;
}

/** 写输入上限（原子写；同样保住 systemPlaces 等其它键）。返回净化后的值。 */
export function saveInputLimitChars(home: string, chars: number): number {
  const value = sanitizeInputLimitChars(chars);
  const prev = readRawDoc(home) ?? {};
  const places = Array.isArray(prev["systemPlaces"]) ? (prev["systemPlaces"] as unknown[]).map(String) : undefined;
  const next: Record<string, unknown> = {
    ...prev,
    ...(places ? { systemPlaces: places } : {}),
    inputLimitChars: value,
  };
  const header =
    "# agent 系统上下文的投递划分 —— 唯一运行时真源\n" +
    "# 读写入口：上下文树页的 ⇄ 开关（或直接改本文件；下一轮真发生效）\n" +
    "# 结构：只声明**进 system** 的单元，其余自动归 runtime；两两不可互为祖先/后代\n" +
    "# inputLimitChars：用户单条消息的字符上限（超过 → 发送前弹门禁框，##426）\n" +
    "# 契约：pkgs.ts/diy-app/src/shared/context/config.ts 的 ContextConfigSchema\n";
  writeFileAtomic(contextConfigFile(home), header + yaml.dump(next, { indent: 2, noRefs: true }));
  return value;
}
