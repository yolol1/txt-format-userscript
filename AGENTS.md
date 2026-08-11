# AGENTS.md

## Git 工作流约定

项目所有者要求：**每次修改代码并更新 @version 后，由代理自行判断时机，直接完成提交并推送到 GitHub，无需等待用户指示。**

- 执行顺序：`git add -A` → `git commit` → `git push`
- 提交信息需包含本次版本号（如 `v2026-08-11.21`）
- 该约定适用于本项目及以后所有带 git/GitHub 的项目
