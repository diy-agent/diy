import { createMemo, For, Match, Show, Switch } from "solid-js";
import { personaStore } from "../../store/personaStore";
import { TurnUsageBar, type UsageHoverState } from "../UsagePanel";
import { RowGutter } from "@diy/ui-kit";
import { taskStore } from "../../store/taskStore";
import { CONCLUSION_LINES_MAX, CONCLUSION_LINES_MIN } from "../../lib/ui-state";
import { MarkdownView } from "../MarkdownView";
import { bubbleAlignClass, hasAuthor, roomOriginOf } from "../../lib/user-bubble";
import { bylineOf } from "../../lib/assistant-byline";
import { deliveryBadge, memberColor, shortName } from "../../../shared/room";
import { userStamp } from "../../lib/user-stamp";
import type { ReasoningEffort } from "../../../main/services/local-agent";
import { reasoningEffortLabel } from "../../../shared/reasoning-effort";
import { clampLines, countLines } from "../../lib/chat-text";
import type { BlockNode } from "../../../main/services/local-blocks";
import { collapsedRows, composeTail, degradedOf, endLeafTip, endReasonOf, isFailedTool, isReceiptTurn, historyOpenOf, leadUsers, linesFromDrag, liveTailOf, planOfLevel, tailOf, turnEndNote, turnFoldTip, turnRows, type TurnLevel, type TurnRow } from "../../lib/chat-fold";
import { steerModeLabel, steerModeTip } from "../../../shared/steer-mode";
import { DEGRADED_DANGLING_TEXT } from "../../../shared/degraded-history";
import { DisclosureHead, EndLeafBox, ErrorBox, HISTORY_TEXT_FOLD_LINES, MarkdownText, PlainText, ProcessRow, TailBox, hasAssistantContent, leafById, reuseRows, str, summaryOf, turnById } from "./MessageStream";

/** 该轮耗时（main 收尾 patch 写入的 `durationMs`）；没写（旧日志 / 崩溃轮）→ null，不编 0 */
function turnDurationMs(t: BlockNode): number | null {
    const d = t.attrs.durationMs;
    return typeof d === "number" ? d : null;
}

