// components/ThemeSettings.tsx — 外观设置：深色/浅色切换
//
// daisyUI light + dark 双主题（见 index.css），data-theme 显式锁定，localStorage 持久。
import { createSignal } from "solid-js";
import { getTheme, setTheme, type DiyTheme } from "../lib/theme";

export function ThemeSettings() {
  const [theme, setThemeSig] = createSignal<DiyTheme>(getTheme());

  const pick = (t: DiyTheme) => {
    setTheme(t);
    setThemeSig(t);
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
    </div>
  );
}
