// Pi Session TPS 包入口（package.json 的 pi.extensions 指向本文件）。
// default export 为 Pi 扩展工厂；库消费面 re-export 适配层公共 API。
// 组件边界：本文件只做整合导出，不实现统计或事件逻辑（src/core、src/adapter 所有）。

export * from './src/adapter/index.ts';
export { default } from './src/adapter/index.ts';
