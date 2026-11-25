// dev-mock.ts —— **只在 dev** 生效的「无后端、无模型」演示数据。
//
// 为什么需要它：工具的折叠行、待答卡、作业卡片、错误条**都不来自文本** —— 它们由
// tool / notice(job) / error 条目与 Snapshot.asks 驱动。真实模型要发起一次 ask 得
// 真的花钱调一轮，而且内容不可控；而这几样正是本轮改得最多的组件（Button / 字号 /
// 状态色都落在它们身上），不给它们一个可复现的实例，就等于「改了但没验」。
//
// 用法：`http://127.0.0.1:52137/room/<任意房间>?mock=1`
//   · 传输被换成 chat-core 的 MockChatClient（同 ChatClient 契约，内存实现）；
//   · seed 里预置一排形态，进页面就能看见，不用先发消息；
//   · 再发任何消息 → 按 script 追加一轮「工具 → 作业 → 提问」。
//
// 生产构建里这段会被 `import.meta.env.DEV` 挡掉；`?mock=1` 在 dev 之外无效。

import type { AskRequest } from '@diy-agent/chat-core';
import type { MockStep } from '@diy-agent/chat-core';

/** 预置：一屏能看到全部形态 */
export const MOCK_SEED: MockStep[] = [
    { kind: 'chat', text: '把这三个房间的作业全部重新跑一遍，然后告诉我谁最慢。', author: 'human' },
    { kind: 'chat', text: '先看一眼作业账本，再决定并发几条。', author: 'bot' },
    {
        kind: 'tool',
        name: 'bash',
        args: { command: 'diy2 job list --room proj:diy' },
        result: { stdout: '3 条在跑\n- r-1  checkout     12s\n- r-2  sha check    44s\n- r-3  npm ci      1m02s' },
        state: 'ok',
    },
    {
        kind: 'tool',
        name: 'edit',
        args: { path: 'apps/diy2/src/main.tsx' },
        result: { error: 'file changed on disk since last read' },
        state: 'error',
    },
    {
        kind: 'notice',
        text: 'run r-3 已结束（退出码 0）\n$ npm ci --workspaces',
        noticeKind: 'job-done',
        job: {
            run: 'r-3',
            state: 'exited',
            exitCode: 0,
            signal: null,
            durationMs: 62_400,
            command: 'npm ci --workspaces',
            tail: 'added 1204 packages in 58s\n（输出已截断，完整内容用 job output r-3）',
            truncatedBytes: 18_432,
        },
    },
    { kind: 'error', message: '上游返回 429：这一轮被限流，等 30s 再试。' },
    { kind: 'chat', text: '并发这件事得你定，我一次问完。', author: 'bot' },
];

/** 那一批提问（三题：多选 / 表单 / 单行文本 —— 正好验翻页与「一次提交整批」） */
export const MOCK_ASK: AskRequest = {
    askId: 'ask-mock-1',
    at: Date.now(),
    note: '这三个决定会影响接下来怎么跑；一起定完我一次提交，不来回问。',
    owner: 'bot:mock',
    questions: [
        {
            id: 'q1',
            question: '这三条作业怎么跑？',
            kind: 'choice',
            multiple: true,
            allowFreeform: true,
            note: '多选。并发会抢 CPU，串行更稳但慢。',
            options: [
                { value: 'parallel', label: '三条并发', description: '最快，但 sha check 会被挤慢' },
                { value: 'serial', label: '一条一条来', description: '稳，总时长约 2 分钟' },
                { value: 'only-slow', label: '只重跑最慢那条', description: '省时间，另外两条保持现状' },
            ],
        },
        {
            id: 'q2',
            question: '失败的那条（edit 冲突）怎么处理？',
            kind: 'choice',
            required: false,
            options: [
                { value: 'retry', label: '重试一次' },
                { value: 'skip', label: '跳过' },
            ],
        },
        {
            id: 'q3',
            question: '重跑完要不要顺手把结论写进 journal？',
            kind: 'text',
            required: false,
            note: '可选。写了以后下一次能翻到。',
        },
    ],
};

/** 发消息后追加的一轮（走 script 路径，不看回复文本） */
export const MOCK_SCRIPT: MockStep[] = [
    { kind: 'chat', text: '好，按你说的来。先跑第一条。', author: 'bot' },
    {
        kind: 'tool',
        name: 'bash',
        args: { command: 'sha.sh check' },
        result: { stdout: '全部通过' },
        state: 'ok',
    },
    { kind: 'ask', request: MOCK_ASK },
];
