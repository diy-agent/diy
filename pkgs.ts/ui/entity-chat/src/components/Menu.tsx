// Menu.tsx —— 「⋮ + 下拉」的小菜单。两处共用：侧栏行尾、房间头 kebab。
//
// 2026-11-26 换成官方 `DropdownMenu`（Base UI 的 Menu）。之前是自写 139 行：
// portal 到 body + fixed 定位 + 手算上下翻转 + 左右钳位 + 外点关闭 + Esc + 滚动即关。
// 那套能跑，但每一件都是官方组件本来就有的，而且有几处是自己补出来的：
//   · 翻转/钳位是估出来的（`items.length * 26 + 8` 估高，估早了会误翻转）；
//   · 滚动一律关闭（官方是跟着重定位，不会把菜单收掉）；
//   · 键盘只有 Esc（官方有方向键/Home/End/Tab 循环与焦点还原）。
// 换成组件后这些都不用管，只留一件事：**行本身可点**，所以点击不能冒泡到行上。
//
// 历史备注（保留，将来若有人想换回手写版）：浮层必须 portal 出 `overflow-y-auto` 的
// 列表与 `overflow-hidden` 的外层，否则行在末位时菜单被裁成一条缝。

import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';

import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@diy-agent/ui-shadcn';

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
    return (
        // 侧栏整行是个可点区域：菜单里的任何一下都不该同时选中房间
        <div className={`shrink-0 ${className}`} onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            title={title}
                            aria-label={title}
                            className="text-muted-foreground"
                        />
                    }
                >
                    <MoreHorizontal className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                    {items.map((item) => (
                        <DropdownMenuItem
                            key={item.key}
                            variant={item.danger === true ? 'destructive' : 'default'}
                            onClick={() => item.onClick()}
                        >
                            {item.icon}
                            {item.label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
