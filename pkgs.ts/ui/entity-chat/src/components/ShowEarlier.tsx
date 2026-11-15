// ShowEarlier —— "显示更早的 N 条"（长会话分页窗口的入口）。

export function ShowEarlier({ hidden, onClick }: { hidden: number; onClick: () => void }) {
    if (hidden <= 0) return null;
    return (
        <div className="flex justify-center py-2">
            <button onClick={onClick} className="rounded-full border px-3 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
                显示更早的 {hidden} 条
            </button>
        </div>
    );
}
