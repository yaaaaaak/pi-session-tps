// Pi Session TPS 适配层公共导出（整合 worker 的入口消费点）。
// 组件边界：只消费 src/core 的导出 API；本目录不依赖任何 npm 包。
// 本文件自身可作为 Pi 扩展直接加载（default export 为扩展工厂）。

import sessionTpsExtension from './extension.ts';

export { STATUS_KEY, createSessionTpsExtension } from './extension.ts';
export type { SessionTpsOptions } from './extension.ts';
export {
  MARKER_CUSTOM_TYPE,
  MARKER_VERSION,
  assistantFingerprint,
  parseMeasurementMarker,
  readUsageOutput,
  scanBranchForMeasurements,
  stopReasonToOutcome,
} from './marker.ts';
export type {
  AssistantFingerprint,
  BranchScanResult,
  MarkerMatchInfo,
  MeasurementMarkerData,
} from './marker.ts';
export { formatStatusText } from './status.ts';
export type {
  PiAdapterHandler,
  PiAssistantMessageEventLike,
  PiContentPartLike,
  PiExtensionApiLike,
  PiExtensionContextLike,
  PiMessageLike,
  PiSessionEntryLike,
  PiTurnEndEvent,
  PiUnsubscribe,
} from './pi-types.ts';

export { sessionTpsExtension };
export default sessionTpsExtension;
