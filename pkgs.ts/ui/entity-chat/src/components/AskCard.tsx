// AskCard —— 需要用户回答的提问，**渲染在正文里**（触发它的工具行下面）。
//
// 为什么不做成浮层：官方（assistant-ui 的 approval 模型）就是把提问挂在 tool-call
// 那个 part 上、在消息流里就地渲染；浮层会盖住正文，也不跟着对话滚动。
//
// 三种形态：choice（选项，可多选、可带自由输入）/ form（多字段）/ text（单个自由输入）。
//
// **一批可以有好几题**：模型经常要连着定几件相关的事（口径 / 拓扑 / 落地到哪步）。
// 以前一次工具调用只能问一个 ⇒ 三张卡、点三次提交、模型收到三条独立消息。
// 现在一张卡列全部、**一次提交整批**。呈现方式四家各有分歧（dsh 翻页 / opencode 切 tab /
// assistant-ui 平铺 / shadcn 一步一题），这里两者都要：
//   · 多题默认**翻页**（顶部 `1/3` + 进度点，底部 上一题 / 跳过 / 下一题），单选一点自动前进；
//     题干短、选项多时平铺会把卡撑得很长，翻页能把注意力锁在当下这一题。
//   · 一个「全部展开」把手动切回平铺 —— 真正的好处是能对比着答（几件事相互牵制时）。
//   · **已答的卡片永远平铺**：那时用户是回来核对"当时每题选了啥"，翻页只会让他一页页翻。
//
// **提交才校验**：按钮不再灰着（灰按钮不告诉你差哪题），点了没答完就跳到第一个缺口、
// 把那几题标红。可选题（`required: false`）不拦 —— else 用户会被迫在无关的题上点一下。
//
// **答完不消失**：传了 `resolved` 就切成只读，选项照旧列着、用户选过的项标出来。
// 之前的做法是回答一提交整块就没了，时间线上只剩一条「回答提问…」的文字，
// 用户回头看不到当时有哪些选项、自己挑的是哪一个。
//
// **半填的内容不丢**：勾了一半的选项、填了两个字段的表单都存在草稿设施里
// （owner = roomId，field = ask:<askId>，题在里面按 id 分桶），切表面 / 切房间 / 刷新
// 都会回填；提交成功后按值清、提问有了结局（答过 / 失效）也清。逻辑在 askDraft.ts。

import { Check, HelpCircle, MinusCircle } from 'lucide-react';
import * as React from 'react';

import type { AskAnswer, AskQuestion, AskRequest } from '@diy-agent/chat-core';

import {
    answerOf,
    answeredOf,
    askDraftOf,
    draftFieldOf,
    isQuestionReady,
    isQuestionSatisfied,
    isReady,
    missingFieldsOf,
    questionDraftFor,
    setChoice,
    setField,
    setSkipped,
    setText,
    unansweredOf,
    type AskDraft,
    type QuestionDraft,
} from '../askDraft';
import { useDraftValue } from '../drafts';
import { answerAsk, cancelAsk } from '../store';

/** 自动翻页后的交互冷却（毫秒）：见 AskCard 里 advancedAt 的注释 */
const COOL_MS = 250;

/** 已有的结局：答过了，或者失效了 */
export interface ResolvedAsk {
    answer?: AskAnswer;
    cancelled?: boolean;
    reason?: string;
}

