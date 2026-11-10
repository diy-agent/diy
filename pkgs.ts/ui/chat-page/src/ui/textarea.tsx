// textarea.tsx —— shadcn Textarea（源码引入）。

import * as React from 'react';
import { cn } from './cn.js';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.ReactElement {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                'flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow]',
                'placeholder:text-muted-foreground field-sizing-content',
                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
                'disabled:cursor-not-allowed disabled:opacity-50',
                className,
            )}
            {...props}
        />
    );
}

export { Textarea };
