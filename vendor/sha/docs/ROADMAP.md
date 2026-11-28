# SHA 下一步开发参考

状态：基于 `6b2ef9c` 的 review 结论整理  
适用范围：`sha.bash` 核心分发、测试框架、文档与后续 option/help 能力  
目标：先清掉死代码，再补 diy 构建脚本真正需要的 option/help 能力。

---

## 1. 当前状态

### 已有能力

- 函数名即命令，自注册，零执行发现。
- `.` 与 `__` 都是层级分隔符：
  - `build.web()` / `build__web()` → `sha build web`
- 单个 `_` 永不拆分，保护 `run_tests`、`my_cmd` 等 snake_case。
- 私有前缀不注册：
  - `_*`
  - `fn_*`
  - `sha`
  - `sha_*`
  - `sha.*`
- 同一路径撞车（`a.b` 与 `a__b`）注册时报错。
- 纯分组命令：
  - `sha build` → help + `return 3`
  - `sha build bad` → unknown + `return 1`
- `root()` 存在时，`sha` 无参执行它。
- `-h/--help` 在分发层打印当前层级 help。
- 退出码：
  - `0` 成功
  - `1` 未知命令 / 注册失败
  - `3` 纯分组缺子命令

### 已修复的重要问题

- 测试 runner 假通过：
  - 旧写法 `if ( time "$functionName" )` 会把测试放进 condition context，关闭子 shell 里的 `set -e`。
  - 已改为外层 `set +e` + 子 shell `set -e` + 显式取 `status`。
- 同进程重入误判：
  - 旧 diff 模型第二次调用可能误判为叶子命令并静默 `return 0`。
  - 新模型每次全量重建命令表，行为稳定。
- `exit` → `return`：
  - 库不再替调用方决定进程生死。
- Windows 性能：
  - 默认关闭 `compgen -c` 系统命令扫描。
  - 默认不挂 `ERR` trap。
  - 去掉逐函数 `$(declare -f)` fork。
- 关联数组清空：
  - 不再依赖 `arr=()` 的 Bash 4.4 行为，改用 `_sha_clear_associative_array`。
- 测试可信度：
  - `test_help_flag` 断言修正。
  - `test_reentry_same_process` 改为同 shell 连续调用。
  - `test_array_difference` 改为真实内容断言。
  - 注入“第一条 assert 失败、第二条成功”的测试，runner 现在能正确报 `FAIL`。

### 验证基线

```bash
bash test_sha.bash
# 16/16 PASS, rc=0
```

当前测试约 4.5 秒（Windows Git Bash 环境）。

---

## 2. 已固定的设计决策

这些先不要再反复讨论，除非出现真实需求：

1. **分隔符**
   - 只支持 `.` 和 `__`。
   - 单个 `_` 不拆分。
   - `A_B_C` 不作为默认层级形式。
   - 暂不加 `SHA_SEP_SINGLE_USCORE` 开关；等真实迁移需求再说。

2. **旧 `bake` 点号调用**
   - 不支持 `sha foo.bar`。
   - 只支持 `sha foo bar`。
   - 迁移旧脚本时用 sed 把点号路径替换成空格路径。

3. **注册失败策略**
   - 全量注册，全有或全无。
   - 任意非法函数名或路径撞车 → 整个 CLI 返回 1。
   - 这是 feature：启动即失败，好过某个子命令悄悄失踪。

4. **私有命令**
   - 私有函数不注册、不出现在 help。
   - 需要调试时直接 `source` 后调用函数本身，不通过 `sha`。

5. **库边界**
   - 不默认修改调用方 `set -e` / `trap` / `shopt`。
   - 出错用 `return`，不用 `exit`。

---

## 3. 清理清单（下一步先做）

目标：去掉死代码和半成品，让核心只保留命令分发必需内容。

### 3.1 `sha.bash` 可删除项

| 项 | 原因 |
|---|---|
| `_sha_real_path` | 只有定义和注释，无实际调用 |
| `_sha_pwd` | 只有定义和注释，无实际调用 |
| `_sha_log` | 只有定义和注释，无实际调用 |
| `_sha_sys_commands` | 只写不读，冲突检查未实现 |
| `_sha_register_sys_commands` | 只填充 `_sha_sys_commands`，没有任何消费方 |
| `SHA_CHECK_SYS_CONFLICT` | 当前是假功能，开了也不检查 |
| `_sha_array_regex_match` | 仅测试使用，核心不需要 |
| `_sha_array_find_first_index` | 仅测试使用，核心不需要 |
| `_sha_array_contains` | 仅测试使用，核心不需要 |
| `_sha_array_difference` | 仅测试使用，核心不需要 |
| `_sha_reset` | 只是 `_sha_register_all` 的别名，当前无调用方 |
| `nullglob` 临时开关 | 新注册模型没有 glob 展开，已不需要 |

清理时注意：

- 删除 `_sha_array_*` 后，同步删除 `test_sha.bash` 中对应的 4 个测试。
- 删除 `assert_not_contains`（如果没有其他用例使用）。
- 删除 `SHA_CHECK_SYS_CONFLICT` 后，更新文件头和入口注释。
- `_sha_clear_associative_array` 保留，注册表清空依赖它。
- `_sha_on_error` 保留，`SHA_DEBUG=1` 仍可用。

### 3.2 顺手修掉的小问题

- `_sha_clear_associative_array` 的参数错误提示里用了不存在的 `${func_name[0]}`，改成固定函数名。
- `run_tests` 里的 `declare -F | grep | awk` 可以改成 `compgen -A function`，减少外部进程。
- `test_sha.bash` 里 `${TEST_PATH}` 当前为空，导致测试输出前面有两个空格；设置 `TEST_PATH` 或去掉该占位。
- README 补一句最低版本：`Bash 4.4+`。

