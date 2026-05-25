# AI Voice Input Assistant

面向桌面端优先的 AI 语音输入助手项目。

- 项目整理文档：[docs/product-requirements.md](docs/product-requirements.md)
- MVP 开发计划：[docs/mvp-plan.md](docs/mvp-plan.md)
- 桌面端转型方案：[docs/desktop-transition-plan.md](docs/desktop-transition-plan.md)
- 本地服务入口：[server.js](server.js)

本地配置：

1. 复制 `.env.example` 为 `.env.local`。
2. 填入 `DASHSCOPE_API_KEY`。
3. ASR 热词优先在应用内“我的热词”面板维护。高级兜底配置见：[docs/hot-words.md](docs/hot-words.md)。

启动服务：`npm start`
桌面端启动: npm run desktop
打开地址(web)：`http://127.0.0.1:4173/web/index.html`
视频:https://www.bilibili.com/video/BV1PhGf6gEu3/?spm_id_from=333.1387.homepage.video_card.click
