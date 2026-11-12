// demo.ts — UI 本地演示块（接真工具前，先能看见 tool / think 块长什么样）。
//
// 用法：输入框里敲 `/demo-tool` ⇒ 渲染层**本地**插一条假工具块：
//   先 running（黄色圆点、details 展开，看得到进度）
//   → 约 900ms 后变 ok（绿色圆点、收起、带一行结果摘要 + 折叠输出）
//
// 硬边界：一个字节都不发主进程、不进会话历史、不落盘 —— 纯界面演示。
// 刷新/切 bot 后它不会回来（那是核心层的快照说了算）。

import type { ToolBlockData, WireMessage } from './shared.js';

/** 演示命令（输入框原样等于它才触发） */
export const DEMO_TOOL_COMMAND = '/demo-tool';

/**
 * 一条假的 tool 消息。
 * `phase: 'running'` = 正在跑（展开）；`'ok'` = 跑完（收起 + 摘要 + 输出）。
 */
export function demoToolMessage(phase: 'running' | 'ok'): WireMessage {
    const data: ToolBlockData =
        phase === 'running'
            ? {
                  name: 'read_file',
                  args: 'docs/plans/2026-11-02-concurrency-actor.md',
                  state: 'running',
                  summary: '读取中…',
              }
            : {
                  name: 'read_file',
                  args: 'docs/plans/2026-11-02-concurrency-actor.md',
                  state: 'ok',
                  summary: '读取 6.0 KB',
                  output: '# 并发架构：单实例 = 单 actor（备忘）\n\n（演示输出，共 6.0 KB）',
              };
    // 2026-11-11：同一条演示消息里带上一个 think 块 —— 一次能看到 AI Elements 的
    // Reasoning（折叠 + 时长）与 Tool（状态徽章 + 参数/结果）两种高级效果。
    const think = {
        kind: 'think' as const,
        id: 'demo-think',
        data: { text: '先确认要读的文件存在，再取全文（演示用的思考过程）。', done: phase === 'ok' },
    };
    return { role: 'assistant', blocks: [think, { kind: 'tool', id: 'demo-tool', data: { ...data } }] };
}
