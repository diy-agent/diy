// examples/video.ts — 范例②：视频制作工作流（9 泳道 · 含一次打回）
//
// 与范例①（`examples/dev.ts`）**同形**：A 层（拓扑 + 提示词）都是「节点 → 边 → guard / hint / art」，
// 一行都没多。真正的行业差异全落在**插件层**（`examples/video.plugins.ts`：三个读外部世界的 guard、
// 一个写外部世界的 action、六个把行业 raw 翻成引擎渲染器 data 的 render）与 **`anchor` 类型**上。
// 这就是 ##166 §13.3 那句话的代码证明：**一个新行业 = 换插件 + 换形状，不换拓扑、不写页面**。
//
// 拓扑（##166 §14.3 的视频场景：12 步 / 9 泳道 / 1 次打回）：
//
//     topic ─▶ script ─▶ storyboard ─▶ shoot ─▶ cut ─▶ render ─▶ approve ─▶ checks ─▶ publish
//                                                ▲                  │
//                                                └─── bounce ───────┘     审片打回**不新建节点**：cut 再驻留一次（`seq = 2`）
//
// 节点 id / guard / art（renderer + 插件名）**逐字对齐**验收基准 `##166` 的 `workflow-trace-sketch.html`
// （`render_board` / `render_preview` / `render_probe` / `render_notes` / `render_compliance` / `render_topic`）——
// demo 是基准，不是重新发明。
//
// guard 的分水岭仍是**可观测性**（##166 §10.3）：`prompt:` 只能 actor 宣布（topic / script / storyboard /
// shoot / cut / approve），`pred:` / `action:` 由系统求值并自动转移（render / checks / publish）。

import { defineWorkflow, type WorkflowDef } from '@diy/flow';

/** 泳道 ≡ 节点（1:1）：九个 id 就是九条泳道（也是折线上可能出现的全部节点） */
export const VIDEO_NODE_IDS = [
    'topic',
    'script',
    'storyboard',
    'shoot',
    'cut',
    'render',
    'approve',
    'checks',
    'publish',
] as const;
export type VideoNodeId = (typeof VIDEO_NODE_IDS)[number];

/**
 * ##166 §14.3 的视频轨迹 —— 本范例要端到端复现的那条折线（12 步）：
 * `topic → script → storyboard → shoot → cut → render → approve ⟲ cut → render → approve → checks → publish`。
 * `approve → cut` 那一步走 **bounce 边**（唯一一次打回），于是 `cut` / `render` / `approve` 各驻留两次。
 */
export const VIDEO_TRACE = [
    'topic',
    'script',
    'storyboard',
    'shoot',
    'cut',
    'render',
    'approve',
    'cut',
    'render',
    'approve',
    'checks',
    'publish',
] as const;

/** 宿主关联（`Visit.ref`）用的键 —— 内核只透传不解释（与范例①同名，宿主自己的命名习惯） */
export const VIDEO_REF_KEY = 'taskUri';

export const videoWorkflow: WorkflowDef<VideoNodeId> = defineWorkflow({
    id: 'video',
    name: '视频制作工作流',
    nodes: [
        {
            id: 'topic',
            name: '选题定调',
            actor: 'agent',
            guard: ['prompt:topic_ok'],
            hint: '选题有受众假设、有差异化角度',
            art: {
                raw: '选题卡（结构化）',
                renderer: 'table',
                plugin: 'render_topic',
                note: '选题卡 → 键值表',
            },
        },
        {
            id: 'script',
            name: '脚本撰写',
            actor: 'agent',
            guard: ['prompt:script_ok'],
            hint: '脚本完成，钩子 / 结构 / 落点齐备',
            // 纯文本 → 引擎默认 doc 渲染器：**不需要插件**（「引擎能枚举的 → 配置」，##166 §13.1）
            art: { raw: 'script.md', renderer: 'doc', note: '纯文本 → 默认 doc' },
        },
        {
            id: 'storyboard',
            name: '分镜设计',
            actor: 'agent',
            guard: ['prompt:board_ok'],
            hint: '分镜能支撑脚本，时长预估合理',
            art: {
                raw: 'shots.json（每镜的起止与内容）',
                renderer: 'timeline',
                plugin: 'render_board',
                note: '分镜数组 → 引擎的 timeline 渲染器',
            },
        },
        {
            id: 'shoot',
            name: '素材收集',
            actor: 'human',
            guard: ['prompt:footage_ok'],
            hint: '镜头够用（是否「够用」只有人能判）',
            art: { raw: 'footage.lst', renderer: 'table', note: '素材清单 → 默认 table' },
        },
        {
            id: 'cut',
            name: '剪辑成片',
            actor: 'agent',
            guard: ['prompt:cut_ok'],
            hint: '节奏、配色、字幕、配乐满意',
            art: {
                raw: 'preview.mp4',
                renderer: 'video',
                plugin: 'render_preview',
                note: '成片文件 → 引擎的 video 渲染器（播放器卡，带进度）',
            },
        },
        {
            id: 'render',
            name: '转码渲染',
            actor: 'system',
            guard: ['pred:render_done'],
            hint: 'ffprobe(out) 通过且产物存在',
            art: {
                raw: 'ffprobe(job) 结果',
                renderer: 'table',
                plugin: 'render_probe',
                note: '容器探测 → 表',
            },
        },
        {
            id: 'approve',
            name: '审片',
            actor: 'agent',
            guard: ['prompt:approve_ok'],
            hint: '审美与合规的主观放行',
            art: {
                raw: '审片意见',
                renderer: 'table',
                plugin: 'render_notes',
                note: '意见 → 表（第 2 次驻留时「前 3 秒」那条已被划掉）',
            },
        },
        {
            id: 'checks',
            name: '平台合规检查',
            actor: 'system',
            guard: ['pred:duration_ok', 'pred:copyright_ok'],
            hint: '数组 = 与：时长与版权都过',
            art: {
                raw: 'compliance.json',
                renderer: 'table',
                plugin: 'render_compliance',
                note: '检查结果 → 表',
            },
        },
        {
            id: 'publish',
            name: '多平台发布',
            actor: 'system',
            guard: ['action:publish'],
            hint: '投递到各平台（写外部世界的动作）',
            art: { raw: '投递回执', renderer: 'badge', note: '回执 → 徽章' },
        },
    ],
    // 边只连节点 id（打错字 / 回退到泳道 = 编译期报错）；入口自动推断 = topic（唯一没有入边的节点）
    edges: [
        { from: 'topic', to: 'script', kind: 'next' },
        { from: 'script', to: 'storyboard', kind: 'next' },
        { from: 'storyboard', to: 'shoot', kind: 'next' },
        { from: 'shoot', to: 'cut', kind: 'next' },
        { from: 'cut', to: 'render', kind: 'next' },
        { from: 'render', to: 'approve', kind: 'next' },
        { from: 'approve', to: 'cut', kind: 'bounce' },
        { from: 'approve', to: 'checks', kind: 'next' },
        { from: 'checks', to: 'publish', kind: 'next' },
    ],
});
