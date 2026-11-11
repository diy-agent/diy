// scope.test.ts — 挂载点（prefix）与模块（api）分离（##87 2026-11）
//
// 被测价值：**前缀是宿主的事，模块不知道自己的名字**。defineService 已经能把 api 挂上去，
// 但那要求模块自带 `name` —— 于是「同一个模块挂到 `diy.task` 与 `diyvideo.task`」只能改源码。
// 这里四件事，删掉任一条都会漏掉具体一类问题（写在每条名字里）。
//
// 归属：core（rpc 协议层）。判据是测试归属规则 §1 —— 这些失败 UI 一律看不见，
// 只在第一条请求回来时变成 `Unknown method`。
//
// 写法遵守 §2：黑盒（只经 mountService / createScopedClient / 真实调用的返回值与抛错），
// 不碰私有函数与内部注册表；替身只用内存 transport（真 rpc 链路，无 mock）。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RpcSchema, createScopedClient, mountService } from '../../src/core/index';
import { channelHarness } from '../harness';

/** 一个普通模块：api 里没有名字，只有路径（`list` / `create`） */
function taskApi() {
    return RpcSchema.group({
        children: {
            list: RpcSchema.unary({ input: {}, output: z.array(z.string()) }),
            create: RpcSchema.unary({ input: { title: z.string() }, output: z.string() }),
        },
    });
}

describe('mountService / createScopedClient', () => {
    it('同一个 api 挂两个前缀：两条线上名各自可达，互不覆盖', async () => {
        // 会漏的问题：前缀没进线上名（两边撞到同一个 `list`）⇒ 后挂的把先挂的盖住，
        // 症状是「改了 A 却调到了 B」，而单前缀用例永远看不见。
        const api = taskApi();
        const { binding, client, dispose } = await channelHarness.start();
        mountService(binding, {
            prefix: 'diy.task',
            api,
            handlers: {
                list: () => ['from-diy'],
                create: ({ input }) => `diy:${input.title}`,
            },
        });
        mountService(binding, {
            prefix: 'diyvideo.task',
            api,
            handlers: {
                list: () => ['from-video'],
                create: ({ input }) => `video:${input.title}`,
            },
        });

        const diyTask = createScopedClient({ api, client, prefix: 'diy.task' });
        const videoTask = createScopedClient({ api, client, prefix: 'diyvideo.task' });
        expect(await diyTask.list({})).toEqual(['from-diy']);
        expect(await videoTask.list({})).toEqual(['from-video']);
        expect(await diyTask.create({ title: 'x' })).toBe('diy:x');
        expect(await videoTask.create({ title: 'x' })).toBe('video:x');
        await dispose();
    });

    it('同一前缀重复挂 ⇒ 挂载时就抛（不等第一条请求）', async () => {
        // 会漏的问题：后挂的静默覆盖前一个后端 —— 表现为「某个模块的调用莫名跑到了另一个实现」。
        const api = taskApi();
        const { binding, dispose } = await channelHarness.start();
        const handlers = { list: () => [], create: () => '' };
        mountService(binding, { prefix: 'diy.task', api, handlers });
        expect(() => mountService(binding, { prefix: 'diy.task', api, handlers })).toThrow(/已注册/);
        await dispose();
    });

    it('handlers 少一个方法 ⇒ 挂载时就抛（运行期兜底）', async () => {
        // 会漏的问题：类型绕过（`as never`）或 api 与 handlers 版本不一致时，
        // 缺陷会拖到第一条调用才以 `Unknown method` 出现 —— 那时已经在用户面前了。
        const api = taskApi();
        const { binding, dispose } = await channelHarness.start();
        expect(() =>
            mountService(binding, {
                prefix: 'diy.task',
                api,
                handlers: { list: () => [] } as never,
            }),
        ).toThrow(/缺少 handler/);
        await dispose();
    });

    it('prefix 为空 ⇒ 两端都拒（否则线上名是 ".list" 这种畸形名）', async () => {
        // 会漏的问题：注册成 `".list"` —— 客户端按任何正常前缀都调不到，且报错指向不存在的方法名。
        const api = taskApi();
        const { binding, client, dispose } = await channelHarness.start();
        expect(() => mountService(binding, { prefix: '', api, handlers: { list: () => [], create: () => '' } })).toThrow(
            /prefix 不能为空/,
        );
        expect(() => createScopedClient({ api, client, prefix: '' })).toThrow(/prefix 不能为空/);
        await dispose();
    });

    it('createScopedClient 带回部署信息：cmd 缺省取前缀末段，显式给出则覆盖', async () => {
        // 会漏的问题：CLI 合并命令树时把 `diy.task` 原样当命令名 ⇒ 用户得敲 `diy diy.task list`。
        // cmd / prefix / desc 是**调用方读的返回值**（CLI 构建命令树用），不是内部字段。
        const api = taskApi();
        const { client, dispose } = await channelHarness.start();
        const byDefault = createScopedClient({ api, client, prefix: 'diy.task' });
        expect(byDefault.prefix).toBe('diy.task');
        expect(byDefault.cmd).toBe('task');

        const explicit = createScopedClient({ api, client, prefix: 'diy.task', cmd: 't', desc: '任务' });
        expect(explicit.cmd).toBe('t');
        expect(explicit.desc).toBe('任务');
        await dispose();
    });
});
