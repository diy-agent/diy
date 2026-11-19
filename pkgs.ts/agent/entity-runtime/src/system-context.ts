// system-context.ts —— 房间 agent 的**规则上下文**：AGENTS.md 链 + 知识库索引。
//
// 为什么必须有：diy2 的 agent 之前只有「你是 X」+ persona + 工具提示，于是
// `~/AGENTS.md` / `~/git/AGENTS.md` / 仓库 AGENTS.md 里的规则（worktree、GPG、验证入口…）
// 一条都进不来 —— 实测表现就是「经常直接在 main 上改」。
//
// 三条判据（与 diy-app 的 chain / bot 的 system-context 同一口径）：
//   · 链从 cwd 爬到 `$HOME`（不进 `/`、不进 `/Users`）；外层在前，最深处最特化
//   · `<home>/AGENTS.md`（应用级）在链首；`home` 不传 = 没有应用级规范（测试 / 非 app 宿主）
//   · 知识库只投**索引**（路径 + desc + 节数），正文按需 `diy2 facts get <路径>#<小节>`
//
// 为什么只组装一次：这是每轮请求的固定前缀，每次重写会打碎前缀缓存（同 bot 的
// system-context 注释）。RoomActor 在构造时算一次，session 复用。
//
// 失败降级：读不到就缺席，绝不因为上下文构建失败让人发不出消息。

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { agentsChain } from '@diy-agent/agents-chain';
import { globalKbRoot, kbRootOf, scanKb } from '@diy-agent/kb';

/** 规则上下文的缺省字节上限（diy 仓实测全量 ~15.8 KB：链 + 67 条索引；给一点余量） */
export const SYSTEM_CONTEXT_MAX_BYTES = 16_384;

export interface RoomSystemContextOptions {
    /** 工作目录（房间的 `data.dir`）：链从它开始向上爬 */
    readonly cwd: string;
    /**
     * 应用数据根（diy2 = `DIY2_HOME`）：`<home>/AGENTS.md` 进链首，且允许读设备级知识库。
     * 不传 = 没有应用级规范、也不读设备库（测试 / 纯仓库宿主）。
     */
    readonly home?: string;
    readonly maxBytes?: number;
}

interface KbLine {
    readonly path: string;
    readonly desc: string;
    readonly sections: number;
    readonly scope: 'project' | 'global';
}

function kbIndexOf(opts: RoomSystemContextOptions): KbLine[] {
    const global = globalKbRoot(process.env['DIY_HOME'], homedir());
    const candidate = kbRootOf(opts.cwd);
    const roots: { dir: string; scope: 'project' | 'global' }[] = [];
    // kbRootOf 会一路走到 $HOME：cwd 在任何用户目录下都会撞上 ~/.diy/knowledge（那是设备库）
    if (resolve(candidate) !== resolve(global)) roots.push({ dir: candidate, scope: 'project' });
    if (opts.home !== undefined) roots.push({ dir: global, scope: 'global' });

    const byPath = new Map<string, KbLine>();
    for (const root of roots) {
        for (const entry of scanKb(root.dir).entries) {
            // 先 project 后 global：同名取项目那份
            if (root.scope === 'global' && byPath.has(entry.path)) continue;
            byPath.set(entry.path, {
                path: entry.path,
                desc: entry.desc,
                sections: entry.sections,
                scope: root.scope,
            });
        }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function chainSection(opts: RoomSystemContextOptions): string | null {
    const appHome = opts.home ?? join(opts.cwd, '__no_app__');
    const chain = agentsChain({ appHome, cwd: opts.cwd });
    if (chain.length === 0) return null;
    const blocks = chain.map(
        (item) => `<project_instructions path="${item.path}" scope="${item.scope}">\n${item.content}\n</project_instructions>`,
    );
    return [
        '以下规则按目录 scope 生效（外层在前；处理某个文件时，其所在目录链上最深的一层最特化，冲突时以它为准）：',
        ...blocks,
    ].join('\n\n');
}

function kbSection(opts: RoomSystemContextOptions): string | null {
    const lines = kbIndexOf(opts);
    if (lines.length === 0) return null;
    return [
        '知识库索引（`.diy/knowledge/**/*.md`；要正文用 `diy2 facts get <路径>#<小节>`，' +
            '不确定展开哪条先 `diy2 facts brief <主题>` 看首句）：',
        ...lines.map((line) => `- ${line.path} — ${line.desc}（${line.sections} 节 · ${line.scope}）`),
    ].join('\n');
}

/**
 * 按 UTF-8 字节裁切（不能按字符数裁：中文一个字符 3 字节，按字符裁会超预算）。
 * 二分找最大可容纳的前缀。
 */
function cutToBytes(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
        else high = mid - 1;
    }
    return text.slice(0, low);
}

/**
 * 组装一次房间的规则上下文；空串 = 什么都没有（agent 只带 persona）。
 *
 * 预算按**最终文本**的 UTF-8 字节量；超了就截断并标注，不静默丢。
 */
export function buildRoomSystemContext(opts: RoomSystemContextOptions): string {
    if (opts.cwd.trim() === '') return '';
    const parts = [chainSection(opts), kbSection(opts)].filter((part): part is string => part !== null);
    if (parts.length === 0) return '';

    const max = opts.maxBytes ?? SYSTEM_CONTEXT_MAX_BYTES;
    const NOTE = '\n（上下文超预算，余下省略）';
    const noteBytes = Buffer.byteLength(NOTE, 'utf8');
    let out = '';
    for (const part of parts) {
        const next = out === '' ? part : `${out}\n\n${part}`;
        if (Buffer.byteLength(next, 'utf8') <= max) {
            out = next;
            continue;
        }
        const room = max - Buffer.byteLength(out, 'utf8') - noteBytes - (out === '' ? 0 : 2);
        out = room > 100 ? `${out === '' ? '' : `${out}\n\n`}${cutToBytes(part, room)}${NOTE}` : `${out}${NOTE}`;
        break;
    }
    return out;
}
