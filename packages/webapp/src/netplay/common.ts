import { type Button, Player } from '@mantou/nes';
import { configure } from 'src/configure';
import type { LocaleKey } from 'src/i18n/basic';
import { LatencyMonitor } from 'src/netplay/latency';

export enum ChannelMessageType {
  CHAT_TEXT,
  KEYDOWN,
  KEYUP,
  ROLE_OFFER,
  ROLE_ANSWER,
  PING,
  POINTER_MOVE,
}

export type Role =
  | {
      userId: number;
      username: string;
      nickname: string;
    }
  | undefined;

export abstract class ChannelMessageBase {
  type: ChannelMessageType;
  timestamp: number;
  userId: number;
  username: string;
  nickname: string;

  constructor() {
    this.timestamp = Date.now();
    this.userId = configure.user!.id;
    this.username = configure.user!.username;
    this.nickname = configure.user!.nickname;
  }

  toSystemRole() {
    this.userId = 0;
    this.username = '';
    this.nickname = '';
    return this;
  }

  toString() {
    return JSON.stringify(this);
  }
}

export type SysMsg = [LocaleKey, ...string[]];
export class TextMsg extends ChannelMessageBase {
  type = ChannelMessageType.CHAT_TEXT;

  text: string;
  constructor(text: string | SysMsg) {
    super();
    this.text = typeof text === 'string' ? text : text.join('\n');
  }
}

export class PointerMoveMsg extends ChannelMessageBase {
  type = ChannelMessageType.POINTER_MOVE;

  player = Player.One;
  x = 0;
  y = 0;
  dx = 0;
  dy = 0;

  constructor(x: number, y: number, dx: number, dy: number) {
    super();
    this.x = x;
    this.y = y;
    this.dx = dx;
    this.dy = dy;
  }
}

export class KeyDownMsg extends ChannelMessageBase {
  type = ChannelMessageType.KEYDOWN;

  player = Player.One;
  button: Button;
  constructor(button: Button) {
    super();
    this.button = button;
  }
}
export class KeyUpMsg extends KeyDownMsg {
  type = ChannelMessageType.KEYUP;
}

export class RoleOffer extends ChannelMessageBase {
  type = ChannelMessageType.ROLE_OFFER;

  // null 表示踢出
  // undefined 表示自动
  roleType?: Player | null;
  constructor(roleType?: Player | null) {
    super();
    this.roleType = roleType;
  }
}

export class RoleAnswer extends ChannelMessageBase {
  type = ChannelMessageType.ROLE_ANSWER;

  roles: Partial<Record<Player, Role>>;
  constructor(roles: Partial<Record<Player, Role>>) {
    super();
    this.roles = roles;
  }
}

export class Ping extends ChannelMessageBase {
  type = ChannelMessageType.PING;

  prevPing?: number;
  constructor(prevPing?: number) {
    super();
    this.prevPing = prevPing;
  }
}

export type ChannelMessage = TextMsg | KeyDownMsg | KeyUpMsg | RoleOffer | RoleAnswer | Ping | PointerMoveMsg;

export class RTCBasic extends EventTarget {
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
    // 包一层箭头延迟调用：子类的类属性在基类之后赋值，而该箭头只在 tick 时执行，
    // 因此能正确解析到子类覆写版本
    getFallback: () => this.getFallbackLatency(),
  });

  deleteUser = (userId: number) => {
    // 注销点。放在最前，确保即使后续分支提前返回也已完成注销。
    // 注意：不能挂在本类的 destroy 上——RTCClient / RTCHost 用类属性箭头函数定义了同名成员，
    // 会遮蔽基类实现导致基类 destroy 永不执行；而两者的 destroy 都会 forEach 调用 deleteUser。
    this.monitor.remove(userId);
    const conn = this.connMap.get(userId);
    this.connMap.delete(userId);
    if (conn) {
      const channel = this.channelMap.get(conn);
      if (channel) {
        channel.onclose = null;
        this.channelMap.delete(conn);
        channel.close();
      }
      conn.close();
    }
  };

  createRTCPeerConnection = (userId: number) => {
    this.deleteUser(userId);
    const conn = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
          username: 'peerjs',
          credential: 'peerjsp',
        },
      ],
    });
    this.stream.getTracks().forEach((track) => conn.addTrack(track, this.stream));
    this.connMap.set(userId, conn);
    // 注册点。首行的 deleteUser 已完成同 userId 的注销，
    // 因此重连时是先 remove 再 add，采样窗口随之清零（旧链路样本不代表新链路）
    this.monitor.add(userId, conn);
    return conn;
  };

  getPlayer = (userId: number) => {
    const player = (Object.keys(this.roles) as unknown as Player[]).find((role) => this.roles[role]?.userId === userId);
    // rust 生成的 enum 值为数字
    return player !== undefined ? (Number(player) as Player) : player;
  };

  emitMessage = (detail: ChannelMessage | ArrayBuffer) => {
    this.dispatchEvent(new CustomEvent('message', { detail }));
  };

  start = async (_options: { host: number; stream: MediaStream; audio: HTMLAudioElement }) => {
    //
  };

  destroy = () => {
    //
  };

  needSendFrame = () => {
    return false;
  };

  sendFrame = (_frame: Uint8Array, _frameNum: number) => {
    //
  };

  send = (data: ChannelMessage, emit = true) => {
    this.channelMap.forEach((c) => {
      if (c.readyState === 'open') {
        c.send(data.toString());
      }
    });
    if (emit) {
      this.emitMessage(data);
    }
  };

  kickOutRole = (_userId: number) => {
    //
  };

  disablePlayer = (_player: Player) => {
    //
  };
}

const dataChannelSend = RTCDataChannel.prototype.send;
RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView) {
  try {
    dataChannelSend.apply(this, [data]);
  } catch {
    //
  }
};
