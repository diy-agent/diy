// jobCard.test.tsx —— 后台作业在界面上「到底啥情况」能不能看出来。
//
// 判据只认渲染出来的 html：`chat-core` 的解析有单测，但「卡片装的是 run id 还是截断 JSON」
// 「ANSI 码有没有混进去」「退出码在不在」只有真渲一次才看得见（2026-11-23 的原始症状就是
// 这些字段全丢了，用户只能问「job 卡住了？」）。文案片段取自真实运行的返回。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { jobOf, jobViewOfNotice, type TimelinePart } from '@diy-agent/chat-core';

import { JobCard } from '../src/components/JobCard';

const STATUS_TEXT = [
    'r-mwtg5rvq-csiq · 已结束 · 40.8s',
    '命令：cd /Users/ccc/git/diy/diy && for i in $(seq 1 40); do echo "[$i] 心跳"; done',
    '目录：/Users/ccc/git/diy/diy',
    '结局：退出码 0',
    '输出：/Users/ccc/.diy/diy2/log/job/runs/2026-11-23/r-mwtg5rvq-csiq/out.log',
    '来源：01a2091d-a9b0-7747-aacc-0b53dd48ee4c#01a2091d-a9b1-7bda-9277-65a08fcc090d',
    '—— 输出尾部 ——',
    '[39] 演示作业 心跳 23:55:45',
    '[40] 演示作业 心跳 23:55:46',
].join('\n');

function tool(overrides: Partial<TimelinePart & { kind: 'tool' }>): TimelinePart & { kind: 'tool' } {
    return {
        kind: 'tool',
        id: 'c1',
        name: 'job',
        state: 'ok',
        args: { action: 'status', id: 'r-mwtg5rvq-csiq' },
        result: STATUS_TEXT,
        ...overrides,
    } as TimelinePart & { kind: 'tool' };
}

function html(part: TimelinePart & { kind: 'tool' }): string {
    const view = jobOf(part);
    expect(view).toBeDefined();
    return renderToStaticMarkup(<JobCard view={view!} />);
}

describe('后台作业卡片', () => {
    it('job 查状态：run id / 状态 / 退出码 / 输出尾部都在', () => {
        const out = html(tool({}));
        expect(out).toContain('r-mwtg5rvq-csiq');
        expect(out).toContain('已结束');
        expect(out).toContain('40.8s');
        expect(out).toContain('退出码 0');
        expect(out).toContain('[40] 演示作业 心跳 23:55:46');
        // 命令是「它在干什么」的唯一线索，不能被截成 JSON
        expect(out).toContain('for i in $(seq 1 40)');
    });

    it('bash 转后台那一次也成卡（用户第一次看见这条作业的地方）', () => {
        const out = html(
            tool({
                name: 'bash',
                args: { command: './sha.sh check', background: true },
                result: [
                    '已转到后台：r-mwtfmywg-vkh1（状态 running）',
                    '输出：/Users/ccc/.diy/diy2/log/job/runs/2026-11-24/r-mwtfmywg-vkh1/out.log',
                ].join('\n'),
            }),
        );
        expect(out).toContain('转到后台');
        expect(out).toContain('r-mwtfmywg-vkh1');
        expect(out).toContain('运行中');
        expect(out).toContain('./sha.sh check');
    });

    it('还没收尾的 wait：明确写「未结束」，不冒充成功', () => {
        const out = html(
            tool({
                args: { action: 'wait', id: 'r-mwtfmywg-vkh1' },
                result: 'r-mwtfmywg-vkh1 · 运行中 · 12.0s\n（已等 10m00s，仍未结束；别干等长任务）',
            }),
        );
        expect(out).toContain('运行中');
        expect(out).toContain('未结束');
        expect(out).toContain('仍未结束');
    });

    it('收口通知：结构化事实画成卡，ANSI 色码不进界面', () => {
        const view = jobViewOfNotice(
            {
                run: 'r-mwtg5rvq-csiq',
                state: 'exited',
                exitCode: 0,
                durationMs: 40_800,
                command: 'echo hi',
                tail: '\u001b[32mok\u001b[0m',
            },
            '整段原文（含 \u001b[38;5;255m 色码）',
        );
        const out = renderToStaticMarkup(<JobCard view={view} />);
        expect(out).toContain('r-mwtg5rvq-csiq');
        expect(out).toContain('退出码 0');
        expect(out).toContain('ok');
        expect(out).not.toContain('\u001b[');
    });
});
