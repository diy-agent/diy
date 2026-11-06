// src/main/core/input-limit-config.ts
// 🎯 用户单条消息字符上限的**文件层**：全局一份 $DIY_HOME/input-limit.yaml 的读写。
//
// 为什么单独一个文件而不是塞进 state.yaml：state.yaml 由运行中的应用**独占写入**（见提示词里的
// 硬规则），而这份是**用户配置**（可以手改），两者混在一处会互相踩。
//
// 分家历史（##520）：这个键原先跟着「投递划分」一起住。投递划分已删（信封只有一份全量），
// 只剩阈值 —— 于是它单独一份文件，不再背上下文投递的语义。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import * as yaml from "js-yaml";
import { DEFAULT_INPUT_LIMIT_CHARS, sanitizeInputLimitChars } from "../../shared/context/input-limit";

export function inputLimitConfigFile(home: string): string {
  return join(home, "input-limit.yaml");
}

/** 读原始文档（文件缺失 / 解析失败 / 结构不符 → null） */
function readRawDoc(home: string): Record<string, unknown> | null {
  const p = inputLimitConfigFile(home);
  if (!existsSync(p)) return null; // sync-io-ok: 真发前要同步拿到阈值
  try {
    const doc = yaml.load(readFileSync(p, "utf-8")); // sync-io-ok: 同上
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

/** 写输入上限（原子写；保住别的键）。返回净化后的值。 */
export function saveInputLimitChars(home: string, chars: number): number {
  const value = sanitizeInputLimitChars(chars);
  const prev = readRawDoc(home) ?? {};
  const header =
    "# 用户单条消息的字符上限（超过 → 发送前弹门禁框，##426）\n" +
    "# 读写入口：对话页的门禁框（或直接改本文件；下一轮生效）\n";
  writeFileAtomic(inputLimitConfigFile(home), header + yaml.dump({ ...prev, inputLimitChars: value }, { indent: 2, noRefs: true }));
  return value;
}
