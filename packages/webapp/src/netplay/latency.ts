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
