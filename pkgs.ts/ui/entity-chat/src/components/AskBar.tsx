// AskBar —— 模型需要你做决定时，置顶显示选项 / 表单。
//
// 为什么不做成消息里的一句话：正文提问会被大段输出淹掉，用户常常没意识到"卡在等我"。
// 这里固定在消息区上方，答完才消失。壳层组件，两种 surface 共用。

import { HelpCircle } from 'lucide-react';
import * as React from 'react';

import type { AskRequest } from '@diy-agent/chat-core';

import { answerAsk, conversationOf } from '../store';

function ChoiceBody({
    request,
    selected,
    toggle,
}: {
    request: AskRequest;
    selected: string[];
    toggle: (value: string) => void;
}) {
    const multiple = request.multiple === true;
    return (
        <div className="mt-1 flex flex-col gap-1">
            {(request.options ?? []).map((option) => {
                const checked = selected.includes(option.value);
                return (
                    <label
                        key={option.value}
                        className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1 text-[12px] hover:bg-muted ${
                            checked ? 'border-primary/50 bg-primary/5' : ''
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
        </div>
    );
}

function FormBody({
    request,
    fields,
    setField,
}: {
    request: AskRequest;
    fields: Record<string, string>;
    setField: (name: string, value: string) => void;
}) {
    return (
        <div className="mt-1 flex flex-col gap-1.5">
            {(request.fields ?? []).map((field) => (
                <label key={field.name} className="flex flex-col gap-0.5 text-[12px]">
                    <span className="text-muted-foreground">
                        {field.label}
                        {field.required === true && <span className="ml-0.5 text-destructive">*</span>}
                    </span>
                    {field.type === 'textarea' ? (
                        <textarea
                            value={fields[field.name] ?? ''}
                            onChange={(event) => setField(field.name, event.target.value)}
                            placeholder={field.placeholder}
                            rows={2}
                            className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                        />
                    ) : (
                        <input
                            type={field.type === 'number' ? 'number' : 'text'}
                            value={fields[field.name] ?? ''}
                            onChange={(event) => setField(field.name, event.target.value)}
                            placeholder={field.placeholder}
                            className="rounded border bg-background px-2 py-1 text-[12px] outline-none"
                        />
                    )}
                </label>
            ))}
        </div>
    );
}

function AskItem({ roomId, request }: { roomId: string; request: AskRequest }) {
    const [selected, setSelected] = React.useState<string[]>([]);
    const [fields, setFields] = React.useState<Record<string, string>>({});
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const toggle = (value: string) => {
        if (request.multiple === true) {
            setSelected((current) => (current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]));
        } else {
            setSelected([value]);
        }
    };

    const missing = (request.fields ?? []).filter(
        (field) => field.required === true && (fields[field.name] ?? '').trim() === '',
    );
    const ready = request.kind === 'form' ? missing.length === 0 : selected.length > 0;

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await answerAsk(roomId, request.askId, request.kind === 'form' ? { fields } : { values: selected });
            // 成功后卡片由 SSE 的 ask.answered 收掉
        } catch (cause) {
            // 404（run 已结束 / 服务重启）或网络失败：不能静默，否则用户以为点了没反应
            setError(`${cause instanceof Error ? cause.message : String(cause)}；可以「取消本轮」重新发消息。`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="border-b bg-sky-500/10 px-4 py-2">
            <div className="flex items-start gap-2 text-xs">
                <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
                <div className="min-w-0 flex-1">
                    <div className="font-medium">{request.question}</div>
                    {request.note !== undefined && <div className="mt-0.5 text-[11px] text-muted-foreground">{request.note}</div>}
                    {request.kind === 'form' ? (
                        <FormBody request={request} fields={fields} setField={(name, value) => setFields((current) => ({ ...current, [name]: value }))} />
                    ) : (
                        <ChoiceBody request={request} selected={selected} toggle={toggle} />
                    )}
                    <div className="mt-1.5 flex items-center gap-2">
                        <button
                            onClick={() => void submit()}
                            disabled={!ready || busy}
                            className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] hover:bg-sky-500/20 disabled:opacity-50"
                        >
                            {busy ? '提交中…' : request.kind === 'form' ? '提交' : '就这样'}
                        </button>
                        <button
                            onClick={() => conversationOf(roomId).cancel()}
                            className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                        >
                            取消本轮
                        </button>
                        {!ready && error === null && (
                            <span className="text-[10px] text-muted-foreground">
                                {request.kind === 'form' ? `还有 ${missing.length} 个必填项` : '先选一个'}
                            </span>
                        )}
                    </div>
                    {error !== null && <p className="mt-1 text-[10px] text-destructive">{error}</p>}
                </div>
            </div>
        </div>
    );
}

export function AskBar({ roomId }: { roomId: string }) {
    const conversation = conversationOf(roomId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    if (state.asks.length === 0) return null;

    return (
        <div>
            {state.asks.map((request) => (
                <AskItem key={request.askId} roomId={roomId} request={request} />
            ))}
        </div>
    );
}
