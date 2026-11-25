// UnitTextView —— 任务页「文本」tab：模型实际读到的 `units` 节**原文**。
//
// 为什么要有这一页：树和图都是「同一份数据的两种画法」，而人真正要核对的是
// 「模型到底读到了什么」—— 此前只能靠系统提示词的转述或 demo 推断。这里显示的不是
// 复刻：服务端 `unitsContextText()` 与上下文注入同一份代码（`unitsContextValue()` + `toYaml`），
// 所以逐字节就是注入的那一段。
//
// 「分解」和这里是两个 tab、**不是两份文本**：两边都读 `units.list` 的同一份树，模型读的
// 也是同一节 `units`。所以这里只有一份原文，不需要「在树 / 图之间切换文本」的开关；
// 页头点明这件事，省得以后有人再加一个假的切换。
import { roomTitle, type Room } from '../model';
import { useUnitText } from '../useUnitText';

/** 与服务端同一口径的粗略估算（中文 + 结构下约 0.78 tok / 字符，见 ContextPanel） */
const TOKENS_PER_CHAR = 0.78;

export function UnitTextView({ room }: { room: Room }) {
    const { view, error } = useUnitText(room.id);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-muted-foreground">只有任务有内部拆分。</div>;
    }
    if (view === null) {
        return <div className="p-3 text-xs text-muted-foreground">{error ?? '读取中…'}</div>;
    }

    const tokens = Math.round(view.chars * TOKENS_PER_CHAR);
    return (
        <div className="flex h-full flex-col gap-2 overflow-hidden p-3 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{roomTitle(room)}</span>
                <span>{view.chars} 字 · ≈{tokens} tok</span>
                {view.mode === 'full' && <span>{view.treeLines} 行树</span>}
                {view.mode === 'summary' && (
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-600">
                        已退化成摘要（树太大）
                    </span>
                )}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
                这是每轮注入 system 的 <code className="text-[10px]">units</code> 节原文。
                「分解」那棵树画的就是<b>这份数据</b>，模型读的也是<b>同一段文本</b> —— 不是两份。
            </p>
            {view.text === '' ? (
                <div className="text-muted-foreground">还没有拆分：这一节不注入（整段缺席，不是空节）。</div>
            ) : (
                <pre className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground">
                    {view.text}
                </pre>
            )}
            {error !== null && <div className="text-[11px] text-red-500">{error}</div>}
        </div>
    );
}
