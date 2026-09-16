# 联机房间页网络延时指示器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让联机房间页（`/room/:id`）的房主与客户端都能看到网络延时，房主看到的是所有客户端中最差的那个。

**Architecture:** 新增 `LatencyMonitor`（`src/netplay/latency.ts`），由基类 `RTCBasic` 持有，在 `createRTCPeerConnection` / `deleteUser` 两个基类方法上单点挂接，因此 host 与 client 零分支。监测器每 1s 用 `RTCPeerConnection.getStats()` 读 `candidate-pair.currentRoundTripTime`，经三级回退链解析后写入 `latencyStore`，由 `<nesbox-latency>` 元素纯展示。

**Tech Stack:** TypeScript、@mantou/gem（Web Components + `createState` 响应式 store）、duoyun-ui、WebRTC（`RTCPeerConnection.getStats()`）、Vite、Biome。

**Spec:** `docs/superpowers/specs/2026-09-16-game-latency-indicator-design.md`

---

## 关于验证方式的重要说明

本计划**不含单元测试**，这是设计文档第 3 节决策 #8 明确选定的（项目全仓库 0 个测试文件、无 vitest/jest，CI 只跑 `yarn lint`）。因此每个任务的验证门禁是：

1. **`cd packages/webapp && npx tsc --noEmit`** —— 类型正确性（基线已确认为 exit 0，任何输出都是回归）
2. **`yarn lint`**（仓库根）—— Biome 格式 + 全 monorepo 类型检查，等同 CI 门禁
3. **桌测表**（desk-check）—— 纯函数给出「输入 → 期望输出」对照表，实施时逐条比对代码
4. **Task 12 的手动验证清单** —— 行为正确性最终由浏览器实测确认

不要为了补测试而引入测试框架，那属于超出本功能范围的项目级决策。

## 关键约束（违反即返工）

- **`0` 是合法 RTT**。全链路禁止 falsy 判断，一律用 `== null` / `=== undefined`。
- **`currentRoundTripTime` 单位是秒**，必须 `Math.round(rtt * 1000)`。
- **监测器绝不进入帧循环**，不碰 `sendFrame`、`video.rtcImprove`、帧发送节奏。
- **`room.ts` / `mt-room.ts` 不得 import `latencyStore`**，否则渲染会级联到 canvas。
- **`verbatimModuleSyntax: true`**：仅类型使用的 import 必须写 `import type`。
- 不要把停表逻辑写进 `RTCBasic.destroy`——它被两个子类的类属性箭头函数遮蔽，永不执行。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/netplay/latency.ts` | **新增**。唯一含测量逻辑的模块：纯函数（秒转毫秒、挑选 candidate-pair、分级、环形窗口）+ `latencyStore` + `LatencyMonitor` 类 |
| `src/netplay/common.ts` | 修改。`RTCBasic` 持有 monitor，在建连/断连处挂接，提供 `getFallbackLatency()` 默认实现 |
| `src/netplay/host.ts` | 修改。覆写 `getFallbackLatency()`；修复 `!channel.clientPrevPing` 的 falsy 缺陷 |
| `src/netplay/client.ts` | 修改。覆写 `getFallbackLatency()` |
| `src/elements/net.ts` | 修改。`onlineIcon` 加 `export` 并改名 `signalIcon`，供延时元素复用 |
| `src/elements/latency.ts` | **新增**。`<nesbox-latency>`：信号格图标 + 颜色分级 + 数值 + tooltip，纯展示 |
| `src/elements/ping.ts` | **删除**（Task 11，等两个页面都切走之后） |
| `src/pages/room.ts` | 修改。延时改为无条件渲染，FPS 仍房主独占 |
| `src/pages/mt-room.ts` | 修改。拆开 `v-if` / `v-else` |
| `src/locales/zh-CN/basic.json` | 修改。新增 3 个 key（`LocaleKey` 类型来源，必须） |
| `src/locales/en/basic.json` | 修改。新增 3 个 key |

任务顺序刻意安排为**每一步之后仓库都处于可编译状态**：Task 8 新建 `latency.ts` 时不删 `ping.ts`（两者标签名不同，可共存），Task 9/10 分别切换页面，Task 11 才删除已无引用的 `ping.ts`。

---

### Task 1: `netplay/latency.ts` —— 纯函数与 store

**Files:**
- Create: `packages/webapp/src/netplay/latency.ts`

- [ ] **Step 1: 创建文件，写入完整内容**

```ts
import { createState } from '@mantou/gem';

/** 采样窗口长度（样本数），配合 1s 采样间隔即 30 秒 */
export const SAMPLE_COUNT = 30;

export type LatencyTier = 'good' | 'fair' | 'poor';

/**
 * 延时分级阈值（ms）
 * - ≤ 100ms：60fps 下约 6 帧延迟，动作游戏可接受
 * - 101–200ms：约 12 帧，开始能感觉到
 * - > 200ms：明显卡顿
 */
export const getTier = (ms: number): LatencyTier => (ms <= 100 ? 'good' : ms <= 200 ? 'fair' : 'poor');

/** 各分级需要弱化的信号弧 part，与 elements/net.ts 的 signalIcon 对应 */
export const TIER_DIM_PARTS: Record<LatencyTier, string[]> = {
  good: [],
  fair: ['g4'],
  poor: ['g3', 'g4'],
};

