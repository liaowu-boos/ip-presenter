# 第三方依赖

MIT 只覆盖本项目有权授权的自有部分，不改变依赖及使用者自行导入素材的许可。

基础依赖见 `requirements.txt`：FastAPI、Uvicorn、HTTPX、python-dotenv、OpenCC Python reimplementation、websockets，以及安装时解析的传递依赖。开发测试使用 pytest。

`backend/local_services.py` 保留 Ollama、兼容 Whisper 的本机服务及 macOS 系统语音的适配接口；本仓库不分发这些软件、模型或声音。使用者自行安装或调用时应遵守相应许可与服务条款。

依赖软件和素材的授权范围需要分别检查，本文件不构成对所有第三方组件的法律审查结论。
