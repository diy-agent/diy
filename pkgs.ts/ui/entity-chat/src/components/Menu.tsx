// Menu.tsx —— 「⋮ + 浮层」的小菜单。两处共用：侧栏行尾、房间头 kebab。
//
// 为什么自写：仓库里没有 dropdown 组件（`kit` 只有 confirm / drawer 这些），而这件事
// 不到 100 行 —— 为它引一整套组件库再包一层，比自己写更贵。
// 行为只有两条：点 ⋮ 开合；点菜单外任意处关闭（含 Esc）。
//
// 浮层必须 **portal 到 body + fixed 定位**（2026-11-25 修）：侧栏行在 `overflow-y-auto`
// 的列表里、外面还套一层 `overflow-hidden`，`absolute` 浮层被这两层裁掉 —— 行在末位或
// 列表滚到底时只看得见一条缝，菜单项点不到。`z-30` 对裁剪无效。
// 上下方向按可用空间**翻转**（下方不够就往上弹），左右钳在视口内。

import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

/** 浮层宽度（px）与「离锚点多远」——翻转 / 钳位都靠这两个数 */
const WIDTH = 144;
const GAP = 4;

export interface MenuItem {
    key: string;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
}

export function MenuButton({
    items,
    title = '更多操作',
    className = '',
}: {
    items: MenuItem[];
    title?: string;
    className?: string;
}) {
    const [open, setOpen] = React.useState(false);
    const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
    const box = React.useRef<HTMLDivElement | null>(null);
    const menu = React.useRef<HTMLDivElement | null>(null);
    const close = React.useCallback(() => {
        setOpen(false);
        setAnchor(null);
    }, []);

    React.useEffect(() => {
        if (!open) return;
        // pointerdown 而不是 click：菜单项自己也是 click，用 click 会先关后触发（顺序不可靠）。
        const onDown = (event: PointerEvent) => {
            const target = event.target as Node;
            if (!box.current?.contains(target) && !menu.current?.contains(target)) close();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        // 锚点会随滚动 / 窗口变化跑位 —— 与其追，不如关掉（菜单是一次性动作）
        const onMove = () => close();
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onMove);
        window.addEventListener('scroll', onMove, true);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onMove);
            window.removeEventListener('scroll', onMove, true);
        };
    }, [open, close]);

    const style: React.CSSProperties = React.useMemo(() => {
        if (anchor === null) return {};
        const below = window.innerHeight - anchor.bottom;
        const above = anchor.top;
        // 估算高度：菜单项 24px + 上下 padding；估高了会误翻转，估低了会溢出
        const height = items.length * 26 + 8;
        const top = below >= height + GAP || below >= above ? anchor.bottom + GAP : Math.max(GAP, anchor.top - height - GAP);
        const left = Math.max(GAP, Math.min(anchor.right - WIDTH, window.innerWidth - WIDTH - GAP));
        return { top, left, width: WIDTH };
    }, [anchor, items.length]);

    return (
        <div ref={box} className={`relative shrink-0 ${className}`}>
            <button
                onClick={(event) => {
                    // 行本身可点（选中房间）：菜单按钮不该把这一下也传下去
                    event.stopPropagation();
                    // rect 在这里就取：晚一步 React 已把 currentTarget 置空（updater 在渲染期跑）
                    if (open) {
                        close();
                    } else {
                        setAnchor(event.currentTarget.getBoundingClientRect());
                        setOpen(true);
                    }
                }}
                title={title}
                aria-label={title}
                aria-expanded={open}
                aria-haspopup="menu"
                className={`rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground ${
                    open ? 'bg-muted text-foreground' : ''
                }`}
            >
                <MoreHorizontal className="size-3.5" />
            </button>
            {open && anchor !== null && createPortal(
                <div
                    ref={menu}
                    role="menu"
                    className="fixed z-[1000] overflow-hidden rounded-md border bg-popover py-1 shadow-md"
                    style={style}
                >
                    {items.map((item) => (
                        <button
                            key={item.key}
                            role="menuitem"
                            onClick={(event) => {
                                event.stopPropagation();
                                close();
                                item.onClick();
                            }}
                            className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted ${
                                item.danger === true ? 'text-destructive' : ''
                            }`}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </div>,
                document.body,
            )}
        </div>
    );
}
