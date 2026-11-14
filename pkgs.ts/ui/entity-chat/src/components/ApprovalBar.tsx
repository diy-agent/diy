// ApprovalBar —— 工具审批条：模型想写文件 / 执行命令时，停在消息区上方等人点头。
//
// 放在壳层（不是 surface 里），两种表面共用同一份行为；审批状态来自 ConversationStore。

import { Check, ShieldAlert, X } from 'lucide-react';
import * as React from 'react';

import { conversationOf, decideApproval } from '../store';

function preview(args: unknown): string {
    if (args === undefined || args === null) return '';
    try {
        const text = JSON.stringify(args);
        return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    } catch {
        return String(args);
    }
}

export function ApprovalBar({ roomId }: { roomId: string }) {
    const conversation = conversationOf(roomId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    const [busy, setBusy] = React.useState<string | null>(null);

    if (state.approvals.length === 0) return null;

    const decide = async (approvalId: string, approved: boolean) => {
        setBusy(approvalId);
        await decideApproval(roomId, approvalId, approved);
        setBusy(null);
    };

    return (
        <div className="border-b bg-amber-500/10 px-4 py-2">
            {state.approvals.map((request) => (
                <div key={request.approvalId} className="flex flex-wrap items-center gap-2 py-0.5 text-xs">
                    <ShieldAlert className="size-3.5 text-amber-500" />
                    <span className="font-medium">需要批准</span>
                    <span className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px]">{request.toolName}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{preview(request.args)}</span>
                    <button
                        onClick={() => void decide(request.approvalId, true)}
                        disabled={busy === request.approvalId}
                        className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                        <Check className="size-3" />
                        允许
                    </button>
                    <button
                        onClick={() => void decide(request.approvalId, false)}
                        disabled={busy === request.approvalId}
                        className="flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                    >
                        <X className="size-3" />
                        拒绝
                    </button>
                </div>
            ))}
        </div>
    );
}
