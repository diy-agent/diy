// components/CodeBlock.tsx — 代码块高亮（Shiki，异步按需加载）
//
// 为什么异步 + 动态 import：Shiki 的语言语法数据极大（单个 TypeScript 语法 188KB，
// 全部语言 11MB），若静态 import 会全部打进主 chunk（实测主包 390KB → 1.5MB）。
// 因此：
//   1. 高亮器首次真正需要时（首个代码块渲染）才动态 import 引擎与主题；
//   2. 每种语言单独动态 import，用到才加载，各自成为独立 chunk；
//   3. 引擎用 JS 正则版（@shikijs/engine-javascript），避开 oniguruma wasm 的 652KB。
//
// 与流式渲染的配合：未定稿的代码块（内容还在增长）不请求高亮，直接 <pre> 呈现；
// 定稿后触发一次异步高亮。异步期间显示纯文本，不阻塞也不闪烁布局。
import { Show, createResource } from "solid-js";
import { getTheme } from "../lib/theme";

/** 已注册语言 → 动态加载器（键同时充当白名单，未知语言直接降级） */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  ts: () => import("shiki/dist/langs/typescript.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  js: () => import("shiki/dist/langs/javascript.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  bash: () => import("shiki/dist/langs/bash.mjs"),
  sh: () => import("shiki/dist/langs/bash.mjs"),
  shell: () => import("shiki/dist/langs/bash.mjs"),
  md: () => import("shiki/dist/langs/markdown.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  py: () => import("shiki/dist/langs/python.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  yml: () => import("shiki/dist/langs/yaml.mjs"),
};

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

/** 单例高亮器：动态 import 一次，之后复用（语言仍按需 codeToHtml 时加载） */
async function createHighlighter() {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  const [themeDark, themeLight] = await Promise.all([
    import("shiki/dist/themes/github-dark.mjs"),
    import("shiki/dist/themes/github-light.mjs"),
  ]);
  return createHighlighterCore({
    themes: [themeDark.default, themeLight.default],
    // 空语言表：具体语言在 highlight() 里按需 loadLanguage
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}

let _hlPromise: Promise<Highlighter> | null = null;
function hl(): Promise<Highlighter> {
  if (!_hlPromise) _hlPromise = createHighlighter();
  return _hlPromise;
}

/** 已注册语言集合（避免每次查表 + 提醒 loadLanguage 的并发竞态） */
const loaded = new Set<string>();

export function CodeBlock(props: {
  code: string;
  lang?: string;
  /** 所属块是否仍在生成：true 时不走高亮，防对增长中的代码反复着色 */
  streaming?: boolean;
}) {
  const lang = () => (props.lang ?? "").toLowerCase();
  const loader = () => LANG_LOADERS[lang()];
  const canHighlight = () => !props.streaming && !!props.code && !!loader();

  // createResource：依赖 (code, lang, theme) 变化时重新高亮；异步不阻塞渲染
  const [html] = createResource(
    () => ({ code: props.code, lang: lang(), theme: getTheme(), on: canHighlight() }),
    async (src) => {
      if (!src.on) return null;
      try {
        const h = await hl();
        // loadLanguage 幂等，重复调用无害；并发首载由 shiki 内部去重
        if (!loaded.has(src.lang)) {
          await h.loadLanguage(LANG_LOADERS[src.lang]!() as never);
          loaded.add(src.lang);
        }
        return h.codeToHtml(src.code, {
          lang: src.lang,
          theme: src.theme === "light" ? "github-light" : "github-dark",
        });
      } catch (e) {
        // 未注册语言 / 引擎边界情况：降级纯文本，绝不因着色失败打断渲染
        console.warn("[CodeBlock] 高亮失败，降级纯文本:", e);
        return null;
      }
    },
  );

  return (
    <Show
      when={html()}
      fallback={
        <pre class="my-2 overflow-auto rounded-lg bg-base-200 p-3 text-xs leading-relaxed font-mono">
          <code>{props.code}</code>
        </pre>
      }
    >
      {/* Shiki 产出的是自带 <pre class="shiki"> 的完整结构，直接挂载其输出。
          内容由 Shiki 从纯文本生成（非用户 HTML 注入），是官方消费方式。
          背景/内边距用 CSS 覆盖，让深浅主题与 daisyUI 变量一致。 */}
      <div class="my-2 overflow-auto rounded-lg text-xs [&_pre]:m-0 [&_pre]:p-3 [&_pre]:!bg-base-200" innerHTML={html()!} />
    </Show>
  );
}
