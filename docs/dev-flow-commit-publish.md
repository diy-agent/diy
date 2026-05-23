# dev flow 之提交与发布管理

## 项目版本发布工具链

### 工具分类

1. 提交辅助与日志生成 - 解决"写什么"
   - Commitizen：交互式引导写出规范提交信息
   - git-cliff：从提交历史自动生成 CHANGELOG.md
   - towncrier：每个 PR 独立新闻片段，发布时汇总
   - ai工具：ai辅助工具

2. 提交规范校验 - 解决"写得对不对"
   - commitlint：检查提交信息是否符合 Conventional Commits 格式
   - pre-commit：通用钩子，可运行任意检查脚本

3. 版本发布与执行 - 解决"怎么做"
   - semantic-release：全自动，合并即发布
   - release-please：半自动，创建 Release PR 需人工审核后发布
   - python-semantic-release：Python 原生全自动发布
   - GoReleaser：跨平台构建，通过钩子支持 Python


### 发展阶段

阶段1：快速迭代
→ 无 + 无 + semantic-release

阶段2：要求规范
→ 无 + commitlint + semantic-release/release-please

阶段3：安全审批
→ Commitizen/git-cliff/ai类辅助方式 + commitlint + semantic-release/release-please
