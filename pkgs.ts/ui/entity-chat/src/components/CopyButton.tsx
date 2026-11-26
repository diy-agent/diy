// CopyButton.tsx —— 「复制这段正文」+ 1.5 秒的「已复制」反馈。
//
// 为什么抽成共用件：两面都该能复制一条回复（这是聊天界面最常被用的一次点击），
// 而 assistant-ui 面曾经用它的 ActionBarPrimitive.Copy 白拿了这个能力 —— 那一面删掉后
// 倘若不补，用户会发现「换了表面就复制不了」。逻辑只有十来行，样式由调用方给。
//
// 代码块自己的复制按钮在 Markdown.tsx 里（粒度不同：那个复制一个 code fence）。

import { Check, Copy } from 'lucide-react';
import * as React from 'react';

import { Button } from '@diy-agent/ui-shadcn';

export function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = React.useState(false);
    const timer = React.useRef<number | undefined>(undefined);
    React.useEffect(
        () => () => {
            if (timer.current !== undefined) window.clearTimeout(timer.current);
        },
        [],
    );
    const copy = React.useCallback((text: string) => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        if (timer.current !== undefined) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
    }, []);
    return { copied, copy };
}

export function CopyButton({
    text,
    className,
    iconClassName = 'size-3',
    title = '复制这段回复',
}: {
    text: string;
    className?: string;
    iconClassName?: string;
    title?: string;
}) {
    const { copied, copy } = useCopyFeedback();
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => copy(text)}
            title={copied ? '已复制' : title}
            aria-label={copied ? '已复制' : title}
            className={className}
        >
            {copied ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
        </Button>
    );
}
