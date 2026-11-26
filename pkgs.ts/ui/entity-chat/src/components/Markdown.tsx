// Markdown —— 中性的 markdown 渲染（react-markdown + gfm），不依赖任何 UI 库。
//
// 为什么自己写：Astryx 自带的 Markdown 绑在它的设计系统上，而 shadcn 面是全裸 Tailwind、
// 不该为一个 markdown 去引聊天框架。这里只做"文本 → HTML"这一件事，两面共用。

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { highlightCode, languageOf } from './highlight';
import { Button } from '@diy-agent/ui-shadcn';

export const Markdown = React.memo(function Markdown({
    text,
    onLinkClick,
}: {
    text: string;
    /** 点击链接时额外处理（桌面端开真正的浏览器窗口）；返回 false = 已拦下默认跳转 */
    onLinkClick?: (href: string, event: React.MouseEvent<HTMLAnchorElement>) => false | void;
}) {
    return (
        <div className="text-sm leading-relaxed break-words">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ children }) => <p className="my-1.5">{children}</p>,
                    h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-[17px] font-semibold">{children}</h1>,
                    h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[15px] font-semibold">{children}</h2>,
                    h3: ({ children }) => <h3 className="mt-2 mb-1 text-[14px] font-semibold">{children}</h3>,
                    ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
                    ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
                    li: ({ children }) => <li className="my-0.5">{children}</li>,
                    a: ({ children, href }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 underline underline-offset-2"
                            onClick={
                                onLinkClick === undefined
                                    ? undefined
                                    : (event) => {
                                          onLinkClick(href ?? '', event);
                                      }
                            }
                        >
                            {children}
                        </a>
                    ),
                    code: ({ className, children }) => {
                        const language = languageOf(className);
                        if (language === undefined) {
                            return (
                                <code className="rounded bg-muted/70 px-1 py-0.5 font-mono text-xs">{children}</code>
                            );
                        }
                        const code = String(children ?? '').replace(/\n$/, '');
                        return (
                            <div className="my-2 overflow-hidden rounded-md border border-border/60">
                                <div className="flex items-center justify-between bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                                    <span className="lowercase">{language}</span>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        onClick={() => void navigator.clipboard?.writeText(code)}
                                        className="h-auto px-1"
                                    >
                                        复制
                                    </Button>
                                </div>
                                <pre className="overflow-x-auto p-2.5 text-xs leading-relaxed">
                                    <code
                                        className="hljs bg-transparent p-0"
                                        dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
                                    />
                                </pre>
                            </div>
                        );
                    },
                    pre: ({ children }) => <>{children}</>,
                    blockquote: ({ children }) => (
                        <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">
                            {children}
                        </blockquote>
                    ),
                    table: ({ children }) => (
                        <div className="my-2 overflow-x-auto">
                            <table className="w-full border-collapse text-xs">{children}</table>
                        </div>
                    ),
                    th: ({ children }) => (
                        <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
                            {children}
                        </th>
                    ),
                    td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
                    hr: () => <hr className="my-3 border-border" />,
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
});
