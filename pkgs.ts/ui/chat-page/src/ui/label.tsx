// label.tsx —— shadcn Label（源码引入；不引 Radix Label，原生 <label> 已够用）。

import * as React from 'react';
import { cn } from './cn.js';

function Label({ className, ...props }: React.ComponentProps<'label'>): React.ReactElement {
    return (
        <label
            data-slot="label"
            className={cn('flex select-none items-center gap-2 text-sm font-medium leading-none', className)}
            {...props}
        />
    );
}

export { Label };
