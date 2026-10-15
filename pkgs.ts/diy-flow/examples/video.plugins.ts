// examples/video.plugins.ts — 范例②的插件：读外部世界（3 个 guard）+ 写外部世界（1 个 action）+ 形状翻译（6 个 render）
//
// 判据（##166 §13.1）：**引擎能枚举的 → 配置；引擎查不到的 → 插件**。「引擎查不到」只有三种落点：
//   · **读**外部世界（ffprobe 过了没 / 时长合规没 / 版权命中没）⇒ `guard` 槽；
//   · **写**外部世界（把成片投递到各平台）⇒ `action` 槽；
//   · **译**非文本形状（选题卡 / 分镜 / 成片 / 探针结果 / 审片意见 / 合规结果 → 引擎九种渲染器）⇒ `render` 槽。
// **行业定制就收敛在这 10 个函数里**，且 render 那六个只做**形状翻译**、一行视图代码都不写（##166 §14.7）。
//
// **范例态**：不接真 ffmpeg / 真平台（真接入是 ##319 的事）—— 外部事实由 `VideoFacts` 注入，缺省「都过」；
// 节点产物（raw）由 `VIDEO_NODE_DATA` 供给（真接入时从节点产出里取）。于是「绿 → 推」与「红 → 停在边上」
// 两条路都能在测试里跑到，且**不碰 fs、不引新依赖**。

import type { ActionPlugin, GuardPlugin, PluginRegistry, RenderPlugin } from '@diy/flow';
import type { VideoNodeId } from './video';

/** 外部世界的事实（真实现此刻去跑 ffprobe / 问平台 API；范例用注入的假数据） */
export interface VideoFacts {
    /** `pred:render_done` —— 转码产物在不在、ffprobe 通不通 */
    readonly renderDone?: boolean;
    /** `pred:duration_ok` —— 时长合规（≤ 60s） */
    readonly durationOk?: boolean;
    /** `pred:copyright_ok` —— 版权 / 敏感词零命中 */
    readonly copyrightOk?: boolean;
    /** `action:publish` —— 投递成没成 */
    readonly publishOk?: boolean;
    /** `action:publish` —— 投递回执（哪个平台、什么状态） */
    readonly publishRef?: string;
}

// ── 节点产物（raw）：行业知道长什么样，引擎不知道 ──────────────────────────────
// 带 `render` 插件的节点，这里给**行业 raw**（插件把它翻成渲染器 data）；
// 不带插件的节点（script / shoot / publish），这里给的**就是渲染器 data 本身**（引擎直接吃）。
// 真接入时它们由节点的真实产出替换，**形状不变**（那正是「契约」的意思）。

/** `render_topic` 的输入：选题卡 */
interface TopicCard {
    readonly audience: string;
    readonly angle: string;
    readonly hook: string;
}

/** `render_board` 的输入：一个分镜 */
interface Shot {
    readonly label: string;
    readonly start: number;
    readonly end: number;
    readonly color?: string;
}

/** `render_preview` 的输入：成片文件 */
interface CutPreview {
    readonly poster: string;
    readonly duration: number;
    readonly at: number;
}

/** `render_probe` 的输入：容器探测结果 */
interface ProbeResult {
    readonly format: string;
    readonly bitrate: string;
    readonly duration: number;
}

/** `render_notes` 的输入：审片意见 */
interface ReviewNotes {
    readonly notes: readonly { readonly at: string; readonly what: string }[];
}

/** `render_compliance` 的输入：合规检查结果 */
interface ComplianceReport {
    readonly duration: number;
    readonly copyrightHits: number;
    readonly bannedWords: number;
}

/**
 * 每个节点交给 `view` 的那份数据（范例态假数据；键 = 节点 id ⇒ 少一个节点当场编译报错）。
 *
 * 形状是 `unknown`：内核不认识行业数据（`View.payload` 就是 `unknown`），
 * 「这坨 raw 长什么样」由**本文件的 `render` 插件**认领（`takeShape<T>`），对外契约是 `src/view.ts`。
 */
