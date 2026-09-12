// components/ThemeSettings.tsx — 外观设置：深色/浅色切换 + 视图缓存清理
//
// daisyUI light + dark 双主题（见 index.css），data-theme 显式锁定，localStorage 持久。
import { createSignal } from "solid-js";
import { getTheme, setTheme, type DiyTheme } from "../lib/theme";
import { clearUiCache } from "../lib/ui-state";

export function ThemeSettings() {
  const [theme, setThemeSig] = createSignal<DiyTheme>(getTheme());

  const pick = (t: DiyTheme) => {
    setTheme(t);
    setThemeSig(t);
  };

  const reset = () => {
    clearUiCache();
    // 内存态（展开/滚动/宽度/密度/主题）都随组件存活：reload 最干净，
    // 所有视图 cache 回默认；只清界面状态，不碰业务数据
    setTimeout(() => location.reload(), 120);
  };

  return (
    <div class="p-4 space-y-3">
      <div class="text-sm font-bold">🎨 外观</div>
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
      <div class="text-xs opacity-60">深色为默认；浅色下任务链接自动用深蓝，保证对比度。</div>

      <div class="divider"></div>
      <div class="text-sm font-bold">🧹 视图缓存</div>
      <button class="btn btn-sm btn-outline btn-error" onClick={reset}>
        重置界面状态
      </button>
      <div class="text-xs opacity-60">
        清空 localStorage 中的视图缓存（任务树展开/滚动位置、详情面板宽度、聊天密度、
        主题偏好），刷新后全部回默认。只清理界面状态，不影响任何任务数据。
      </div>
    </div>
  );
}