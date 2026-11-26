// exportMarkdown.ts —— 时间线 → Markdown（纯函数，无 React / DOM）。
//
// 为什么要单独一层：「导出对话」是**渲染**，不是取数 —— 时间线的分组语义已经在
// chat-core 的 `buildTimeline` 里定了（一条回复 = 同一 (turnId, author) 的条目），
// 这里只把那些 `TimelineEntry` 摊成 Markdown 文本。
//
// 写成纯函数（而不是塞进按钮组件）的三个理由：
//   · 能单测 —— 「工具行 / 提问 / 通知 / 错误分别长什么样」只能靠测试钉住；
//   · 导出时刻可注入，产出**逐字可断言**（测试不能依赖真实时钟）；
//   · 以后要挪到服务端做（CLI 导出）时不动调用方。
//
// 与界面的关系：导出的就是**界面上那条时间线**，顺序、归属、命名都一致；不额外补充
// 界面没有的信息，也不丢条目（typing 占位是「还没内容」的临时态，导出成一行说明）。

import { jobOf, jobViewOfNotice, type JobView, type TimelineEntry, type TimelinePart } from '@diy-agent/chat-core';

import { roomTitle, taskNumberOf, taskStatusOf, type Bot, type Room } from './model';
import { toolTargetOf } from './surfaces/shared';

export interface MarkdownExportInput {
    room: Room;
    /** bot 表（成员名 / 房间名兜底都要它）；缺省空表 = 用 id 顶上 */
    bots?: Record<string, Bot>;
    /** 界面上的时间线（`buildTimeline` 的产出） */
    entries: readonly TimelineEntry[];
    /** 导出时刻（毫秒）；缺省 `Date.now()` —— 测试必须注入 */
    exportedAt?: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD`（本地时区） */
function dateOf(at: number): string {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `HH:mm` */
function clockOf(at: number): string {
    const date = new Date(at);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 条目时间戳：第一次出现 / 跨天时带日期，同一天内只写时刻（一份导出里几十个日期是纯噪音） */
function stampOf(at: number, withDate: boolean): string {
    return withDate ? `${dateOf(at)} ${clockOf(at)}` : clockOf(at);
}

/** 多行文本 → blockquote（每行都加 `>`，空行留 `>`，否则 Markdown 会把引用断开） */
function quote(text: string): string {
    return text
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
}

const STATUS_MARK = { running: '◌ 运行中', ok: '✓', error: '✗ 失败' } as const;

/** 作业卡片 → 几行：id / 状态 / 结局 / 时长 / 命令，输出尾部给一个代码块 */
function jobLines(view: JobView): string[] {
    const head = [`**作业**${view.id === undefined ? '' : ` \`${view.id}\``}`];
    const facts: string[] = [];
    if (view.label !== undefined)
        facts.push(view.outcome === undefined ? view.label : `${view.label}（${view.outcome}）`);
    else if (view.outcome !== undefined) facts.push(view.outcome);
    if (view.duration !== undefined) facts.push(view.duration);
    if (facts.length > 0) head.push(facts.join(' · '));
    const lines = [`${head.join(' ')}${view.command === undefined ? '' : ` · 命令 \`${view.command}\``}`];
    if (view.error !== undefined) lines.push(`⚠️ ${view.error}`);
    if (view.note !== undefined) lines.push(view.note);
    if (view.tail !== undefined && view.tail.trim() !== '') {
        lines.push('', '```', view.tail.replace(/\s+$/, ''), '```');
        if ((view.tailDroppedBytes ?? 0) > 0) lines.push(`（前面还有 ${view.tailDroppedBytes} 字节输出未保留）`);
    }
    return lines;
}

/** 一题提问 → quote 里的几行（选项 / 已选 / 待回答） */
function questionLines(part: TimelinePart & { kind: 'ask' }): string[] {
    const { request, answer } = part;
    const lines: string[] = [];
    if (request.note !== undefined && request.note.trim() !== '') lines.push(`背景：${request.note.trim()}`);
    const answered = new Map((answer?.answers ?? []).map((item) => [item.id, item]));
    const several = request.questions.length > 1;
    request.questions.forEach((question, index) => {
        // 多题时标题是 `1.` 开头的有序项，选项得缩进 3 格才**嵌在那一题下面**
        // （顶格的 `-` 会被 Markdown 当成与有序列表平级的另一张表，对应关系就丢了）
        const indent = several ? '   ' : '';
        lines.push(`${several ? `${index + 1}. ` : ''}**${question.question}**`);
        for (const option of question.options ?? []) {
            const picked = answered.get(question.id)?.values?.includes(option.value) === true;
            const desc = option.description === undefined ? '' : ` — ${option.description}`;
            lines.push(`${indent}- ${picked ? '**[已选]** ' : ''}\`${option.value}\` ${option.label}${desc}`);
        }
        for (const field of question.fields ?? []) {
            const value = answered.get(question.id)?.fields?.[field.name];
            lines.push(`${indent}- 字段 \`${field.name}\`（${field.label}）${value === undefined ? '' : `：${value}`}`);
        }
        const own = answered.get(question.id);
        if (own?.text !== undefined && own.text !== '') lines.push(`${indent}- 自由输入：${own.text}`);
        if (own?.skipped === true) lines.push(`${indent}- 用户跳过了这一题`);
    });
    const status =
        part.answer !== undefined
            ? undefined
            : part.expired === true
              ? `已过期${part.reason === undefined ? '' : `：${part.reason}`}`
              : part.cancelled === true
                ? `已撤回${part.reason === undefined ? '' : `：${part.reason}`}`
                : '待回答';
    if (status !== undefined) lines.push(`→ ${status}`);
    else if (request.questions.length === 1 && (answer?.answers.at(0)?.values?.length ?? 0) === 0)
        lines.push('→ 已提交');
    return lines;
}

