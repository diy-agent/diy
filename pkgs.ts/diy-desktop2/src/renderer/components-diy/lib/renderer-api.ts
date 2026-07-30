import { RpcImpl, router } from '@diy/rpc';
import { z } from 'zod';
import { getRendererActions } from './renderer-actions';

/**
 * renderer-api.ts — Renderer 侧提供的 RPC 服务
 *
 * 这些服务只在 Renderer 进程（浏览器）中运行，
 * 通过 Transport 桥接（pipe）暴露给 Main 进程和 CLI。
 * 完整限定名：diy.desktop.renderer.*
 */

export const rendererApi = router({
  diy: {
    desktop: {
      renderer: {
        /** 列出当前页面所有可用 UI 组件 */
        component: {
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
        },

        /** 页面级服务 */
        page: {
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

          /** 导航到指定页面（通过回调触发 React state 变更） */
          navigate: RpcImpl.unary({
            input: { page: z.string().describe('目标页面名称') },
            output: z.object({ status: z.string() }),
            call: async ({ input }) => {
              getRendererActions().navigate?.(input.page);
              return { status: 'ok' };
            },
          }),

          /** 聚焦指定任务 */
          focus: RpcImpl.unary({
            input: { uri: z.string().describe('任务 URI') },
            output: z.object({ status: z.string() }),
            call: async ({ input }) => {
              getRendererActions().focus?.(input.uri);
              return { status: 'ok' };
            },
          }),

          /** 显示 Toast 通知 */
          toast: RpcImpl.unary({
            input: { message: z.string(), level: z.string().optional() },
            output: z.object({ status: z.string() }),
            call: async ({ input }) => {
              getRendererActions().toast?.(input.message, input.level ?? 'info');
              return { status: 'ok' };
            },
          }),
        },
      },
    },
  },
});
