// job-hint.test.ts —— 锁住 job 使用判据的提示词（知识库 `app/rule#job-when` 的落地）。
//
// 为什么要有：原文「后台长活（构建 / **测试** / 装依赖）用 background」把测试列进了
// 该 job 的例子，于是 check / test / tsc 全被后台化 —— job runs 从每日 26 涨到 138
// （2026-11-26 查）。**例子会过时，判据不会**，所以这里锁判据、并禁止旧例子回来。

import { describe, expect, it } from 'vitest';

import { JOB_HINT_BODY } from '../src/room';

describe('JOB_HINT_BODY（job 使用判据）', () => {
    it('给的是判据本身，不是例子', () => {
        expect(JOB_HINT_BODY).toContain('本轮下一步要不要用它的输出');
    });

    it('不再把「测试 / 构建 / 装依赖」列进该 job 的例子（改回旧文案就红）', () => {
        // 旧句：「后台长活（构建 / 测试 / 装依赖）用 bash 的 background…」
        expect(JOB_HINT_BODY).not.toContain('后台长活');
        expect(JOB_HINT_BODY).not.toContain('装依赖');
    });

    it('明确 check / test 是前台的「轮次内工具步骤」，不是后台任务', () => {
        expect(JOB_HINT_BODY).toContain('轮次内的工具步骤');
        expect(JOB_HINT_BODY).toContain('前台同步等');
        expect(JOB_HINT_BODY).toContain('./sha.sh check');
    });

    it('background 只留给真长活（起服务 / 会离开的超长跑 / 跨轮次）', () => {
        expect(JOB_HINT_BODY).toContain('background: true');
        expect(JOB_HINT_BODY).toContain('staging');
        expect(JOB_HINT_BODY).toContain('跨轮次');
    });

    it('后台起完的运维动作仍在（查状态 / 取输出 / 停、别轮询）', () => {
        expect(JOB_HINT_BODY).toContain('别轮询');
        expect(JOB_HINT_BODY).toContain('插话叫醒你');
    });
});
