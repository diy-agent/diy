// before-run.test.ts — 执行前拦截钩子（2026-11-05，D2 的落地验证）
//
// 判据归宿主（只有它知道哪个数据根是生产），本包只留钩子位。
// 这里验三件事：
//   ① 钩子说拦 ⇒ 命令**不执行**（spawn 一次都没发生）
//   ② 拦截理由原样出现在结果头后面（模型能看懂为什么）
//   ³ 钩子不拦 / 没给钩子 ⇒ 照常执行

import { describe, expect, it } from 'vitest';
import { makeShellTool, type ShellToolHost } from '../src/shell/tool.js';
import { FALLBACK_SHELL } from '../src/shell/spec.js';

/** 取出工具定义里的 execute（ai-sdk 的 tool() 返回对象带 execute） */
const exec = async (
    host: Pick<ShellToolHost, 'beforeRun'>,
    command: string,
): Promise<string> => {
    const t = makeShellTool(FALLBACK_SHELL, { cwd: process.cwd(), limits: { bashTimeoutMs: 2000 }, ...host });
    const out = await (t as unknown as { execute: (a: unknown) => Promise<string> }).execute({ command });
    return out;
};

describe('beforeRun 钩子', () => {
    it('钩子说拦 ⇒ 不执行，理由进结果', async () => {
        const out = await exec({ beforeRun: () => ({ block: true, reason: '这条会杀掉宿主' }) }, 'echo SHOULD_NOT_RUN');
        expect(out).toContain('[已拦截]');
        expect(out).toContain('这条会杀掉宿主');
        expect(out, '命令不该被执行').not.toContain('SHOULD_NOT_RUN');
    });

    it('钩子说放 ⇒ 正常执行', async () => {
        const out = await exec({ beforeRun: () => undefined }, 'echo RAN_OK');
        expect(out).toContain('RAN_OK');
    });

    it('不给钩子 ⇒ 正常执行（宿主没配护栏不该影响功能）', async () => {
        const out = await exec({}, 'echo NO_HOOK');
        expect(out).toContain('NO_HOOK');
    });

    it('钩子收到的就是**原始命令**（宿主拿它自己判，不做预处理）', async () => {
        let seen = '';
        await exec({ beforeRun: (cmd) => { seen = cmd; return undefined; } }, 'echo "带 引号 的命令"');
        expect(seen).toBe('echo "带 引号 的命令"');
    });
});

// ── 规则 1b：按 DIY_HOME 判「谁是我家人」（2026-11-05 第二刀）──
import { judgeSelfKill, type SelfProcessInfo } from '../src/shell/guard.js';

const selfWith = (home: string, pids: number[] = [100]): SelfProcessInfo => ({
    pid: 100,
    pgid: 100,
    pids: new Set(pids),
    cmdlines: ['/path/to/electron apps/chat/build/app/main/index.mjs'],
    home,
});

describe('judgeSelfKill · 按 DIY_HOME 判家人', () => {
    const PROD = '/Users/me/.diy';

    it('杀同 DIY_HOME 的兄弟进程 ⇒ 拦（那是生产实例的 GPU/renderer）', () => {
        const v = judgeSelfKill('kill -9 999', selfWith(PROD), (pid) => (pid === 999 ? PROD : undefined));
        expect(v.blocked).toBe(true);
        expect(v.reason).toContain('同一个 diy 实例');
    });

    it('杀别的 DIY_HOME（agent 自建实例）⇒ **放行**（这正是以前误拦的那类）', () => {
        const v = judgeSelfKill('kill -9 999', selfWith(PROD), (pid) =>
            pid === 999 ? '/Users/me/git/diy/build/lab/home' : undefined,
        );
        expect(v.blocked, '不该误拦自建实例').toBe(false);
    });

    it('pid 查不到环境变量 ⇒ 放行（拿不准时保守放行，不阻断开发）', () => {
        const v = judgeSelfKill('kill -9 999', selfWith(PROD), () => undefined);
        expect(v.blocked).toBe(false);
    });

    it('不传 homeOf ⇒ 退化成只看祖先链（不因缺少能力就阻断）', () => {
        const v = judgeSelfKill('kill -9 999', selfWith(PROD));
        expect(v.blocked).toBe(false);
    });

    it('self.home 为空（没拿到 DIY_HOME）⇒ 规则 1b 不生效', () => {
        const v = judgeSelfKill('kill -9 999', selfWith(''), () => PROD);
        expect(v.blocked, '不知道自己的 home 就不该猜').toBe(false);
    });

    it('杀自己的祖先仍然走规则 1（与 1b 无关）', () => {
        const v = judgeSelfKill('kill -9 100', selfWith(PROD, [100, 200]), () => '/x');
        expect(v.blocked).toBe(true);
        expect(v.reason).toContain('自身进程树');
    });
});