/** 各分级对应的 theme 语义色 key，延迟到渲染时取值以保持主题响应 */
export const TIER_COLOR_KEY: Record<LatencyTier, 'positiveColor' | 'noticeColor' | 'negativeColor'> = {
  good: 'positiveColor',
  fair: 'noticeColor',
  poor: 'negativeColor',
};

/**
 * `currentRoundTripTime` 的单位是秒，必须 ×1000 转毫秒。
 * 注意 0 是合法值（<0.5ms 的本地回环），因此用 `== null` 而非 falsy 判断。
 */
export const rttToMs = (rtt?: number | null): number | undefined =>
  rtt == null ? undefined : Math.round(rtt * 1000);

/**
 * 从 RTCStatsReport 中挑出当前生效的 candidate-pair 的 RTT（单位：秒）。
 * 优先 `nominated && state === 'succeeded'`；否则退回任一 succeeded 且有 RTT 的 pair。
 * 不使用 `selected` 属性——它已从 W3C 规范移除，新浏览器不再返回。
 */
export const pickCandidatePair = (report: RTCStatsReport): number | undefined => {
  let fallback: number | undefined;
  for (const stat of report.values()) {
    if (stat.type !== 'candidate-pair') continue;
    const pair = stat as RTCIceCandidatePairStats;
    const rtt = pair.currentRoundTripTime;
    if (pair.state !== 'succeeded' || rtt == null) continue;
    if (pair.nominated) return rtt;
    fallback ??= rtt;
  }
  return fallback;
};

/** 固定长度环形窗口，避免 push/shift 反复移动数组 */
export class SampleWindow {
  #buf: number[] = [];
  #index = 0;

  push = (value: number) => {
    if (this.#buf.length < SAMPLE_COUNT) {
      this.#buf.push(value);
    } else {
      this.#buf[this.#index] = value;
    }
    this.#index = (this.#index + 1) % SAMPLE_COUNT;
  };

