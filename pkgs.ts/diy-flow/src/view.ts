// view.ts — 通用渲染器契约：九种**引擎侧固定渲染器**各自吃哪种 `data` 形状（##166 §14.7）
//
// 判据（##166 §13.2「把插件做薄」）：**行业不写页面，只写形状翻译**。
//   · `art.renderer` —— 引擎侧固定渲染器（九种；id 真源是 `define.ts` 的 `RENDERERS`）；
//   · `art.plugin`   —— `render` 插件：把**这个行业的 raw** 翻成该渲染器要吃的 `data`（全工程唯一「需写代码」处）；
//   · 页面长什么样   —— 归宿主（##320）。行业一个字节的视图代码都不写。
// 本文件只声明**每种渲染器吃什么形状**，也就是 `View.payload`（内核里是 `unknown`）的**形状化视角**：
// 形状是「行业插件」与「引擎渲染器」之间的契约 —— 写在这里，一处定义、两边引用（插件产出它、渲染器消费它）。
//
// ⚠️ **不复制 id 清单**：本文件只有**一张形状表**（`ShapeMap`），九种渲染器那份 id 真源始终是
//    `define.ts` 的 `RENDERERS` —— 两者由**两道编译期护栏**对齐（漏一种 / 多一种都当场报错，见 `ViewShapes`）。
//
// ⚠️ **纯类型、零运行时代码**（##318 硬约束）：类型只在编译期起作用，运行期一个字节都不产出。
//    故 `index.ts` 末尾以 `export type *` 把它**类型导出** —— 消费者按形状收窄 `View.payload` 的正路是
//    `import type { ViewData } from '@diy/flow'`；跨包**子路径** import（`@diy/flow/src/view`）才是 hack
//    （`exports` 只有 `.`）。类型导出零运行时代价：不产出运行时成员，`import` 侧也不留副作用。

import type { Renderer } from './define.js';

/**
 * 语义色调：行业说「这行 / 这条 / 这枚是**什么性质**」，引擎只照它上色，**不解释含义**（不给 = 引擎默认色）。
 * 这是「形状翻译」的一部分：行业**只给语义**，配色归引擎 —— 行业一给色值，就等于开始写页面了。
 */
export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

/** `doc` —— 一段文档正文（`script.md` / `review.md` 之类纯文本产物直接就是它） */
export interface DocData {
    readonly text: string;
}

/** `diff` 的一行：加 / 删 / 上下文（`text` 含或不含行首标记都行，渲染器只按 `kind` 上色） */
export interface DiffLine {
    readonly kind: 'add' | 'del' | 'context';
    readonly text: string;
}

/** `diff` —— 一段补丁（`git diff` 的工作区产物） */
export interface DiffData {
    readonly lines: readonly DiffLine[];
}

/** `table` 的一行（`cells` 长度不必齐 —— 行是行、列是列） */
export interface TableRow {
    readonly cells: readonly string[];
    readonly tone?: Tone;
}

/** `table` —— 键值表 / 清单 / 检查项（`columns` 只用来给表头，可给可不给） */
export interface TableData {
    readonly columns?: readonly string[];
    readonly rows: readonly TableRow[];
}

/** `timeline` 上的一段（`start` / `end` 与 `ruler` **同单位**，通常 = 秒或百分比） */
export interface TimelineItem {
    readonly label: string;
    readonly start: number;
    readonly end: number;
    /** 行业直接给色（不给则由引擎按 `tone` 取默认色） */
    readonly color?: string;
    readonly tone?: Tone;
}

/** `timeline` —— 时间轴（分镜 / 排期 / 甘特）：若干段 + 可选刻度 */
export interface TimelineData {
    readonly items: readonly TimelineItem[];
    /** 刻度标签（如 `['0s','15s','30s','45s']`）；不给则引擎自己均分 */
    readonly ruler?: readonly string[];
}

/** `video` —— 播放器卡（`duration` / `at` 单位：秒） */
export interface VideoData {
    readonly src?: string;
    readonly poster?: string;
    readonly duration?: number;
    /** 播放头位置（秒） */
    readonly at?: number;
}

