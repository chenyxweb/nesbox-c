# 房间页语音功能环境变量开关 设计文档

日期：2026-09-17
范围：`packages/webapp`（`room.ts` 与 `mt-room.ts`）+ `deploy/` 构建链路

## 1. 背景与现状

房间页（web 端 [room.ts](../../../packages/webapp/src/pages/room.ts) 与 mt-app 端 [mt-room.ts](../../../packages/webapp/src/pages/mt-room.ts)）常驻渲染 `<m-room-voice>` 语音组件，点击后通过 WebRTC 麦克风采集 + `sendVoiceMsg` 信令建立房间内语音通话；mt-app 端还支持手柄 `FrontRightTop` 按键触发 `toggleVoice()`。

现状：语音功能**无条件开启**，无部署侧开关。私有化部署场景下，多余的 RTCPeerConnection 与麦克风权限请求不属于必需功能，需要能够在构建期关闭。

## 2. 目标与非目标

### 目标

- 新增环境变量 `VOICE_ENABLED` 控制语音功能，**默认关闭**
- 关闭时：web 与 mt-app 两端均不渲染语音按钮，mt-app 手柄按键触发天然失效（ref 为 undefined，可选链短路）
- 沿用项目现有 `process.env.*` + vite define 的构建期注入模式，与 `AI_SEARCH_BASE`（留空禁用）同构

### 非目标（明确不做）

- 不做运行时（后端 API 下发）开关——需要后端配合与异步时序处理，超出单一 UI 开关的需求
- 不做 UI 置灰禁用态——关闭即不渲染，不引入禁用态样式
- 不改 `room-voice.ts` 组件内部逻辑——开关只在挂载点拦截
- 不引入测试框架

## 3. 已确认的决策

| # | 决策项 | 选择 |
| --- | --- | --- |
| 1 | 环境变量名 | `VOICE_ENABLED` |
| 2 | 语义 | 留空/未设置 = 禁用（默认）；任意非空值 = 启用 |
| 3 | 注入方式 | 方案 A：vite define `process.env.VOICE_ENABLED`（与 `AI_SEARCH_BASE` 同构，拒绝 Vite 原生 `VITE_*` 与后端运行时下发两条替代路线） |
| 4 | 禁用粒度 | 完全禁用：两端均不渲染按钮，mt-app 手柄按键不生效 |
| 5 | 代码落点 | `constants.ts` 导出一处常量，两处挂载点消费 |
| 6 | 验证策略 | `tsc` + 构建产物冒烟（define 值 `''` 与 `'1'` 各构建一次确认按钮显隐） |

## 4. 配置链路与数据流

```
deploy/.env
  └─ VOICE_ENABLED=          ← 留空禁用（默认）、1/true 等非空启用
       ▼
deploy/docker-compose.yml
  └─ build.args.VOICE_ENABLED: ${VOICE_ENABLED:-}   ← 透传 build-arg
       ▼
deploy/webapp/Dockerfile
  └─ ARG VOICE_ENABLED=  →  ENV VOICE_ENABLED=$VOICE_ENABLED
       ▼
packages/webapp/vite.config.ts
  └─ define: 'process.env.VOICE_ENABLED': JSON.stringify(process.env.VOICE_ENABLED ?? '')
       ▼
packages/webapp/src/constants.ts
  └─ export const voiceEnabled = Boolean(process.env.VOICE_ENABLED)
       ▼
room.ts / mt-room.ts
  └─ ${voiceEnabled ? html`<m-room-voice …>` : ''}   ← 挂载点拦截
       ▼
mt-room.ts 手柄按键
  └─ #voiceRef.value?.toggleVoice()  ← 元素不渲染时 value === undefined，天然短路
```

## 5. 代码落点

### packages/webapp

| 文件 | 改动 |
| --- | --- |
| `vite.config.ts` | define 块新增 `'process.env.VOICE_ENABLED': JSON.stringify(process.env.VOICE_ENABLED ?? '')`，附注释"语音通话功能开关（留空禁用）" |
| `src/constants.ts` | 新增 `export const voiceEnabled = Boolean(process.env.VOICE_ENABLED);`，附注释"留空禁用，非空启用（构建期注入）" |
| `src/pages/room.ts` | 423 行语音按钮改为 `voiceEnabled ? html`<m-room-voice class="icon"></m-room-voice>` : ''`（import 常量） |
| `src/pages/mt-room.ts` | 119 行语音按钮做同样条件渲染（import 常量） |

### deploy/

| 文件 | 改动 |
| --- | --- |
| `webapp/Dockerfile` | 头注释构建参数清单补一行；`ARG VOICE_ENABLED=` + `ENV VOICE_ENABLED=$VOICE_ENABLED` |
| `docker-compose.yml` | webapp `build.args` 补 `VOICE_ENABLED: ${VOICE_ENABLED:-}`，注释"留空禁用语音" |
| `.env.example` | "前端构建参数"节补 `VOICE_ENABLED=`，注释：留空禁用（默认）；非空（如 `1`）启用 |

## 6. 边界与错误处理

- `Boolean('0') === true`：与 `AI_SEARCH_BASE` 的非空即启语义保持一致，文档注释明确"任意非空值即启用"，不额外特殊处理字符串 `'0'`
- 关闭状态下 `room-voice.ts` 仍会被构建进 bundle（tree-shaking 不生效），但不挂载即不执行其逻辑，不申请麦克风权限、不建 RTCPeerConnection——功能**可达性**关闭，非**打包体积**优化
- mt-app 端 `#voiceRef.value?.toggleVoice()` 已有可选链保护，无需改动；若未来重构去掉可选链，需同步此开关

## 7. 验证策略

1. `yarn --cwd packages/webapp build`（或 `tsc`）：默认（未设置）下构建通过
2. 冒烟验证按钮显隐：临时改 `vite.config.ts` define 值为 `'1'` 构建 → 产物含语音按钮；改回 `''` 构建 → 产物不含
3. 部署链路：`cp deploy/.env.example .env` 后 `docker compose build webapp` 观察 build-arg 透传无告警；`.env` 中设置 `VOICE_ENABLED=1` 后镜像内按钮可见