function fmtDuration(ms: number): string {
    return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms}ms`;
}

/**
 * 「这轮发生了什么」一行字：`6 步 · 12 秒 · ⚙ 5 · 💭 6 · ❌ 1`。
 *
 * 语义上属于**轮次**（不是某条消息），但视觉上归**轮尾**（时刻右侧、用量按钮左边）——
 * 用户 2026-10-11 口径："把人物右侧的统计放到下面、用量的左边，不用 hover"：
 *   · 放轮次头右侧时它跟身份挤在一行，读起来像名字的后缀；轮尾那行本来就"总结这一轮"；
 *   · 它不能可点（没有"更多信息"可给），而轮次头整行是开合按钮 —— 摆在里面就成了
 *     "点统计也换层"，与轮尾时刻同理（滚屏阅读时最易误触）。
 * 与用量按钮**分开**：用量要 hover/点击，统计纯文本，两者语义不同（同轮尾时刻的处理）。
 *
 * 判据（都是 review 或用户口径换来的）：
 *   · **不放 token**：用量按钮就在右边，同一行说两遍；
 *   · **不放 `n/4`**：级别归顶部那个全局按钮，单轮只有开/合两态（见 TurnHeader 头注）；
 *   · 报错要有位置：一屏多轮时先看见"哪轮出过事"最快（error 块本身是恒显行，见 chat-fold.turnRows）。
 */
function turnStatLine(t: BlockNode, c: { step: number; tool: number; think: number; error: number }): string {
    const parts: string[] = [];
    if (c.step) parts.push(`${c.step} 步`);
    const d = turnDurationMs(t);
    if (d != null) parts.push(fmtDuration(d));
    if (c.tool) parts.push(`⚙ ${c.tool}`);
    if (c.think) parts.push(`💭 ${c.think}`);
    if (c.error) parts.push(`❌ ${c.error}`);
    return parts.join(" · ");
}

/**
 * 轮次头（人物标题 bar）：身份 + 开合箭头。点它 = **这一轮**收拢 / 展开。
 *
 * 身份（🤖 头像 · 人物 · 模型 · 思考级别）**任何级别都显示** —— 用户 2026-10-11 口径：
 * "1 级的人物 bar 和 2 级不一样，需要一致，也需要显示人物/模型信息"。
 * 身份是**该轮事实**的投影（`turn.attrs.model` / `reasoningEffort`），不是当前配置 ——
 * 否则改一次 personas.yaml，全部历史署名被一起改写（任务 196 的教训）。
 *
 * **统计不在这里**（步数 · 耗时 · ⚙ n · 💭 n · ❌ n）：搬到轮尾一行、用量按钮左边
 * （用户 2026-10-11 口径，判据见 `turnStatLine`）。这里只剩身份 —— 一行两件事本来就挤，
 * 而且整行是开合按钮，统计摆进来会被读成"点了会出更多数字"。
 * 它仍进 `ariaLabel` / `title`：读屏与 hover 时"这轮发生了什么"是有用的。
 */
function TurnHeader(props: {
    /** 轮次 id（节点按 id 现取：行对象按 id 复用，见文件头注） */
    turnId: string;
    /** **过程历史**开合（不是级别：级别只改"历史里显示多少"，见 `historyOpenOf`） */
    open: boolean;
    onToggle: () => void;
    counts: { step: number; tool: number; think: number; error: number };
}) {
    const t = () => turnById(props.turnId);
    // 身份是**该轮事实**的投影（turn.attrs.model），不是当前配置（任务 196 的教训）
    const id = () => taskStore.selectedTask?.persona ?? personaStore.idForTask();
    const persona = () => personaStore.defOfLive(id());
    const info = () =>
        bylineOf({
            turnModel: t().attrs.model,
            personaName: persona()?.name ?? null,
            personaModel: persona()?.model ?? null,
        });
    // 思考级别：**该轮事实**（main 在 turn start 写进 meta），不是当前配置
    const effort = () => str(t().attrs.reasoningEffort);
    /** 视觉上不画（在轮尾），但读屏/hover 文案要 —— `turnStatLine` 的唯一第二调用点 */
    const stat = () => turnStatLine(t(), props.counts);
    const open = () => props.open;
    return (
        <DisclosureHead
            open={open()}
            onToggle={props.onToggle}
            class="flex items-center gap-1.5 w-full text-left rounded-lg px-1.5 py-1 hover:bg-base-200/60 text-body"
            ariaLabel={`${info().name ?? "助理"}${info().model ? `（${personaStore.displayModel(info().model)}）` : ""}：${stat()}；${turnFoldTip(open())}`}
            rest={{
                "data-testid": "turn-header",
                "data-row-head": "1",
                "data-block-id": t().id,
                "data-block-tag": "turn",
                "data-open": open() ? "1" : "0",
                "data-inferred": info().inferred ? "1" : undefined,
                title: `${turnFoldTip(open())}\n${info().title}`,
            }}
        >
            {/* 开合手柄在**行首 gutter**（`RowGutter`）：一轮里"轮次头 → 过程 bar → 逐条过程"
                三级同列左对齐，一眼能看出层级（2026-10-11 用户口径：箭头从右边换到左边；
                2026-10-12 用户口径：竖列成一列，见 RowGutter 头注） */}
            <RowGutter open={open()} onToggle={props.onToggle} />
            {/* 身份：**所有级别都显示**（1 级与 2 级必须一致，用户 2026-10-11 口径） */}
            <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-body"
                aria-hidden="true"
            >
                🤖
            </span>
            {/* min-w-0 + truncate（review2-1）：多 view 并排时单栏只有 200~260px，模型名
                （`provider/model`）很长，会把这条 flex 行撑成两行、甚至顶破容器右缘 ——
                `min-width:auto` 是默认值，不加就永远不缩。真正长的是模型名，所以它先被截。 */}
            <Show when={info().name}>
                <span class="min-w-0 truncate font-medium">{info().name}</span>
            </Show>
            <Show when={info().model}>
                <span class="shrink-0 opacity-50">·</span>
                <span class="min-w-0 truncate opacity-60">{personaStore.displayModel(info().model)}</span>
            </Show>
            {/* 思考级别：该轮实际生效的档位（main 写入 turn meta） */}
            <Show when={effort() && effort() !== "none"}>
                <span class="opacity-50">·</span>
                <span class="opacity-60">{reasoningEffortLabel(effort() as ReasoningEffort)}</span>
            </Show>
            <Show when={info().inferred}>
                <span class="shrink-0 opacity-40">（当时人物未知）</span>
            </Show>
            {/* 过程历史里的失败/中断数 —— 历史收起时这是**唯一**的线索（用户 2026-10-12 R22：
                中间步骤的错误不单列根级，"只在树各层的图标/颜色上标注"） */}
            <Show when={props.counts.error > 0}>
                <span
                    class="shrink-0 rounded border border-error/40 bg-error/10 px-1 font-mono text-caption text-error"
                    data-head-err
                    title={`过程历史里有 ${props.counts.error} 处失败/中断（展开可见）`}
                >
                    ✗ {props.counts.error}
                </span>
            </Show>
            {/* 该轮时刻**不在这里**：它在轮尾状态行（★ 状态行，见 UsagePanel 的 Clock）——
                一轮只该出现一次，且要跟统计/用量/速度同列可扫。 */}
            {/* 统计不在这里：轮尾一行（时刻右边、用量左边）—— 见 turnStatLine 头注 */}
        </DisclosureHead>
    );
}

/**
 * **助理正文行** —— 所有级别共用同一个组件，级别只决定 `clamp`（"级别同构"的落点之一）。
 *
 * `clamp`（1 级的结论）压成 N 行摘要、点提示行进下一级看全；`!clamp`（2 级起 + 3-4 级的
 * 中间正文）一律全文。
 *
 * 两个易错点（都是用户反馈过的）：
 *   ① **必须跟 MD 渲染/原文开关走**（2026-10-11 反馈：摘要态强制原文、展开态才是渲染，
 *      同一个块两种格式切换很怪）。摘要仍走同一份正文，只是行数少了 —— 渲染方式与
 *      是否截断是两个正交维度，不能互相决定。截断处 Markdown 会在围栏/列表中间断开，
 *      交给 MarkdownView 的 streaming 分支兜底（未闭合围栏照样成块），不退回原文。
 *   ② 「被裁剪过」必须**一眼可见**（2026-10-11 反馈：只截 3 行看不出被缩过）：
 *      底部**渐隐**暗示"下面还有"（Linear / Notion / Apple 摘要一路），
 *      再加**可点提示行**说清"还有几行 + 点哪看全"（GitHub / Slack 的 Show more 一路）。
 *      只靠 CSS line-clamp 自带的 `…` 信息量最低，且会把代码块截在结构中间。
 */
function TextRow(props: {
    node: BlockNode;
    /** 折叠判据：正文行数超过它才给折叠能力（草图 v4 = 3 行） */
    lines: number;
    /** **缺省**开合（用户的 pin 优先）：结论 = 2 级起开、1 级折；过程历史正文 = 恒开 */
    defaultOpen: boolean;
    /** 开合状态（与过程行同一套 pin）—— **点自己这一块**，不是换级别、更不是折别人 */
    pin: Record<string, boolean>;
    onToggle: (id: string, force?: boolean) => void;
    md: boolean;
    /** 结尾槽的「结论」形态：这一块**自己就是** `[data-tail-box=conclusion]`（草图 v4 的
        `.tailbox.k-conc` 就是这一块，不再包一层 —— 包一层就是槽里那张卡还套一张卡） */
    box?: "conclusion";
    /** **仅结论行**：拖下缘改「可见行数」（= 1 级摘要的可视高度）。给了才渲染拖条 ——
     *  过程历史里的正文行（`HISTORY_TEXT_FOLD_LINES` 固定）不给，它们的高度不归用户调。 */
    onResizeLines?: (n: number) => void;
}) {
    const b = () => props.node;
    /** 正文宿主（拖拽时量它当前高度 —— 等比换算的基准，见 `linesFromDrag`） */
    let bodyRef: HTMLDivElement | undefined;
    const raw = () => str(b().attrs.content);
    /** 能不能折 = **"点开真的会多出东西"**（review ##253 RV-6）。
     *  原来按**原始**行数判（`countLines(raw()) > lines`），而 `clampLines` 已跳过前导空行
     *  （RV-2 的修复）⇒ 以空行开头的正文会给出一个"点开毫无变化"的箭头。
     *  现在直接取 `clampLines` 的 `omitted` —— 与"真截"**同源**，不再有第二套口径。 */
    /** 全文行数：**按块版本 memo**（块不变就不重算）—— 直播中的大块每帧付一次 `countLines`，定稿后只算一次 */
    const totalLines = createMemo(() => countLines(raw()));
    /** 截断结果同样 memo：原来 `canFold()` 与 `view()` **各算一次** `clampLines` ⇒ 每帧两遍全文 split（##93） */
    const clamped = createMemo(() => clampLines(raw(), props.lines, totalLines()));
    const canFold = () => clamped().omitted > 0;
    const open = () => (b().id in props.pin ? props.pin[b().id]! : props.defaultOpen);
    // 直播中的正文不折：它还在长，折叠只会来回跳；定稿后才折成摘要
    const folded = () => canFold() && b().stopped && !open();
    const view = () => (folded() ? clamped() : { text: raw(), omitted: 0, exact: true });
    const cut = () => view().omitted > 0;
    /** 点**这一块**（正文行自己那条竖列折叠条 / 提示行）—— 用户 2026-10-12 R6 报的 bug：
     *  原来结论槽把 `onExpand` 接到了"换级别"，点一下**把工具历史折了、自己没变**。 */
    const fire = () => props.onToggle(b().id, !open());
    /** 折叠条的无障碍名：只读"展开 / 收起"听不出是**哪一行**（review ##253 小项6） */
    const foldLabel = () => `${folded() ? "展开" : "收起"}${props.box === "conclusion" ? "结论" : "正文"}`;
    /** 结论下缘拖拽：改的是**全局**摘要行数（1 级所有轮次一起变 —— 它是"我习惯看几行"的偏好，
     *  与顶部 `n/4 展开` 同级，不是逐轮覆盖；逐轮覆盖不落盘，见 ui-state 头注）。
     *  起点量一次宿主高度，之后按等比换算出行数（纯函数 `linesFromDrag`）。 */
    const startResize = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const onResize = props.onResizeLines;
        const el = bodyRef;
        if (!onResize || !el) return;
        const h0 = el.getBoundingClientRect().height;
        const n0 = props.lines;
        const startY = e.clientY;
        const move = (ev: MouseEvent) =>
            onResize(linesFromDrag(n0, h0, ev.clientY - startY, CONCLUSION_LINES_MIN, CONCLUSION_LINES_MAX));
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };
    /** 拖条只在**结论收起态**给（拖它 = 改"1 级看几行"）：展开态（2 级全看）没有高度可调；
     *  未定稿（还在长）也不给 —— 高度每帧变，拖了没有稳定基准。 */
    const canResize = () => props.box === "conclusion" && !!props.onResizeLines && !open() && b().stopped;
    return (
        <div
            data-block-id={b().id}
            data-block-tag="text"
            data-tail-box={props.box}
            data-clamped={cut() ? "1" : undefined}
            data-text-open={open() ? "1" : "0"}
        >
            <RowGutter
                /* 直播中的正文不折（见 `folded`）⇒ 那时**不承诺**可展开：给静态点，不给箭头
                   （箭头 + `aria-expanded` 会说"收起"，而正文本来就是全的 —— 点了当帧无变化）。 */
                can={canFold() && b().stopped}
                /* 显示态取 `folded()`（真截断了才算"收起"），与下面 `view()` 同一个判据 */
                open={!folded()}
                label={foldLabel()}
                onToggle={fire}
                /* 正文行**没有行头控件**（正文本身就是内容，不是 DisclosureHead）⇒ 条是它唯一的
                   键盘入口，给 `sole`。但收起态那条"⋯ 已折叠 N 行 · 点击展开全部正文"是可见按钮，
                   已经有停靠点 ⇒ 那时条退回装饰（免得同一行动作两个 tab 停靠点）。 */
                sole={!cut()}
            />
            <div
                ref={(el) => (bodyRef = el)}
                style={
                    cut()
                        ? {
                              "mask-image":
                                  "linear-gradient(to bottom, #000 45%, rgba(0,0,0,0) 100%)",
                              "-webkit-mask-image":
                                  "linear-gradient(to bottom, #000 45%, rgba(0,0,0,0) 100%)",
                          }
                        : undefined
                }
            >
                <Show when={props.md} fallback={<PlainText text={view().text} />}>
                    <MarkdownText text={view().text} streaming={!b().stopped || cut()} />
                </Show>
            </div>
            <Show when={cut()}>
                {/* 提示行是独立 button：正文（上面那层 div）仍可拖选复制 */}
                <button
                    type="button"
                    class="mt-0.5 text-caption opacity-60 hover:opacity-100 hover:text-primary"
                    onClick={fire}
                >
                    ⋯ 已折叠 {view().exact ? "" : "≥"}{view().omitted} 行 · 点击展开全部正文
                </button>
            </Show>
            {/* 1 级「摘要结论」下缘拖条：往下拖 = 这一块画更多行（免在 1/2 级间来回切）。
                全局偏好（所有轮次一起变），tooltip 说清；`data-concl-resize` 供 CDP 定位。 */}
            <Show when={canResize()}>
                <div
                    class="group mt-1 flex h-2 cursor-row-resize items-center justify-center rounded hover:bg-primary/20 active:bg-primary/40"
                    data-concl-resize={String(props.lines)}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`拖动调整 1 级摘要高度（当前 ${props.lines} 行）`}
                    title={`拖动调整「1 级摘要」高度（当前 ${props.lines} 行；往下拖看更多，全局生效）`}
                    onMouseDown={startResize}
                >
                    <span class="h-0.5 w-10 rounded-full bg-base-content/20 group-hover:bg-base-content/50" />
                </div>
            </Show>
        </div>
    );
}

/**
 * 用户发言气泡：一切档位/模式下都全文 —— 它就是"我说过啥"的脉络本体。
 *
 * 对齐 = **谁说的**（##166 §40 C）：
 *   · **无 `author`**（本任务本人在任务对话页里发的）⇒ **右对齐，逐字不变**（老行为）；
 *   · **有 `author`**（代发 / 多 agent 同席：room 投递、CLI `--author`、驱动环）⇒ **左对齐 + 署名行 + 色点**，
 *     与助手气泡同侧 —— 因为那句话在本会话里**不是我说的**，右边那套语义（"我说过啥"）会撒谎。
 * 色点走 `memberColor`（与房间成员栏**同一份**配色判据，同 id 到哪都一样色），不写死色值。
 */
function UserBubble(props: { node: BlockNode }) {
    const b = () => props.node;
    const steer = () => str(b().attrs.steer);
    /** 发言者成员 id（`agent:166` / `human:ccc`）；空 = 本任务本人 */
    const author = () => str(b().attrs.author);
    /** 房间来源（`{ roomId, sayId }`）；空 = 不是投递来的（第 23 刀） */
    const roomOrigin = () => roomOriginOf(b().attrs);
    /** 「房间投递 · #N」文案；`null` = 不画 */
    const deliveryNote = () => deliveryBadge(roomOrigin());
    /** 这句话的时刻：块 id 自带所属轮（turnId 内嵌毫秒），格式复用 agent 侧那个 `fmtTurnStamp`。
     *  取不到就不显示（绝不用渲染时刻顶替）—— 数据源与降级口径见 `lib/user-stamp` 头注。 */
    const stamp = () => userStamp(b().id);
    return (
        <div class={bubbleAlignClass(author(), roomOrigin())}>
            <div class="max-w-[85%] bg-primary/10 border border-primary/20 rounded-2xl px-3.5 py-2 text-prose whitespace-pre-wrap break-words">
                {/* 房间投递标记（##377 第 23 刀）：这句话**不是本任务的人说的** —— 是别的房间投过来的。
                    为什么要标：接收方原来分不清「本任务的人在跟我说话」与「别的房间投来的一句」，
                    那条 user 块看起来就是这个任务自己的发言。标记只写来源（房间短名），不写原因。 */}
                <Show when={deliveryNote()}>
                    {(n) => (
                        <div class="mb-0.5 flex items-center gap-1.5 text-caption opacity-70" data-user-room={roomOrigin()?.roomId}>
                            <span class="shrink-0">🫧</span>
                            <span class="font-medium">{n()}</span>
                        </div>
                    )}
                </Show>
                <Show when={hasAuthor(author()) ? author() : null}>
                    {(a) => (
                        <div class="mb-0.5 flex items-center gap-1.5 text-caption" data-user-author={a()}>
                            <span
                                class="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ background: memberColor({ id: a(), color: undefined }) }}
                            />
                            <span class="font-medium opacity-80">{shortName(a())}</span>
                            <span class="opacity-40">{a()}</span>
                        </div>
                    )}
                </Show>
                <Show when={steer()}>
                    <span class="mb-0.5 block text-caption opacity-60">
                        ⤵ 插话（{steerModeLabel(steer())}）{steerModeTip(steer())}
                    </span>
                </Show>
                {str(b().attrs.content)}
                {/* 时刻压在气泡内右下（IM 惯例）：与 agent 侧同格式，不另起一行占版面 */}
                <Show when={stamp()}>
                    {(s) => (
                        <div class="mt-0.5 text-right text-caption opacity-50" data-user-stamp title={s().title}>
                            {s().text}
                        </div>
                    )}
                </Show>
            </div>
        </div>
    );
}

/**
 * 过程 bar（3 级起）：**一段连续的思考/工具**折成一行（切法见 `chat-fold.contentItems`）。
 *
 * 行首形状（2026-10-11 用户口径定稿）：`chevron ▸ · 💭 n · ⚙ n [✗] · │ · 首行内容`——
 *   · **计数在 chevron 右边、内容左边**（原在右侧）：短、定宽、永远是数字，压在行首才扫得出
 *     "整页哪几轮重"；而且**展开/收起都在**，同一位置同一形状，不随开合消失。
 *   · **不再写「过程」二字**：那是"展开后不留空"的补丁标题，现在行首恒有计数 ICON，不空。
 *   · **计数块带底色 chip**，收起态再接一个 `│` 分隔，把计数与后面那段首行内容从视觉上切开
 *     （否则 `💭 1 · ⚙ 2 首行内容` 读成一串，看不出前半是统计）。
 *   · **不再顶 `statusMark`**（R15 加过）：计数块已经带 `💭`/`⚙` 字形，前面再顶一个是同一行
 *     图标叠两遍（R12 删掉同一处图标串的判据）；"这段跑没跑完"由失败 `✗` 与直播轮的实时区
 *     （那边有 statusMark，因为它画的是**单个**节点）负责。
 *
 * 收起 = 计数 + 该段**第一个**过程的内容（思考首行 / `tool · 命令首行`）；
 * 展开 = 只剩计数（下面铺开的就是那第一行，标题再复述一遍就是同一屏看两遍），逐条单行与
 * 4 级那一行长得一样：`open` 不跟级别走死 —— **用户的 pin 优先，否则跟 4 级**
 * （整体切到 4 级 = 所有 bar 都开，单点某一行 = 只开这一行，共用同一套渲染，不会各说各话）。
 *
 * bar 里**只有过程**：助理正文各自成项（3 级起全文）—— 正文与过程一旦合并，
 * 顺序就会出错（上一版把正文收进这一行的教训）。
 */
function ProcBar(props: {
    /** 这一段连续的过程叶子（文档序）——数组引用稳定是 `<For>` 不重建的前提（见 reuseRows） */
    parts: BlockNode[];
    /** 所在轮：透传给 `summaryOf` 算工具行标题的"意图" */
    turn?: BlockNode;
    open: boolean;
    /** 点整行 = 切这一行的 pin（**不是**换级别：级别循环归顶部按钮） */
    onToggle: () => void;
    pin: Record<string, boolean>;
    onToggleProc: (id: string) => void;
    onFull: (title: string, content: string) => void;
}) {
    const thinks = () => props.parts.filter((n) => n.tag === "think").length;
    const tools = () => props.parts.filter((n) => n.tag === "tool").length;
    const failed = () => props.parts.some(isFailedTool);
    /** 计数块的读屏/自动化文案（图标的字形读屏念不出来）；**两个计数恒在**（见下） */
    const countsText = () => `${thinks()} 段思考、${tools()} 个工具`;
    return (
        <div
            data-block-tag="proc-bar"
            /* 行键 = 该段**首个叶子** id（与 pin 的 `row:` 前缀同一来源）；加 `_bar` 后缀 ——
               这块是"一段过程"的容器，不是那个叶子本身，id 不该与子行撞车（同一份 DOM 里
               两个 `[data-block-id]` 同值，调试/选择器都会指错人）。 */
            data-block-id={`${props.parts[0]?.id ?? "proc"}_bar`}
            data-has-error={failed() ? "1" : undefined}
            data-open={props.open ? "1" : "0"}
        >
            <RowGutter open={props.open} onToggle={props.onToggle} />
            <DisclosureHead
                open={props.open}
                onToggle={props.onToggle}
                class="flex items-center gap-1.5 w-full py-1 pr-1 hover:bg-base-200/60 text-body"
                ariaLabel={`过程：${countsText()}（点击${props.open ? "收起" : "展开"}这一行）`}
                rest={{ "data-row-head": "1" }}
            >
                {/* 计数在**行首**：展开/收起都在（同一位置同一形状，不随开合消失），
                    带底色 chip = 与后面的首行内容分开（见头注） */}
                <span
                    class="shrink-0 rounded bg-base-300/60 px-1 tabular-nums text-caption opacity-70"
                    data-proc-counts={countsText()}
                    title={countsText()}
                >
                    {/* **两个计数恒在**（为 0 也写）：各段的计数块同宽同位，扫一眼就能比"哪段重"；
                        只写非零那个，第一段（只有思考）就比后面的窄一截，看着像两种行
                        （用户 2026-10-11 口径："甚至为 0 都要有，方便对齐和视觉概念上的统一"）。 */}
                    {`💭 ${thinks()} · ⚙ ${tools()}`}
                    <Show when={failed()}>
                        <span class="ml-1 text-error" title="这一行里有失败的工具">
                            ✗
                        </span>
                    </Show>
                </span>
                {/* 收起态才有"内容"可写（首行内容），故分隔符与内容一起只在收起态出现 */}
                <Show when={!props.open && props.parts[0]}>
                    <span class="shrink-0 opacity-25" aria-hidden="true">
                        │
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/80">
                        {summaryOf(props.parts[0], false, props.turn)}
                    </span>
                </Show>
            </DisclosureHead>
            {/* **子层在卡内**（包含关系）：卡 = 块自己，子行缩进在卡的留白里 —— 这样父卡
                （含它那道 4px 色条 / 贯穿线）覆盖的是**整段**，而不是"只有行头那一行"。
                缩进量由皮肤给（card = 父卡留白 20px；rail = 线 + 缩进，见 index.css）。 */}
            <Show when={props.open}>
                <div class="space-y-0.5" data-proc-children="1">
                    <For each={props.parts}>
                        {(n) => (
                            <PartRow
                                node={n}
                                turn={props.turn}
                                pin={props.pin}
                                onToggle={props.onToggleProc}
                                onFull={props.onFull}
                            />
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

/**
 * 过程 bar 铺开后的**逐条**：过程 → 单行（各自再点开才是内容 = 第 5 层）；plan / 未知块照实画。
 *
 * 每行**照带** chevron + 状态灯（`ProcessRow` 的默认形状）：外层 bar 只说"这一段有几段思考、
 * 几个工具"，逐条里"哪条是思考、哪条还在跑/失败"只能由每行自己说（2026-10-11 用户口径）。
 */
function PartRow(props: {
    node: BlockNode;
    /** 所在轮（见 `summaryOf` 的 `turn`） */
    turn?: BlockNode;
    pin: Record<string, boolean>;
    onToggle: (id: string, force?: boolean) => void;
    onFull: (title: string, content: string) => void;
}) {
    const b = props.node;
    if (b.tag === "think" || b.tag === "tool") {
        return (
            <ProcessRow
                node={b}
                turn={props.turn}
                pin={props.pin}
                onToggle={props.onToggle}
                onFull={props.onFull}
            />
        );
    }
    if (b.tag === "plan") {
        return (
            <div class="text-body opacity-70">
                📋 计划：
                <For each={(b.attrs.items as unknown[]) ?? []}>
                    {(it) => <div>• {str(it)}</div>}
                </For>
            </div>
        );
    }
    return <div class="text-body opacity-40">[未知块 {b.tag}]</div>;
}

/**
 * error 块的外观（唯一出处）。
 *
 * 两个调用点共用：① turn 内的叶子（llm 报错 / 中断 / 超预算）；② **根级** error 块 ——
 * 后者只出现在历史日志里（旧版上限提示没写 parent，fold 后成了根块），
 * 不在这里兜底的话，根渲染分支只会吐一句「[未知根 error]」，用户看不到
 * "还有 N 条插话没投出去"这种关键信息。
 */
/** 从错误原文里抠 `trace_id: <id>`（上游回执格式，见 ##309）：缺则无深链 */
function countTags(turn: BlockNode): { step: number; tool: number; think: number; error: number } {
    let step = 0,
        tool = 0,
        think = 0,
        error = 0;
    const walk = (x: BlockNode) => {
        for (const c of x.children) {
            if (c.tag === "step") step++;
            else if (c.tag === "tool") tool++;
            else if (c.tag === "think") think++;
            // 排队回执是正常态，不计入"出过事"的红 ✗ 计数（见 ErrorBox 的降级判据）
            else if (c.tag === "error" && str(c.attrs.source) !== "queue") error++;
            walk(c);
        }
    };
    walk(turn);
    return { step, tool, think, error };
}

export function TurnView(props: {
    /** 轮次 id（节点按 id 现取 —— 行对象按 id 复用，见文件头注） */
    turnId: string;
    /** 过程**详情**层的开合（用户自己点出来的那一下；与级别无关） */
    pin: Record<string, boolean>;
    /** **全局**展开级别（1-4，见 lib/chat-fold 的 TurnLevel）—— 决定结论是否压摘要、过程 bar 是否铺开 */
    level: TurnLevel;
    /** 这一轮的**过程历史**开不开（人物栏那枚 chevron / 全局级别，见 `historyOpenOf`） */
    histOpen: boolean;
    /** 点轮次头 = **收拢 / 展开这一轮的历史**（不换层；层归顶部那个全局按钮） */
    onCycle: () => void;
    /** 1 级结论摘要的行数（拖结论下缘改它，见 `onResizeLines`） */
    conclusionLines: number;
    /** 结论下缘拖拽 → 新的摘要行数（页面级：改全局偏好并落盘） */
    onResizeLines: (n: number) => void;
    onToggle: (id: string, force?: boolean) => void;
    onFull: (title: string, content: string) => void;
    liveTurnId: string | null;
    md: boolean;
    /** 用量 hover 卡（页面级状态：块树重建不丢） */
    usageHover: UsageHoverState | null;
    onHoverUsage: (id: string, el: HTMLElement) => void;
    onHoverEndUsage: () => void;
    /** 用量明细抽屉（打开的 turnId；页面级，单实例覆盖式） */
    usageDetail: string | null;
    onDetailUsage: (id: string) => void;
}) {
    const t = () => turnById(props.turnId);
    const plan = () => planOfLevel(props.level);
    /** 轮首用户发言：渲染在轮次头**之前**（IM 顺序）。见 chat-fold.leadUsers */
    const lead = () => leadUsers(t());
    const isLiveTurn = () => props.liveTurnId != null && props.liveTurnId === t().id;
    /** 直播中：本轮已出助理内容、但 main 还没写过 usage patch → 轮尾那行先出**占位**
     *  （时间由 turnId 自带，用量要等第一步 finish-step）。判据与"等待响应"loading 互补：
     *  助理内容一出现，占位条即接管，界面不再"什么都没有"。 */
    const usagePending = () => !t().attrs.usage && isLiveTurn() && hasAssistantContent(t());
    /** **活动块**（仅直播轮次）= 文档序最后一个非用户叶子（think / tool / **text** …，见 chat-fold） */
    const liveNode = () => liveTailOf(t(), isLiveTurn());
    /** **结尾槽**：直播 = 执行过程；已结束 = 现场 / 结论 / 结束点。判据只在 chat-fold（`tailOf`） */
    const tail = () => tailOf(t(), liveNode());
    /** 现场/活动框的分解（错误条 vs 主体）—— 只有 scene / live 两种形态用得上 */
    const composed = () => composeTail(t(), tail()?.node ?? null);
    /** 上帧的行序列：跨次渲染复用未变的行（`<For>` 按引用 diff —— 不复用就是每帧重建 = 点击全丢） */
    let prevRows: TurnRow[] = [];
    /** 正文行序列 —— **一条路径、所有级别同构**（见 chat-fold.turnRows） */
    const rows = () => {
        const next = turnRows(t(), liveNode());
        prevRows = reuseRows(prevRows, next);
        return prevRows;
    };
    const counts = () => countTags(t());
    /** 过程 bar 的开合：用户的 pin 优先，否则跟 4 级。键加 `row:` 前缀 —— 行键 = 该段首个叶子 id，
     *  不加前缀会与那个叶子自己的过程 pin 撞车（点过程变成连整段 bar 一起开合）。 */
    const rowOpen = (key: string) => {
        const p = props.pin[`row:${key}`];
        return p === undefined ? plan().midExpanded : p;
    };
    return (
        <div class="space-y-1.5" data-turn-id={t().id} data-turn-level={props.level} data-hist-open={props.histOpen ? "1" : "0"}>
            {/* 轮首用户发言**先出**：IM 直觉是"用户先说、对方再接"。
                轮次头（助理身份行）压在用户消息上面 = 看着像助理先开口（2026-10-11 反馈）。 */}
            <For each={lead()}>{(n) => <UserBubble node={n} />}</For>
            <TurnHeader turnId={props.turnId} open={props.histOpen} onToggle={props.onCycle} counts={counts()} />
            {/* ── 过程历史（**可折叠**：人物栏 chevron / 全局 1-4 级）────────────────
                这是**唯一**的折叠容器（`data-chat-list`）：皮肤那条"贯穿线"就画在它上面，
                所以开头有、结尾槽与状态行**在它之外**（线不穿过结尾 —— 用户 2026-10-12 R22：
                结尾是"顶级、自暴露、与状态同级"，不是历史的一部分）。
                `pl-2`：箭头移到行首后，左列箭头的缩进就是层级刻度
                （轮次头 → 过程 bar → 逐条过程），8px 才读得出"bar 在轮次头之下"。 */}
            <Show
                when={props.histOpen}
                /* 收起态（1-2 级 / 用户手动收拢这一轮）：过程不显示，但**用户发言恒显**。
                   用户 2026-10-21：「1/2/3/4 级都没有我那条留言，我需要展开 1 就能看到，
                   这是用户级留言，不应该被折叠放到深层」—— 自己说的话是对话脉络本体，
                   不是"过程细节"，收起来只会被读成"发出去了但丢了"。 */
                fallback={
                    <div class="space-y-1.5" data-chat-list="users-only">
                        <For each={collapsedRows(rows())}>
                            {(row) => (row.kind === "user" ? <UserBubble node={row.node} /> : null)}
                        </For>
                    </div>
                }
            >
                <div class="space-y-1.5" data-chat-list>
                    <For each={rows()}>
                    {(row) => {
                        if (row.kind === "user") return <UserBubble node={row.node} />;
                        if (row.kind === "error")
                            return (
                                <ErrorBox
                                    node={row.node}
                                    receiptSteerId={
                                        isReceiptTurn(t()) && typeof t().attrs.steerId === "string"
                                            ? (t().attrs.steerId as string)
                                            : ""
                                    }
                                />
                            );
                        if (row.kind === "text")
                            return (
                                <TextRow
                                    node={row.node}
                                    lines={HISTORY_TEXT_FOLD_LINES}
                                    defaultOpen={true}
                                    pin={props.pin}
                                    onToggle={props.onToggle}
                                    md={props.md}
                                />
                            );
                        return (
                            <ProcBar
                                parts={row.parts}
                                turn={t()}
                                open={rowOpen(row.key)}
                                /* **显式**给反值：`pin` 缺省时翻转出来是 `!undefined = true`，
                                   而 4 级这行**默认就是展开** —— 不显式传 force 的话第一次点
                                   毫无变化（要连点两下才收起）。与 TailBox 同一个坑，见 togglePin。 */
                                onToggle={() => props.onToggle(`row:${row.key}`, !rowOpen(row.key))}
                                pin={props.pin}
                                onToggleProc={props.onToggle}
                                onFull={props.onFull}
                            />
                        );
                    }}
                    </For>
                </div>
            </Show>
            {/* ── 结尾槽（**自暴露 · 恒显 · 不受历史折叠影响**，与状态行同级）────────────
                形态由 `tailOf` 一处判：结论 / 结束点 / 现场 / 执行过程。节点按 id 现取
                （直播时它是每帧换引用的流式节点；内容与错误条由 `composeTail` 一处分解）。 */}
            <Show when={tail()}>
                {(tl) => (
                    <Switch>
                        <Match when={tl().kind === "conclusion"}>
                            {/* 结论 = **这一块**（`[data-tail-box=conclusion]`）：缺省开合跟级别
                                （1 级折、2 级起全），**点它折的是它自己**（用户 R6 报的 bug）。 */}
                            <TextRow
                                node={leafById(props.turnId, tl().node.id)}
                                lines={props.conclusionLines}
                                defaultOpen={!plan().conclusionClamped}
                                pin={props.pin}
                                onToggle={props.onToggle}
                                md={props.md}
                                box="conclusion"
                                onResizeLines={props.onResizeLines}
                            />
                        </Match>
                        <Match when={tl().kind === "endleaf"}>
                            {/* `tip` 用 **turn** 算（`endReason` 只在 turn 上）—— `node` 是尾叶子，
                                两者不是一回事（review ##253 RV-5）。 */}
                            <EndLeafBox
                                node={leafById(props.turnId, tl().node.id)}
                                tip={endLeafTip(t())}
                                turn={t()}
                                pin={props.pin}
                                onToggle={props.onToggle}
                                onFull={props.onFull}
                            />
                        </Match>
                        <Match when={true}>
                            <div data-tail-row={tl().kind}>
                                <TailBox
                                    node={leafById(props.turnId, tl().node.id)}
                                    turn={t()}
                                    error={composed()?.error ?? null}
                                    body={composed()?.body ?? null}
                                    pin={props.pin}
                                    onToggle={props.onToggle}
                                    onFull={props.onFull}
                                    md={props.md}
                                    live={tl().kind === "live"}
                                />
                            </div>
                        </Match>
                    </Switch>
                )}
            </Show>
            {/* 结束状态说明（所有级别恒显 = "1 级不变量"）：按 endReason 说清"模型说完了 /
                被步数掐 / 输出截断 / 被中断 / 流断裂"。旧日志无 endReason 时退回 notice 与 interrupted */}
            <Show when={!isLiveTurn() && turnEndNote(t())}>
                <div class="text-body text-warning" data-turn-end-note>
                    ⚠ {turnEndNote(t())}
                </div>
            </Show>
            {/* 降级轮的行内标注（##424 刀 2）：这一轮是从 turns 折出来的文本记录，
                锚点指向的 ops 已经不在了 ⇒ 如实说「原始记录已清理」，不静默空白。 */}
            <Show when={degradedOf(t())?.refDangling}>
                <div class="text-body text-warning/80" data-turn-degraded={degradedOf(t())?.state ?? ""}>
                    ⓘ {DEGRADED_DANGLING_TEXT}
                </div>
            </Show>
            {/* 轮尾：**时刻靠左、纯文本、不可点**（滚屏阅读时左侧最容易误触，那句话也没有可点的东西），
                用量按钮靠右（hover 出汇总卡、点击开明细抽屉）—— 两个状态都存页面级：
                块树每帧重建，组件内 signal 会被清掉（D3 的"点开又自动合上"）。

                直播轮次**一出现助理内容就出这行**（`usagePending`）：main 的 usage patch 要等
                第一步 finish-step 才写，而第一个思考可能长跑几十秒 —— 那段时间轮尾什么都没有，
                这行会"啪"地蹦出来把下面的内容顶开（用户 2026-10-11 口径：第一次动态内容时
                时间和 token 那行就该在）。数字还没到时给占位（见 TurnUsageBar 的 pending）。 */}
            <Show when={t().attrs.usage || usagePending()}>
                <TurnUsageBar
                    turnId={t().id}
                    usage={t().attrs.usage}
                    pending={usagePending()}
                    /* 直播中：状态图标走"进行中"、⚡速度才显示（停下即不显示 —— 静默的旧轮没有"当前速度"） */
                    live={isLiveTurn()}
                    /* 结束原因：状态行那个 ✓/✗/⛔ 的判据（##288 的 endReason；旧日志 null → 不给图标） */
                    end={endReasonOf(t())}
                    /* 本轮统计（步数 · 耗时 · ⚙ n · 💭 n · ❌ n）画在**轮尾**：时刻右边、
                       用量左边（用户 2026-10-11 口径，判据见 turnStatLine） */
                    stat={turnStatLine(t(), counts())}
                    hover={props.usageHover?.id === t().id}
                    onHover={(el) => props.onHoverUsage(t().id, el)}
                    onHoverEnd={props.onHoverEndUsage}
                    onDetail={() => props.onDetailUsage(t().id)}
                />
            </Show>
            {/* 等待助理首个事件：仅本轮生成中且尚无助理内容时显示 */}
            <Show when={isLiveTurn() && !hasAssistantContent(t())}>
                <div class="flex items-center gap-2 text-primary py-0.5">
                    <span class="loading loading-bars loading-sm" aria-label="等待响应" />
                </div>
            </Show>
        </div>
    );
}