export function AskCard({
    roomId,
    request,
    resolved,
}: {
    roomId: string;
    request: AskRequest;
    resolved?: ResolvedAsk;
}) {
    // 输入本身不住在 useState 里：真源是草稿（切表面 = 卸载重建，useState 会整块丢）
    const draftField = draftFieldOf(request.askId);
    const draft = useDraftValue<AskDraft>(roomId, draftField);
    const parsed = askDraftOf(draft.value);
    // 提交中 / 报错 / 翻到第几页 / 是否展开全部：这一屏的瞬时状态，不用持久化
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [page, setPage] = React.useState(0);
    const [expanded, setExpanded] = React.useState(false);
    /** 提交被拦过一次：从那之后没答的必答题才标红（没点过提交就别先报错） */
    const [showMissing, setShowMissing] = React.useState(false);
    /**
     * 上一次「答完自动翻页」的时刻（毫秒）。翻页会换掉整块选项，而手是跟着上一屏走的：
     * 双击 / 惯性点击的第二下会落在新一屏的选项上 —— 用户根本没看那题，却替他把答案选了。
     * 所以翻页后极短的一段时间里直接丢弃点击（视觉上没延迟，只是这一下不算数）。
     */
    const advancedAt = React.useRef(0);

    /** 已有结局：只读展示（选项保留，选过的标出来） */
    const done = resolved !== undefined;
    const multi = request.questions.length > 1;
    const last = request.questions.length - 1;
    const unanswered = unansweredOf(request, parsed);
    const ready = isReady(request, parsed);
    /** 翻页还是平铺：单题 / 已答 / 用户手动展开 → 平铺 */
    const paging = multi && !done && !expanded;
    /** 夹一下：题数不会变，但 `page` 是 React 状态，防御一下越界 */
    const current = Math.min(page, last);
    const shown = paging ? [request.questions[current]!] : request.questions;
    const optionals = request.questions.filter((question) => question.required === false).length;
    /** 提交按钮旁边那句提示：单题沿用原来的具体提示，多题报到题数 */
    const first = request.questions[0];
    const hint = showMissing
        ? `还有 ${unanswered.length} 题没答`
        : multi
          ? ready
              ? '都答完了，一次提交'
              : `还有 ${unanswered.length} 题没答（不想定可以点「跳过」）`
          : first === undefined
            ? '先答完再提交'
            : first.kind === 'form'
              ? `还有 ${missingFieldsOf(first, questionDraftFor(parsed, first.id)).length} 个必填项`
              : first.kind === 'choice'
                ? '先选一个或直接输入'
                : '输入后再提交';

    // 已经有结局（答过 / 失效）：半填的没用了，别让侧栏 ✎ 为它一直亮着
    React.useEffect(() => {
        if (done && draft.value !== undefined) draft.clear();
    }, [done, draftField, draft.value, draft.clear]);

    /**
     * 提交前校验：没答完就不提交，跳到第一个缺口并把它标红（而不是让按钮一直灰着）。
     *
     * 提示文案用 `showMissing` + `unanswered` **派生**，不存进 error：存一份的话，
     * 用户回头补上一题，"还有 2 题没答"会一直挂着不更新。
     */
    const check = (): boolean => {
        if (ready) return true;
        setShowMissing(true);
        const index = request.questions.findIndex((question) => question.id === unanswered[0]?.id);
        if (index >= 0) {
            setPage(index);
            setExpanded(false);
        }
        return false;
    };

    const submit = async () => {
        if (!check()) return;
        setBusy(true);
        setError(null);
        setShowMissing(false);
        // 快照提交的这一版：提交期间用户还能接着改，成功后只清"还是这版"的草稿
        const snapshot = parsed;
        try {
            await answerAsk(roomId, request.askId, answerOf(request, snapshot));
            draft.clearIfValueMatches(snapshot);
        } catch (cause) {
            // 两种失败要分开说：400 是题对不上（刷新重答），404 是这一问已经没了（卡片作废）
            const reason = cause instanceof Error ? cause.message : String(cause);
            setError(reason.includes('HTTP 404') || reason.includes('no such pending ask') ? `${reason}；这个提问已经失效，刷新一下。` : reason);
        } finally {
            setBusy(false);
        }
    };

    const withdraw = async () => {
        setBusy(true);
        setError(null);
        try {
            await cancelAsk(roomId, request.askId);
        } catch (cause) {
            setError(`撤回失败：${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
            setBusy(false);
        }
    };

    const tone = done ? 'border-border bg-muted/30' : 'border-sky-500/25 bg-sky-500/5';

    return (
        <div className={`my-1 rounded-lg border px-3 py-2 ${tone}`}>
            <div className="flex items-start gap-2">
                {resolved?.cancelled === true ? (
                    <MinusCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                ) : done ? (
                    <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                ) : (
                    <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
                )}
                <div className="min-w-0 flex-1">
                    {/*
                        多题时这里只放整批的背景说明，题目在下面逐条列 —— 否则标题区会出现
                        一堆问题挤在一起，而每题自己的 note 又不知道该挂哪儿。
                    */}
                    {multi && (
                        <div className="flex items-baseline gap-2">
                            <div className="text-[12px] font-medium">
                                {done ? `这一批 ${request.questions.length} 题` : `需要你定 ${request.questions.length} 件事`}
                            </div>
                            {!done && optionals > 0 && (
                                <span className="text-[10px] text-muted-foreground">{optionals} 题可选</span>
                            )}
                            {!done && expanded && (
                                <span className="text-[10px] text-muted-foreground">一次提交就行</span>
                            )}
                            {!done && (
                                // 展开是为了「对比着答」，翻页是为了「一次只想一题」—— 两种都要
                                <button
                                    onClick={() => setExpanded((value) => !value)}
                                    className="ml-auto text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                >
                                    {expanded ? '一题一页' : '全部展开'}
                                </button>
                            )}
                        </div>
                    )}
                    {request.note !== undefined && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{request.note}</div>
                    )}

                    {paging && (
                        // 进度：`1/3` + 每条一题的小段（答过的变绿、跳过的变灰），点一段直接跳
                        <div className="mt-1 flex items-center gap-1.5">
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                                {current + 1}/{request.questions.length}
                            </span>
                            <div className="flex flex-1 gap-1">
                                {request.questions.map((question, index) => {
                                    const own = questionDraftFor(parsed, question.id);
                                    const skin =
                                        index === current
                                            ? 'bg-sky-400'
                                            : own.skipped
                                              ? 'bg-muted-foreground/40'
                                              : isQuestionReady(question, own)
                                                ? 'bg-emerald-500/60'
                                                : 'bg-muted';
                                    return (
                                        <button
                                            key={question.id}
                                            onClick={() => setPage(index)}
                                            title={question.question}
                                            aria-label={`第 ${index + 1} 题`}
                                            className={`h-1 flex-1 rounded-full ${skin}`}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className={multi ? 'mt-1.5 flex flex-col gap-2' : ''}>
                        {shown.map((question) => {
                            const index = request.questions.findIndex((candidate) => candidate.id === question.id);
                            return (
                                <QuestionBlock
                                    key={question.id}
                                    index={index}
                                    total={request.questions.length}
                                    question={question}
                                    draft={questionDraftFor(parsed, question.id)}
                                    done={done}
                                    showMissing={showMissing}
                                    answer={answeredOf(resolved?.answer, question.id)}
                                    onChange={(next) => {
                                        // 刚自动翻过页：这一下是上一屏的余波，丢掉（见 advancedAt）
                                        if (Date.now() - advancedAt.current < COOL_MS) return;
                                        // 单选点一下就翻到下一题（dsh 的手感）：要改就点「上一题」。
                                        // 多选 / 允许自由输入的题不自动前进 —— 用户往往还要接着勾 / 接着打字。
                                        //
                                        // 前进的条件是「**这题从没答过** → 现在答了」，不能用 `page + 1`：
                                        // 快速连点 / 浏览器把一次点击派发两遍时，第二次会再 +1，一次点跳两题。
                                        const before = isQuestionReady(question, questionDraftFor(parsed, question.id));
                                        const updated = next(parsed);
                                        const after = isQuestionReady(question, questionDraftFor(updated, question.id));
                                        draft.update(() => updated);
                                        if (
                                            paging &&
                                            !before &&
                                            after &&
                                            question.kind === 'choice' &&
                                            question.multiple !== true &&
                                            question.allowFreeform !== true &&
                                            current < last
                                        ) {
                                            advancedAt.current = Date.now();
                                            setPage(current + 1);
                                        }
                                    }}
                                />
                            );
                        })}
                    </div>

                    <div className="mt-1.5 flex items-center gap-2">
                        {done ? (
                            // 已回答：只留一个状态痕迹，不再给按钮（重复提交只会得到 404）
                            <span
                                className={`text-[11px] ${resolved?.cancelled === true ? 'text-muted-foreground' : 'text-emerald-500'}`}
                            >
                                {resolved?.cancelled === true
                                    ? `已失效${resolved.reason === undefined ? '' : `：${resolved.reason}`}`
                                    : '已回答，模型的下一轮会接着做'}
                            </span>
                        ) : (
                            <>
                                {paging && (
                                    <button
                                        onClick={() => setPage(Math.max(0, current - 1))}
                                        disabled={current === 0 || busy}
                                        className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-40"
                                    >
                                        上一题
                                    </button>
                                )}
                                {/*
                                    翻页模式下，非最后一页由「下一题」推进、最后一页才给提交；
                                    平铺（单题 / 已展开）直接提交。两种都是**一次提交整批**。
                                */}
                                {(!paging || current === last) && (
                                    <button
                                        onClick={() => void submit()}
                                        disabled={busy}
                                        className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] hover:bg-sky-500/20 disabled:opacity-50"
                                    >
                                        {busy
                                            ? '提交中…'
                                            : multi
                                              ? `提交（${request.questions.length} 题）`
                                              : request.questions[0]?.kind === 'choice'
                                                ? '就这样'
                                                : '提交'}
                                    </button>
                                )}
                                {paging && current < last && (
                                    <button
                                        onClick={() => setPage(current + 1)}
                                        disabled={busy}
                                        className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                                    >
                                        下一题
                                    </button>
                                )}
                                {/*
                                    不是「取消本轮」：那条停的是「正在生成」，而 ask 不阻塞、
                                    点它时这一轮早就跑完了 —— 拿它当「不要这个提问」用，
                                    只会什么都不发生（服务器对 ask 也没有单条撤回的能力，以前）。
                                    现在只做一件事：把这一问作废，卡片收尾，不触发任何运行。
                                */}
                                <button
                                    onClick={() => void withdraw()}
                                    disabled={busy}
                                    className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                                >
                                    {multi ? '撤掉这一批' : '撤掉这一问'}
                                </button>
                                {!ready && error === null && (
                                    <span className="text-[10px] text-muted-foreground">{hint}</span>
                                )}
                            </>
                        )}
                    </div>
                    {error !== null && <p className="mt-1 text-[10px] text-destructive">{error}</p>}
                    {error === null && showMissing && unanswered.length > 0 && (
                        <p className="mt-1 text-[10px] text-destructive">
                            还有 {unanswered.length} 题没答（题目标了「必答」；不想定就点「跳过」）
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

/** 一题：标题 + 输入（或只读答案）+ 跳过 */
function QuestionBlock({
    index,
    total,
    question,
    draft,
    done,
    showMissing,
    answer,
    onChange,
}: {
    index: number;
    total: number;
    question: AskQuestion;
    draft: QuestionDraft;
    done: boolean;
    /** 提交被拦过一次：必答而没答的题标红 */
    showMissing: boolean;
    answer: { values?: string[]; fields?: Record<string, string>; text?: string; skipped?: boolean } | undefined;
    /** 传一个「旧草稿 → 新草稿」的函数：输入控件只管改自己这一题 */
    onChange: (next: (draft: AskDraft) => AskDraft) => void;
}) {
    const multiple = question.multiple === true;
    const answeredValues = answer?.values ?? [];
    const answeredFields = answer?.fields ?? {};
    const answeredText = answer?.text ?? '';
    const skipped = done ? answer?.skipped === true : draft.skipped;
    const missing = missingFieldsOf(question, draft);

    return (
        <div className={total > 1 ? 'rounded border border-border/60 px-2 py-1.5' : ''}>
            <div className="flex items-start gap-2">
                {total > 1 && (
                    <span className="mt-0.5 shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                        {index + 1}/{total}
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <div className={`text-[12px] ${done && skipped ? 'text-muted-foreground line-through' : 'font-medium'}`}>
                        {question.question}
                        {question.required === false && (
                            <span className="ml-1 text-[10px] font-normal text-muted-foreground">（可选）</span>
                        )}
                        {showMissing && !done && !isQuestionSatisfied(question, draft) && (
                            <span className="ml-1 text-[10px] font-normal text-destructive">必答</span>
                        )}
                    </div>
                    {question.note !== undefined && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{question.note}</div>
                    )}

                    {skipped ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                            （跳过）
                            {!done && (
                                <button
                                    onClick={() => onChange((previous) => setSkipped(previous, question.id, false))}
                                    className="ml-1 underline underline-offset-2 hover:text-foreground"
                                >
                                    撤销
                                </button>
                            )}
                        </div>
                    ) : (
                        <>
                            {question.kind === 'form' && (
                                <div className="mt-1.5 flex flex-col gap-1.5">
                                    {(question.fields ?? []).map((field) => (
                                        <label key={field.name} className="flex flex-col gap-0.5 text-[12px]">
                                            <span className="text-muted-foreground">
                                                {field.label}
                                                {field.required === true && (
                                                    <span className="ml-0.5 text-destructive">*</span>
                                                )}
                                            </span>
                                            {field.type === 'textarea' ? (
                                                <textarea
                                                    readOnly={done}
                                                    disabled={done}
                                                    value={
                                                        done ? (answeredFields[field.name] ?? '—') : (draft.fields[field.name] ?? '')
                                                    }
                                                    onChange={(event) =>
                                                        onChange((previous) =>
                                                            setField(previous, question.id, field.name, event.target.value),
                                                        )
                                                    }
                                                    placeholder={field.placeholder}
                                                    rows={2}
                                                    className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                                />
                                            ) : (
                                                <input
                                                    type={field.type === 'number' ? 'number' : 'text'}
                                                    readOnly={done}
                                                    disabled={done}
                                                    value={
                                                        done ? (answeredFields[field.name] ?? '—') : (draft.fields[field.name] ?? '')
                                                    }
                                                    onChange={(event) =>
                                                        onChange((previous) =>
                                                            setField(previous, question.id, field.name, event.target.value),
                                                        )
                                                    }
                                                    placeholder={field.placeholder}
                                                    className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                                />
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}

                            {question.kind === 'choice' && (
                                <div className="mt-1.5 flex flex-col gap-1">
                                    {(question.options ?? []).map((option) => {
                                        const checked = (done ? answeredValues : draft.selected).includes(option.value);
                                        // 已答的卡片：选中的留着高亮 + 勾，没选中的压暗，一眼看出当时挑了哪个
                                        const skin = checked
                                            ? done
                                                ? 'border-emerald-500/40 bg-emerald-500/10'
                                                : 'border-sky-500/40 bg-sky-500/10'
                                            : done
                                              ? 'opacity-55'
                                              : '';
                                        return (
                                            <label
                                                key={option.value}
                                                className={`flex items-start gap-2 rounded border px-2 py-1 text-[12px] ${
                                                    done ? '' : 'cursor-pointer hover:bg-muted'
                                                } ${skin}`}
                                            >
                                                <input
                                                    type={multiple ? 'checkbox' : 'radio'}
                                                    // 同名 radio 会把整批的题连成一组（只能选一个），必须按题分组
                                                    name={`${question.id}`}
                                                    checked={checked}
                                                    disabled={done}
                                                    onChange={() =>
                                                        onChange((previous) =>
                                                            setChoice(previous, question.id, option.value, multiple),
                                                        )
                                                    }
                                                    className="mt-0.5"
                                                />
                                                <span>
                                                    <span className="font-medium">{option.label}</span>
                                                    {option.description !== undefined && (
                                                        <span className="ml-2 text-muted-foreground">{option.description}</span>
                                                    )}
                                                </span>
                                            </label>
                                        );
                                    })}
                                    {question.allowFreeform === true &&
                                        (done ? (
                                            answeredText.trim() === '' ? null : (
                                                <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[12px]">
                                                    其他：{answeredText}
                                                </div>
                                            )
                                        ) : (
                                            <input
                                                value={draft.text}
                                                onChange={(event) =>
                                                    onChange((previous) => setText(previous, question.id, event.target.value))
                                                }
                                                placeholder="其他（直接输入）"
                                                className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                            />
                                        ))}
                                </div>
                            )}

                            {question.kind === 'text' &&
                                (done ? (
                                    <div className="mt-1.5 rounded border bg-background px-2 py-1 text-[12px] whitespace-pre-wrap">
                                        {answeredText.trim() === '' ? '（空）' : answeredText}
                                    </div>
                                ) : (
                                    <textarea
                                        value={draft.text}
                                        onChange={(event) =>
                                            onChange((previous) => setText(previous, question.id, event.target.value))
                                        }
                                        placeholder="输入你的回答…"
                                        rows={2}
                                        className="mt-1.5 w-full rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                    />
                                ))}
                        </>
                    )}

                    {!done && total > 1 && !skipped && (
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            {missing.length > 0 && <span>还有 {missing.length} 个必填项</span>}
                            {isQuestionReady(question, draft) && <span className="text-emerald-500">已答</span>}
                            {question.required === false && !isQuestionReady(question, draft) && <span>可留空</span>}
                            {/*
                                显式跳过而不是"留空就好"：模型必须能区分「他不想定」和「他漏了」。
                                dsh 用 {selected:[]} 占位、shadcn 用 status:'skipped'，两家独立收敛。
                            */}
                            <button
                                onClick={() => onChange((previous) => setSkipped(previous, question.id, true))}
                                className="underline underline-offset-2 hover:text-foreground"
                            >
                                跳过
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