/** `badge` —— 一枚徽章（`label` 是给人看的短语，性质由 `tone` 说） */
export interface Badge {
    readonly label: string;
    readonly tone: Tone;
}

/** `badge` —— 一排徽章（状态 / 回执 / 签字） */
export interface BadgeData {
    readonly badges: readonly Badge[];
}

/** `kline` 的一根 K 线（`t` 是时间标签，原样显示；`t` 不是 `number` —— 时间格式归行业） */
export interface Candle {
    readonly t: string;
    readonly o: number;
    readonly h: number;
    readonly l: number;
    readonly c: number;
}

/** `kline` —— K 线序列 */
export interface KlineData {
    readonly candles: readonly Candle[];
}

/** `heatmap` 的一格（`tint` 0..1：行业给的着色强度；不给则由引擎按 `value` 自行归一） */
export interface HeatmapCell {
    readonly value: number;
    readonly tint?: number;
}

/** `heatmap` —— 热力图（因子矩阵 / 相关性矩阵），`cells` 按行优先铺 */
export interface HeatmapData {
    readonly cells: readonly HeatmapCell[];
}

/** `equity` —— 净值曲线 + 回撤（`drawdown` 与 `nav` 逐点对应，可选；`markDrawdown` 标出最大回撤点） */
export interface EquityData {
    readonly nav: readonly number[];
    readonly drawdown?: readonly number[];
    readonly markDrawdown?: boolean;
}

/**
 * 九种形状的**内层映射表**（键 → 该渲染器要吃的 data）。
 *
 * ⚠️ 它**不继承** `Record<Renderer, unknown>`：那样漏一种会从基类**继承到 `unknown`**，护栏形同虚设。
 * 两张显式表 + 下面两道编译期护栏，才是「漏一种 = 报错」真正生效的写法。
 */
interface ShapeMap {
    doc: DocData;
    diff: DiffData;
    table: TableData;
    timeline: TimelineData;
    video: VideoData;
    badge: BadgeData;
    kline: KlineData;
    heatmap: HeatmapData;
    equity: EquityData;
}

/** `Expect<T extends true>`：把「编译期断言」写成一行 —— 断言不成立时，报错就落在这行 */
type Expect<T extends true> = T;

/** 两个字符串集合相等（`A ⊆ B` 且 `B ⊆ A`） */
type SameSet<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * **编译期护栏**：形状表的键必须**恰等于** `Renderer` 全集。
 *
 * 护栏 ①（本行）：多一种（写了内核没有的渲染器）/ 漏一种，都在这里报
 * `Type 'false' does not satisfy the constraint 'true'`；
 * 护栏 ②（下面 `ViewShapes` 那行）：漏一种还会额外报 `Type 'K' cannot be used to index type 'ShapeMap'`。
 *
 * 于是「内核加了渲染器、契约忘了跟上」这种腐坏在 `tsc` 一步就拦住 —— 这就是**不复制 id 清单**的收益：
 * 真源永远只有 `define.ts` 的 `RENDERERS`。
 */
type _ShapeMapIsExhaustive = Expect<SameSet<keyof ShapeMap & string, Renderer>>;

/** 渲染器 id → data 形状（`View.payload` 的形状化视角；`Record<Renderer, …>` 由映射类型保证满覆盖） */
export type ViewShapes = { readonly [K in Renderer]: ShapeMap[K] };

/** 某个渲染器要吃的 data 形状（`View.payload` 的形状化视角：`ViewData<'kline'>` = `KlineData`） */
export type ViewData<R extends Renderer> = ViewShapes[R];

/** 一个节点的 view：渲染器 id + 该渲染器要的 data（把内核的 `{ renderer, payload }` 形状化配对） */
export type TypedView<R extends Renderer = Renderer> = {
    [K in Renderer]: { readonly renderer: K; readonly data: ViewShapes[K] };
}[R];
