// components/ThemeSettings.tsx — 外观设置：深色/浅色 + 界面样式（皮肤）+ 视图缓存清理
//
// daisyUI light + dark 双主题（见 index.css），data-theme 显式锁定，localStorage 持久。
import { createSignal, For } from "solid-js";
import { getTheme, setTheme, type DiyTheme } from "../lib/theme";
import { getSkin, setSkin, SKINS, type DiySkin } from "../lib/skin";
import { clearUiCache } from "../lib/ui-state";
import { ChatSkinPreview } from "@diy/ui-kit";

export function ThemeSettings() {
  const [theme, setThemeSig] = createSignal<DiyTheme>(getTheme());
  const [skin, setSkinSig] = createSignal<DiySkin>(getSkin());

  const pick = (t: DiyTheme) => {
    setTheme(t);
    setThemeSig(t);
  };

  const pickSkin = (s: DiySkin) => {
    setSkin(s);
    setSkinSig(s);
  };

  const reset = () => {
    clearUiCache();
    // 内存态（展开/滚动/宽度/密度/主题）都随组件存活：reload 最干净，
    // 所有视图 cache 回默认；只清界面状态，不碰业务数据
    setTimeout(() => location.reload(), 120);
  };

  return (
    <div class="p-4 space-y-3">
      <div class="text-title font-bold">🎨 外观</div>
      <div class="join">
        <button
          class={`btn btn-sm join-item ${theme() === "dark" ? "btn-active" : ""}`}
          onClick={() => pick("dark")}
        >
          🌙 深色
        </button>
        <button
          class={`btn btn-sm join-item ${theme() === "light" ? "btn-active" : ""}`}
          onClick={() => pick("light")}
        >
          ☀️ 浅色
        </button>
      </div>
      <div class="text-body opacity-60">深色为默认；浅色下任务链接自动用深蓝，保证对比度。</div>

      <div class="divider"></div>
      <div class="text-title font-bold">🎛 界面样式</div>
      <div class="join">
        <For each={SKINS}>
          {(s) => (
            <button
              class={`btn btn-sm join-item ${skin() === s.key ? "btn-active" : ""}`}
              title={s.hint}
              onClick={() => pickSkin(s.key)}
            >
              {s.label}
            </button>
          )}
        </For>
      </div>
      <div class="text-body opacity-60">
        系统整体样式（不是聊天页私有开关）：换的是"块怎么摆"。当前只有 agent 输出区落地，
        其余页面暂无差异。两套皮肤的样式规则都在 index.css 的 [data-skin] 段。
      </div>
      {/* 实时小样：设置页会把聊天区整个换掉 ⇒ 不预览就等于"点了没反应"（见 ChatSkinPreview 头注） */}
      <ChatSkinPreview />

      <div class="divider"></div>
      <div class="text-title font-bold">🧹 视图缓存</div>
      <button class="btn btn-sm btn-outline btn-error" onClick={reset}>
        重置界面状态
      </button>
      <div class="text-body opacity-60">
        清空 localStorage 中的视图缓存（任务树展开/滚动位置、详情面板宽度、聊天密度、
        主题偏好、界面样式），刷新后全部回默认。只清理界面状态，不影响任何任务数据。
      </div>
    </div>
  );
}