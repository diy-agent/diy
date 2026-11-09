/**
 * gen.mts —— 从 **seed 色** 生成 M3 令牌 CSS。
 *
 * 为什么要有它（##518 用户裁）：`src/gen/*.css` 以前是从 Material Theme Builder 导出的**手抄产物** ——
 * 版权头在、格式是压缩的，但仓库里没有生成它的东西，于是「换主题」只能再导出一次、再人工 diff，
 * 而且**没法复核它到底对不对**。现在：seed →（material-color-utilities）→ CSS，
 * `./sha.sh gen` 重算、`./sha.sh check` 验生成物是否过期。
 *
 * 产物（只写 src/gen/，不要手改）：
 *   src/gen/ref-palette.css   参考色板：6 条 hue × 13 档 tone
 *   src/gen/sys-color.css     语义角色：--md-sys-color-* = light-dark(亮端, 暗端)
 *
 * 为什么用 `MaterialDynamicColors` 而不是 `theme.schemes.light`：
 *   后者的 Scheme 只有 29 个角色（没有 surface-container-* / *-fixed 系列），而 @material/web 的组件
 *   到处引用 `--md-sys-color-surface-container-high` 这些 —— 缺了它们，组件会退回内置灰。
 *   MaterialDynamicColors 是 M3 规范里的完整色角色表（54 个），传 DynamicScheme 即可求值。
 *
 * 不生成的部分（`src/base/` 里是 M3 规范常量，与 seed 无关）：shape / motion / elevation / typography。
 */
import {
    argbFromHex,
    hexFromArgb,
    Hct,
    MaterialDynamicColors,
    SchemeTonalSpot,
    themeFromSourceColor,
} from "@material/material-color-utilities";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 品牌 seed（diy 的蓝）。换主题只改这一行，然后 `./sha.sh gen`。 */
const SEED = "#3b6fd4";

/** M3 tonal palette 的标准 13 档 */
const TONES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100] as const;

/** 参考色板：palettes 里的键 → CSS 前缀（与 M3 命名一致） */
const PALETTE_NAMES: Record<string, string> = {
    primary: "primary",
    secondary: "secondary",
    tertiary: "tertiary",
    neutral: "neutral",
    neutralVariant: "neutral-variant",
    error: "error",
};

/** 驼峰 → kebab：onPrimaryContainer → on-primary-container */
function kebab(name: string): string {
    return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** `*PaletteKeyColor` 是内部调色锚点，不是 UI 角色 */
const INTERNAL = /PaletteKeyColor$/;

const seedArgb = argbFromHex(SEED);
// 参考色板仍取自 themeFromSourceColor：DynamicScheme 上没有 palettes 树（只有色角色）
const palettes = themeFromSourceColor(seedArgb).palettes as unknown as Record<
    string,
    { tone: (t: number) => number }
>;
const light = new SchemeTonalSpot(Hct.fromInt(seedArgb), false, 0);
const dark = new SchemeTonalSpot(Hct.fromInt(seedArgb), true, 0);

const roles = MaterialDynamicColors as unknown as Record<string, { getArgb: (s: unknown) => number }>;
const roleNames = Object.keys(roles)
    .filter((k) => typeof roles[k]?.getArgb === "function" && !INTERNAL.test(k))
    .sort();

// ── ref-palette.css ──────────────────────────────────────────────
const paletteLines: string[] = [
    "@layer md.ref.palette {",
    ":root {",
    `  /* seed: ${SEED} —— 由 scripts/gen.mts 生成，勿手改 */`,
];
for (const [key, cssName] of Object.entries(PALETTE_NAMES)) {
    const palette = palettes[key];
    if (palette === undefined || typeof palette.tone !== "function") continue;
    for (const tone of TONES) {
        paletteLines.push(`  --md-ref-palette-${cssName}${String(tone)}: ${hexFromArgb(palette.tone(tone))};`);
    }
}
paletteLines.push("}", "}", "");

// ── sys-color.css ────────────────────────────────────────────────
const sysLines: string[] = [
    "@layer md.sys.color {",
    ":root {",
    "  color-scheme: light dark;",
    `  /* seed: ${SEED} —— 由 scripts/gen.mts 生成，勿手改 */`,
];
for (const role of roleNames) {
    const l = hexFromArgb(roles[role]!.getArgb(light));
    const d = hexFromArgb(roles[role]!.getArgb(dark));
    sysLines.push(`  --md-sys-color-${kebab(role)}: light-dark(${l}, ${d});`);
}
sysLines.push("}", "}", "");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "gen");
writeFileSync(join(outDir, "ref-palette.css"), paletteLines.join("\n"));
writeFileSync(join(outDir, "sys-color.css"), sysLines.join("\n"));
console.log(
    `已生成 ${String(roleNames.length)} 个语义角色 + ${String(Object.keys(PALETTE_NAMES).length * TONES.length)} 档参考色（seed ${SEED}）`,
);
