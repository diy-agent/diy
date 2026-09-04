import type { EnvelopeTransport, ServerBinding } from '@diy/rpc';
import { ChannelServerBinding } from '@diy/rpc';
import { getRendererActions } from './renderer-actions';
import { apiDef } from '../../../main/services/api-def';
import { diyService } from './rpc';
import { createProjectViaUi } from './create-project';
import { createTaskViaUi } from './create-task';

/**
 * renderer-api-impl.ts — Renderer 侧 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta（diy.ui 子树），通过 binding.on(meta, handler) 绑定实现。
 * 命名体系：diy.ui.*（Renderer 进程域）。
 * 页面交互通过 renderer-actions 回调触发 React state 变更；
 * 进程级数据（diy.ui.tree/status）反向调 main 的 diy.* 获取。
 */

export function bindRendererApi(transport: EnvelopeTransport): ServerBinding {
  const binding = new ChannelServerBinding(transport);
  const ui = apiDef.diy.ui;

  binding.on(ui.component.list, async () => {
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

  binding.on(ui.component.status, async () => {
    // TODO: 从组件 Store 读取真实状态
    return {
      status: 'ok',
      data: { visible: true, state: 'ready' },
    };
  });

  binding.on(ui.page.info, async () => ({
    status: 'ok',
    data: {
      title: document.title,
      url: window.location.href,
      ready: document.readyState === 'complete',
    },
  }));

  binding.on(ui.page.navigate, async ({ input }) => {
    getRendererActions().navigate?.(input.page);
    return { status: 'ok' };
  });

  binding.on(ui.page.focus, async ({ input }) => {
    getRendererActions().focus?.(input.uri);
    return { status: 'ok' };
  });

  binding.on(ui.page.toast, async ({ input }) => {
    getRendererActions().toast?.(input.message, input.level ?? 'info');
    return { status: 'ok' };
  });

  // diy.ui.tree — 反向调 main 的 diy.loadTaskTree 取结构化数据
  binding.on(ui.tree, async ({ input }) => {
    return diyService.diy.loadTaskTree({ allTasks: input.all ?? false });
  });

  // diy.ui.status — 进程数据反向调 main 的 diy.getAppStatus
  binding.on(ui.status, async () => {
    const s = await diyService.diy.getAppStatus({});
    return { status: s.status, data: s.data };
  });

  // diy.ui.project.create — 与 UI「创建项目」按钮共用同一入口
  binding.on(ui.project.create, async ({ input }) => {
    const id = await createProjectViaUi(input.path, input.label, input.desc);
    return { status: 'ok', data: { id } };
  });

  // diy.ui.task.create — 与 UI「新增任务」按钮（CreateTaskSheet）共用同一入口
  binding.on(ui.task.create, async ({ input }) => {
    const uri = await createTaskViaUi(input.title, input.project, input.parent);
    return { status: 'ok', data: { uri } };
  });

  return binding;
}
