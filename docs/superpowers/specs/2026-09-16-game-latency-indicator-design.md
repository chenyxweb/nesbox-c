# 联机房间页网络延时指示器 设计文档

日期：2026-09-16
范围：`packages/webapp`（`/room/:id` 路由下的 `room.ts` 与 `mt-room.ts`）

## 1. 背景与现状

项目中已存在一个延时显示，但覆盖不全、形态原始：

| 位置 | 现状 |
| --- | --- |
| `src/elements/ping.ts` | `<nesbox-ping>` 渲染纯文本 `Ping: {n}ms`，无分级、无图标 |
| `src/netplay/client.ts` | 客户端每 1s 发一条 `Ping` 消息 → 房主原样回显 → 客户端计算 `Date.now() - msg.timestamp` 写入 `pingStore` |
| `src/netplay/host.ts` | 房主只做回显，存了 `channel.clientPrevPing` 但从不展示 |
| `src/pages/room.ts` | 右下角 `.info`：房主看 FPS，客户端看 Ping，二者互斥 |
| `src/pages/mt-room.ts` | 右上角 `.info`：同上 |

核心缺口：**房主看不到任何延时**。而房主是帧广播源（`RTCHost.sendFrame`），恰恰是网络状况最需要被观测的一端。

此外 `client.ts` 的注释已自认现有测量不准：

> 不按顺序接收消息的问题 …… 2. ping 值不准确

原因是 data channel 以 `{ ordered: false }` 创建，应用层 Ping 的往返会被乱序污染。

## 2. 目标与非目标

### 目标

- 房主与客户端**都能**在房间内看到网络延时
- 房主看到的是所有已连接客户端中**最差**的那个（木桶短板）
- 延时以信号格图标 + 颜色分级 + 数值呈现，一眼可判好坏
- 悬停显示详情：最差玩家昵称、近期均值、近期峰值
- 测量准确度不依赖 data channel 的消息顺序

### 非目标（明确不做）

- 不做延时历史折线图
- 不做丢包率 / 抖动（jitter）统计——`getStats` 能免费拿到 `packetsLost`，但没有展示位就不采集
- 不做高延时 toast 告警或任何打断性提示
- 不做自动降级传输策略（不改 `video.rtcImprove`、不改帧发送节奏）
- 不加用户设置开关
- 不改 `/emulator` 单机页（纯本地 WASM，无网络链路）
- 不改 `/game/:id` 游戏详情页
- 不引入测试框架

## 3. 已确认的决策

| # | 决策项 | 选择 |
| --- | --- | --- |
| 1 | 目标页面 | 联机房间页（`room.ts` + `mt-room.ts`） |
| 2 | 房主端 | FPS 与延时并存，延时取最差客户端 |
| 3 | 测量方式 | `RTCPeerConnection.getStats()` 为主，现有应用层 Ping 为回退 |
| 4 | 展示形态 | 信号格图标 + 数值 + tooltip |
| 5 | 异常反馈 | 只做被动展示（颜色分级），不弹提示 |
| 6 | 可见性 | 常显，不加开关 |
| 7 | 代码落点 | 方案 A：独立 `netplay/latency.ts` 监测器，由基类 `RTCBasic` 持有 |
| 8 | 验证策略 | 不引入测试框架，靠 `tsc` + 手动验证清单 |

## 4. 架构与数据流

