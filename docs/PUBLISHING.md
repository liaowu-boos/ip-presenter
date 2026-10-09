# 发布到 GitHub

这个目录是经过筛选的公开源码。不要把包含本机模型与私人素材的上级开发目录整个上传。

发布前在此目录运行：

```bash
python3 scripts/check_public_release.py
npm test
npm run build
```

按 README 运行 Python 核心测试，检查 LICENSE 的授权人表述与许可选择。审核 `git status --short` 和 `git diff --cached --stat`，确认没有意外素材或凭证。

在 GitHub 创建空仓库，例如 `ip-presenter`，选择 Public，不额外生成 README。此目录尚未绑定任何远程仓库；以下命令由你在确认要发布时执行，把占位 URL 换成自己的仓库地址：

```bash
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial open-source release"
git remote add origin https://github.com/YOUR_ACCOUNT/ip-presenter.git
git push -u origin main
```

推荐描述：`Local-first interactive avatar presenter with real-time voice, grounded Q&A, and resumable narration.`

推荐 topics：`digital-human`、`avatar`、`presentation`、`realtime-voice`、`qwen`、`fastapi`。

可在仓库设置中启用 Secret scanning / Push protection（可用时）及 Private vulnerability reporting。CI 使用模拟接口，不需要配置真实模型密钥。