  get avg() {
    if (!this.#buf.length) return 0;
    return Math.round(this.#buf.reduce((acc, val) => acc + val, 0) / this.#buf.length);
  }

  get max() {
    if (!this.#buf.length) return 0;
    return Math.max(...this.#buf);
  }
}

export type LatencyPeer = {
  rtt: number;
  avg: number;
  max: number;
  nickname: string;
};

export const latencyStore = createState<{
  peers: Record<number, LatencyPeer>;
  worst?: number;
}>({ peers: {} });
```

- [ ] **Step 2: 桌测表逐条比对**

对照代码确认下列行为（无测试框架，靠读代码核对）：

| 函数 | 输入 | 期望输出 | 验证的是什么 |
| --- | --- | --- | --- |
| `rttToMs` | `0.023` | `23` | 秒→毫秒换算 |
| `rttToMs` | `0` | `0` | 0 不被吞掉 |
| `rttToMs` | `undefined` | `undefined` | 空值透传 |
| `rttToMs` | `null` | `undefined` | 空值透传 |
| `getTier` | `100` | `'good'` | 边界归属 |
| `getTier` | `101` | `'fair'` | 边界归属 |
| `getTier` | `200` | `'fair'` | 边界归属 |
| `getTier` | `201` | `'poor'` | 边界归属 |
| `pickCandidatePair` | 只有 `nominated:true, state:'succeeded', rtt:0.05` | `0.05` | 主路径 |
| `pickCandidatePair` | `nominated:true, rtt:0.2` 与 `nominated:false, rtt:0.05` 并存 | `0.2` | nominated 优先 |
| `pickCandidatePair` | 只有 `nominated:false, state:'succeeded', rtt:0.05` | `0.05` | 无 nominated 时退回 |
| `pickCandidatePair` | `nominated:true, state:'failed', rtt:0.05` | `undefined` | state 过滤 |
| `pickCandidatePair` | 空 report | `undefined` | 空值 |
| `SampleWindow` | push 1..35 后取 `avg` | `21`（仅最近 30 个：6..35） | 窗口溢出 |
| `SampleWindow` | push 1..35 后取 `max` | `35` | 窗口溢出 |
| `SampleWindow` | 未 push 直接取 `avg` / `max` | `0` / `0` | 空窗口 |

- [ ] **Step 3: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 4: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/netplay/latency.ts
git commit -m "feat: 新增网络延时测量的纯函数与 latencyStore"
```

---

### Task 2: `netplay/latency.ts` —— `LatencyMonitor` 类

**Files:**
- Modify: `packages/webapp/src/netplay/latency.ts`（在文件末尾追加）

- [ ] **Step 1: 在 `latencyStore` 定义之后追加以下代码**

```ts
type MonitorOptions = {
  /** 从 RTCBasic.roles 解析昵称，RoleAnswer 未到达时返回 undefined */
  getNickname: (userId: number) => string | undefined;
  /** L2 回退源，由 RTCBasic 子类覆写 */
  getFallback: () => Record<number, number | undefined>;
};

/** 采样间隔（ms）。用自递归 setTimeout 而非 setInterval，避免 getStats 变慢时任务堆积重叠 */
const INTERVAL = 1000;

export class LatencyMonitor {
  #conns = new Map<number, RTCPeerConnection>();
  #windows = new Map<number, SampleWindow>();
  #getNickname: (userId: number) => string | undefined;
  #getFallback: () => Record<number, number | undefined>;
  #timer = 0;
  /**
   * 与 #timer 分离：tick 的 await 期间 #timer 为 0，
   * 此时若 add() 仅凭 #timer 判断就会再起一条循环，导致双循环。
   */
  #running = false;

  constructor({ getNickname, getFallback }: MonitorOptions) {
    this.#getNickname = getNickname;
    this.#getFallback = getFallback;
  }

  add = (userId: number, conn: RTCPeerConnection) => {
    this.#conns.set(userId, conn);
    if (!this.#running) {
      this.#running = true;
      this.#schedule();
    }
  };

  remove = (userId: number) => {
    this.#conns.delete(userId);
    this.#windows.delete(userId);
    if (this.#conns.size === 0) this.#stop();
  };

  #stop = () => {
    clearTimeout(this.#timer);
    this.#timer = 0;
    this.#running = false;
    latencyStore({ peers: {}, worst: undefined });
  };

  #schedule = () => {
    this.#timer = window.setTimeout(this.#tick, INTERVAL);
  };

  #tick = async () => {
    this.#timer = 0;
    if (this.#conns.size === 0) {
      this.#running = false;
      return;
    }

    const entries = [...this.#conns];
    const fallback = this.#getFallback();
    // allSettled 而非 all：单个连接 reject 不应让全部延时数据一起消失
    const results = await Promise.allSettled(entries.map(([, conn]) => conn.getStats()));

    // await 之后二次守卫：此期间可能已离开房间（conns 被清空），
    // 若继续排下一轮就会永久泄漏一个 1Hz 定时器，反复对已关闭连接调 getStats。
    if (this.#conns.size === 0) {
      this.#running = false;
      return;
    }

    const peers: Record<number, LatencyPeer> = {};
    let worst: number | undefined;
    results.forEach((result, index) => {
      const [userId] = entries[index];
      const statsRtt = result.status === 'fulfilled' ? pickCandidatePair(result.value) : undefined;
      // L1 → L2。用 `??` 而非 `||`，保证 0ms 是合法值不会误触回退
      const rtt = rttToMs(statsRtt) ?? fallback[userId];
      // L3：两级都拿不到则该 peer 不写入 store
      if (rtt == null) return;

      let win = this.#windows.get(userId);
      if (!win) {
        win = new SampleWindow();
        this.#windows.set(userId, win);
      }
      win.push(rtt);

      peers[userId] = { rtt, avg: win.avg, max: win.max, nickname: this.#getNickname(userId) || '' };
      worst = worst === undefined ? rtt : Math.max(worst, rtt);
    });

    latencyStore({ peers, worst });
    this.#schedule();
  };
}
```

- [ ] **Step 2: 桌测表逐条比对生命周期**

| 场景 | 期望行为 |
| --- | --- |
| `add(1, connA)` | `#running = true`，排出一个 1s 定时器 |
| 紧接着 `add(2, connB)` | `#running` 已为 true，**不**再排第二个定时器（无双循环） |
| `remove(1)`，仍有 connB | 不触发 `#stop()`，store 不清空，循环继续 |
| `remove(2)`，conns 归零 | `#stop()`：清定时器、`#running = false`、store 重置为 `{ peers: {}, worst: undefined }` |
| tick 的 `await` 期间所有 conn 被 remove | await 返回后二次守卫命中 → `#running = false` 且**不**再 `#schedule()`（这是防泄漏的关键路径） |
| tick 的 `await` 期间 `add` 了新 conn | `#running` 仍为 true，`add` 不重复起循环；await 返回后守卫不命中，正常写 store 并排下一轮 |
| 某个 conn 的 `getStats()` reject | `allSettled` 保留其他结果，该 peer 走 L2/L3，其余 peer 正常写入 |
| 某 peer 的 L1 与 L2 都无值 | 该 peer 不出现在 `peers` 中，不参与 `worst` 计算 |

- [ ] **Step 3: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 4: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/netplay/latency.ts
git commit -m "feat: 新增 LatencyMonitor 采样循环与防泄漏守卫"
```

---

### Task 3: i18n key

**Files:**
- Modify: `packages/webapp/src/locales/zh-CN/basic.json`（在 `"tooltip.room.leave"` 之前插入）
- Modify: `packages/webapp/src/locales/en/basic.json`（在 `"tooltip.room.leave"` 之前插入）

`LocaleKey` 类型由 `typeof zhCN` 推导（见 `src/i18n/basic.ts`），因此 **zh-CN 必须先改**，否则 Task 8 的元素代码类型检查不通过。ja / zh-TW 缺 key 时由 `fallbackLanguage = 'zh-CN'` 自动兜底，本次不改。

注意 `i18n.get(key, ...rest)` 的 rest 参数类型是 `string`，**不接受 number**，传值时必须 `String(...)`。

- [ ] **Step 1: 修改 `src/locales/zh-CN/basic.json`**

找到：

```json
  "tooltip.room.leave": "离开房间",
```

在它**之前**插入三行（key 按字母序，`latency*` 在 `leave` 之前）：

```json
  "tooltip.room.latency": "网络延时",
  "tooltip.room.latencyStats": "均值 $1ms · 峰值 $2ms",
  "tooltip.room.latencyWorst": "最差玩家",
```

- [ ] **Step 2: 修改 `src/locales/en/basic.json`**

找到：

```json
  "tooltip.room.leave": "Leave room",
```

在它**之前**插入三行：

```json
  "tooltip.room.latency": "Network Latency",
  "tooltip.room.latencyStats": "Avg $1ms · Peak $2ms",
  "tooltip.room.latencyWorst": "Worst peer",
```

- [ ] **Step 3: 校验 JSON 合法且 key 无重复**

Run:
```bash
cd /Users/chen/work/study/nesbox-c/packages/webapp/src/locales
node -e "for (const l of ['zh-CN','en']) { const o = require('./'+l+'/basic.json'); console.log(l, Object.keys(o).length, o['tooltip.room.latency'], '|', o['tooltip.room.latencyStats'], '|', o['tooltip.room.latencyWorst']); }"
```
Expected: 两行输出，各自 key 总数比改动前 +3，且三个新 key 的值都能打印出来（不是 `undefined`）

- [ ] **Step 4: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 5: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/locales/zh-CN/basic.json packages/webapp/src/locales/en/basic.json
git commit -m "feat: 新增网络延时指示器的 i18n 文案"
```

---

### Task 4: `elements/net.ts` —— 导出信号图标

**Files:**
- Modify: `packages/webapp/src/elements/net.ts`

该图标是「圆点 + 3 道弧」，每道弧带 `part="g2/g3/g4"`，正是分级弱化所需的机制。导出复用以避免复制 SVG。

- [ ] **Step 1: 把 `onlineIcon` 改名为 `signalIcon` 并导出**

找到：

```ts
const onlineIcon = raw`
```

改为：

```ts
/** 信号格图标（圆点 + 3 道弧），每道弧带 part 以便按需弱化。elements/latency.ts 复用 */
export const signalIcon = raw`
```

SVG 内容本身**不动**。

- [ ] **Step 2: 更新同文件内的引用**

在 `render` 中找到：

```ts
      <dy-use .element=${navigator.onLine ? onlineIcon : offlineIcon}></dy-use>
```

改为：

```ts
      <dy-use .element=${navigator.onLine ? signalIcon : offlineIcon}></dy-use>
```

- [ ] **Step 3: 确认没有遗漏的 `onlineIcon` 引用**

Run: `grep -rn "onlineIcon" packages/webapp/src || echo "无残留引用"`
Expected: `无残留引用`

- [ ] **Step 4: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 5: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/elements/net.ts
git commit -m "refactor: 导出 net 元素的信号图标以供复用"
```

---

### Task 5: `netplay/common.ts` —— `RTCBasic` 挂接监测器

**Files:**
- Modify: `packages/webapp/src/netplay/common.ts`

- [ ] **Step 1: 新增 import**

`common.ts` 现有的 import 块只有三行：

```ts
import { type Button, Player } from '@mantou/nes';
import { configure } from 'src/configure';
import type { LocaleKey } from 'src/i18n/basic';
```

在 `import type { LocaleKey } from 'src/i18n/basic';` 之后新增一行（`configure` < `i18n/basic` < `netplay/latency`，符合 Biome 的 `:ALIAS:` 组字母序）：

```ts
import { LatencyMonitor } from 'src/netplay/latency';
```

> 无循环依赖：`latency.ts` 只从 `@mantou/gem` import，不反向依赖 `netplay/` 下任何模块。

- [ ] **Step 2: 在 `RTCBasic` 类中新增 monitor 成员与回退方法**

找到：

```ts
export abstract class RTCBasic extends EventTarget {
  connMap = new Map<number, RTCPeerConnection>();
  channelMap = new Map<RTCPeerConnection, RTCDataChannel>();
  roles: Partial<Record<Player, Role>> = {};

  stream: MediaStream;
```

改为：

```ts
export abstract class RTCBasic extends EventTarget {
  connMap = new Map<number, RTCPeerConnection>();
  channelMap = new Map<RTCPeerConnection, RTCDataChannel>();
  roles: Partial<Record<Player, Role>> = {};

  stream: MediaStream;

  /**
   * L2 回退源：getStats 拿不到 currentRoundTripTime 时（如 Safari / WKWebView）使用。
   * 默认无回退，由 RTCClient / RTCHost 覆写。
   */
  getFallbackLatency = (): Record<number, number | undefined> => ({});

  /**
   * 延时监测器。挂在基类上，host 与 client 共用同一套聚合逻辑：
   * 房主有多条连接时取最差客户端，客户端只有一条连接时自然退化为「到房主的 RTT」。
   */
  monitor = new LatencyMonitor({
    getNickname: (userId) => Object.values(this.roles).find((role) => role?.userId === userId)?.nickname,
    getFallback: () => this.getFallbackLatency(),
  });
```

> 说明：`getFallback` 用箭头包一层延迟调用 `this.getFallbackLatency()`。子类的类属性在基类属性之后赋值，而该箭头只在 tick 时才执行，因此能正确解析到子类覆写版本。

- [ ] **Step 3: 在 `deleteUser` 开头挂注销点**

找到：

```ts
  deleteUser = (userId: number) => {
    const conn = this.connMap.get(userId);
    this.connMap.delete(userId);
```

改为：

```ts
  deleteUser = (userId: number) => {
    // 注销点。放在最前，确保即使后续分支提前返回也已完成注销。
    // 注意：不能挂在本类的 destroy 上——RTCClient / RTCHost 用类属性箭头函数定义了同名成员，
    // 会遮蔽基类实现，导致基类 destroy 永不执行；而两者的 destroy 都会 forEach 调用 deleteUser。
    this.monitor.remove(userId);
    const conn = this.connMap.get(userId);
    this.connMap.delete(userId);
```

- [ ] **Step 4: 在 `createRTCPeerConnection` 末尾挂注册点**

找到：

```ts
    this.stream.getTracks().forEach((track) => conn.addTrack(track, this.stream));
    this.connMap.set(userId, conn);
    return conn;
  };
```

改为：

```ts
    this.stream.getTracks().forEach((track) => conn.addTrack(track, this.stream));
    this.connMap.set(userId, conn);
    this.monitor.add(userId, conn);
    return conn;
  };
```

> `createRTCPeerConnection` 首行已有 `this.deleteUser(userId)`，因此同一 userId 重连时会先 `remove` 再 `add`，滚动窗口随之清零——这是设计文档 §10.5 期望的行为（旧链路样本不代表新链路）。

- [ ] **Step 5: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 6: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/netplay/common.ts
git commit -m "feat: RTCBasic 挂接延时监测器与 L2 回退接口"
```

---

### Task 6: `netplay/host.ts` —— 覆写回退源并修复既有缺陷

**Files:**
- Modify: `packages/webapp/src/netplay/host.ts`

- [ ] **Step 1: 修复 `sendFrame` 的 falsy 判断缺陷**

找到：

```ts
    this.channelMap.forEach((channel) => {
      // Wait for client to send ping
      if (!channel.clientPrevPing) return;
```

改为：

```ts
    this.channelMap.forEach((channel) => {
      // Wait for client to send ping
      // 必须用 undefined 判断：ping 为 0 是合法值，
      // 原先的 falsy 判断会导致该客户端永久收不到帧（画面卡死）
      if (channel.clientPrevPing === undefined) return;
```

- [ ] **Step 2: 覆写 `getFallbackLatency`**

在 `RTCHost` 类中，`#setRoles` 定义之前插入：

```ts
  /**
   * L2 回退：客户端自报的 ping（`Ping` 消息携带的 `prevPing`，滞后一个采样周期）。
   * 不是房主亲自测量的 RTT，精度低于 getStats，仅作降级显示之用。
   */
  getFallbackLatency = (): Record<number, number | undefined> => {
    const result: Record<number, number | undefined> = {};
    this.connMap.forEach((conn, userId) => {
      result[userId] = this.channelMap.get(conn)?.clientPrevPing;
    });
    return result;
  };
```

- [ ] **Step 3: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 4: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/netplay/host.ts
git commit -m "fix: 修复 clientPrevPing 为 0 时房主停止发帧的缺陷并支持延时回退"
```

---

### Task 7: `netplay/client.ts` —— 覆写回退源

**Files:**
- Modify: `packages/webapp/src/netplay/client.ts`

- [ ] **Step 1: 覆写 `getFallbackLatency`**

在 `RTCClient` 类中，`#onSignal` 定义之前插入：

```ts
  /**
   * L2 回退：现有的应用层 ping（每 1s 发 Ping 消息、房主回显后计算得出）。
   * 客户端的连接以自身 userId 为键（见 #startClient 中的 createRTCPeerConnection）。
   */
  getFallbackLatency = (): Record<number, number | undefined> => ({
    [configure.user!.id]: pingStore.ping,
  });
```

- [ ] **Step 2: 确认 `pingStore` 的清理逻辑保持不动**

`RTCClient.destroy` 末尾的 `pingStore({ ping: undefined });` **必须保留**。设计文档 §5 要求离开房间后数值不残留；`latencyStore` 的清理由 `monitor.remove` → `#stop()` 负责，两者互不替代。

Run: `grep -n "pingStore({ ping: undefined })" packages/webapp/src/netplay/client.ts`
Expected: 输出 1 行匹配（在 `destroy` 中）

- [ ] **Step 3: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 4: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/netplay/client.ts
git commit -m "feat: RTCClient 支持延时 L2 回退到应用层 ping"
```

---

### Task 8: 新增 `elements/latency.ts`

**Files:**
- Create: `packages/webapp/src/elements/latency.ts`

本任务**不删除** `elements/ping.ts`。两者标签名不同（`nesbox-latency` / `nesbox-ping`），可安全共存，等 Task 9/10 把两个页面都切走后再于 Task 11 删除。这样每一步之后仓库都能编译。

用 `@shadow()` 而非无 shadow：照抄 `elements/net.ts` 已验证可用的组合——注入的 `<style>` 需要被限定在 shadow root 内，`dy-use::part(gN)` 选择器才能生效。

- [ ] **Step 1: 创建文件，写入完整内容**

```ts
import {
  adoptedStyle,
  connectStore,
  css,
  customElement,
  GemElement,
  html,
  shadow,
} from '@mantou/gem';
import { isMtApp } from '@nesbox/mtapp';
import { fpsStyle } from 'src/elements/fps';
import { signalIcon } from 'src/elements/net';
import { i18n } from 'src/i18n/basic';
import { getTier, latencyStore, TIER_COLOR_KEY, TIER_DIM_PARTS } from 'src/netplay/latency';
import { theme } from 'src/theme';

import 'duoyun-ui/elements/use';
import 'src/elements/tooltip';

const style = css`
  :host {
    display: inline-flex;
    align-items: center;
  }
  dy-use {
    width: 1.2em;
  }
`;

@customElement('nesbox-latency')
@adoptedStyle(fpsStyle)
@adoptedStyle(style)
@connectStore(latencyStore)
@shadow()
export class NesboxLatencyElement extends GemElement {
  /** 生成弱化指定信号弧的 CSS 规则；无需弱化时返回空串 */
  #dimRule = (parts: string[]) => {
    if (!parts.length) return '';
    return `${parts.map((part) => `dy-use::part(${part})`).join(', ')} { opacity: 0.5; }`;
  };

  render = () => {
    const { peers, worst } = latencyStore;
    // 用 == null 而非 falsy：0ms 是合法延时，不能被隐藏
    if (worst == null) return html``;

    const tier = getTier(worst);
    // 用普通 style 字符串而非 styleMap：同一颜色要同时给 dy-use 与 span，
    // 而 styleMap 返回的是有状态 directive，仓库内无任何复用同一 directive 的先例
    const color = `color: ${theme[TIER_COLOR_KEY[tier]]};`;
    const peer = Object.values(peers).find((item) => item.rtt === worst);
    // 只有一个 peer 时（客户端）不加"最差玩家"前缀——只有一个连接无所谓最差
    const label = Object.keys(peers).length > 1 ? i18n.get('tooltip.room.latencyWorst') : '';
    const peerLine = [label, peer?.nickname, `${worst}ms`].filter(Boolean).join(' ');

    return html`
      <style>
        ${this.#dimRule(TIER_DIM_PARTS[tier])}
      </style>
      <nesbox-tooltip
        position=${isMtApp ? 'bottomRight' : 'topRight'}
        .content=${html`
          <div>${i18n.get('tooltip.room.latency')}</div>
          <div>${peerLine}</div>
          <div>
            ${i18n.get(
              'tooltip.room.latencyStats',
              String(peer?.avg ?? worst),
              String(peer?.max ?? worst),
            )}
          </div>
        `}
      >
        <dy-use role="img" aria-label=${i18n.get('tooltip.room.latency')} style=${color} .element=${signalIcon}></dy-use>
        <span style=${color}>${worst}ms</span>
      </nesbox-tooltip>
    `;
  };
}
```

- [ ] **Step 2: 桌测表逐条比对渲染分支**

| 场景 | 期望渲染 |
| --- | --- |
| `worst === undefined`（L3，无任何数据） | 空模板，什么都不显示 |
| `worst === 0` | **正常显示** `0ms`，绿色全亮（验证 falsy 陷阱已避开） |
| `worst === 80`，单 peer，nickname `张三` | 绿色全亮；`80ms`；tooltip 第二行 `张三 80ms`（无前缀） |
| `worst === 150`，3 peers，最差者 nickname `李四` | `noticeColor`，`g4` 弱化；tooltip 第二行 `最差玩家 李四 150ms` |
| `worst === 250` | `negativeColor`，`g3` 与 `g4` 弱化 |
| peer 的 nickname 为空串（RoleAnswer 未到） | tooltip 第二行退化为 `180ms`，不显示 `undefined`、不抛错 |
| 切换主题（default / punk / retro） | 颜色随 `theme[...]` 变化（`Theme<T>` 是响应式 Sheet，渲染时取值即可） |

- [ ] **Step 3: 确认页面尚未引用（此时应无匹配）**

Run: `grep -rn "nesbox-latency" packages/webapp/src/pages || echo "页面尚未接线（符合预期）"`
Expected: `页面尚未接线（符合预期）`

- [ ] **Step 4: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 5: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/elements/latency.ts
git commit -m "feat: 新增 nesbox-latency 延时指示器元素"
```

---

### Task 9: `pages/room.ts` 接线

**Files:**
- Modify: `packages/webapp/src/pages/room.ts`

- [ ] **Step 1: 替换 import**

找到（约第 50-51 行）：

```ts
import 'src/elements/fps';
import 'src/elements/ping';
```

改为：

```ts
import 'src/elements/fps';
import 'src/elements/latency';
```

原地将 `ping` 替换为 `latency` 即可。现有顺序本就非字母序（第 49 行 `list` 在第 50 行 `fps` 之前），说明 Biome 的 organizeImports 不重排副作用 import，因此不会因改名而触发额外变动。

- [ ] **Step 2: 替换 render 中的 info 区**

找到（约第 420 行）：

```ts
        ${this.#isHost ? html`<nesbox-fps></nesbox-fps>` : html`<nesbox-ping></nesbox-ping>`}
```

改为：

```ts
        ${this.#isHost ? html`<nesbox-fps></nesbox-fps>` : ''}
        <nesbox-latency></nesbox-latency>
```

FPS 仍房主独占；延时变为无条件渲染。房主一行 4 项、客户端 3 项，`dy-space` 自动排布。

- [ ] **Step 3: 确认页面没有引入 `latencyStore`**

Run: `grep -n "latencyStore" packages/webapp/src/pages/room.ts || echo "未引入（符合约束）"`
Expected: `未引入（符合约束）`

这是「渲染不级联到 canvas」的前提：`p-room` 只 `@connectStore(store)` 与 `@connectStore(configure)`，`latencyStore` 每秒的更新只重渲染 `<nesbox-latency>` 自身。

- [ ] **Step 4: 确认 `.info` 位置**

Run: `grep -n -A 4 "\.info {" packages/webapp/src/pages/room.ts`
Expected: 输出含 `right: 1rem;` 与 `bottom: 1rem;`——**room.ts 的 info 区在右下角**（与 mt-room.ts 的右上角不同，验证时注意）

- [ ] **Step 5: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 6: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/pages/room.ts
git commit -m "feat: 房间页房主与客户端均展示网络延时"
```

---

### Task 10: `pages/mt-room.ts` 接线

**Files:**
- Modify: `packages/webapp/src/pages/mt-room.ts`

- [ ] **Step 1: 替换 import**

找到（约第 29-30 行）：

```ts
import 'src/elements/fps';
import 'src/elements/ping';
```

改为：

```ts
import 'src/elements/fps';
import 'src/elements/latency';
```

- [ ] **Step 2: 拆开 `v-if` / `v-else`**

找到（约第 117-118 行）：

```ts
        <nesbox-fps v-if=${this.#playing?.host === configure.user?.id}></nesbox-fps>
        <nesbox-ping v-else></nesbox-ping>
```

改为：

```ts
        <nesbox-fps v-if=${this.#playing?.host === configure.user?.id}></nesbox-fps>
        <nesbox-latency></nesbox-latency>
```

- [ ] **Step 3: 确认页面没有引入 `latencyStore`**

Run: `grep -n "latencyStore" packages/webapp/src/pages/mt-room.ts || echo "未引入（符合约束）"`
Expected: `未引入（符合约束）`

- [ ] **Step 4: 类型检查**

Run: `cd packages/webapp && npx tsc --noEmit`
Expected: 无输出，exit 0

- [ ] **Step 5: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add packages/webapp/src/pages/mt-room.ts
git commit -m "feat: mt 房间页展示网络延时"
```

---

### Task 11: 删除 `elements/ping.ts`

**Files:**
- Delete: `packages/webapp/src/elements/ping.ts`

- [ ] **Step 1: 确认已无任何引用**

Run: `grep -rn "elements/ping\|nesbox-ping\|NesboxPingElement" packages/webapp/src || echo "无引用，可安全删除"`
Expected: `无引用，可安全删除`

若仍有输出，说明 Task 9 或 Task 10 未完成，**先回去补完**，不要删除文件。

- [ ] **Step 2: 确认 `pingStore` 仍被保留**

Run: `grep -rn "pingStore" packages/webapp/src`
Expected: 匹配出现在 `netplay/client.ts`（定义、写入、L2 回退读取、destroy 清理）。`pingStore` 不随 `ping.ts` 删除——它仍是 L2 回退源，且 `host.ts` 的发帧闸门依赖 `clientPrevPing`。

- [ ] **Step 3: 删除文件**

Run: `git rm packages/webapp/src/elements/ping.ts`
Expected: `rm 'packages/webapp/src/elements/ping.ts'`

- [ ] **Step 4: 跑完整 CI 门禁**

Run: `cd /Users/chen/work/study/nesbox-c && yarn lint`
Expected: Biome 无报错（可能自动格式化，若有改动需 `git add` 后一并提交）；`tsc --noEmit` 全 monorepo 通过，exit 0

- [ ] **Step 5: Commit**

```bash
cd /Users/chen/work/study/nesbox-c
git add -A
git commit -m "refactor: 移除已被 nesbox-latency 取代的 ping 元素"
```

---

### Task 12: 手动验证

无自动化测试，本任务是行为正确性的唯一保障，**必须逐条执行并记录结果**。

- [ ] **Step 1: 启动开发服务器**

Run: `yarn --cwd packages/webapp start`

`packages/webapp/.env`（已被 gitignore，仅本机生效）已配置 `DEV_PROXY_TARGET=https://nesbox.voida.asia:19991`，Vite 会把 `/api/*`（含 WebSocket）与 `/files/*` 代理到远端服务，因此可直接联调真实联机。

- [ ] **Step 2: 准备双端环境**

用两个独立的浏览器上下文登录两个账号（如 Chrome 普通窗口 + 无痕窗口），一个创建房间当房主，另一个加入当客户端。另开一个标签页打开 `chrome://webrtc-internals` 作为数值参照。

- [ ] **Step 3: 逐条执行验证清单**

| # | 验证项 | 操作 | 期望 |
| --- | --- | --- | --- |
| 1 | **单位换算**（防 1000 倍坑） | 在 `chrome://webrtc-internals` 找到选中 candidate-pair 的 `currentRoundTripTime`，与页面显示值对比 | 页面 ms 值 = 该值 × 1000 后四舍五入，误差 ≤ 1ms |
| 2 | 房主 + 1 客户端 | 两端都进入房间 | **两端都显示延时**（房主同时显示 FPS），数值接近 |
| 3 | 房主 + 3 客户端 | 再加两个客户端加入，其中一端用 DevTools 限速制造高延时 | 房主显示最差那个的值；tooltip 第二行为 `最差玩家 {昵称} {值}ms` |
| 4 | 阈值边界 | 用 DevTools → Network → Throttling 自定义档位构造 < 100ms / 100–200ms / > 200ms | 颜色依次为 `positiveColor` / `noticeColor` / `negativeColor`；信号弧弱化数量依次为 0 / 1 / 2 道 |
| 5 | TURN 中继 | 在 `chrome://webrtc-internals` 确认 candidate-pair 的 candidate 类型为 `relay` | 指示器应落红区——这是正确指示，不是缺陷 |
| 6 | **Safari / WKWebView 回退** | 用 Safari 打开同一房间（或 macOS 的 Tauri 构建） | 若 `getStats` 拿不到 RTT，应经 L2 回退仍显示数值（客户端回退到 `pingStore`）。**若显示为空，记录到下方"待确认"并检查 `getFallbackLatency` 是否被正确覆写** |
| 7 | **定时器泄漏**（防竞态） | 反复进出房间 10 次，DevTools → Performance 录制整个过程 | 录制结束后不应有持续累积的 1Hz 定时器/任务；离开房间后 `getStats` 调用应停止 |
| 8 | 数值不残留 | 离开房间后立刻重新进入另一个房间 | 不显示上一局的延时值；新房间连接建立前短暂为空，随后出现新值 |
| 9 | 语音共存 | 开启房间语音（`room-voice` 每 60ms 轮询 getStats） | 延时指示器正常更新，无报错、无可感知卡顿 |
| 10 | 重连 | 客户端断开网络数秒后恢复 | `#restart` 触发重连，滚动窗口重置（tooltip 的均值/峰值从新值重新累积），数值恢复 |
| 11 | 两个页面位置 | 分别验证 `room.ts` 与 `mt-room.ts` | room 在**右下角**、mt-room 在**右上角**，两处都正常显示且不与录制/语音图标重叠 |
| 12 | 主题适配 | 设置中切换 default / punk / retro 三套主题 | 三档颜色在各主题下均可辨识 |
| 13 | i18n | 切换 zh-CN / en / ja / zh-TW | zh-CN 与 en 显示各自文案；ja / zh-TW 回退到 zh-CN 中文，**不得显示 key 原文**（如 `tooltip.room.latency`） |
| 14 | 无障碍 | 用读屏器（macOS VoiceOver）聚焦延时图标 | 先念出「网络延时」再念数值，而不是孤立的数字 |
| 15 | 0ms 边界 | 本地环回或极低延时场景（若能构造） | 显示 `0ms` 而非空白——验证 falsy 陷阱 |
| 16 | 房主不发帧缺陷已修 | 长时间联机观察 | 房主不会因某客户端 ping 为 0 而停止发帧（原缺陷：该玩家画面卡死） |

- [ ] **Step 4: 最终 CI 门禁**

Run: `cd /Users/chen/work/study/nesbox-c && yarn lint`
Expected: exit 0，无 Biome 报错、无 tsc 报错

- [ ] **Step 5: 记录待确认项并提交**

若第 6 项（Safari / WKWebView 回退）未能验证或行为不符预期，在 `docs/superpowers/specs/2026-09-16-game-latency-indicator-design.md` 第 13 节追加实测结论。

```bash
cd /Users/chen/work/study/nesbox-c
git add -A
git commit -m "docs: 补充网络延时指示器的实测验证结论"
```

（若无需追加结论，跳过本步的提交。）

---

## Self-Review 记录

计划写完后对照 spec 自检的结果：

**1. Spec 覆盖**

| Spec 章节 | 对应任务 |
| --- | --- |
| §4 架构与数据流 | Task 1、2、5 |
| §4「为什么不放在 RTCBasic.destroy」 | Task 5 Step 3 的代码注释 |
| §5 采样循环（自递归 setTimeout、双重守卫） | Task 2 |
| §5 candidate-pair 挑选 | Task 1 `pickCandidatePair` |
| §5 单位换算 | Task 1 `rttToMs` |
| §5 三级回退链 L1 | Task 2 `#tick` |
| §5 三级回退链 L2 | Task 5 Step 2、Task 6 Step 2、Task 7 Step 1 |
| §5 三级回退链 L3 | Task 2 `if (rtt == null) return`、Task 8 Step 2 桌测 |
| §5 滚动窗口（30 样本、环形数组） | Task 1 `SampleWindow` |
| §5 聚合 `worst` | Task 2 `#tick` |
| §6 阈值与视觉分级 | Task 1 `getTier` / `TIER_DIM_PARTS` / `TIER_COLOR_KEY`，Task 8 渲染 |
| §7 图标来源（export signalIcon） | Task 4 |
| §7 元素重命名 | Task 8、11 |
| §7 Tooltip 内容 | Task 8 |
| §7 无障碍 | Task 8 `role="img"` + `aria-label`，Task 12 第 14 项 |
| §8 页面接线 + 不得引入 latencyStore | Task 9、10 的 Step 3 |
| §9 i18n（3 key、zh-CN 必须、en 补齐） | Task 3 |
| §10.1 allSettled | Task 2 |
| §10.2 await 竞态守卫 | Task 2 `#tick` + Step 2 桌测 |
| §10.3 禁用 falsy 判断 | Task 1、2、8 各处 + 关键约束清单 |
| §10.4 昵称缺失不抛错 | Task 8 Step 2 桌测 |
| §10.5 重连窗口清零 | Task 5 Step 4 说明 + Task 12 第 10 项 |
| §10.6 后台标签页不处理 | 无代码（刻意不做） |
| §11 顺带修复 falsy 缺陷 | Task 6 Step 1 |
| §12 两条硬约束 | 关键约束清单 + Task 2 |
| §13 待验证项（Safari） | Task 12 第 6 项 + Step 5 |
| §14 验证清单 15 条 | Task 12（扩充为 16 条，新增第 16 项验证 §11 的缺陷修复） |
| §15 涉及文件清单 11 个 | File Structure 表逐一对应 |

无遗漏。

**2. 占位符扫描**：无 TBD / TODO / 「适当处理错误」/「类似 Task N」等；所有代码步骤均给出完整可落盘代码，所有命令均给出期望输出。

**3. 类型一致性**：跨任务引用的名称已核对一致——`latencyStore`、`LatencyMonitor`、`LatencyPeer`、`SampleWindow`、`getTier`、`rttToMs`、`pickCandidatePair`、`TIER_DIM_PARTS`、`TIER_COLOR_KEY`、`signalIcon`、`getFallbackLatency`、`monitor.add` / `monitor.remove`、标签名 `nesbox-latency`。`i18n.get` 的插值参数已统一用 `String(...)` 包裹（其 rest 参数类型为 `string`，不接受 number）。

**4. 中途状态可编译性**：Task 8 创建新元素时保留 `ping.ts`，Task 9/10 分别切换页面，Task 11 才删除——每个 Task 结束时 `tsc --noEmit` 均应为 exit 0。
