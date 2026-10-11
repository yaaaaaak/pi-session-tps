# pi-session-tps

[Pi coding agent](https://github.com/earendil-works/pi) 扩展：在 TUI 状态栏同时显示**当轮 TPS** 与**会话 TPS**（加权口径），并给出估算标记与已测覆盖率。

- 兼容版本：针对 **Pi 1.1.0** 开发并验证（事件契约、marker 持久化时序均按 1.1.0 源码核查）。
- 零运行时依赖：不依赖 host SDK、不捆绑任何 host 包、无网络/计时器/进程。

## 显示示例

扩展使用独立 status key `pi-session-tps`，不接管 footer。状态栏一行显示：

```
当轮 12.3 | 会话 15.7 tok/s | 已测 3/5
```

- `当轮`：当前处理周期（见下）的 tokens/s。
- `会话`：当前分支已测响应的加权 tokens/s。
- `~` 前缀（如 `当轮 ~12.3`）：该值为估算或实时估计（见「token 来源」）。
- `--`：尚无有效数据（首轮开始前、或尚无任何可计时长），不会把时长夹成 1ms 制造速度。
- `已测 m/n`：**已测模型响应数 / 当前分支模型响应总数**。n 为当前分支直接 assistant 条目数，m 为其中有有效配对计量记录、合法正生成时长的响应数。它不是用户对话轮数，也不是准确率；一轮工具往返可能产生多条 assistant 响应。例如当前分支累计 5 次模型响应，全部有效计量时显示 `已测 5/5`。

轮结束后保留最近一轮数值；新的处理周期从 `agent_start` 开始，重置当轮统计。

## 统计定义

### 当轮（cycle）定义

一轮 = 从本轮首个 `agent_start` 到 `agent_settled` 的完整处理周期。其中：

- 同一轮内的后续 `agent_start`（自动重试、compaction 续跑、queued follow-up 合并）幂等，不清零。
- `agent_settled` 之后才算本轮结束；`agent_end` 不是结算边界。
- queued 输入可能被合并处理，因此「一轮」不保证严格对应一条用户消息。

### 会话（weighted session）

会话 TPS = 当前分支所有贡献响应的 tokens 总和 / 这些响应的有效生成时长总和（Σtokens / ΣgenerationMs × 1000，加权口径），**不是**各轮 TPS 的算术平均。会话值实时包含当前正在生成的内容；每条响应结束后只结算一次，不重复累计。未测历史不参与计算，因此会话值不保证覆盖安装前的整个会话。

### 生成时长口径（TTFT / 工具 / 闲置排除）

每条直接的 assistant 响应：

- 从首个非空的 `text_delta` / `thinking_delta` / `toolcall_delta` 开始计时，到 `message_end` 停止，包含流内停顿。
- **排除**：首 token 延迟（TTFT）、工具执行时间、用户闲置、重试退避、`*_start` 事件（不算生成内容）。
- 时间用 `performance.now()` 自测；不使用原生 `AssistantMessage.durationMs`（它包含 TTFT，口径不符）。
- 一轮内多条模型响应（工具往返、重试）逐条计时累加，不丢失、不重复。

### token 来源：provider output vs `~` 估算

- 优先采用 provider 在 `message_end` 给出的最终 `usage.output`（不加 `usage.reasoning`）。
- 输出非空但 `usage.output` 缺失/为零初始值/非法时，按**累计可见内容**（text、thinking、全部工具参数）做确定性字符比率估算（ASCII≈4 chars/token，CJK≈1.5 chars/token），并标记 `~`。
- 实时（流式中）显示的值属于估计值，一律加 `~`；部分使用估算的聚合也保持 `~`。
- 不计入：toolResult 内嵌的模型 usage、compaction、cache warming、stream chunk 数（绝不用 chunk 数冒充 token 数）。
- 估算按逻辑流隔离累计：同类不同内容块/不同工具调用以 Pi 事件的 `contentIndex` 为流身份，交错到达次序不改变最终估算；text/thinking/工具参数三类互不拼接，跨 delta 的 Unicode 代理对只在所属流内配对；缺省/非法 contentIndex 归入确定的兼容流。

### 可见内容局限

估算只累计本扩展观察到的 delta 内容：

- provider 在 `*_start` 即交付完整内容、不产生 delta 的场景（如部分 redacted thinking）会低估，以 `~` 标记传达。
- 估算为固定字符比率启发式，非 tokenizer 精度。
- 覆盖范围内的 `已测 m/n` 用于判断可信度：未测历史只进入分母 n，不进入任一 TPS 的分子/分母；`m/n` 不是整段历史的全量速度，未计入 m 的响应不参与任何 TPS。

### 失败 / 取消 / 重试

- 有可观察内容且时长合法的部分输出计入（token 不足时用显式 `~` 估算补足）；无内容失败不贡献 tokens/时长、不写 marker。
- 实际发生的重试生成各自计一次（一次真实生成就算一段）；退避等待不计。
- `context_edit` 只改模型上下文，不会从当前分支的生成历史中扣除失败响应。

### 当前 branch 与恢复

- 统计与覆盖率都基于**当前分支**（`getBranch()`）：`session_start`（startup/reload/new/resume/fork）与 `session_tree` 导航时按当前分支重建，并清除活动计时起点。
- **完整观测与保守拒算**：只有观察到该响应 `message_start` 的流才按完整口径结算（最终 provider output ÷ 自测窗口）。Pi reload 或扩展晚加载后仅见到局部 delta、或只收到 `message_end` 的响应保守拒算：不进入任何 TPS 的分子/分母、不写可计量 marker，只计入 `已测 m/n` 的分母（真实落盘 assistant 仍算一条）。流式中的 provisional 展示可继续（带 `~`），但结算口径拒算——不能用完整 tokens 除以局部时间冒充测量。
- **防御性丢弃**：被新消息、异常或生命周期边界打断且没有对应真实落盘 assistant 的流被整体丢弃：不贡献 TPS，也不计入 coverage（total 与 measured 都不加）。
- 持久化机制：`message_end`（扩展事件）先于 assistant 消息落盘，扩展在该事件中用 `pi.appendEntry()` 写入前置 measurement marker（仅含 version、roundId、segmentId、自测时长、回退估算与匹配指纹，不存正文）；随后落盘的 assistant 消息在恢复时与 marker 一次性配对，提供最终 usage。
- **marker 版本与兼容**：当前写入 v2 marker——正文指纹采用结构无歧义编码（带类型的结构化序列化后摘要），单块内容与多块拼接不会产生相同编码。旧 v1 marker（歧义编码时代写入）保守不配对：不贡献 TPS/measured，仅其后的真实 assistant 计入 `已测 m/n` 分母；不迁移、不重算。
- **持久化后校准**：每条 assistant 落盘后的 `turn_end` 边界按当前分支完整配对扫描校准 coverage 与配对贡献：以真实分支条目为权威，live 与恢复记录不双算，不清当前轮/多响应累计；重复结束通知不会制造多个响应。其他扩展只改写最终 `usage.output` 且仍可配对时，用落盘后的 tokens/tokenSource 替换原贡献，保证校准后与 reload 的会话值一致。
- **安装前历史无法还原**：marker 只有安装后才会写入，安装前已存在的会话历史没有生成时长数据，只能进入 `已测 m/n` 的分母，不会被伪装成已测。
- 其他扩展若在本扩展观察 `message_end` 后、assistant 落盘前改写正文，`turn_end` 校准与恢复配对会在指纹不一致时作废该条：该响应排除在 measured/TPS 之外，但真实条目仍保留在分母 n 中。正文指纹使用 FNV-1a 32 位非加密摘要，存在碰撞可能，仅用于变更检测，不提供强完整性或安全保证。

## 为什么与其他 TPS 插件的数值不同？

本插件逐条累加「首个非空 delta → message_end」的生成时间，不使用整轮墙钟耗时。如果另一个插件从整轮首次输出连续计到 `agent_end`，即使采用暂停/恢复扣时，两者对后续请求等待、工具间隔的处理仍可能不同。会话加权值也不能直接与最近一轮或滑动窗口值比较；还需确认 token 来源是否相同、是否带 `~`、覆盖范围是否一致。数值不同本身不代表某一方计算错误。

## 安装与试用

在仓库根目录单次试用（不写入安装设置）：

```bash
pi -e .
```

从其他目录试用：`pi -e /path/to/pi-session-tps`。本地目录按 Pi 的 package 发现规则加载（本包 `package.json` 的 `pi.extensions` 指向 `index.ts`），运行扩展无需先执行 `npm install` 或编译。

安装本地仓库（会写入 Pi 设置，目录必须保留）：

```bash
pi install /path/to/pi-session-tps
```

仓库已推送到 GitHub 后，也可从 Git 安装：

```bash
pi install git:github.com/yaaaaaak/pi-session-tps
```

移除：`pi remove <source>`；查看：`pi list`。不要同时加载本地和 Git 副本，以免重复注册同一扩展。详见 Pi 官方文档 [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

## 开发与验证

开发与验证需要 Node >= 22.19（与 Pi 1.1.0 的 engines 要求一致；`npm test` 依赖原生 TypeScript test runner，本项目在 Node v24.14.0 上验证）。

```bash
npm ci --ignore-scripts  # 按 lockfile 安装开发依赖，用于 typecheck
npm test           # node --test：内核/适配层单元测试 + tests/verification 真实 Pi SDK 验证
npm run typecheck  # tsc --noEmit（strict，覆盖 index.ts、src、scripts、tests 全量）
npm run check:loader  # 用本机真实 Pi dist/core/extensions/loader.js 做加载/注册/合成事件冒烟（不发 LLM 请求）
npm pack --dry-run   # 检查发布包内容（不含 node_modules/测试/临时文件）
```

**真实 Pi 环境前提**：完整 `npm test` 不只是模拟事件测试——`tests/verification/**` 会动态加载本机真实 Pi 1.1.0 的 SessionManager 与扩展 loader 做黑盒验证，因此需要本机已安装 Pi 1.1.0（不发起 LLM 请求）。`npm test` 与 `npm run check:loader` 使用同一套解析规则：默认从 `~/.pi/agent/install/current-version` 解析到 `releases/<版本>/node_modules/@earendil-works/pi-coding-agent`；可用环境变量 `PI_SESSION_TPS_PI_DIR` 直接指定该包目录，或 `PI_AGENT_DIR` 指定 agent 目录。未安装 Pi 时这些验证会报环境阻塞而非跳过。

## 项目结构

```
index.ts               # 包入口（pi.extensions 指向此文件），default export 为扩展工厂
src/core/              # 纯统计内核（零 Pi 依赖，时间全注入）
src/adapter/           # Pi 1.1.0 事件/持久化适配层 + TUI status
tests/core/ tests/adapter/  # 单元/事件模拟测试（内核可控时钟、适配层边界/配对/恢复）
tests/verification/    # 真实 Pi SDK 黑盒验证（真实 SessionManager/loader，需已安装 Pi 1.1.0）
scripts/check-loader.mts    # 真实 Pi loader 冒烟脚本（9 事件注册 + 完整一轮含 turn_end 校准）
.gitignore             # 排除依赖、生成产物、日志及本地交接资料
```

Git 保留源码、测试、配置、lockfile 与公开文档；内部规格、历史交接、session 导出、依赖目录和临时验证日志属于本地资料，由 `.gitignore` 排除。发布包另由 `package.json` 的 `files` 白名单限定，不包含测试、开发脚本或内部资料。

验证采用合成流事件和真实 Pi loader/SessionManager，不请求外部 LLM，也不修改用户 Pi 设置；它不等同于真实模型性能基准或完整 TUI 屏幕渲染测试。其他 Pi 版本尚未验证。

## 参考来源与许可

- 设计参考：[gsanhueza/pi-token-speed](https://github.com/gsanhueza/pi-token-speed) @ `b708faf217fb139c51cf8f8df0ca9c4050e489c8`（MIT）。本项目为独立实现，未复制其代码；不复刻其设置菜单、颜色阈值、滑动窗口与 TTFT 展示。
- 本包 license：MIT（见 [LICENSE](LICENSE)）；第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
