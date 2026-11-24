// Menu.tsx —— 「⋮ + 浮层」的小菜单。两处共用：侧栏行尾、房间头 kebab。
//
// 为什么自写：仓库里没有 dropdown 组件（`kit` 只有 confirm / drawer 这些），而这件事
// 不到 70 行 —— 为它引一整套组件库再包一层，比自己写更贵。
// 行为只有两条：点 ⋮ 开合；点菜单外任意处关闭（含 Esc）。

import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';

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
    const box = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!open) return;
        // pointerdown 而不是 click：菜单项自己也是 click，用 click 会先关后触发（顺序不可靠）。
        const onDown = (event: PointerEvent) => {
            if (!box.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div ref={box} className={`relative shrink-0 ${className}`}>
            <button
                onClick={(event) => {
                    // 行本身可点（选中房间）：菜单按钮不该把这一下也传下去
                    event.stopPropagation();
                    setOpen((value) => !value);
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
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-full z-30 mt-1 w-36 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
                >
                    {items.map((item) => (
                        <button
                            key={item.key}
                            role="menuitem"
                            onClick={(event) => {
                                event.stopPropagation();
                                setOpen(false);
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
                </div>
            )}
        </div>
    );
}
