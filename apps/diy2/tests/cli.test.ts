// CLI 命令树：只验「形状 / 输出 / 退出码」——域实现（注册表 / 探活）另有单测。
//
// 为什么用 `CliApp.inProcess`：与真实入口同一条路径（mem 传输 + 同一棵 api 树），
// 但它把 out/err/exit 收进数组，不会真退进程。

import { describe, expect, it } from 'vitest';
import { CliApp } from '@diy-agent/rpc/cli';

import { instanceApi } from '../src/cli/instance';

const ROW = {
    pid: 4242,
    port: 5300,
    home: '/w/build/lab/home',
    variant: 'lab',
    env: 'development',
    launch: 'lab',
    name: null,
    worktree: '/w',
    startedAt: '2026-11-19T10:00:00.000+0800',
    updatedAt: '2026-11-19T10:00:00.000+0800',
};

const handlers = {
    instance: {
        list: () => ({ instances: [ROW] }),
        stop: async () => ({ stopped: 1, instances: [ROW] }),
        port: async () => 5300,
        home: () => '/w/build/lab/home',
    },
};

function makeCli() {
    return CliApp.inProcess({
        name: 'diy2',
        version: '0.0.1',
        scopes: [{ prefix: 'diy2', api: instanceApi, handlers }],
        // instance 只是域层，用户敲 `diy2 list`
        cliRootPath: ['instance'],
    });
}

describe('diy2 CLI（@diy-agent/rpc/cli + mem）', () => {
    it('instance 域摊平到顶层：list / stop / port / home', async () => {
        const result = await makeCli().run(['--help']);
        expect(result.code).toBe(0);
        const text = result.out.join('\n');
        for (const name of ['list', 'stop', 'port', 'home']) expect(text).toContain(name);
        // 域层名不该出现在命令里
        expect(text).not.toContain('diy2 instance');
    });

    it('list --json 走 {ok,data} 包装', async () => {
        const result = await makeCli().run(['list', '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out.join('\n'))).toEqual({ ok: true, data: { instances: [ROW] } });
    });

    it('port 输出裸数字（脚本 `PORT=$(diy2 port)` 不破）', async () => {
        const result = await makeCli().run(['port']);
        expect(result.code).toBe(0);
        expect(result.out.join('\n')).toBe('5300');
    });

    it('home 输出裸路径', async () => {
        const result = await makeCli().run(['home']);
        expect(result.code).toBe(0);
        expect(result.out.join('\n')).toBe('/w/build/lab/home');
    });

    it('未知命令 → usage error（退出码 2）', async () => {
        const result = await makeCli().run(['nope']);
        expect(result.code).toBe(2);
    });
});
