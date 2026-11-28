// ThemePicker.tsx —— 标题栏上的主题选择器：**一套配色 + 明暗**两件事，一个菜单里选。
//
// 主题名来自 shadcn 官方 themes.css（12 套：5 灰阶 + 7 彩），已整份收进
// `@diy-agent/ui-shadcn/themes.css`。切换方式就是给 `<html>` 挂 `theme-xxx`（+ `dark`）：
//   · 不挂 `theme-*` 时走 styles.css 的 :root（本仓自己的基准色）；
//   · 挂上之后由 themes.css 的 `.theme-xxx` 覆盖同一批语义变量 —— 组件一行都不用改。
//
// 为什么放这里而不是 entity-chat：主题是**宿主**的事（同一份组件库可以长成任何样子），
// 而且它要改的是 document.documentElement，属于全局副作用。
//
// 持久化走 localStorage：刷新后还在（用户选完不想每次开机再点一遍）。读失败（隐私模式）就退回默认。

import { Moon, Palette, Sun } from 'lucide-react';
import * as React from 'react';

import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@diy-agent/ui-shadcn';

/** 与 `pkgs.ts/ui/shadcn/src/themes.css` 里的 `.theme-*` 一一对应 */
const THEMES: Array<{ id: string; label: string }> = [
    { id: 'default', label: '默认（本仓基准）' },
    { id: 'neutral', label: 'Neutral' },
    { id: 'zinc', label: 'Zinc' },
    { id: 'slate', label: 'Slate' },
    { id: 'stone', label: 'Stone' },
    { id: 'gray', label: 'Gray' },
    { id: 'red', label: 'Red' },
    { id: 'rose', label: 'Rose' },
    { id: 'orange', label: 'Orange' },
    { id: 'yellow', label: 'Yellow' },
    { id: 'green', label: 'Green' },
    { id: 'blue', label: 'Blue' },
    { id: 'violet', label: 'Violet' },
];

const KEY = 'diy2.theme';

interface Choice {
    theme: string;
    dark: boolean;
}

function read(): Choice {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw !== null) {
            const parsed = JSON.parse(raw) as Partial<Choice>;
            if (typeof parsed.theme === 'string') {
                return { theme: parsed.theme, dark: parsed.dark === true };
            }
        }
    } catch {
        // 隐私模式 / 坏数据：退回默认，不值得为一条偏好把界面拦住
    }
    return { theme: 'default', dark: false };
}

/** 把选择落到 `<html>` 上 —— 全仓唯一改主题 class 的地方 */
function apply(choice: Choice): void {
    const root = document.documentElement;
    for (const theme of THEMES) {
        if (theme.id !== 'default') root.classList.remove(`theme-${theme.id}`);
    }
    if (choice.theme !== 'default') root.classList.add(`theme-${choice.theme}`);
    root.classList.toggle('dark', choice.dark);
}

export function ThemePicker() {
    const [choice, setChoice] = React.useState<Choice>(read);

    // 挂载时应用一次：刷新后 class 不会自己回来
    React.useEffect(() => {
        apply(choice);
        try {
            localStorage.setItem(KEY, JSON.stringify(choice));
        } catch {
            // 存不下就算了，本次会话仍然生效
        }
    }, [choice]);

    const current = THEMES.find((theme) => theme.id === choice.theme);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button variant="ghost" size="icon-xs" title="主题与明暗" aria-label="主题与明暗">
                        <Palette className="size-3.5" />
                    </Button>
                }
            />
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setChoice((prev) => ({ ...prev, dark: !prev.dark }))}>
                    {choice.dark ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                    {choice.dark ? '切到亮色' : '切到暗色'}
                </DropdownMenuItem>
                {THEMES.map((theme) => (
                    <DropdownMenuItem
                        key={theme.id}
                        onClick={() => setChoice((prev) => ({ ...prev, theme: theme.id }))}
                        className={theme.id === choice.theme ? 'font-medium text-foreground' : undefined}
                    >
                        {theme.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
