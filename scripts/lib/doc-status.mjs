// scripts/lib/doc-status.mjs —— 文档「状态 / 出处」的解析口径（一份实现，三处用）
//
// 为什么单独抽出来：`docs.index` 的 `status` 字段（apps/diy-app/src/main/services/docs-index.ts）
// 已经在做启发式抽取，而这条护栏要按同一口径判「状态行有没有 / 合不合法」。两处各写一份
// 正则 = 迟早出现「索引里显示定稿、护栏说没状态」。
//
// 约定的形状（`docs/plans/*.md` 开篇引用块）：
//
//     > 状态：草稿 | 候选 | 定稿
//     > 出处：<哪次会话 / 哪个 PR>
//
// 三档的语义（2026-11-28 用户裁：先止血，别让草稿冒充口径）：
//   · 草稿 —— 还能被推翻，只允许活在工作区 / 分支里，随时可删
//   · 候选 —— 已提交成 PR 接受评审，作者认为「可以照它干活了」
//   · 定稿 —— 已进 main 且被文档索引收录；**只有这一档能写「唯一口径」这类权威话术**
//
// 判据为什么盯住「权威话术」而不是盯住「谁写的」：事故不在「bot 写文档」，在
// 一份草稿把「这份取代某某」写进正文 → 下一个人当真口径引用（2026-11-28：确认稿把
// 41/46/34 三个来自不同表的数字当事实，迁移方案按它排会漏 10 个房）。

export const STATUS_VALUES = ['草稿', '候选', '定稿'];

/** 开篇引用块里「状态：…」那一句（返回三档之一；没有 / 不合法返回 null） */
export function statusOf(text) {
    const lines = text.split('\n').slice(0, 20);
    for (const line of lines) {
        if (!line.startsWith('>')) continue;
        const body = line
            .replace(/^>\s*/, '')
            .replace(/\*\*|__/g, '')
            .trim();
        const m = body.match(/^状\s*态\s*[:：]\s*(草稿|候选|定稿)/);
        if (m !== null) return m[1];
    }
    return null;
}

/**
 * 「权威话术」：写了这些词，读者就会把它当唯一口径。
 *
 * 只在**正文**里找，跳过引用块（`>` 开头）—— 引用块里常见「取代：某稿」这类**说明自己档位**的话，
 * 那不是权威声明。也跳过代码块。
 */
export const AUTHORITY_PHRASES = ['唯一口径', '以此为准', '本稿为准', '这份取代', '该文档取代'];

const QUOTE_PAIRS = [
    ['「', '」'],
    ['『', '』'],
    ['`', '`'],
    ['"', '"'],
    ['“', '”'],
    ['《', '》'],
];

/** 这个位置是不是**被引用的词**而不是声明（`「唯一口径」` / `` `以此为准` `` / "本稿为准"） */
function quotedAt(line, start, end) {
    return QUOTE_PAIRS.some(([left, right]) => {
        const open = line.lastIndexOf(left, start - 1);
        if (open === -1) return false;
        const close = line.indexOf(right, end);
        // 括号要真的把这句话包住：左括号在这之前、右括号在这之后（能覆盖「a / b / c」这种列举）
        return close !== -1 && open < start && close >= end;
    });
}

export function authorityHits(text) {
    const hits = [];
    let fenced = false;
    let exempt = false;
    for (const [index, line] of text.split('\n').entries()) {
        if (line.trimStart().startsWith('```')) fenced = !fenced;
        // 逃生口：整段在讲这条规则本身（表里列举话术）时写 `<!-- authority-ok: 理由 -->`，管到空行
        if (/authority-ok:\s*\S/.test(line)) exempt = true;
        if (line.trim() === '') exempt = false;
        if (fenced || exempt) continue;
        if (line.trimStart().startsWith('>')) continue;
        for (const phrase of AUTHORITY_PHRASES) {
            let from = 0;
            for (;;) {
                const at = line.indexOf(phrase, from);
                if (at === -1) break;
                from = at + phrase.length;
                // 被引号包住的 = 在说这个词，不是在用这句话
                if (quotedAt(line, at, at + phrase.length)) continue;
                hits.push({ line: index + 1, phrase });
            }
        }
    }
    return hits;
}

/**
 * 「疑似手抄的库表数字」：`45 个任务房` / `48 行` / `34 份快照` 这种。
 *
 * 命中不算错，只是**提醒** —— 正确做法是让 `./sha.sh doc-stats` 生成 stats 块（带表名 / 查询 / 时刻）。
 * 判据里刻意要求「数字 + 量词 + 库表名词」，避免把「3 步」「第 2 条」全算进来。
 */
const NUMBER_CLAIM =
    /\d{1,5}\s*(?:个|行|份|条|张)\s*(?:任务|项目|房|bot|Bot|实体|会话|快照|session|行|成员|模板|profile)/g;

export function numberClaims(text) {
    const out = [];
    let fenced = false;
    let inStats = false;
    // 逃生口：引用事故原数 / 举例的时候写 `<!-- numbers-ok: 理由 -->`，**管到下一个空行为止**
    // （一整段表格 / 一整段引用都是例子，逐行标太吵；理由空着不算数）
    let exempt = false;
    for (const [index, line] of text.split('\n').entries()) {
        if (line.trimStart().startsWith('```')) fenced = !fenced;
        if (/<!--\s*\/?stats:/.test(line)) inStats = /<!--\s*stats:/.test(line);
        if (/numbers-ok:\s*\S/.test(line)) exempt = true;
        if (line.trim() === '') exempt = false;
        if (fenced || inStats || exempt) continue;
        for (const m of line.matchAll(NUMBER_CLAIM)) out.push({ line: index + 1, text: m[0] });
    }
    return out;
}

const BLOCK = /<!--\s*stats:([a-z0-9-]+)\s*-->([\s\S]*?)<!--\s*\/stats:\1\s*-->/g;

/**
 * 文档里所有 stats 块：`[{ name, body, start, end }]`（start/end 是 body 在全文里的下标）。
 *
 * **跳过代码块里的块**：文档经常要举例「块长什么样」（` ```markdown ` 里放一对空标签），
 * 把例子也填上真数字 = 例子失效，还可能把外层围栏截断。
 */
export function statsBlocks(text) {
    const out = [];
    const fenced = [];
    let open = null;
    text.split('\n').forEach((line, index) => {
        if (!line.trimStart().startsWith('```')) return;
        if (open === null) open = index;
        else {
            fenced.push([open, index]);
            open = null;
        }
    });
    const lineStarts = [0];
    for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
    const inFence = (index) => {
        const line = lineStarts.findIndex((start) => start > index) - 1;
        const at = line === -1 ? lineStarts.length - 1 : line;
        return fenced.some(([from, to]) => at >= from && at <= to);
    };
    for (const m of text.matchAll(BLOCK)) {
        if (inFence(m.index)) continue;
        const start = m.index + m[0].indexOf('-->') + 3;
        out.push({ name: m[1], body: m[2], start, end: start + m[2].length });
    }
    return out;
}

/** 去掉 stats 块内容（比较「值有没有变」时用：采集时刻每次都不同，不能参与比较） */
export function withoutStats(text) {
    return text.replace(BLOCK, (all, name) => `<!-- stats:${name} --><!-- /stats:${name} -->`);
}

/** stats 块里的「采集：…」那行（新鲜度比较时先剥掉） */
export function stripCollected(body) {
    return body.replace(/^\s*采集[:：].*$/gm, '').trim();
}
