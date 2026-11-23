// job.test.ts —— 后台作业工具返回值的解读。
//
// 所有样本都取自**线上真数据**（`~/.diy/diy2/diy2.db` 的 entity_items）：
// 文案由 `@diy-agent/jobs` 的 `runDetail` / `runLine` 生成，这里钉住解析与它的对应关系。
// 那边改文案而这里没跟，测试会红 —— 这正是要的。

import { describe, expect, it } from 'vitest';
import { jobOf, stripAnsi } from '../src/job';
import type { TimelinePart } from '../src/timeline';

const tool = (name: string, args: unknown, result?: unknown): TimelinePart & { kind: 'tool' } => ({
    kind: 'tool',
    id: 'tool-1',
    name,
    args,
    ...(result === undefined ? {} : { result }),
    state: 'ok',
});

describe('不是后台作业的工具', () => {
    it('普通 bash 不接管', () => {
        expect(jobOf(tool('bash', { command: 'ls' }, 'x'))).toBeUndefined();
    });

    it('bash 带 background:false 也不接管', () => {
        expect(jobOf(tool('bash', { command: 'ls', background: false }, 'x'))).toBeUndefined();
    });
});

describe('bash(background: true) —— 作业第一次出现的地方', () => {
    const started = tool(
        'bash',
        { command: 'cd /w && ./sha.sh check > /tmp/x.log 2>&1', background: true },
        '已转到后台：r-mwtfmywg-vkh1（状态 running）\n输出：/Users/ccc/.diy/diy2/log/job/runs/2026-11-23/r-mwtfmywg-vkh1/out.log\n结束时会插话通知你，**不要轮询**；查状态 / 取输出 / 停止用 job 工具。',
    );

    it('取到 id / 状态 / 日志路径 / 命令', () => {
        const view = jobOf(started);
        expect(view).toMatchObject({
            action: 'start',
            id: 'r-mwtfmywg-vkh1',
            state: 'running',
            label: '运行中',
            logPath: '/Users/ccc/.diy/diy2/log/job/runs/2026-11-23/r-mwtfmywg-vkh1/out.log',
            command: 'cd /w && ./sha.sh check > /tmp/x.log 2>&1',
        });
    });

    it('启动失败（没看到「已转到后台」）说成错误，而不是编一个 id', () => {
        const view = jobOf(tool('bash', { command: 'x', background: true }, '[启动失败] spawn ENOENT'));
        expect(view?.id).toBeUndefined();
        expect(view?.error).toBe('[启动失败] spawn ENOENT');
    });
});

describe('job status / wait —— runDetail 那套', () => {
    const detail = [
        'r-mwtfmywg-vkh1 · 已结束 · 34.3s',
        '命令：cd /w && ./sha.sh check',
        '目录：/Users/ccc/git/diy/diy',
        '结局：退出码 0',
        '输出：/Users/ccc/.diy/diy2/log/job/runs/2026-11-23/r-mwtfmywg-vkh1/out.log',
        '来源：task-mwljlzdz#bot-mwljlzdz',
        '—— 输出尾部（前 1378 字节已截断） ——',
        '\u001b[38;5;255;48;5;66;1m[check-os-boundary] ✓ 通过\u001b[0m',
        '[2] 心跳 23:55:28',
    ].join('\n');

    it('状态 / 时长 / 命令 / 结局 / 来源 全取到，尾部去掉 ANSI 色码', () => {
        const view = jobOf(tool('job', { action: 'wait', id: 'r-mwtfmywg-vkh1', timeoutMs: 300000 }, detail));
        expect(view).toMatchObject({
            action: 'wait',
            id: 'r-mwtfmywg-vkh1',
            state: 'exited',
            label: '已结束',
            duration: '34.3s',
            command: 'cd /w && ./sha.sh check',
            cwd: '/Users/ccc/git/diy/diy',
            outcome: '退出码 0',
            origin: 'task-mwljlzdz#bot-mwljlzdz',
            tailDroppedBytes: 1378,
        });
        expect(view?.tail).toBe('[check-os-boundary] ✓ 通过\n[2] 心跳 23:55:28');
    });

    it('wait 没等到：说明单独摘出来，不当成输出的一部分', () => {
        const view = jobOf(
            tool('job', { action: 'wait', id: 'r-1' }, `${detail}\n（已等 5m00s，仍未结束；别干等长任务 —— 去做别的，结束会通知你）`),
        );
        expect(view?.note).toContain('已等 5m00s');
        expect(view?.tail).not.toContain('已等');
    });

    it('没有输出', () => {
        const view = jobOf(tool('job', { action: 'status', id: 'r-1' }, 'r-1 · 已结束 · 0ms\n命令：true\n结局：退出码 0\n（无输出）'));
        expect(view?.tail).toBe('');
    });

    it('结果还没回来（工具在跑）：只带 action + id', () => {
        const view = jobOf(tool('job', { action: 'status', id: 'r-1' }));
        expect(view).toMatchObject({ action: 'status', id: 'r-1' });
        expect(view?.state).toBeUndefined();
    });

    it('工具自己报的错（没有这个进程）不是状态', () => {
        const view = jobOf(tool('job', { action: 'status', id: 'gone' }, '[没有这个后台进程] gone（只认本 bot 起的；job list 看现有；宿主重启后表会清空）'));
        expect(view?.error).toContain('没有这个后台进程');
        expect(view?.state).toBeUndefined();
    });
});

describe('job list', () => {
    it('逐行解析成表', () => {
        const view = jobOf(
            tool(
                'job',
                { action: 'list' },
                [
                    '共 2 条（运行中 1）',
                    '运行中 · r-abc · 12s · ./sha.sh check ← task-1#bot-1',
                    '已结束 · r-def · 34.3s · npm test',
                ].join('\n'),
            ),
        );
        expect(view?.rows).toEqual([
            { state: 'running', id: 'r-abc', duration: '12s', command: './sha.sh check ← task-1#bot-1' },
            { state: 'exited', id: 'r-def', duration: '34.3s', command: 'npm test' },
        ]);
    });
});

describe('job kill', () => {
    it('停止信号：id 与说明都留痕', () => {
        const view = jobOf(tool('job', { action: 'kill', id: 'r-1' }, '已发送停止信号（进程组 4242）：r-1。稍后用 job status 确认终态。'));
        expect(view?.id).toBe('r-1');
        expect(view?.note).toContain('进程组 4242');
    });
});

describe('stripAnsi', () => {
    it('去掉色码但保留正文', () => {
        expect(stripAnsi('\u001b[38;5;66;1m✓ 通过\u001b[0m')).toBe('✓ 通过');
    });
});
