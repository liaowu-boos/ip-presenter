# IP Presenter · 自主交互数字人演讲

一个运行在本机的中文交互演讲原型。把讲稿、图片和审核过的知识卡交给数字人，在演讲中提问、打断、调图，再从书签继续讲解。

前端使用原生 JavaScript，后端使用 FastAPI。基础工作台无需本地大模型；千问实时语音需要使用者自行配置 API Key、业务空间与模型权限。

## 可以做什么

- **演讲与恢复**：按句播放讲稿，暂停、打断后保留主讲书签。
- **资料交互**：图片缩放、区域聚焦、并排对比、独立观众窗口。
- **问答与接管**：问题队列、作者接管、依据审核资料回答。
- **实时语音**：千问音频会话、服务端工具调用、输出音量驱动人物嘴部。
- **项目编辑**：导入图片、编辑讲稿与知识卡，在浏览器保存或导出项目。

这是研究原型。基础工作台与云端语音适配可以独立使用；视频人物、精细嘴型与动作连续性属于实验功能，需要额外模型和素材，不包含在首次启动流程中。

## 快速开始

需要 Python 3.10+。Node.js 20+ 仅用于运行 JavaScript 测试；启动工作台不需要 npm 安装。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8765
```

Windows PowerShell 中，将前两行替换为 `py -m venv .venv` 与 `.venv\Scripts\Activate.ps1`。Windows 尚未实际验证。

打开 <http://127.0.0.1:8765>，会看到通用演示材料和几何示例人物。可以直接编辑项目、调图，或在设置中选择规则演示与字幕模式。macOS 也可双击 `启动千问语音.command`，首次启动会联网安装 Python 依赖。

### 配置千问

1. 在工作台选择“千问 · 实时语音”，打开“配置千问”。
2. 填写自己的 API Key、Workspace ID 和对应地域，点击“保存并检查连接”。
3. 验证通过后开启语音会话，允许浏览器使用麦克风。
4. 可以说“开始汇报”“停一下”“继续汇报”或“我来回答”。

默认模型与音色见 `backend/qwen_realtime.py`。模型权限、地域支持和服务可用性以使用者账户的实际连接检查为准。本仓库的测试使用模拟接口，不代表云端账户或真人语音验收通过。

API Key 保存到本机 `.runtime/qwen.json`，不放进前端或项目导出。使用云端语音时，麦克风音频、审核后的文本资料与必要会话状态会发往服务提供方。主动保存的诊断录像留在本地。详见 [安全说明](SECURITY.md)。

## 目录

| 路径 | 用途 |
| --- | --- |
| `frontend/index.html`、`frontend/src/` | 工作台、演讲状态与音频播放 |
| `backend/` | 本地 API、千问会话、录制接口 |
| `scripts/` | 启动、构建、模型与视频实验工具 |
| `tests/` | 核心测试与实验回归测试 |
| `docs/` | 架构、素材导入、实验边界与发布说明 |
| `.github/` | CI 和问题模板 |

## 开发与验证

```bash
python -m pip install -r requirements-dev.txt
npm test
python -m pytest -q tests/test_backend.py tests/test_qwen.py tests/test_qwen_floor.py tests/test_qwen_interaction.py tests/test_qwen_playback.py tests/test_qwen_speech.py tests/test_performance_recordings.py
python scripts/check_public_release.py
npm run build
```

`npm test` 运行不依赖私人素材的核心测试集。`npm run test:all` 保留完整研究测试入口，其中一部分需要未分发的素材、模型、录音或 macOS 组件；它不是干净克隆的默认验收命令。

`npm run build` 生成本地 `直接预览.html`，用于离线查看工作台；实时语音仍需本地后端。构建文件不会提交到 Git。

## 素材与实验

开源版本没有包含原项目的毕业设计资料、Figma 导出、人物图片、录音、录像、模型权重或实验产物。默认人物由程序绘制的几何图形构成。历史 URL 中的 `project=thesis-trial` 在本版本同样打开通用演示。

使用自己的素材请看 [素材导入](docs/ASSETS.md)。视频舞台与模型实验请看 [实验说明](docs/EXPERIMENTS.md)，不要把历史 review 页面视为可以直接播放的在线演示。

## 贡献与许可

欢迎修复问题和完善文档，参见 [贡献指南](CONTRIBUTING.md)。提交问题时请移除密钥、录音和私人材料。

本仓库自有代码与新增通用演示使用 [MIT License](LICENSE)（[标准文本](https://opensource.org/license/mit)）。外部依赖、模型、第三方实现和自行导入素材分别受原有许可约束，参见 [第三方说明](THIRD_PARTY_NOTICES.md)。
