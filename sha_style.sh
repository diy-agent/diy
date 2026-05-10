#!/usr/bin/env bash

# ==============================================================================
# 1. 基础 ANSI 转义定义 (The Foundation)
# ==============================================================================

# $'\e[' 是 Bash 的特殊语法，代表 "Escape" 字符 (ASCII 27)。
# 所有的终端颜色指令都必须以这个 [ 符号开头。
esc=$'\e['

# 0m 是重置指令。如果不加这个，终端颜色会一直“流血”到后续的所有文字。
reset="${esc}0m"

# 装饰器 (形状改变)
# 1m = 加粗 (Bold)
# 2m = 变暗/细 (Dim)
# 3m = 斜体 (Italic)
# 4m = 下划线 (Underline)
text_bold="${esc}1m"
text_dim="${esc}2m"
text_italic="${esc}3m"
text_underline="${esc}4m"

# ==============================================================================
# 2. 核心引擎：亮度计 (Luma Engine)
# ==============================================================================

# 该函数实现“背景决定前景”的自动化逻辑。
# 输入：分号分隔的 RGB 值 (例如 "59;130;246")
# 输出：最适合该背景的文字 RGB 值 (深色或浅色)
_get_fg_for_bg() {
    local r g b

    # [IFS=';'] : 告诉 read 命令用分号作为分隔符来拆分字符串。
    # [read -r r g b] : 将拆分后的三个值存入变量 r, g, b。
    # [<<< "$1"] : "Here-string" 语法，将函数参数 $1 喂给 read 命令。
    IFS=';' read -r r g b <<< "$1"

    # 工业标准的亮度计算公式 (感知亮度)。
    # 因为人眼对绿色最敏感，对蓝色最弱，所以权重不同。
    local luma=$(( (r * 299 + g * 587 + b * 114) / 1000 ))

    # 如果亮度 > 150 (满分255)，说明背景是浅色，返回深色文字 (Slate-900)
    # 否则返回浅色文字 (Slate-50)
    if [ "$luma" -gt 150 ]; then
        echo "15;23;42"  # 深色文本 RGB
    else
        echo "248;250;252" # 浅色文本 RGB
    fi
}

# ==============================================================================
# 3. 主题设置与变量构造 (Theme & Tokens)
# ==============================================================================

use_theme() {
    # 如果没传参数，默认使用 dark 模式
    local mode=${1:-dark}

    # 预定义的原子色值 (分号格式 R;G;B)
    local c_blue="59;130;246"    # Primary
    local c_red="239;68;68"      # Error
    local c_amber="245;158;11"   # Warning
    local c_slate_900="15;23;42" # 深色正文
    local c_slate_50="248;250;252" # 浅色正文

    # 内部工具函数：快速构造“背景+前景+加粗”的 UI 组件
    # $1: 背景 RGB
    _make_ui() {
        local bg_rgb="$1"
        local fg_rgb=$(_get_fg_for_bg "$bg_rgb")

        # 拆解 ANSI 指令:
        # ${esc}48;2;...m  -> 设置背景色 (48代表背景，2代表Truecolor模式)
        # ${esc}38;2;...m  -> 设置前景色 (38代表前景)
        # ${text_bold}     -> 加粗
        echo "${esc}48;2;${bg_rgb}m${esc}38;2;${fg_rgb}m${text_bold}"
    }

    # --- 交付给外部脚本使用的样式变量 ---

    # 正文文字色：根据 dark/light 模式切换
    if [ "$mode" == "dark" ]; then
        # 深色模式用浅色字
        ui_fg="${esc}38;2;${c_slate_50}m"
    else
        # 浅色模式用深色字
        ui_fg="${esc}38;2;${c_slate_900}m"
    fi

    # 成套组件：背景+文字 强绑定，防止在不同主题下看不清
    ui_primary=$(_make_ui "$c_blue")
    ui_error=$(_make_ui "$c_red")
    ui_warning=$(_make_ui "$c_amber")
}

# ==============================================================================
# 4. 测试与演示 (Usage & Test)
# ==============================================================================

test_sha_style() {
    # 模拟深色模式 (大多数程序员的终端)
    use_theme dark
    echo "--- [ DARK MODE TEST ] ---"

    # 使用成套组件 ui_xxx
    # 注意：变量后面紧跟 ${reset} 是非常重要的习惯，防止颜色污染
    echo -e "${ui_primary} PRIMARY ${reset} <- 自动配白字"
    echo -e "${ui_warning} WARNING ${reset} <- 自动配黑字 (对比度更高)"
    echo -e "${ui_error} ERROR   ${reset} <- 自动配白字"

    # 使用基础正文 ui_fg
    echo -e "${ui_fg}This is standard text in dark mode.${reset}"

    echo

    # 模拟浅色模式
    use_theme light
    echo "--- [ LIGHT MODE TEST ] ---"
    echo -e "${ui_fg}Now the standard text has switched to dark color.${reset}"
    echo -e "${ui_primary} PRIMARY ${reset} <- 在浅色背景下依然清晰"

    echo
    echo "--- [ 复杂场景组合 ] ---"
    use_theme dark
    # 组合使用：组件 + 默认字 + 装饰器
    echo -e "${ui_error} FAIL ${reset} ${ui_fg}Process terminated at ${text_italic}${text_underline}14:30${reset}"
}

# 如果直接运行脚本，则执行测试
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    test_sha_style
fi
