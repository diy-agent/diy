import { RpcSchema } from '@diy/rpc';
import { z } from 'zod';

/**
 * renderer-api-def.ts — Renderer 侧 RPC 纯定义（meta，无 call）
 *
 * 这些服务只在 Renderer 进程（浏览器）中运行，
 * 通过 Transport 桥接（pipe）暴露给 Main 进程和 CLI。
 * 完整限定名：diy.desktop.renderer.*
 */

export const rendererApiDef = {
  diy: {
    desktop: {
      renderer: {
        /** 列出当前页面所有可用 UI 组件 */
        component: {
          list: RpcSchema.unary({
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
          }),

          /** 查询组件当前状态（参数因组件而异） */
          status: RpcSchema.unary({
            input: { name: z.string().describe('组件名称') },
            output: z.object({
              status: z.string(),
              data: z.object({
                visible: z.boolean(),
                state: z.string().optional(),
              }),
            }),
          }),
        },

        /** 页面级服务 */
        page: {
          info: RpcSchema.unary({
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                title: z.string(),
                url: z.string(),
                ready: z.boolean(),
              }),
            }),
          }),

          /** 导航到指定页面（通过回调触发 React state 变更） */
          navigate: RpcSchema.unary({
            input: { page: z.string().describe('目标页面名称') },
            output: z.object({ status: z.string() }),
          }),

          /** 聚焦指定任务 */
          focus: RpcSchema.unary({
            input: { uri: z.string().describe('任务 URI') },
            output: z.object({ status: z.string() }),
          }),

          /** 显示 Toast 通知 */
          toast: RpcSchema.unary({
            input: { message: z.string(), level: z.string().optional() },
            output: z.object({ status: z.string() }),
          }),
        },
      },
    },
  },
} as const;

export type RendererApiDef = typeof rendererApiDef;
