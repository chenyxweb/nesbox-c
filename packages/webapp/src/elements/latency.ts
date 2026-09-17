import { adoptedStyle, connectStore, css, customElement, GemElement, html, shadow } from '@mantou/gem';
import { isMtApp } from '@nesbox/mtapp';
import { fpsStyle } from 'src/elements/fps';
import { signalIcon } from 'src/elements/net';
import { i18n } from 'src/i18n/basic';
import { getTier, latencyStore, type LatencyTier } from 'src/netplay/latency';
import { theme } from 'src/theme';

import 'duoyun-ui/elements/use';
import 'src/elements/tooltip';

/**
 * 表现层常量，刻意放在元素而非 netplay/latency.ts：
 * 'g3' / 'g4' 是 elements/net.ts 中 signalIcon 的 SVG part 名，
 * 改图标结构时必须同步这里；theme 的语义色 key 同理。
 */
const TIER_DIM_PARTS: Record<LatencyTier, string[]> = {
  good: [],
  fair: ['g4'],
  poor: ['g3', 'g4'],
};

const TIER_COLOR_KEY: Record<LatencyTier, 'positiveColor' | 'noticeColor' | 'negativeColor'> = {
  good: 'positiveColor',
  fair: 'noticeColor',
  poor: 'negativeColor',
};

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
    // 而 styleMap 返回的是有状态 directive，不应在两处复用同一实例
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
          <div>${i18n.get('tooltip.room.latencyStats', String(peer?.avg ?? worst), String(peer?.max ?? worst))}</div>
        `}
      >
        <dy-use
          role="img"
          aria-label=${i18n.get('tooltip.room.latency')}
          style=${color}
          .element=${signalIcon}
        ></dy-use>
        <span style=${color}>${worst}ms</span>
      </nesbox-tooltip>
    `;
  };
}
