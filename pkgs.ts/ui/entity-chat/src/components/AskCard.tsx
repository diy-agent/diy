// AskCard —— 需要用户回答的提问，**渲染在正文里**（触发它的工具行下面）。
//
// 为什么不做成浮层：官方（assistant-ui 的 approval 模型）就是把提问挂在 tool-call
// 那个 part 上、在消息流里就地渲染；浮层会盖住正文，也不跟着对话滚动。
//
// 三种形态：choice（选项，可多选、可带自由输入）/ form（多字段）/ text（单个自由输入）。
//
// **答完不消失**：传了 `resolved` 就切成只读，选项照旧列着、用户选过的项标出来。
// 之前的做法是回答一提交整块就没了，时间线上只剩一条「回答提问…」的文字，
// 用户回头看不到当时有哪些选项、自己挑的是哪一个。

import { Check, HelpCircle, MinusCircle } from 'lucide-react';
import * as React from 'react';

import type { AskAnswer, AskRequest } from '@diy-agent/chat-core';

import { answerAsk, conversationOf } from '../store';

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
    const [selected, setSelected] = React.useState<string[]>([]);
    const [fields, setFields] = React.useState<Record<string, string>>({});
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const multiple = request.multiple === true;
    /** 已有结局：只读展示（选项保留，选过的标出来） */
    const done = resolved !== undefined;
    const answeredValues = resolved?.answer?.values ?? [];
    const answeredFields = resolved?.answer?.fields ?? {};
    const answeredText = resolved?.answer?.text ?? '';
    const toggle = (value: string) => {
        if (multiple) {
            setSelected((current) =>
                current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
            );
        } else {
            setSelected([value]);
        }
    };

    const missingFields = (request.fields ?? []).filter(
        (field) => field.required === true && (fields[field.name] ?? '').trim() === '',
    );
    const ready =
        request.kind === 'form'
            ? missingFields.length === 0
            : request.kind === 'text'
              ? text.trim() !== ''
              : selected.length > 0 || text.trim() !== '';

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const answer =
                request.kind === 'form'
                    ? { fields, ...(text.trim() === '' ? {} : { text: text.trim() }) }
                    : request.kind === 'text'
                      ? { text: text.trim() }
                      : { values: selected, ...(text.trim() === '' ? {} : { text: text.trim() }) };
            await answerAsk(roomId, request.askId, answer);
        } catch (cause) {
            // 常见原因：这个提问已经过期（容器重开过 / 已答过），卡片是旧的
            setError(`${cause instanceof Error ? cause.message : String(cause)}；这个提问可能已经失效，刷新一下再试。`);
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
                    <div className="text-[12px] font-medium">{request.question}</div>
                    {request.note !== undefined && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{request.note}</div>
                    )}

                    {request.kind === 'form' && (
                        <div className="mt-1.5 flex flex-col gap-1.5">
                            {(request.fields ?? []).map((field) => (
                                <label key={field.name} className="flex flex-col gap-0.5 text-[12px]">
                                    <span className="text-muted-foreground">
                                        {field.label}
                                        {field.required === true && <span className="ml-0.5 text-destructive">*</span>}
                                    </span>
                                    {field.type === 'textarea' ? (
                                        <textarea
                                            readOnly={done}
                                            disabled={done}
                                            value={done ? (answeredFields[field.name] ?? '—') : (fields[field.name] ?? '')}
                                            onChange={(event) =>
                                                setFields((current) => ({
                                                    ...current,
                                                    [field.name]: event.target.value,
                                                }))
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
                                            value={done ? (answeredFields[field.name] ?? '—') : (fields[field.name] ?? '')}
                                            onChange={(event) =>
                                                setFields((current) => ({
                                                    ...current,
                                                    [field.name]: event.target.value,
                                                }))
                                            }
                                            placeholder={field.placeholder}
                                            className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                        />
                                    )}
                                </label>
                            ))}
                        </div>
                    )}

                    {request.kind === 'choice' && (
                        <div className="mt-1.5 flex flex-col gap-1">
                            {(request.options ?? []).map((option) => {
                                const checked = (done ? answeredValues : selected).includes(option.value);
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
                                            name={request.askId}
                                            checked={checked}
                                            disabled={done}
                                            onChange={() => toggle(option.value)}
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
                            {request.allowFreeform === true &&
                                (done ? (
                                    answeredText.trim() === '' ? null : (
                                        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[12px]">
                                            其他：{answeredText}
                                        </div>
                                    )
                                ) : (
                                    <input
                                        value={text}
                                        onChange={(event) => setText(event.target.value)}
                                        placeholder="其他（直接输入）"
                                        className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                    />
                                ))}
                        </div>
                    )}

                    {request.kind === 'text' &&
                        (done ? (
                            <div className="mt-1.5 rounded border bg-background px-2 py-1 text-[12px] whitespace-pre-wrap">
                                {answeredText.trim() === '' ? '（空）' : answeredText}
                            </div>
                        ) : (
                            <textarea
                                value={text}
                                onChange={(event) => setText(event.target.value)}
                                placeholder="输入你的回答…"
                                rows={2}
                                className="mt-1.5 w-full rounded border bg-background px-2 py-1 text-[12px] outline-none"
                            />
                        ))}

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
                                    {busy ? '提交中…' : request.kind === 'choice' ? '就这样' : '提交'}
                                </button>
                                <button
                                    onClick={() => conversationOf(roomId).cancel()}
                                    className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                                >
                                    取消本轮
                                </button>
                                {!ready && error === null && (
                                    <span className="text-[10px] text-muted-foreground">
                                        {request.kind === 'form'
                                            ? `还有 ${missingFields.length} 个必填项`
                                            : request.kind === 'choice'
                                              ? '先选一个或直接输入'
                                              : '输入后再提交'}
                                    </span>
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
