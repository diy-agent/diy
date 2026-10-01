// src/main/core/persona.ts
// 🎯 agent 人物（persona）的文件层：全局一份 $DIY_HOME/personas.yaml 的读写 + 解析。
//
// 分层：契约在 shared/persona.ts（纯 zod），本文件只做文件 I/O 与"哪个人物生效"的判定。
// 为什么全局一份而不是按项目：先简单（跨项目共用同一批人物），将来要按项目建人物时
// 只需把 personasFile() 换成项目路径，调用方无感。
//
// 为什么默认值兜底成"内置人物"而不是报错：personas.yaml 不存在时系统必须可用
// （开箱即用），且缺省人物是**数据**（用户可改）而不是代码里的硬编码回落 ——
// 旧实现把 DEFAULT_MODEL 硬编码进 chat()，正是"每次重启都回到同一个模型"的病灶。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as yaml from "js-yaml";
import { isKnownModel, reasoningOf } from "../../shared/models";
import {
  BUILTIN_PERSONAS,
  PersonasFileSchema,
  type Persona,
  type PersonaDef,
  type PersonasFile,
} from "../../shared/persona";
import { parseTaskFile } from "./state";

export function personasFile(home: string): string {
  return join(home, "personas.yaml");
}

/** 内置默认（文件缺失/不可解析时的唯一权威） */
function builtinFile(): PersonasFile {
  return BUILTIN_PERSONAS;
}

function builtinPersona(): Persona {
  const [id, def] = Object.entries(BUILTIN_PERSONAS.personas)[0]!;
  return { id, ...def };
}

export function loadPersonas(home: string): PersonasFile {
  const p = personasFile(home);
  if (!existsSync(p)) return builtinFile();
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(p, "utf-8"));
  } catch (e) {
    // 解析失败是**可见降级**：内置人物继续可用，但必须出声（否则用户改了文件却"没反应"）
    console.warn(`[persona] ${p} 解析失败，用内置默认人物:`, e);
    return builtinFile();
  }
  const parsed = PersonasFileSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[persona] ${p} 结构不符（${parsed.error.issues.map((i) => i.path.join(".")).join(",")}），用内置默认人物`);
    return builtinFile();
  }
  if (Object.keys(parsed.data.personas).length === 0) {
    console.warn(`[persona] ${p} 里没有任何人物，用内置默认人物`);
    return builtinFile();
  }
  return parsed.data;
}

/** 写入 personas.yaml（原子：tmp → rename）。结构非法直接抛（写侧不允许存下坏数据）。 */
export function savePersonas(home: string, file: PersonasFile): void {
  const p = personasFile(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, yaml.dump(PersonasFileSchema.parse(file), { indent: 2, noRefs: true }), "utf-8");
  renameSync(tmp, p);
}

/**
 * 生效的缺省人物 id：`default` 必须指向存在的人物；
 * 否则退到人物表里的第一个；再否则退到内置 id（三条规则都只依赖文件本身，不含环境探测）。
 */
export function defaultPersonaId(home: string): string {
  const file = loadPersonas(home);
  if (Object.hasOwn(file.personas, file.default)) return file.default;
  const first = Object.keys(file.personas)[0];
  return first ?? Object.keys(BUILTIN_PERSONAS.personas)[0]!;
}

/** 列出全部人物（含内置兜底）；顺序 = 文件里的书写顺序（UI 选择器照此展示） */
export function listPersonas(home: string): Persona[] {
  const file = loadPersonas(home);
  return Object.entries(file.personas).map(([id, def]) => ({ id, ...def }));
}

/** 按 **id** 取人物（引用键；唯一可靠寻址方式） */
export function personaById(home: string, id: string): Persona | null {
  const def = loadPersonas(home).personas[id];
  return def ? { id, ...def } : null;
}

/**
 * 按 id 或名字取人物 —— **CLI 便利入口**（人敲命令时记得的是名字，不是 id）。
 * 名字不保证唯一（两个人物可以同名），命中多个时取第一个并出声。
 */
export function personaByIdOrName(home: string, key: string): Persona | null {
  const direct = personaById(home, key);
  if (direct) return direct;
  const hits = listPersonas(home).filter((p) => p.name === key);
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    console.warn(`[persona] 名字「${key}」对应 ${hits.length} 个人物，取 ${hits[0]!.id}（同名不唯一，建议用 id）`);
  }
  return hits[0]!;
}

/**
 * 任务 frontmatter 里的 `persona` 引用（id）。
 *
 * 走 **home 权威路径**（`join(home, taskUri, "AGENTS.md")`）而不是 `getTask(uri)` ——
 * 后者内部用全局 `diyHome()` 拼路径，在隔离实例/测试里会读到**生产任务文件**
 * （与 `chainOf` 那条 `isAppDir` 修复同一类病灶：home 参数传进来了却没用，隔离静默失效）。
 */
function taskPersonaId(home: string, taskUri: string): string | undefined {
  const fp = join(home, taskUri, "AGENTS.md");
  if (!existsSync(fp)) return undefined;
  try {
    return parseTaskFile(readFileSync(fp, "utf-8"))?.persona;
  } catch (e) {
    console.warn(`[persona] ${fp} 解析失败，按「跟随缺省」处理:`, e);
    return undefined;
  }
}

/**
 * 任务当前生效的人物：任务 frontmatter 的 `persona`（**存 id**）→ 查定义 → 缺省人物。
 *
 * `persona` 键**不存在 = 跟随缺省**（不固定绑定；改缺省时本任务下一轮跟着变）。
 * 这是新建任务的默认状态，故缺字段不再出声 ——「这次用了哪个模型」由事件流每 step 记录（##164）。
 * 指向不存在的 id 时**回落缺省并出声**（人物被删 / 手写文件写错 id），
 * 不允许静默换成某个"猜的"模型。
 */
export function personaForTask(home: string, taskUri: string): Persona {
  const fallback = (): Persona => personaById(home, defaultPersonaId(home)) ?? builtinPersona();
  if (!taskUri) return fallback();
  const id = taskPersonaId(home, taskUri);
  if (!id) {
    // **正常情况**：任务没写 persona 键 = 跟随缺省（新建任务的默认状态）。
    // 不再出声 —— 这是设计中的常态，不是异常（以前"创建时物化"才会有"字段缺失=异常"的假设）。
    // 手删字段与"跟随缺省"因此在语义上**合一**：都是"不固定，用缺省"，无需区分。
    return fallback();
  }
  const found = personaById(home, id);
  if (found) return found;
  console.warn(`[persona] 任务 ${taskUri} 指向不存在的人物「${id}」，本轮回落「${fallback().name}」`);
  return fallback();
}

/**
 * 定义合法性与**能力**校验（写入前拒绝非法配置，而不是等上游 400）：
 *   模型必须在清单内（清单外模型连 API 面都无从判断）
 *   推理强度必须在该模型 supported 内（各模型词表不同，见 shared/models.ts）
 */
export function assertPersonaDef(def: PersonaDef): void {
  if (!isKnownModel(def.model)) {
    throw new Error(`未知模型 ${def.model}（可选：见 diy agent local models）`);
  }
  const r = reasoningOf(def.model);
  if (!r.supported.includes(def.reasoningEffort)) {
    throw new Error(`模型 ${def.model} 不支持推理强度 ${def.reasoningEffort}（可选：${r.supported.join("/")}）`);
  }
}
