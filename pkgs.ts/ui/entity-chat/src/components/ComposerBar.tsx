// ComposerBar —— 输入框大框**最底下一行**：上下文 · 模型 · 作业。
//
// 用户 2026-11-24：「把上下文、model 和 job 都放到输入框内部大框框的最下面，和其他 agent 类似」，
// 随后在选型（A 方案）里定了这枚作业 chip 的位置。三个 chip 都**不解释自己是什么** ——
// 它们共处一行、各带图标，本身就是「这轮拿什么、用谁、还有什么在跑」三件事的一览。
//
// 这一层属于**壳**（`App.tsx` 渲染、由两个 surface 摆进各自的 composer 底栏）：
// 模型弹窗 / 上下文压缩的状态都在壳里，surface 不该各长一份。

import { Square } from 'lucide-react';
import * as React from 'react';

import { conversationOf } from '../store';
import { ContextPanel } from './ContextPanel';
import { JobsChip } from './JobsChip';
import { ModelChip } from './ModelChip';
import type { Room } from '../model';

export function ComposerBar({ room, onPickModel }: { room: Room; onPickModel: () => void }) {
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <ContextPanel room={room} side="up" />
            <ModelChip value={room.modelKey} onClick={onPickModel} />
            <JobsChip />
            {/* 「全部停止」暂驻在这里（用户 2026-11-24）：房间状态条不再说「谁在跑」，
                但停的能力不能跟着消失 —— 单停在这一轮的底行，全停在这里。 */}
            <StopAll roomId={room.id} />
        </div>
    );
}

/** 有人在跑才出现：没人跑时它只是一枚没用的红按钮 */
function StopAll({ roomId }: { roomId: string }) {
    const conversation = React.useMemo(() => conversationOf(roomId), [roomId]);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    if (!state.running) return null;
    return (
        <button
            onClick={() => conversation.cancel()}
            title="停掉这一轮的全部成员"
            className="ml-auto flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
            <Square className="size-2.5" />
            全部停止
        </button>
    );
}