```
RTCBasic (netplay/common.ts)              ← 基类，host/client 共同父类
  ├─ connMap: Map<userId, RTCPeerConnection>
  ├─ roles:   Partial<Record<Player, Role>>       ← 提供 nickname
  ├─ createRTCPeerConnection(userId)      ← 【注册点】monitor.add(userId, conn)
  ├─ deleteUser(userId)                   ← 【注销点】monitor.remove(userId)
  ├─ getFallbackLatency()                 ← 默认返回 {}，子类覆写（L2 回退源）
  └─ monitor: LatencyMonitor
              │
              ▼
LatencyMonitor (netplay/latency.ts)       ← 新增，唯一含测量逻辑的地方
  ├─ 自递归 setTimeout 1s 循环
  ├─ Promise.allSettled(conns.map(c => c.getStats()))
  ├─ 挑出 nominated && state === 'succeeded' 的 candidate-pair
  ├─ currentRoundTripTime(秒) × 1000 → ms，取整
  ├─ per-peer 环形缓冲（30 样本 = 30s）→ avg / max
  └─ 写入 latencyStore
              │
              ▼
latencyStore (createState)
  { peers: Record<userId, { rtt, avg, max, nickname }>, worst?: number }
              │
              ▼
<nesbox-latency> (elements/latency.ts)    ← 只读 store，不含任何测量逻辑
  ├─ 信号格图标（复用 net.ts 的 signalIcon）+ 颜色分级
  ├─ 数值 `${worst}ms`
  └─ nesbox-tooltip：最差玩家 / 当前值 / 近期均值 / 峰值
              │
              ▼
room.ts / mt-room.ts                      ← 房主: FPS + latency；客户端: latency
```

### 为什么注册点放在基类

`createRTCPeerConnection` 与 `deleteUser` 都定义在 `RTCBasic`（`common.ts`），房主（`host.ts#onOffer`）和客户端（`client.ts#startClient`）都经由它们建连/断连。因此存在单点 hook，**两端零分支**。

同时「取所有连接里最差的那个」这个聚合语义，对客户端（只有 1 条连接）会自然退化为「到房主的 RTT」。所以：

- `<nesbox-latency>` 不需要知道自己是房主还是客户端
- `room.ts` / `mt-room.ts` 都不需要为延时写 `#isHost` 分支

### 为什么不放在 `RTCBasic.destroy()`

`RTCBasic.destroy` 是空方法，而 `RTCClient.destroy` 与 `RTCHost.destroy` 均以**类属性箭头函数**定义同名成员，会直接遮蔽基类实现。写进 `RTCBasic.destroy` 的逻辑永远不会执行。

但两个子类的 `destroy` 都会执行 `this.connMap.forEach((_, id) => this.deleteUser(id))`。因此注销点放在 `deleteUser`，并由「peers 归零即停表」兜住生命周期，才是可靠路径。

## 5. 测量算法

### 采样循环

使用**自递归 `setTimeout`** 而非 `setInterval`。`getStats()` 是异步的，在 WebView 上偶尔会慢；`setInterval` 会导致采样任务堆积重叠。自递归保证「上一轮全部 await 完成后才排下一轮」，天然串行化。

```
tick():
  if (peers.size === 0) { timer = 0; return }          ← 前置守卫
  results = await Promise.allSettled(conns.map(sample))
  if (peers.size === 0) { timer = 0; return }          ← await 后二次守卫（关键）
  写入 latencyStore
  timer = setTimeout(tick, 1000)
```

### candidate-pair 挑选

遍历 `RTCStatsReport`，优先级：

1. `type === 'candidate-pair'` && `nominated === true` && `state === 'succeeded'`
2. 若无 nominated，退回任一 `state === 'succeeded'` 且 `currentRoundTripTime != null` 的 pair
3. 都没有 → 该 peer 走回退链

**不要使用 `selected` 属性**——它已从 W3C 规范移除，新浏览器不再返回。

### 单位换算

`currentRoundTripTime` 的单位是**秒**（double），不是毫秒：`Math.round(rtt * 1000)`。这是整个功能唯一可能「数值差 1000 倍」的坑点，必须在验证清单中显式核对。

### 三级回退链

| 级别 | 来源 | 覆盖场景 |
| --- | --- | --- |
| L1 | `getStats()` 的 `currentRoundTripTime` | Chrome / Edge / Firefox 正常情况 |
| L2 | `RTCBasic.getFallbackLatency()` | Safari / WKWebView 拿不到 stats |
| L3 | 该 peer 不写入 store；全空则元素渲染空 | 连接刚建立、ICE 未完成 |

