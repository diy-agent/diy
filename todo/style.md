# 颜色变量命名设计总结

## 最终设计方案

### 分层结构

| 层级 | 命名规则 | 例子 | 遵循规范 |
|------|----------|------|----------|
| **基础色** | `text_<颜色>_<明度>` 前景色 <br> `bg_<颜色>_<明度>` 背景色 | `text_slate_50`, `bg_red_500` | **Tailwind CSS 命名习惯**，使用下划线替代连字符 |
| **Material 3 语义单色** | `m3_<role>` 背景色 <br> `m3_on_<role>` 前景色 | `m3_primary`, `m3_on_primary` | **Material 3 设计**，保留 `m3_` 前缀 |
| **顶层直接使用合成色** | `<role>` = `m3_on_role` + `m3_role` | `primary`, `error`, `success` | 无前缀直接使用，方便快捷 |
| **文字样式** | `font_bold` 字体加粗 <br> `text_dim`/`text_italic`/`text_underline` 文字样式 | `font_bold`, `text_italic` | **Tailwind 分类**，加粗归 `font_`，其他文字样式归 `text_` |

### 关键规则

1. **ANSI 转义必须用 `$'...'`** - bash 只有 `$'\033'` 才会正确解析为转义字符，`"\033"` 会保留字面量
2. **顶层合成色不加粗** - `primary` 只包含前景+背景，需要加粗自己加 `${font_bold}primary...${reset}`
3. **兼容旧代码** - `c_*` 合成色保留，且仍然默认加粗，保证现有代码无需修改

### 今天完成的修改

1. `sha_common.sh`:
   - 定义了全套 Tailwind 基础色（slate/gray/red/orange/amber/yellow/green/blue/indigo/purple/pink）从 50 到 950
   - 定义了 Material 3 语义单色 `m3_*` / `m3_on_*`
   - 定义了文字样式 `font_bold`, `text_dim`, `text_italic`, `text_underline`

2. `sha.sh`:
   - 顶层定义合成色 `primary`, `secondary`, `tertiary`, `success`, `error`, `warning`, `info`, `surface`...
   - 废弃了所有 `c_*` 用法，全部替换为新命名
   - 修复了 `reset` 定义错误

### 待完成

- [ ] 验证所有 ANSI 转义正确，颜色显示正常