export const VIDEO_NODE_DATA: Readonly<Record<VideoNodeId, unknown>> = {
    topic: {
        audience: '24–30 岁通勤族',
        angle: '反常识：越忙越要留白',
        hook: '前 3 秒抛结论',
    } satisfies TopicCard,
    script: { text: '# 脚本\n\n钩子（0–3s）：结论先抛。\n结构：问题 → 反常识 → 方法 → 落点。\n' },
    storyboard: {
        shots: [
            { label: '开场钩子', start: 0, end: 18, color: '#f59e0b' },
            { label: '问题铺陈', start: 18, end: 34, color: '#8b5cf6' },
            { label: '方法展开', start: 34, end: 62, color: '#3b82f6' },
            { label: '案例演示', start: 62, end: 88, color: '#10b981' },
            { label: '落点收束', start: 88, end: 100, color: '#ef4444' },
        ] satisfies readonly Shot[],
        ruler: ['0s', '15s', '30s', '45s'],
    },
    shoot: {
        rows: [
            { cells: ['A001', '特写 · 咖啡杯', '✓ 可用'], tone: 'ok' },
            { cells: ['A002', '全景 · 工位', '✓ 可用'], tone: 'ok' },
            { cells: ['A003', '转场 · 窗外', '✗ 抖动 → 重拍'], tone: 'danger' },
        ],
    },
    cut: { poster: 'frame-0042.png', duration: 48, at: 12.4 } satisfies CutPreview,
    render: { format: 'mp4 / h264', bitrate: '8.2 Mbps', duration: 48 } satisfies ProbeResult,
    approve: {
        notes: [
            { at: '00:00–00:03', what: '节奏拖沓 ✗ → 已重剪' },
            { at: '00:12', what: '字幕偏移' },
            { at: '01:02', what: '配乐渐弱恰当' },
        ],
    } satisfies ReviewNotes,
    checks: { duration: 48, copyrightHits: 0, bannedWords: 0 } satisfies ComplianceReport,
    publish: {
        badges: [
            { label: 'B站 已发布', tone: 'ok' },
            { label: '抖音 已发布', tone: 'ok' },
            { label: '视频号 审核中', tone: 'warn' },
        ],
    },
};

// ── 形状翻译小工具（行业包自带；插件只做「取字段 + 换个形状」，不做视图）────────────────
function takeShape<T extends object>(data: unknown, what: string): T {
    if (typeof data !== 'object' || data === null) throw new Error(`${what}：节点产物应为对象（实得 ${typeof data}）`);
    return data as T;
}

// ── render 槽：六个形状翻译（唯一「需写代码」处，且只翻形状）────────────────────────

/** `render_topic`：选题卡 → `table`（受众 / 角度 / 钩子三行） */
const renderTopic: RenderPlugin = (data) => {
    const card = takeShape<TopicCard>(data, 'render_topic');
    return {
        renderer: 'table',
        payload: {
            rows: [{ cells: ['受众', card.audience] }, { cells: ['角度', card.angle] }, { cells: ['钩子', card.hook] }],
        },
    };
};

/** `render_board`：分镜数组 → `timeline`（每镜一段 + 刻度） */
const renderBoard: RenderPlugin = (data) => {
    const board = takeShape<{ shots: readonly Shot[]; ruler?: readonly string[] }>(data, 'render_board');
    return {
        renderer: 'timeline',
        payload: {
            items: board.shots.map((shot) => ({
                label: shot.label,
                start: shot.start,
                end: shot.end,
                color: shot.color,
            })),
            ruler: board.ruler,
        },
    };
};

/** `render_preview`：成片文件 → `video`（播放器卡，带播放头位置） */
const renderPreview: RenderPlugin = (data) => {
    const cut = takeShape<CutPreview>(data, 'render_preview');
    return {
        renderer: 'video',
        payload: { poster: cut.poster, duration: cut.duration, at: cut.at },
    };
};

/** `render_probe`：容器探测 → `table` */
const renderProbe: RenderPlugin = (data) => {
    const probe = takeShape<ProbeResult>(data, 'render_probe');
    return {
        renderer: 'table',
        payload: {
            columns: ['项', '值'],
            rows: [
                { cells: ['容器', probe.format] },
                { cells: ['码率', probe.bitrate] },
                { cells: ['时长', `${probe.duration} s`] },
            ],
        },
    };
};

