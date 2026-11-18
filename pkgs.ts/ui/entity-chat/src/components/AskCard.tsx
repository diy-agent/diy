// AskCard —— 需要用户回答的提问，**渲染在正文里**（触发它的工具行下面）。
//
// 为什么不做成浮层：官方（assistant-ui 的 approval 模型）就是把提问挂在 tool-call
// 那个 part 上、在消息流里就地渲染；浮层会盖住正文，也不跟着对话滚动。
//
// 三种形态：choice（选项，可多选、可带自由输入）/ form（多字段）/ text（单个自由输入）。
//
// **一批可以有好几题**：模型经常要连着定几件相关的事（口径 / 拓扑 / 落地到哪步）。
// 以前一次工具调用只能问一个 ⇒ 三张卡、点三次提交、模型收到三条独立消息。
// 现在一张卡列全部、**一次提交整批**，用户一屏看全、能对比着答。呈现方式四家各有分歧
// （dsh 翻页 / opencode 切 tab / assistant-ui 平铺 / shadcn 一步一题），这里选平铺：
// 卡在消息流里本来就会滚，翻页多一层状态、还会让"我能一起看到"这个好处消失。
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
    // 提交中 / 报错是这一屏的瞬时状态，不用持久化
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    /** 已有结局：只读展示（选项保留，选过的标出来） */
    const done = resolved !== undefined;
    const multi = request.questions.length > 1;
    const unanswered = unansweredOf(request, parsed);
    const ready = isReady(request, parsed);
    /** 提交按钮旁边那句提示：单题沿用原来的具体提示，多题报到题数 */
    const first = request.questions[0];
    const hint = multi
        ? `还有 ${unanswered.length} 题没答（不想定可以点「跳过」）`
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

    const submit = async () => {
        setBusy(true);
        setError(null);
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
                                需要你定 {request.questions.length} 件事
                            </div>
                            <span className="text-[10px] text-muted-foreground">一次提交就行</span>
                        </div>
                    )}
                    {request.note !== undefined && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{request.note}</div>
                    )}

                    <div className={multi ? 'mt-1.5 flex flex-col gap-2' : ''}>
                        {request.questions.map((question, index) => (
                            <QuestionBlock
                                key={question.id}
                                index={index}
                                total={request.questions.length}
                                question={question}
                                draft={questionDraftFor(parsed, question.id)}
                                done={done}
                                answer={answeredOf(resolved?.answer, question.id)}
                                onChange={(next) => draft.update(() => next(parsed))}
                            />
                        ))}
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
                                <button
                                    onClick={() => void submit()}
                                    disabled={!ready || busy}
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
    answer,
    onChange,
}: {
    index: number;
    total: number;
    question: AskQuestion;
    draft: QuestionDraft;
    done: boolean;
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
