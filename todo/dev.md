# dev flow 改进点

从 AI Agent 协同和工程健壮性两个维度对 @docs/dev.md 和 @sha.sh 提出了以下优化建议：

1. 解决 .gitignore 导致的工具失效 (最紧迫)
   问题： .worktree/ 目录在 .gitignore 中，导致 AI 的高级工具（如 read_file, grep_search）默认会跳过这些目录。这迫使 Agent 退化到使用 cat 等低级 shell 命令，降低了感知能力。
   优化：
- 方案 A： 在 .geminiignore 中显式排除 .worktree/（如果存在该文件）。
- 方案 B： 在 sha.sh worktree add 成功后，自动生成一个临时逻辑，引导 AI 使用带有 no_ignore: true 参数的工具。

2. merge 流程的安全护栏
   问题： 目前的 merge 命令非常“暴力”。
- 未提交检查： 如果开发者在 worktree 中修改了代码但忘记 git commit，直接在根目录运行 merge 会导致这些修改被遗留在 worktree 目录中而没有合并进 main，随后 worktree 被删除，造成代码丢失。
- 落后于 Main： 如果 main 分支在开发期间有更新，直接 merge 可能产生冲突。
  优化：
- 在 merge 执行前，增加 git status --porcelain 检查。如果 worktree 内有未提交变更，强制报错中断。
- 增加“预合并”步骤：先在 worktree 内部尝试 git merge main（或 rebase），确保冲突在隔离环境下解决，而不是在主根目录解决。

3. 自动化测试的落地
   问题： sha.sh 中的 步骤 1/4: 运行测试 目前是注释掉的，或者没有针对单测/集成测的区分。
   优化：
- 取消注释，并支持检测 package.json 中的 test 或 check 脚本。
- 增量检查： 建议增加 npx tsc --noEmit 作为合并前的强校验（Surgical Validation），确保类型安全。

4. 环境自动初始化
   问题： 创建 worktree 后，如果依赖发生了变化，或者是一个全新的环境，通常需要 npm install。
   优化：
- sha.sh worktree add 增加可选参数 --install，自动在目标目录运行依赖安装。
- 自动链接根目录的 node_modules（使用 pnpm 或 ln -s）以节省空间和时间。

5. AI 协同指令优化 (docs/dev.md)
   问题： 现有的 dev.md 对 AI 的约束较少。
   建议在 dev.md 增加以下内容：
- 验证强制要求： “合并前必须在 worktree 目录下运行 ./sha.sh check 或 npm run check。”
- 提交规范： “必须在 worktree 内完成 commit 后再返回根目录执行 merge。”

6. 脚本内部逻辑优化 (sha.sh)
   问题： git checkout main 在根目录执行时，如果根目录有未追踪的文件或修改，可能会失败。
   优化：
- 使用 git symbolic-ref --short HEAD 检查当前是否已在 main，避免不必要的切换。
- 在 merge 开始前执行 git stash 保护根目录可能存在的临时改动。
