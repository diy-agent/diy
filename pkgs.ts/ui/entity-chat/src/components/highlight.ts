// highlight.ts —— 代码高亮（highlight.js core + 只注册常用语言）。
//
// 为什么不用全量包：highlight.js 默认带 ~190 种语言，打包后几百 KB。
// 这里只注册我们真的会遇到的十种，其余语言退化成不高亮的纯文本。
//
// 为什么不用 Astryx 的 tokenizer：它是 lab 的 canary API，而这段代码要给
// 两个表面共用（Astryx / shadcn），不能绑在某一个库上。

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

/** 从 `language-ts` 这类 className 里取语言名 */
export function languageOf(className: string | undefined): string | undefined {
    const match = /language-([\w-]+)/.exec(className ?? '');
    return match?.[1]?.toLowerCase();
}

/** 高亮成 HTML（未注册的语言交给 highlightAuto；再不行就原样转义） */
export function highlightCode(code: string, language: string | undefined): string {
    try {
        if (language !== undefined && hljs.getLanguage(language) !== undefined) {
            return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        }
        return hljs.highlightAuto(code).value;
    } catch {
        return code.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char);
    }
}
