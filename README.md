# sha

纯 bash 的 diy 系列项目构建脚本：**函数名即命令，自注册，零执行发现**。

```bash
source ./sha.bash

build() { echo "build default"; }   # sha build
build.web() { echo "build web"; }   # sha build web  (. 是层级分隔符)
build__ios() { echo "build ios"; }  # sha build ios  (__ 也是层级分隔符)
run_tests() { echo "test"; }        # sha run_tests  (单个 _ 永不拆分)
_helper() { :; }                    # _ 开头不注册，私有函数

sha "$@" || exit $?   # 入口：贪心最长匹配，只执行最深命中的函数
```

规则：

- `.` 与 `__` 都是层级分隔符，可混用；单个 `_` 永不拆分（保护 snake_case）。
- 段不能为空（`a..b` / `.a` / `a__` 注册时报错）。
- 同一路径撞车（`a.b` 与 `a__b`）→ 注册报错，绝不静默覆盖。
- 私有前缀不注册：`_*` `fn_*` `sha`/`sha__*`/`sha_*`/`sha.*`（`_sha_cmd_exclude` 可改）。
- `root()` 存在时，`sha` 无参执行它；否则打印 help。
- `-h/--help` 可出现在任何层级，打印该层 help；`-hh`（叠写计数，同 `ssh -v/-vv`）展开整棵命令树。
- 退出码：`0` 成功，`1` 未知命令/注册失败，`3` 纯分组缺子命令。

附带好处：带 `.` 的函数名永远撞不上系统命令（命令名里不能有 `.`）。

## 帮助写在函数注释里

紧贴函数定义行上方、连续的 `#:` 块就是该命令的帮助；不用再 `sha.desc` 逐条注册：

```bash
#: 构建全部产物           ← 块首行 = desc（子命令列表 + help 顶部）
#: 用法: sha build [--target T]   ← "用法:" / "usage:" 行 = usage
#: 默认构建 macos target。        ← 其余行 = detail
build() { :; }

#: 只构建 web
build.web() { :; }
```

- 只用一份文案：`desc`（可多行，首行一句话，其余行补充说明）。**没有单独的 usage / detail 参数**，两种来源同一规则（`sha.desc "<cmd>" $'首行\n补充行'` 与注释等价，注释优先）。
- 只认 `#:`，普通 `#` 是实现备注，不算帮助（不误吞）。
- 中间隔空行就不算「紧贴」，不取。
- 只有注释、什么 option 都没注册，`sha cmd --help` 照样出完整 help。
- 父命令的 help（`-h` / `--help`）除了自己的 usage/desc/options，还把下一层列在 `commands:` 里（与根 help 同一份渲染，命令名不带 `/` 后缀）。

usage 不手写，直接由注册的 options / args 生成（注释里的 `用法:` 行可覆盖）：

```
usage: sha build [-t TARGET] --mode MODE [--release] [--jobs JOBS] <FILE> [TAG]
```

- 选填 → `[方括号]`，必填（spec 里的 `!`）→ 裸写；bool 不带值；string/int → `VAR`；list → `VAR...`。
- 有短名用短名（`-t`），否则长名（`--target`）。
- 完整 help 版式：第一行 `usage:`，空行后 desc(+detail)，再空行 `options:` / `arguments:` / `global options:` / `commands:`（每段之间都空一行）。
- 位置靠 `shopt -s extdebug` 让 `declare -F` 吐出「函数 行号 文件」，再读源文件那个位置；
  用完恢复原 shopt 状态，正常分发路径零开销（只有打印 help 时才读文件）。
- 不做缓存：每次 help 现算（万一哪天嫌慢再加）。
- 列表默认只一层（`-h`），`-hh` / `-hhh` … 都等于整棵树；`--help` 只一层。子层按两格缩进：

```
commands:
  build  构建全部产物
    web  只构建 web 包
  deploy  部署到目标环境
```

## 注册与解析（两个 API，职责不重叠）

| 阶段 | API | 在哪写 | 干什么 |
| --- | --- | --- | --- |
| 注册期 | `sha.def "cmd" --desc … --opt … --arg …` | 顶层（函数外），每条命令一次 | 选项 / 位置参数 / 说明进表，顺带定 help |
| 运行期 | `sha.parse "$@"` | 命令函数体内一行 | 解析 argv：选项写回同名 local 变量，位置参数写回 `--arg` 声明的名字 |

```bash
# 参数顺序约定：--opt / --arg 在前，--desc 放最后一行
#   （多行文案不夹在中间；首行进列表，其余行进 help 的补充说明）
sha.def "build" \
  --opt "-t,--target:string=macos:目标平台" \
  --opt "--mode:string![fast|safe]:运行模式" \
  --arg "FILE!:文件（单个，必填）" \
  --arg "TAG:标签（单个，选填）" \
  --arg "FILES...:其余文件（变长，吃剩余全部）" \
  --desc "构建包
备注：mode 必填；--target 缺席时取 macos。"

build() {
  local target mode
  local FILE="" TAG=""        # --arg 声明的标量名
  local -a FILES=()           # --arg 声明的变长名：声明成数组直接接剩余全部
  sha.parse "$@" || return $?
  echo "$target $mode $FILE $TAG ${FILES[*]}"
}
```

- `--desc` 写在**最后一行**（本项目自身的约定，多行文案放末尾不打断阅读）。
- **声明了什么就解析什么**：没注册的选项、没声明 `--arg` 却传了位置参数，一律报错并打印 `usage:`（不提供默认数组兜底）。
- 位置参数按 `--arg` 声明的名字写回，与选项同一套约定：`--arg "FILE!"` → 标量 `local FILE`，`--arg "FILES..."` → 数组 `local -a FILES`（声明成标量也会被自动提升为数组）。
- 声明了名字却在函数里没 `local`，先报错提示补 `local X`（与选项的防写穿同一判据）。
- 个数 / 必填也由 `--arg` 的表校验（`FILE!` 必填，`...` 吃剩余），多传少传都报错。
- 需要写到别的数组名或用包装函数时，用底层 `sha_opt_parse [--cmd CMD] <数组名> "$@"`。

* 核心：`sha.bash`
* 样式：`sha_style.bash`
* 测试：`test_sha.bash` + `unit_test_framework.bash`（`bash test_sha.bash`）
* 范例：`examples/`（`bash examples/01-basic.bash --help` 起手；注释帮助见 `examples/06-doc-help.bash`）

要求：`Bash 4.3+`（硬依赖 nameref / `declare -n`），推荐 `4.4+`；`sha.bash` / `sha_opt.bash` 加载时会检查 `BASH_VERSINFO`，低版本直接报错并拒绝加载（不会拖到用到时才报 `invalid option`）。
