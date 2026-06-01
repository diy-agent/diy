# DIY CLI Sync (意图导向设计)

## 🎯 核心使命：构建“单源真理”事实标准库

**问题背景**：
AI Agent 在回答库（如 pandas, typescript）相关问题时，常基于训练数据猜测或通过 Web 搜索，导致版本错位（如用 1.x 的知识回答 2.x 的代码）或响应缓慢。

**`diy sync` 的解决方案**：
根据项目 `lock` 文件，将**精确版本**的依赖源码拉取到本地，并建立索引。
- **对人类**：实现 IDE 级的精准跳转。
- **对 AI**：提供一个“就在这里搜索”的事实标准知识库，消除猜测，确保版本确定性。

---

## 1. 寻根逻辑：Hierarchical Discovery

无论在何处执行，始终锁定项目根目录，防止索引碎片化。

```text
~/git/project/           <── 🏠 识别为 ROOT (因为存在 diy.yaml)
├── ✅ diy.yaml
├── .diy/ref/ref.lock.json
└── packages/
    └── sub-package/
        └── src/         <── 🎯 在此执行 `diy sync`
```

---

## 2. 依赖决策：Manifest-Driven & Lock-Resolved

清单（Intention）决定“拉什么”，锁定文件（Certainty）决定“拉哪个版本”。

```text
demo-repo/
├── 📝 package.json        # 声明: { "tsx": "^4.0.0" }       ──┐
├── 📝 pyproject.toml      # 声明: dependencies = ["rich"]   ──┼─> 🔍 提取活跃包名
│                                                              │
├── 🔒 package-lock.json   # 锁定: tsx @ 4.21.0              ──┼─> 🔒 锁定精确版本
└── 🔒 uv.lock             # 锁定: rich @ 15.0.0             ──┘

# 结果：
# - 精确同步 tsx@4.21.0 和 rich@15.0.0
# - 🚫 自动 Prune：忽略清单中已删除但 lock 中残留的包。
```

---

## 3. 存储策略：Zero-Interference Storage

源码全局共享，IDE 绝对路径映射，彻底解决搜索和索引卡顿。

```text
~/.diy/ref/              <── ✅ 全局物理存储 (Global Cache)
├── github.com/microsoft/TypeScript/v5.9.3/
└── github.com/Textualize/rich/v15.0.0/

~/git/project/           <── 💻 本地项目 (Project)
├── 📝 tsconfig.ide.json
│   # "paths": { "typescript": ["~/.diy/ref/.../v5.9.3"] }
└── 📝 .diy/ref/ref.lock.json
    # "mirrorPath": ".diy/ref/..." (相对于 HOME)
```

- **设计意图**：项目内 **0 软链接**。编辑器不会误扫到 `node_modules` 之外的数万个外部源码文件，提升响应速度。

---

## 4. 运行保障：Visibility & Resilience

长耗时网络操作透明化，确保弱网环境下的任务可控性。

```bash
# 环境变量保护：防止无限期挂起
GIT_LOW_SPEED_LIMIT=1000  # < 1KB/s 则断开
GIT_LOW_SPEED_TIME=60     # 持续 60s
GIT_TERMINAL_PROMPT=0     # 禁止交互弹窗

# 命令执行：强制显示进度
git clone --progress --depth 1 --branch v5.9.3 <url> <path>
```

- **日志意图**：
    - `-v`: 进度感知。
    - `-vv`: 执行诊断。
    - `-vvv`: 追踪底层异常。
