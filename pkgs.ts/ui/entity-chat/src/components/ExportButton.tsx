// ExportButton.tsx —— 标题栏上的「导出当前对话」：点一下存一份 .md。
//
// 位置：对话区那条标题栏（整页形态由 `App` 画，工作台是 `ConversationAreaBar` 摆进
// `wb-area-bar`）—— 与表面切换 / 房间菜单同一行。选它而不是塞进 kebab 菜单：导出一份
// 对话是「读」操作、且要找得到；菜单里多一项，用户就得先猜它在不在里面。
//
// 取数：**不订阅**会话状态。导出是点击时的一次性动作，订阅只会让标题栏跟着每条
// 消息重渲一遍，而它画的东西一个都不变。
//
// 点下去先 `reload()` 拉一次快照再渲染：刚切进来的房间快照可能还在路上（那时导出的
// 是一份「标题对、内容空」的文件，比没有更糟），而导出语义本来就是「**整个**房间的
// 时间线」—— 交给服务端做完整取数才靠得住，客户端增量状态只用来验证它确实有内容。
//
// 渲染规则全在 `exportMarkdown.ts`（纯函数、可单测）；这里只负责「时间线 → 文件」。

import { buildTimeline } from '@diy-agent/chat-core';
import { Check, Download } from 'lucide-react';
import * as React from 'react';

import { downloadText } from '../download';
import { exportFileName, roomToMarkdown } from '../exportMarkdown';
import type { Room } from '../model';
import { conversationOf, useBots } from '../store';

type Phase = 'idle' | 'done' | 'failed';

const TITLES: Record<Phase, string> = {
    idle: '导出为 Markdown（整个房间的时间线）',
    done: '已导出到下载目录',
    failed: '导出失败',
};

export function ExportButton({
    room,
    className = 'rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground',
    iconClassName = 'size-3.5',
}: {
    room: Room;
    className?: string;
    iconClassName?: string;
}) {
    const bots = useBots();
    const [phase, setPhase] = React.useState<Phase>('idle');
    const timer = React.useRef<number | undefined>(undefined);

    React.useEffect(
        () => () => {
            if (timer.current !== undefined) window.clearTimeout(timer.current);
        },
        [],
    );

    const onExport = React.useCallback(() => {
        const flash = (next: Phase): void => {
            setPhase(next);
            if (timer.current !== undefined) window.clearTimeout(timer.current);
            // 成功提示 1.5 秒（与复制按钮同节奏）；失败留 3 秒，够看清
            timer.current = window.setTimeout(() => setPhase('idle'), next === 'failed' ? 3000 : 1500);
        };
        void (async () => {
            try {
                const conversation = conversationOf(room.id);
                // 失败也 resolve（原因落进 state.error）：拉不到就把手上那份导出去，别整个不动作
                await conversation.reload();
                const state = conversation.get();
                if (state.items.length === 0 && state.error !== undefined) throw new Error(state.error);
                const entries = buildTimeline(state.items, state.deliveries, bots, {
                    speaking: state.speaking,
                    asks: state.asks,
                    answered: state.answered,
                    turns: state.turns,
                });
                const at = Date.now();
                downloadText(exportFileName(room, bots, at), roomToMarkdown({ room, bots, entries, exportedAt: at }));
                flash('done');
            } catch {
                flash('failed');
            }
        })();
    }, [room, bots]);

    return (
        <button type="button" onClick={onExport} title={TITLES[phase]} aria-label={TITLES[phase]} className={className}>
            {phase === 'done' ? <Check className={iconClassName} /> : <Download className={iconClassName} />}
        </button>
    );
}