/** `render_notes`：审片意见 → `table`（已重剪那条带 `warn`：行业只给语义，配色归引擎） */
const renderNotes: RenderPlugin = (data) => {
    const notes = takeShape<ReviewNotes>(data, 'render_notes');
    return {
        renderer: 'table',
        payload: {
            columns: ['时间', '意见'],
            rows: notes.notes.map((note) =>
                note.what.includes('✗')
                    ? { cells: [note.at, note.what], tone: 'warn' as const }
                    : { cells: [note.at, note.what] },
            ),
        },
    };
};

/** `render_compliance`：合规检查 → `table`（三项各自按结果上色） */
const renderCompliance: RenderPlugin = (data) => {
    const report = takeShape<ComplianceReport>(data, 'render_compliance');
    return {
        renderer: 'table',
        payload: {
            columns: ['检查项', '结果'],
            rows: [
                {
                    cells: ['时长', `${report.duration}.0 s ≤ 60`],
                    tone: report.duration <= 60 ? ('ok' as const) : ('danger' as const),
                },
                {
                    cells: ['版权命中', `${report.copyrightHits}`],
                    tone: report.copyrightHits === 0 ? ('ok' as const) : ('danger' as const),
                },
                {
                    cells: ['敏感词', `${report.bannedWords}`],
                    tone: report.bannedWords === 0 ? ('ok' as const) : ('danger' as const),
                },
            ],
        },
    };
};

// ── guard / action 槽：读 / 写外部世界 ────────────────────────────────────────

/** `pred:render_done` —— **读**：转码产物在不在（真实现跑 `ffprobe`） */
const renderDone: (facts: VideoFacts) => GuardPlugin = (facts) => () => {
    const pass = facts.renderDone ?? true;
    return { pass, reason: pass ? '' : '转码未完成（ffprobe 未通过）' };
};

/** `pred:duration_ok` —— **读**：时长合规 */
const durationOk: (facts: VideoFacts) => GuardPlugin = (facts) => () => {
    const pass = facts.durationOk ?? true;
    return { pass, reason: pass ? '' : '时长超限（> 60s）' };
};

/** `pred:copyright_ok` —— **读**：版权 / 敏感词零命中 */
const copyrightOk: (facts: VideoFacts) => GuardPlugin = (facts) => () => {
    const pass = facts.copyrightOk ?? true;
    return { pass, reason: pass ? '' : '版权或敏感词命中' };
};

/** `action:publish` —— **写**外部世界（真实现调各平台 API；范例只回执外部凭据） */
const publish: (facts: VideoFacts) => ActionPlugin = (facts) => () => {
    const ok = facts.publishOk ?? true;
    return ok ? { ok, ref: facts.publishRef ?? 'bilibili/douyin/wechat' } : { ok };
};

/** 本范例的全部插件（工厂：`facts` 注入外部事实，便于测试与真接入替换） */
export function videoPlugins(facts: VideoFacts = {}): {
    renders: Readonly<Record<string, RenderPlugin>>;
    guards: Readonly<Record<string, GuardPlugin>>;
    actions: Readonly<Record<string, ActionPlugin>>;
} {
    return {
        renders: {
            render_topic: renderTopic,
            render_board: renderBoard,
            render_preview: renderPreview,
            render_probe: renderProbe,
            render_notes: renderNotes,
            render_compliance: renderCompliance,
        },
        guards: {
            render_done: renderDone(facts),
            duration_ok: durationOk(facts),
            copyright_ok: copyrightOk(facts),
        },
        actions: { publish: publish(facts) },
    };
}

/**
 * 把范例插件注册进宿主的注册表 —— **先注册齐，再 `createRuntime`**
 * （组合期就查名字：`pred:turation_ok` 这种漏注册 / 错字，不必等到「走到那一步」才暴露）。
 */
export function registerVideoPlugins(registry: PluginRegistry, facts: VideoFacts = {}): PluginRegistry {
    const { renders, guards, actions } = videoPlugins(facts);
    for (const [name, plugin] of Object.entries(renders)) registry.register('render', name, plugin);
    for (const [name, plugin] of Object.entries(guards)) registry.register('guard', name, plugin);
    for (const [name, plugin] of Object.entries(actions)) registry.register('action', name, plugin);
    return registry;
}
