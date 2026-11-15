// AskCard —— 需要用户回答的提问，**渲染在正文里**（触发它的工具行下面）。
//
// 为什么不做成浮层：官方（assistant-ui 的 approval 模型）就是把提问挂在 tool-call
// 那个 part 上、在消息流里就地渲染；浮层会盖住正文，也不跟着对话滚动。
//
// 三种形态：choice（选项，可多选、可带自由输入）/ form（多字段）/ text（单个自由输入）。

import { HelpCircle } from 'lucide-react';
import * as React from 'react';

import type { AskRequest } from '@diy-agent/chat-core';

import { answerAsk, conversationOf } from '../store';

export function AskCard({ roomId, request }: { roomId: string; request: AskRequest }) {
    const [selected, setSelected] = React.useState<string[]>([]);
    const [fields, setFields] = React.useState<Record<string, string>>({});
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const multiple = request.multiple === true;
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
            setError(`${cause instanceof Error ? cause.message : String(cause)}；可以「取消本轮」重新发消息。`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="my-1 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2">
            <div className="flex items-start gap-2">
                <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
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
                                            value={fields[field.name] ?? ''}
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
                                            value={fields[field.name] ?? ''}
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
                                const checked = selected.includes(option.value);
                                return (
                                    <label
                                        key={option.value}
                                        className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1 text-[12px] hover:bg-muted ${
                                            checked ? 'border-sky-500/40 bg-sky-500/10' : ''
                                        }`}
                                    >
                                        <input
                                            type={multiple ? 'checkbox' : 'radio'}
                                            name={request.askId}
                                            checked={checked}
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
                            {request.allowFreeform === true && (
                                <input
                                    value={text}
                                    onChange={(event) => setText(event.target.value)}
                                    placeholder="其他（直接输入）"
                                    className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                                />
                            )}
                        </div>
                    )}

                    {request.kind === 'text' && (
                        <textarea
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            placeholder="输入你的回答…"
                            rows={2}
                            className="mt-1.5 w-full rounded border bg-background px-2 py-1 text-[12px] outline-none"
                        />
                    )}

                    <div className="mt-1.5 flex items-center gap-2">
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
                    </div>
                    {error !== null && <p className="mt-1 text-[10px] text-destructive">{error}</p>}
                </div>
            </div>
        </div>
    );
}
