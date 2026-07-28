import { RpcImpl, router } from '@diy/rpc';
import { z } from 'zod';

/**
 * renderer-api.ts — Renderer 侧提供的 RPC 服务
 *
 * 这些服务只在 Renderer 进程（浏览器）中运行，
 * 通过 Transport 桥接（pipe）暴露给 Main 进程和 CLI。
 * Main 进程不感知这些 method 的存在。
 */

export const rendererApi = router({
  component: router({
    /** 列出当前页面所有可用 UI 组件 */
    list: RpcImpl.unary({
      input: {},
      output: z.object({
        status: z.string(),
        data: z.object({
          components: z.array(z.object({
            name: z.string(),
            label: z.string(),
            description: z.string().optional(),
          })),
        }),
      }),
      call: async () => {
        // TODO: 动态扫描注册的组件
        return {
          status: 'ok',
          data: {
            components: [
              { name: 'taskTree', label: '任务树', description: '任务层级树形展示' },
              { name: 'logPanel', label: '日志面板', description: '实时日志输出面板' },
              { name: 'agentChat', label: 'Agent 对话', description: 'AI 代理对话面板' },
            ],
          },
        };
      },
    }),

    /** 查询组件当前状态（参数因组件而异） */
    status: RpcImpl.unary({
      input: { name: z.string().describe('组件名称') },
      output: z.object({
        status: z.string(),
        data: z.object({
          visible: z.boolean(),
          state: z.string().optional(),
        }),
      }),
      call: async ({ input }) => {
        // TODO: 从组件 Store 读取真实状态
        return {
          status: 'ok',
          data: { visible: true, state: 'ready' },
        };
      },
    }),
  }),

  /** 页面级服务 */
  page: router({
    /** 获取当前页面标题和路由信息 */
    info: RpcImpl.unary({
      input: {},
      output: z.object({
        status: z.string(),
        data: z.object({
          title: z.string(),
          url: z.string(),
          ready: z.boolean(),
        }),
      }),
      call: async () => ({
        status: 'ok',
        data: {
          title: document.title,
          url: window.location.href,
          ready: document.readyState === 'complete',
        },
      }),
    }),
  }),
});
