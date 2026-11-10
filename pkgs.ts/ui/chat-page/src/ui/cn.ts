// cn.ts —— shadcn 的 class 合并入口（clsx 拼条件类 + tailwind-merge 消冲突工具类）。
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
