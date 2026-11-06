// skills —— 从各级 `.agents/skills/` 收集技能清单。
//
// ── 为什么单独成包（2026-11-06 用户裁）──
//   「skill 单独弄个 pkg，先写一个测试加载看看，应该也是一个 provider」
//
// 它是**业界共享规范目录**，不是 diy 自创的格式：`~/.agents/skills/<名>/SKILL.md`，
// 每个 SKILL.md 带 yaml 头（`name` + `description`，description 里写"触发词"）。
// 本机实测 22 个（symlink 到 `~/.hermes/skills/skills`）。
//
// ── 与 agents-chain 的关系 ──
// 同一套「逐层向上」的判据（外层在前、最深处在后、上界 = homedir），
// 但找的是 `.agents/skills/<名>/SKILL.md` 而不是 `AGENTS.md`。
// 两者都必须**只取头部**：正文按需 `cat`，全量进 system 会吃光窗口。
//
// ── 只取 name + description ──
// 一个 skill 正文几十行，22 个就是几千行。模型的判据是 description 里那句话
// （「触发词：给任务发消息…」），看到关键字它自己会去读全文。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** 一条技能（只够让模型判断"要不要打开它"） */
export interface SkillItem {
    /** 技能名（yaml 头的 `name`；缺省 = 目录名） */
    readonly name: string;
    /** 一句话说明（yaml 头的 `description`；含触发词） */
    readonly desc: string;
    /** SKILL.md 绝对路径（模型要用 `read` 打开它） */
    readonly path: string;
}

export interface SkillsOptions {
    /** 起点目录（通常是工具执行目录） */
    readonly cwd: string;
    /**
     * 全局技能的根：`<globalRoot>/skills/<名>/SKILL.md`。
     *
     * 单独一个参数而不是写死 `~/.agents/skills`：测试要能指向临时目录，
     * 而宿主的"全局"也可能不是 homedir（比如某个受管环境）。
     */
    readonly globalRoot: string;
    /** 向上收集的上界（含）；缺省 `homedir()`，与 agents-chain 同判据 */
    readonly stopAt?: string;
}

/**
 * 扫描**一个** `.agents/skills` 目录，产出一批 skill。
 *
 * 目录不存在的返回空数组（不是错误）—— 绝大多数仓库没有这个目录。
 */
function skillsIn(dir: string): SkillItem[] {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    const out: SkillItem[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const file = join(dir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        const meta = readFrontmatter(readFileSync(file, 'utf-8'));
        out.push({
            name: meta['name'] !== undefined && meta['name'] !== '' ? meta['name'] : entry.name,
            desc: meta['description'] ?? '',
            path: file,
        });
    }
    return out;
}

/**
 * 读 yaml 头（`---` 之间的 `key: value`）。
 *
 * 为什么手写而不引 yaml 库：这里只需要两个**扁平字符串**字段，
 * 而 SKILL.md 的 description 常见写成 `>-`（折叠）或 `|`（字面）；手写能精确处理这两种，
 * 引库反而要为一个字段多带一个依赖（本包定位是零依赖纯 IO）。
 */
export function readFrontmatter(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text.startsWith('---')) return out;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return out;
    const lines = text.slice(3, end).split('\n');

    let key: string | null = null;
    let block: string[] = [];
    const flush = (): void => {
        if (key === null) return;
        // 折叠标量（`>-`）= 行间空格连接；字面标量（`|`）= 换行保留 —— 这里两种都收成单行，
        // 因为下游（help / system 段）要的就是一句话，多行反而占预算。
        out[key] = block.map((l) => l.trim()).filter((l) => l !== '').join(' ');
        key = null;
        block = [];
    };

    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line.trim() === '') continue;
        // 缩进行 = 上一个 key 的续行
        if (/^\s+\S/.test(line)) {
            if (key !== null) block.push(line);
            continue;
        }
        flush();
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (m === null) continue;
        const [, k, v] = m;
        key = k!;
        const value = (v ?? '').trim();
        // `key: >-` / `key: |` ⇒ 值在后续缩进行里
        if (value === '>' || value === '>-' || value === '|' || value === '|-') {
            block = [];
        } else {
            out[key] = value.replace(/^["']|["']$/g, '');
            key = null;
        }
    }
    flush();
    return out;
}

/**
 * 收集各级 `.agents/skills` 的技能清单。
 *
 * **顺序 = 外层在前、最深处在后**（与 AGENTS.md 链一致）；同名时后出现者覆盖，
 * 于是「更近的目录」优先 —— 这正是"项目可以覆盖全局技能"的语义。
 */
export function skillsOf(opts: SkillsOptions): SkillItem[] {
    const start = resolve(opts.cwd);
    const stop = resolve(opts.stopAt ?? homedir());
    const upward = start === stop || start.startsWith(stop + sep);

    const layers: string[] = [];
    for (let dir = start; ; dir = dirname(dir)) {
        layers.push(join(dir, '.agents', 'skills'));
        if (!upward || dir === stop || dir === dirname(dir)) break;
    }
    // 收集顺序是「最深处 → 最外层」；反过来才是「外层在前」
    layers.reverse();
    // 全局层最外（`~/.agents/skills` 之外的都算项目层）
    const globalDir = join(opts.globalRoot, 'skills');
    if (!layers.includes(globalDir)) layers.unshift(globalDir);

    const byName = new Map<string, SkillItem>();
    for (const layer of layers) {
        for (const item of skillsIn(layer)) byName.set(item.name, item);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export * from './provider.js';