L2 用多态实现，避免监测器内部出现 `isHost` 分支：

- `RTCBasic.getFallbackLatency()` → `{}`（默认）
- `RTCClient` 覆写 → `{ [configure.user!.id]: pingStore.ping }`（客户端的连接以自身 userId 为键，见 `client.ts#createRTCPeerConnection(configure.user!.id)`）
- `RTCHost` 覆写 → 遍历 `connMap`，对每条连接取 `channelMap.get(conn)?.clientPrevPing`

> 精度说明：房主侧的 L2 值（`clientPrevPing`）是客户端**自报**的、且滞后一个采样周期的 ping（`Ping` 消息携带的是 `prevPing`）。它不是房主亲自测量的 RTT，精度低于 L1，仅作降级显示之用。

L3 保留现有 `ping.ts` 中「无数据即返回空模板」的行为——宁可什么都不显示，也不显示错的数字。

### 滚动窗口

每个 peer 保留最近 **30 个样本（= 30 秒）**，计算 `avg` / `max` 供 tooltip 使用。

用固定长度环形数组（`buf[i % 30]`），不用 `push` / `shift`——`fps.ts` 那种 `shift` 写法每帧都在移动数组，无必要继承该开销。

### 聚合

`worst = max(peers[*].rtt)`

## 6. 阈值与视觉分级

复用 `theme.ts` 的语义色（三套主题自动适配）：

| 延时 | 颜色 | dim 掉的 part | 依据 |
| --- | --- | --- | --- |
| ≤ 100ms | `theme.positiveColor` | 无（全亮） | 60fps 下约 6 帧延迟，动作游戏可接受 |
| 101–200ms | `theme.noticeColor` | `g4` | 约 12 帧，开始能感觉到 |
| > 200ms | `theme.negativeColor` | `g3`, `g4` | 明显卡顿 |

边界值归属：`100 → positive`、`101 → notice`、`200 → notice`、`201 → negative`。

项目配置了跨洲 TURN 中继（`common.ts` 的 `turn:eu-0.turn.peerjs.com` / `us-0`）。走中继时 RTT 天然会落进红区——**这是正确的指示，不是缺陷**，正是本功能要暴露的信息。

## 7. UI 组件

### 图标来源

复用 `elements/net.ts` 的 WiFi 信号图（圆点 + 3 道弧）。该图标每道弧都带 `part="g2/g3/g4"`，正是分级显示所需的机制——`net.ts` 现已用 `::part()` + `opacity: 0.5` 弱化信号差的弧。

决定：**在 `net.ts` 给 `onlineIcon` 加 `export` 并改名 `signalIcon`，latency 元素 import 复用**。不新建图标资源、不复制 SVG，与导航栏网络指示器视觉一致。

> 备选方案（挪进 `icons.ts` 统一注册）不采纳：`icons.ts` 的 `genIcon` 产出单一 `<path part="icon">`，没有分弧的 part，挪过去反而要重写图标结构，收益不抵成本。

颜色通过 `fill="currentColor"` 生效，宿主元素按分级设置 `color`。

### 元素重命名

`elements/ping.ts` → `elements/latency.ts`，标签 `<nesbox-ping>` → `<nesbox-latency>`。

理由：它现在展示的是 RTT 而非应用层 ping，且与新增的 `netplay/latency.ts` 命名对齐。仅牵动 4 行（两个页面各 1 行 import + 1 行标签）。

`pingStore` **保持原名不动**——它确实就是应用层 ping，身份降级为 L2 回退源。`pingStore`（原始 ping 采样）与 `latencyStore`（解析后的最终值）并存，准确表达了分层。

### 元素结构

- `@adoptedStyle(fpsStyle)` —— 与 FPS 读数视觉一致（`0.875em` + `tabular-nums`）
- `@connectStore(latencyStore)`
- `@shadow()`
- 外层包 `<nesbox-tooltip>`，`position` 按 `isMtApp` 切 `bottomRight` / `topRight`（照抄 `room-voice.ts` 用法）
- 无数据时返回空模板（沿用现有 `ping.ts` 的空渲染行为）