### 3.3 暂时保留

- `sha_style.bash`：可选样式模块，当前未接入核心。先保留，后续决定是否改名/懒加载/删除。
- `SHA_DEBUG=1`：轻量调试能力，保留。
- `_sha_clear_associative_array`：注册表清理必需。

---

## 4. 下一阶段开发优先级

### P0：option 解析 + help 元数据

这是 diy 构建脚本最缺的能力，优先级高于其他所有项。

#### 4.1 Option 解析

建议独立成 `sha_opt.bash`，不要让 `sha.bash` 继续膨胀。

目标能力：

```bash
sha.opt --cmd build --long target --type string --default macos
sha.opt --cmd build --long release --type bool
sha.opt --cmd build --long jobs --type int --default 4
```

命令内使用：

```bash
build() {
  eval "$(sha.parse "$@")"
  echo "target=$target release=$release jobs=$jobs"
}
```

至少要支持：

- `--target macos`
- `--target=macos`
- bool：
  - `--release`
  - `--no-release`
- string / int / list
- default
- required
- `--` 之后全部作为位置参数
- 未知 option 报错
- 重复 option 的策略（覆盖或报错，需要定）

实现方向：

- 用 `printf -v` / nameref 赋值，避免 `eval` 长期风险。
- 但第一版可以先用 `eval "$(sha.parse "$@")"` 快速落地，后续再替换。
- 解析结果变量名默认等于 long option 名，允许 `--var` 重命名。

#### 4.2 help / usage 元数据

建议 API：

```bash
sha.desc  "build web" "构建 web 包"
sha.usage "build web" "sha build web [--target T] [--release]"
```

`sha -h` 输出示例：

```text
Available Commands:
  build/
    web    构建 web 包
  test     运行测试
```

`sha build web -h` 输出该命令的 desc + usage。

需要决定：

- desc/usage 是纯数据表，还是从函数注释里 grep？
- 推荐纯数据表，简单、可控、无解析歧义。

### P1：分发语义补齐

1. 叶子命令的 `-h`
   - 当前叶子 `sha foo -h` 打印空 help。
   - 需要决定：显示 usage，还是把 `-h` 透传给命令自己。
   - 推荐：`sha.usage` 存在则显示 usage；否则透传。

2. `--` 语义
   - 明确 `sha build -- --release` 中 `--release` 是位置参数，不是 option。
   - 在 option 层实现，不分发层重复实现。

3. 函数名校验
   - 恢复旧代码的“函数名不能包含 `/`”检查。
   - 保留空段、撞车检查。

4. `SHA_CHECK_SYS_CONFLICT`
   - 清理时直接删除。
   - 如果以后确实需要系统命令冲突检查，再作为可选严格模式重新设计，不要保留半成品。

### P2：测试与 CI

需要补的测试：

- 非法函数名：
  - `a..b`
  - `.a`
  - `a__`
  - `a____b`
- 私有前缀：
  - `sha_foo`
  - `sha.foo`
  - `_foo`
  - `fn_x`
- `root()` 带参数时的行为
- 叶子命令 `-h`
- `--` 透传
- 连续两次成功调用（当前 reentry 覆盖的是成功 + 失败）
- option 解析矩阵：
  - `--x v`
  - `--x=v`
  - bool / no-bool
  - default / required
  - list
  - 未知 option
  - `--` 后的参数

CI 建议：

```text
bash -n sha.bash test_sha.bash unit_test_framework.bash
bash test_sha.bash
shellcheck ...
```

矩阵：

- Linux Bash 4.4 / 5.x
- Windows Git Bash
- macOS Bash（注意系统自带 3.2 不满足，需 brew bash）

### P3：工程化

1. `SHA_VERSION` / `sha --version`
2. 标准入口模板：
   - `vendor/sha.bash`
   - 下载 / 版本 pin / 失败重试
3. 迁移文档：老 `bake` → 新 `sha`
4. `sha_style.bash`：
   - 决定是否保留
   - 如果保留，改成 `sha.style.*` 命名或懒加载，避免 `use_theme` 被注册成命令
5. 可选：命令补全、`desc` 自动生成、缓存命令表

---

## 5. 不建议现在做的事

- 不要为了性能提前加命令表缓存；当前规模下全量注册足够。
- 不要恢复 `A_B_C` 单下划线拆分；会破坏 snake_case。
- 不要恢复 `sha foo.bar` 兼容；会让分发规则变复杂。
- 不要保留 `SHA_CHECK_SYS_CONFLICT` 这种“有开关无实现”的半成品。
- 不要在没有 option 层之前，继续往 `sha()` 里堆参数解析逻辑。

---

## 6. 推荐执行顺序

1. 按第 3 节做死代码清理。
2. 跑 `bash test_sha.bash`，确认清理后仍全绿。
3. 补 README 的最低版本和当前能力边界。
4. 设计并实现 `sha_opt.bash` 最小版：
   - `--x v`
   - `--x=v`
   - bool / no-bool
   - default
   - `--`
5. 加 `sha.desc` / `sha.usage`。
6. 补 option/help 测试。
7. 再决定 `sha_style.bash` 的去留。

---

## 7. 相关提交

```text
6b2ef9c fix: runner false-pass, true re-entry test, tighten excludes
383702e fix: sha re-entry in same process misdetected as leaf, exit->return
c0bdab1 chore: remove legacy bake engine, optimize sha for Windows
```

`6b2ef9c` 的 review 结论：可保留，P0 已真实修复，测试结果可采信；剩余问题均为 P3 或后续能力项。
