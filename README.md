# IP Presenter · 交互数字人演讲

运行在本机的中文交互演讲工作台。导入自己的图片、讲稿和审核过的知识卡，在演讲中提问、打断、调图，再从书签继续讲解。

前端使用原生 JavaScript，后端使用 FastAPI。默认提供独立绘制的几何机器人和通用图表演示；不包含原作者的个人设计、人物素材、录音或项目资料。

## 功能

- 按句播放讲稿，暂停与打断后保留主讲书签。
- 图片缩放、区域聚焦、并排对比、独立观众窗口。
- 问题队列、作者接管、依据审核知识卡回答。
- 千问实时语音、工具调用、输出音量驱动简单嘴部开合。
- 项目编辑、浏览器保存、JSON 导入与导出。

这是研究原型，精确唇形同步、视频人物和模型实验不在本次公开范围。

## 快速开始

需要 Python 3.10+。Node.js 20+ 仅用于 JavaScript 测试；启动工作台不需要 npm 安装。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8765
```

打开 <http://127.0.0.1:8765>。不接模型也可编辑项目、调图，或在设置中使用规则演示与字幕模式。macOS 可双击 `启动千问语音.command`，首次启动会联网安装 Python 依赖。

Windows PowerShell 将前两行替换为 `py -m venv .venv` 与 `.venv\Scripts\Activate.ps1`。Windows 尚未实际验证。

### 配置实时语音

1. 选择“千问 · 实时语音”，点击“配置千问”。
2. 填写自己的 API Key、Workspace ID 和对应地域，保存并检查连接。
3. 验证通过后开启语音会话，允许浏览器使用麦克风。
4. 可以说“开始汇报”“停一下”“继续汇报”或“我来回答”。

默认模型与音色见 `backend/qwen_realtime.py`，使用者需自行取得对应地域与模型权限。测试使用模拟接口，不表示云端账户或真人语音验收通过。

密钥保存在本机 `.runtime/qwen.json`。使用云端语音时，音频、审核后的文本资料与必要会话状态会发往提供方。详见 [安全说明](SECURITY.md)。

## 目录与开发

| 路径 | 用途 |
| --- | --- |
| `frontend/` | 工作台、演讲状态、音频播放与通用演示 |
| `backend/` | 本地 API、实时语音会话、录制接口 |
| `scripts/` | 启动、离线构建、发布内容检查 |
| `tests/` | 不依赖原始素材的核心测试 |
| `docs/` | 架构、素材导入、验证与发布说明 |

```bash
python -m pip install -r requirements-dev.txt
npm test
python -m pytest -q
python scripts/check_public_release.py
npm run build
```

构建生成 `直接预览.html`，可离线查看工作台；实时语音仍需本地后端。构建产物不提交到 Git。

## 素材与公开范围

通过界面上传自己的 PNG、JPEG、WebP，编辑讲稿和知识卡，再导出项目备份。见 [素材说明](docs/ASSETS.md) 和 [架构](docs/ARCHITECTURE.md)。

公开范围限于通用工作台代码和独立生成的示例。原作者的设计内容、IP 形象、图片、源文件、私人讲稿、历史实验页面与数据均不提供，也不属于本仓库的许可范围。

## 更新与维护

近期变更见 [更新记录](CHANGELOG.md)，验证范围见 [验证记录](docs/VALIDATION.md)。维护现有仓库请参考 [同步与发布指南](docs/PUBLISHING.md)。

## 贡献与许可

欢迎提交修复和文档改进，参见 [贡献指南](CONTRIBUTING.md)。不要在 Issue 或 PR 中提交凭证、录音或私人素材。

自有代码与通用演示采用 [MIT License](LICENSE)。第三方依赖保留其原有许可，参见 [第三方说明](THIRD_PARTY_NOTICES.md)。