### Tooltip 内容

```
网络延时                       ← tooltip.room.latency
最差玩家 李四 180ms            ← 仅 peers > 1 时加"最差玩家"前缀
均值 142ms · 峰值 233ms        ← tooltip.room.latencyStats
```

`peers === 1`（客户端）时第二行直接渲染 `张三 23ms`——纯昵称 + 数字，不含可翻译词汇，**不需要 i18n key**。

### 无障碍

给 `<dy-use>` 加 `role="img"` + `aria-label=${i18n.get('tooltip.room.latency')}`，避免读屏器只念出一串数字而无上下文。

> 实施阶段更正：`signalIcon` 是 `net.ts` 里手写的 `raw` 模板，其 SVG **并没有** `aria-hidden="true"`（只有 `icons.ts` 中 `genIcon` 产出的图标才带）。但 `role="img"` 会把整个子树折叠为单一图像节点，内部装饰性 path 不会单独暴露给辅助技术，因此结果依然正确——仅最初给出的理由不成立。

## 8. 页面接线

### room.ts（右下角 `.info`）

```
改前：  ${#isHost ? <nesbox-fps> : <nesbox-ping>}   [录制] [语音]
改后：  ${#isHost ? <nesbox-fps> : ''}  <nesbox-latency>   [录制] [语音]
```

FPS 仍房主独占，延时变为**无条件渲染**。房主一行 4 项、客户端 3 项，`dy-space` 自动排布。

### mt-room.ts（右上角 `.info`）

拆开现有的 `v-if` / `v-else` 对：`<nesbox-fps v-if=${isHost}>` 保留，`<nesbox-latency>` 无条件跟在其后。

### 约束

**两个页面都不得引入 `latencyStore`。** 这是「渲染不级联到 canvas」结论的前提：`p-room` 当前只 `@connectStore(store)` 与 `@connectStore(configure)`，`latencyStore` 每秒的更新只重渲染 `<nesbox-latency>` 这个几十字节的元素，`<m-stage>` 与 canvas 完全不受影响。

## 9. i18n

新增 3 个 key。`i18n.get` 支持 `$1` / `$2` 位置插值（参照 `"page.friend.playing": "正在玩《$1》"`）。

| key | zh-CN | en |
| --- | --- | --- |
| `tooltip.room.latency` | 网络延时 | Network latency |
| `tooltip.room.latencyWorst` | 最差玩家 | Worst peer |
| `tooltip.room.latencyStats` | 均值 $1ms · 峰值 $2ms | Avg $1ms · Peak $2ms |

**语言覆盖策略**：`l10n.toml` 中 `reference = "src/locales/zh-CN/*.json"`，且 `i18n/basic.ts` 的 `LocaleKey` 类型由 `typeof zhCN` 推导。因此：

- **zh-CN 必须改**（否则类型检查不通过）
- **en 一并补齐**（现状 en 仅缺 2 个 key，维持该惯例）
- ja / zh-TW 缺 key 时由 `fallbackLanguage = 'zh-CN'` 自动兜底，交给 Pontoon 后续翻译，不在本次范围

## 10. 错误处理

### 10.1 用 `Promise.allSettled` 而非 `Promise.all`

`all` 只要一个连接 reject 就丢掉全部结果——一个客户端断开会让房主的所有延时数据同时消失。`allSettled` 保留成功的那些，rejected 的 peer 单独走 L2 / L3 回退。

### 10.2 `destroy()` 与 in-flight `await` 的竞态

```
tick() → await Promise.allSettled(...)   ← 此期间用户离开房间，deleteUser 被逐个调用
       → 若仅依赖 clearTimeout，此刻并无 pending timer 可清
       → await 返回后执行 setTimeout(tick, 1000)   ← 定时器复活，永久泄漏
```

