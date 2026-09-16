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
export const rttToMs = (rtt?: number | null): number | undefined => (rtt == null ? undefined : Math.round(rtt * 1000));

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