/** 一个 part → 若干块（正文原样、工具一行、提问一张、失败一条） */
function partBlocks(part: TimelinePart): string[] {
    if (part.kind === 'text') return part.text.trim() === '' ? [] : [part.text];
    if (part.kind === 'error') return [quote(`⚠️ 失败：${part.message}`)];
    if (part.kind === 'ask') return [quote(questionLines(part).join('\n'))];
    const job = jobOf(part);
    if (job !== undefined) return [jobLines(job).join('\n')];
    const target = toolTargetOf(part);
    const label = target === undefined ? `\`${part.name}\`` : `\`${part.name}\`：\`${target}\``;
    return [`- ${STATUS_MARK[part.state]} ${label}`];
}

/** 一条时间线条目 → 一段 Markdown（不含前面的空行） */
function entryBlock(entry: TimelineEntry, withDate: boolean): string | undefined {
    const stamp = stampOf(entry.at, withDate);
    if (entry.kind === 'typing') {
        return `_${entry.author?.name ?? 'bot'} 正在运行（尚无内容）· ${stamp}_`;
    }
    if (entry.kind === 'notice') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n');
        if (entry.job !== undefined) return quote(jobLines(jobViewOfNotice(entry.job, text)).join('\n'));
        return quote(text);
    }
    if (entry.kind === 'error') {
        // 轮级结局（没有作者的失败）：不属于任何成员，单独立一段
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n');
        return `## 错误 · ${stamp}\n\n${quote(text)}`;
    }
    if (entry.kind === 'user') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n');
        const failed = entry.deliveries.filter((delivery) => delivery.state === 'failed');
        const note = failed.length === 0 ? '' : `\n\n_未送达：${failed.map((delivery) => delivery.name).join('、')}_`;
        return `## 用户 · ${stamp}\n\n${text}${note}`;
    }
    const name = entry.author?.name ?? 'bot';
    const blocks = entry.parts.flatMap(partBlocks);
    // 相邻的工具行紧贴着排（一列清单）；别的块之间空一行（正文 / 提问 / 失败各自成段）
    let body = '';
    blocks.forEach((block, index) => {
        const tight = index > 0 && blocks[index - 1]!.startsWith('- ') && block.startsWith('- ');
        body += (tight ? '\n' : '\n\n') + block;
    });
    return `## ${name} · ${stamp}${body}`;
}

/**
 * 房间 + 时间线 → 一份 Markdown 文档。
 *
 * 结构：抬头（房间 / 容器 / 成员 / 条目数 / 导出时刻）→ 分隔线 → 逐条按时间线顺序。
 */
export function roomToMarkdown(input: MarkdownExportInput): string {
    const { room, entries } = input;
    const bots = input.bots ?? {};
    const exportedAt = input.exportedAt ?? Date.now();
    const title = roomTitle(room, bots);
    const number = taskNumberOf(room);
    const members = room.members.map((member) => {
        const name = bots[member.botId]?.name ?? member.botId;
        return member.primary === true ? `${name}（默认应答）` : name;
    });
    const dir = typeof room.data['dir'] === 'string' ? room.data['dir'].trim() : '';

    const head = [`# ${title}`, ''];
    head.push(
        `- 容器：${room.type === 'task' ? `任务${number === undefined ? '' : ` #${number}`}` : room.type}（${room.id}）`,
    );
    if (room.type === 'task') head.push(`- 状态：${taskStatusOf(room)}`);
    if (dir !== '') head.push(`- 目录：\`${dir}\``);
    head.push(`- 成员：${members.length === 0 ? '（无）' : members.join('、')}`);
    head.push(`- 条目：${entries.length} 条`);
    head.push(`- 导出：${dateOf(exportedAt)} ${clockOf(exportedAt)}`);

    const blocks: string[] = [];
    let lastDate = '';
    for (const entry of entries) {
        const date = dateOf(entry.at);
        const withDate = date !== lastDate;
        lastDate = date;
        const block = entryBlock(entry, withDate);
        if (block !== undefined) blocks.push(block);
    }

    return [head.join('\n'), '---', blocks.length === 0 ? '_（这个房间还没有内容）_' : blocks.join('\n\n'), ''].join(
        '\n\n',
    );
}

/** 文件名能用的短名：去掉路径分隔符之类，太长会撑爆下载目录 */
function slugOf(text: string): string {
    const cleaned = text
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-. ]+|[-. ]+$/g, '');
    return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 59).trimEnd() + '…';
}

/**
 * 导出文件名：`<房间名>-<YYYYMMDD-HHmm>.md`。
 *
 * 带时刻而不是覆盖同名文件：同一个房间可能导很多次（对比前后），下载目录里
 * `对话.md`(1)(2) 比 `对话-20261126-0933.md` 更难认。
 */
export function exportFileName(room: Room, bots?: Record<string, Bot>, at: number = Date.now()): string {
    const date = new Date(at);
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
    const name = slugOf(roomTitle(room, bots));
    return `${name === '' ? room.id : name}-${stamp}.md`;
}
