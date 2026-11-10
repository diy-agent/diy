// button.tsx —— shadcn Button（base-nova 变体风格：源码引入，视觉由 M3 令牌决定）。
//
// 为什么源码引入：密度（IDE 类界面用 compact）与令牌都由我们改，不跟上游发布节奏走。
// 令牌桥在 react.css 的 `@theme inline`（--color-primary → --md-sys-color-primary …）。

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.js';

const buttonVariants = cva(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
                destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
                outline: 'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
                secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/90',
                ghost: 'hover:bg-accent hover:text-accent-foreground',
                link: 'text-primary underline-offset-4 hover:underline',
            },
            size: {
                default: 'h-9 px-4 py-2 has-[>svg]:px-3',
                sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
                lg: 'h-10 rounded-md px-6',
                icon: 'size-9',
                /** compact：IDE 类界面的缺省档（高度 28px 与 style.ts 的行高一档） */
                xs: 'h-7 gap-1 rounded-md px-2.5 text-xs',
            },
        },
        defaultVariants: { variant: 'default', size: 'default' },
    },
);

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, type = 'button', ...props }: ButtonProps): React.ReactElement {
    return (
        <button
            type={type}
            data-slot="button"
            className={cn(buttonVariants({ variant, size }), className)}
            {...props}
        />
    );
}

export { Button, buttonVariants };
