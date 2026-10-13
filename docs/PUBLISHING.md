# 维护与发布

公开仓库：[liaowu-boos/ip-presenter](https://github.com/liaowu-boos/ip-presenter)，默认分支为 `main`，已于 2026-10-09 首次发布。维护现有仓库时无需重新初始化 Git 或创建远程仓库。

## 获取最新公开版

```bash
git clone https://github.com/liaowu-boos/ip-presenter.git
cd ip-presenter
```

已有克隆时，先确认本地改动，再同步远端：

```bash
git status --short
git fetch origin
git log --oneline HEAD..origin/main
git pull --ff-only
```

如果有未提交改动或分支分叉，先检查并处理，不要用强制覆盖代替合并。

## 更新前检查

只在经过审核的公开源码目录中提交。原作者的设计资料、人物素材、录音、专用实验与本机配置不属于公开范围，不能从私人开发目录直接批量同步。

按 README 安装开发依赖后运行：

```bash
python3 scripts/check_public_release.py
npm test
python -m pytest -q
npm run build
git diff --check
git diff --stat
```

内容检查只覆盖部分敏感模式，仍需人工审核新增代码、文件名、注释、截图和示例。图片也可能以 base64 或 data URL 嵌入源码；不能只检查图片扩展名。

## 提交与验证

仅暂存本次已经审核的文件，检查 `git diff --cached`。维护者推送当前分支；外部贡献者通过自己的 fork 提交 Pull Request。提交前再次确认远端是目标仓库，且包含的历史没有私人内容。

GitHub Actions 会在 push 和 Pull Request 时运行核心检查，不需要真实模型密钥。以[当前 Actions 结果](https://github.com/liaowu-boos/ip-presenter/actions)为准；历史通过记录不代表后续提交自动通过。

本地生成的 `直接预览.html`、运行目录和素材目录不提交。更新摘要写入 [CHANGELOG](../CHANGELOG.md)，验证范围写入 [验证记录](VALIDATION.md)。
