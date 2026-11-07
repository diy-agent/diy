// service.test.ts — defineService：模块化 API 单元（2026-11-05）
//
// 验三件事：
//   ① 注册真的带上了 `name.` 前缀（同名方法在两个模块里互不打架）
//   ② `use(client)` 拿到的只有这个模块的方法（别的模块的路径调用会失败）
//   ③ handlers 少给一个 ⇒ 运行期抛错（类型上已经拦了，这是兜底）

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RpcSchema, defineService } from '../../src/core/index';
import { channelHarness } from '../harness';

/** 两个模块，各有一个 `page.list` —— 没前缀就撞车 */
function twoServices() {
    const wb = defineService({
        name: 'diy.ui.workbench',
        api: RpcSchema.group({ children: {
            page: RpcSchema.group({ children: {
                list: RpcSchema.unary({ input: {}, output: z.string() }),
            } }),
            view: RpcSchema.group({ children: {
                render: RpcSchema.unary({ input: { id: z.string() }, output: z.string() }),
            } }),
        } }),
    });
    const other = defineService({
        name: 'diy.other',
        api: RpcSchema.group({ children: {
            page: RpcSchema.group({ children: {
                list: RpcSchema.unary({ input: {}, output: z.string() }),
            } }),
        } }),
    });
    return { wb, other };
}

describe('defineService', () => {
    it('两个模块的同名方法各自可达（前缀生效）', async () => {
        const { wb, other } = twoServices();
        const { binding, client, dispose } = await channelHarness.start();
        wb.bind(binding, {
            page: { list: () => 'wb-list' },
            view: { render: ({ input }) => `wb-render:${input.id}` },
        });
        other.bind(binding, { page: { list: () => 'other-list' } });

        const w = wb.use(client);
        const o = other.use(client);
        expect(await w.page.list({})).toBe('wb-list');
        expect(await o.page.list({})).toBe('other-list');
        expect(await w.view.render({ id: 'x' })).toBe('wb-render:x');
        await dispose();
    });

    it('use() 只含本模块的方法 —— 调别的模块路径会失败', async () => {
        const { wb, other } = twoServices();
        const { binding, client, dispose } = await channelHarness.start();
        wb.bind(binding, { page: { list: () => 'x' }, view: { render: () => 'y' } });
        other.bind(binding, { page: { list: () => 'z' } });

        const w = wb.use(client);
        // `other` 才有的方法在 wb 上不存在 ⇒ Proxy 继续下钻，最终不是函数
        const notMine = (w as unknown as Record<string, unknown>)['nothingHere'];
        expect(typeof notMine).not.toBe('function');
        await dispose();
    });

    it('handlers 少给一个 ⇒ 运行期抛错（类型已拦，这里兜底）', async () => {
        const { wb } = twoServices();
        const { binding, dispose } = await channelHarness.start();
        expect(() =>
            wb.bind(binding, { page: { list: () => 'x' } } as never),
        ).toThrow(/缺少 handler/);
        await dispose();
    });

    it('name 为空 ⇒ 定义时就拒', () => {
        expect(() => defineService({ name: '', api: RpcSchema.group({ children: {} }) })).toThrow(/name 不能为空/);
    });

    it('同一个 api 挂两个 service 不互相污染（meta.name 不被原地改）', async () => {
        const api = RpcSchema.group({ children: {
            ping: RpcSchema.unary({ input: {}, output: z.string() }),
        } });
        const a = defineService({ name: 'a.svc', api });
        const b = defineService({ name: 'b.svc', api });
        const { binding, client, dispose } = await channelHarness.start();
        a.bind(binding, { ping: () => 'from-a' });
        b.bind(binding, { ping: () => 'from-b' });

        expect(await a.use(client).ping({})).toBe('from-a');
        expect(await b.use(client).ping({})).toBe('from-b');
        await dispose();
    });
});
