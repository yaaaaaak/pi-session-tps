# Third-Party Notices

## 参考项目（未复制代码）

- **gsanhueza/pi-token-speed** — https://github.com/gsanhueza/pi-token-speed
  参考版本/commit：`b708faf217fb139c51cf8f8df0ca9c4050e489c8`，License: MIT。
  用途：作为「在 Pi 中显示 tokens/s」的产品设计参考。本项目为独立实现，
  未复制其源代码；因此无需携带其版权声明。若后续引入其代码片段，必须
  在本文件补充其版权与许可声明。

## 运行环境

- 本包由 [Pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）加载。扩展使用本地结构化类型描述所需事件/API 子集，不导入 host SDK，不捆绑、不分发任何 Pi host 包；`package.json` 无运行时 dependencies。依赖规则见 Pi 官方 [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。
- 开发依赖（不进入发布包运行时）：`typescript`（Apache-2.0）、`@types/node`（MIT），仅用于 `npm run typecheck`。