后果是一个 1Hz 轮询在离开房间后继续运行，反复对已关闭的连接调 `getStats()`。

对策见第 5 节的 **await 后二次守卫**：`await` 返回后重新检查 `peers.size === 0`，为空则置 `timer = 0` 并直接 return，不再排下一轮。配合 `remove()` 中「peers 归零即 clearTimeout」，两条路径共同保证无泄漏。

### 10.3 `0` 是合法 RTT，全链路禁用 falsy 判断

`currentRoundTripTime` 可能为 `0`（< 0.5ms 的本地回环）。所有判断一律使用 `!= null`。

这与第 11 节要修的 `!channel.clientPrevPing` 是**同一类缺陷**，两处一起改，并在代码中留注释说明原因。

### 10.4 昵称缺失不抛错

`RoleAnswer` 尚未到达时 `roles` 查不到 nickname，tooltip 该行退化为只显示数值。nickname 在采样时随 peer 一并写入 store，因此下一秒的采样会自动补上。

### 10.5 重连后滚动窗口清零

`client.ts#restart()` 会 `destroy()` + `start()`，monitor 随之重建，30 个样本的历史清空。这是**正确行为**——旧链路的样本已不能代表新链路（可能从 P2P 切换到了 TURN 中继）。

### 10.6 后台标签页不做特殊处理

浏览器会把 `setTimeout` 节流到 ≥ 1s，而本设计的间隔正好是 1s，几乎无影响。增加 `visibilitychange` 处理属于过度设计，不做。

## 11. 顺带修复的既有缺陷

`netplay/host.ts` 的 `sendFrame` 中：

```ts
// Wait for client to send ping
if (!channel.clientPrevPing) return;
```

falsy 判断意味着一旦某个客户端的 ping 恰好为 `0`，房主会**永久停止向该客户端发帧**（该玩家画面卡死）。改为：

```ts
if (channel.clientPrevPing === undefined) return;
```

该字段本次会被 L2 回退读取，属于必须一并处理的相邻代码。1 行改动。

## 12. 性能影响评估

结论：**影响可忽略**。项目内已有更激进的 `getStats()` 使用先例。

| 已存在的开销 | 频率 | 备注 |
| --- | --- | --- |
| 语音音量条 `room-voice.ts` | **每 60ms**，对每个 receiver + 每个 sender 各调一次 `getStats(track)` | 4 人房 ≈ **67 次 getStats/秒**，已在生产运行 |
| FPS 表 `fps.ts` | 每帧 rAF（60Hz），每帧 `push`/`shift` + `reduce` 最多 100 个元素 | 房主端全程开启 |
| 现有 Ping `client.ts` | 每 1s 发一条 JSON 走 data channel | **有网络往返**，占用无序通道带宽 |
| 模拟器主循环 `game.ts#requestFrame` | 60fps | 真正敏感的路径 |
| **本次新增** | **每 1000ms**，对 ≤ 3 条连接各调一次 `getStats()` | ≈ **3 次/秒**，**零网络流量** |

新增量约为现有语音模块 getStats 负载的 **4.5%**。且 `getStats()` 只读浏览器本地统计计数器，**不产生任何网络包**——比现有「每秒发一条 Ping 消息」更轻。

### 两条硬约束

1. **监测器绝不进入帧循环**。它是独立的 1Hz `setTimeout`，与 `requestFrame` 的 60fps 路径零耦合，不读不写任何帧相关状态。
2. **纯只读**。不碰 `sendFrame`、不碰 `video.rtcImprove`、不改帧发送节奏。因此对**联机同步正确性零风险**。

### 已识别的成本控制手段

- `getStats()` 不带参数会返回全量 report（比语音用的 `getStats(track)` 大，因为 `candidate-pair` 不挂在任何 track 上）。对策：单一定时器 + `Promise.allSettled` 并发（不串行等待）、提取完 `currentRoundTripTime` 立即丢弃 report 引用不留存、严格 1Hz 不提频。

