import { RpcServer, type Transport } from '@diy/rpc';
import { getRendererActions } from './renderer-actions';
import { rendererApiDef } from './renderer-api-def';

/**
 * renderer-api-impl.ts — Renderer 侧 RPC handler 绑定（handle 分离）
 *
 * 从 renderer-api-def.ts 导入纯 meta，通过 RpcServer.on() 绑定实现。
 * 页面交互通过 renderer-actions 回调触发 React state 变更。
 */

export function bindRendererApi(transport: Transport): RpcServer {
  const server = new RpcServer({ router: rendererApiDef, transport });

  server.on(rendererApiDef.diy.app.renderer.component.list, async () => {
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
  });

  server.on(rendererApiDef.diy.app.renderer.component.status, async () => {
    // TODO: 从组件 Store 读取真实状态
    return {
      status: 'ok',
      data: { visible: true, state: 'ready' },
    };
  });

  server.on(rendererApiDef.diy.app.renderer.page.info, async () => ({
    status: 'ok',
    data: {
      title: document.title,
      url: window.location.href,
      ready: document.readyState === 'complete',
    },
  }));

  server.on(rendererApiDef.diy.app.renderer.page.navigate, async ({ input }) => {
    getRendererActions().navigate?.(input.page);
    return { status: 'ok' };
  });

  server.on(rendererApiDef.diy.app.renderer.page.focus, async ({ input }) => {
    getRendererActions().focus?.(input.uri);
    return { status: 'ok' };
  });

  server.on(rendererApiDef.diy.app.renderer.page.toast, async ({ input }) => {
    getRendererActions().toast?.(input.message, input.level ?? 'info');
    return { status: 'ok' };
  });

  return server;
}
