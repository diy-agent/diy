import { createApp, Vertical, Text, t } from "../src/index.js";

/**
 * Unified Styling Example:
 * Headers use a consistent Primary Background for clear sectioning.
 */
function* StylingApp() {
  // A prominent header style: Full-width blue background with bold white text
  const headerStyle = t.w_full.bg_blue_500.text_white.font_bold;

  // --- 1. COLORS & DECORATIONS ---
  yield new Text({ content: " 1. COLORS & DECORATIONS ", style: headerStyle });
  yield new Text({ content: " White on Blue (bg_blue_500) ", style: t.bg_blue_500.text_white });
  yield new Text({ content: " Black on Yellow (bg_yellow_500) ", style: t.bg_yellow_500.text_black });
  yield new Text({ content: " White on Magenta (bg_magenta_500) ", style: t.bg_magenta_500.text_white });
  
  yield new Text({ content: "" }); // Spacer

  // --- 2. WIDTH PERCENTAGES ---
  yield new Text({ content: " 2. WIDTH PERCENTAGES ", style: headerStyle });
  yield new Text({ content: "w-full", style: t.w_full.bg_white.text_black });
  yield new Text({ content: "w-2/3",  style: t.w_2_3.bg_yellow_500.text_black });
  yield new Text({ content: "w-1/2",  style: t.w_1_2.bg_white.text_black });
  yield new Text({ content: "w-1/3",  style: t.w_1_3.bg_yellow_500.text_black });

  yield new Text({ content: "" }); // Spacer

  // --- 3. ALIGNMENT ---
  yield new Text({ content: " 3. ALIGNMENT ", style: headerStyle });
  yield new Text({ content: "text-left (default)", style: t.w_full.bg_cyan_500.text_black });
  yield new Text({ content: "text-center", style: t.text_center.bg_black.text_white });
  yield new Text({ content: "text-right", style: t.text_right.bg_cyan_500.text_black });

  yield new Text({ content: "" }); // Spacer

  // --- 4. PADDING ---
  yield new Text({ content: " 4. PADDING ", style: headerStyle });
  yield new Text({ content: "px-1", style: t.px_1.bg_red_500.text_white });
  yield new Text({ content: "px-4", style: t.px_4.bg_magenta_500.text_white });
}

const app = createApp(function* () {
  yield new Vertical({ gap: 0 }, StylingApp);
});
app.run();