## 13. 待验证项与风险

`room-voice.ts` 中存在注释 `// Safari not support`（针对 `media-source.audioLevel`），说明项目已踩过 WebRTC stats 在 Safari / WKWebView 上的兼容性坑。项目另有 `packages/tauriapp` 与 `packages/flutter_app`，运行于系统 WebView。

因此 `currentRoundTripTime` 在 Safari / WKWebView 上**可能取不到**。本设计不断言其可用性，而由三级回退链兜住：用户侧最多是「看不到数字」，不会看到错的数字。

此项列为实施阶段的**必须验证项**（见第 14 节清单第 6 条）。

## 14. 验证清单

无自动化测试，实施后逐条人工勾选。

1. **单位换算**：Chrome DevTools 对照 `chrome://webrtc-internals` 的 `currentRoundTripTime`，确认页面显示的 ms 数值为其 1000 倍取整（专治 1000 倍坑）
2. **房主 + 1 客户端**：两端都显示延时，数值应接近
3. **房主 + 3 客户端**：房主显示最差那个；tooltip 列出该玩家昵称与「最差玩家」前缀
4. **阈值边界**：用 DevTools 网络限速构造 < 100ms / 100–200ms / > 200ms 三档，确认颜色与信号格数正确切换
5. **TURN 中继**：在 `chrome://webrtc-internals` 确认 candidate-pair 为 relay 类型时，指示器应落红区
6. **Safari / WKWebView**：验证 L2 回退是否生效（第 13 节的待验证项）。若 macOS Tauri 构建可用，一并验证
7. **定时器泄漏**：反复进出房间 10 次，用 DevTools Performance 面板确认没有累积的 1Hz 定时器（专治第 10.2 条竞态）
8. **数值不残留**：离开房间后重新进入，确认不显示上一局的延时值
9. **语音共存**：开启语音（60ms getStats 轮询）后确认延时指示器正常，无异常或卡顿
10. **重连**：客户端断网重连后，确认滚动窗口重置且数值恢复
11. **两个页面**：`room.ts`（右下角）与 `mt-room.ts`（右上角）均需验证，注意 `.info` 位置不同
12. **主题适配**：三套主题（default / punk / retro）下颜色均可辨识
13. **i18n**：zh-CN 与 en 切换后 tooltip 文案正确；切到 ja / zh-TW 确认回退到 zh-CN 而非显示 key 原文
14. **无障碍**：读屏器能念出「网络延时」而非孤立数字
15. **`yarn lint`**：biome + `tsc --noEmit` 全通过（CI 唯一门禁）

## 15. 涉及文件清单

| 文件 | 变更 |
| --- | --- |
| `src/netplay/latency.ts` | **新增**：`LatencyMonitor` 类 + `latencyStore` + 纯函数（挑选 candidate-pair、秒转毫秒、分级、环形窗口、回退优先级） |
| `src/netplay/common.ts` | `RTCBasic` 持有 monitor；`createRTCPeerConnection` 注册；`deleteUser` 注销；新增 `getFallbackLatency()` 默认实现 |
| `src/netplay/client.ts` | 覆写 `getFallbackLatency()`；`destroy` 保留现有 `pingStore({ ping: undefined })` 清理 |
| `src/netplay/host.ts` | 覆写 `getFallbackLatency()`；修复 `!channel.clientPrevPing` → `=== undefined` |
| `src/elements/net.ts` | `onlineIcon` 加 `export` 并改名 `signalIcon` |
| `src/elements/latency.ts` | **新增**（由 `ping.ts` 重命名 + 改造） |
| `src/elements/ping.ts` | **删除** |
| `src/pages/room.ts` | import 改名；延时改为无条件渲染 |
| `src/pages/mt-room.ts` | import 改名；拆开 `v-if`/`v-else` |
| `src/locales/zh-CN/basic.json` | 新增 3 个 key（类型来源，必须） |
| `src/locales/en/basic.json` | 新增 3 个 key |
