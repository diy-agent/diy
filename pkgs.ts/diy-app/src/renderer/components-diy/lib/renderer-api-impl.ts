import { RpcServer, type Transport } from '@diy/rpc';
import { getRendererActions } from './renderer-actions';
import { rendererApiDef } from './renderer-api-def';
import { diyService } from './rpc';
import { renderTreeText, type TaskNode } from '../../../main/core/tree-format';

/**
 * renderer-api-impl.ts — Renderer 侧 RPC handler 绑定（handle 分离）
 *
 * 从 renderer-api-def.ts 导入纯 meta，通过 RpcServer.on() 绑定实现。
 * 命名体系：diy.ui.*（Renderer 进程域）。
 * 页面交互通过 renderer-actions 回调触发 React state 变更；
 * 进程级数据（diy.ui.tree/status）反向调 main 的 diy.app.* 获取。
 */

export function bindRendererApi(transport: Transport): RpcServer {
  const server = new RpcServer({ router: rendererApiDef, transport });
  const ui = rendererApiDef.diy.ui;

  server.on(ui.component.list, async () => {
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

  server.on(ui.component.status, async () => {
    // TODO: 从组件 Store 读取真实状态
    return {
      status: 'ok',
      data: { visible: true, state: 'ready' },
    };
  });

  server.on(ui.page.info, async () => ({
    status: 'ok',
    data: {
      title: document.title,
      url: window.location.href,
      ready: document.readyState === 'complete',
    },
  }));

  server.on(ui.page.navigate, async ({ input }) => {
    getRendererActions().navigate?.(input.page);
    return { status: 'ok' };
  });

  server.on(ui.page.focus, async ({ input }) => {
    getRendererActions().focus?.(input.uri);
    return { status: 'ok' };
  });

  server.on(ui.page.toast, async ({ input }) => {
    getRendererActions().toast?.(input.message, input.level ?? 'info');
    return { status: 'ok' };
  });

  // diy.ui.tree — 反向调 main 的 diy.app.loadTaskTree 取数据，本地渲染文本
  server.on(ui.tree, async ({ input }) => {
    const nodes = (await diyService.diy.app.loadTaskTree({ allTasks: input.all ?? false })) as TaskNode[];
    return { status: 'ok', data: renderTreeText(nodes) };
  });

  // diy.ui.status — 进程数据反向调 main 的 diy.app.getAppStatus
  server.on(ui.status, async () => {
    const s = await diyService.diy.app.getAppStatus({});
    return { status: s.status, data: s.data };
  });

  return server;
}
