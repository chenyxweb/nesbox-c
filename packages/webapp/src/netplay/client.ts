import { createState } from '@mantou/gem';
import { Player } from '@mantou/nes';
import { configure } from 'src/configure';
import { globalEvents, type SignalDetail, SignalType } from 'src/constants';
import { logger } from 'src/logger';
import {
  type ChannelMessage,
  ChannelMessageType,
  Ping,
  RoleAnswer,
  RoleOffer,
  RTCBasic,
  TextMsg,
} from 'src/netplay/common';
import { sendSignal } from 'src/services/api';

export const pingStore = createState<{ ping?: number }>({});

export class RTCClient extends RTCBasic {
  #host = 0;
  #restartTimer = 0;
  #pingTimer = 0;
  #audio: HTMLAudioElement;

  /**
   * L2 回退：现有的应用层 ping（每 1s 发 Ping 消息、房主回显后计算得出）。
   * 客户端的连接以自身 userId 为键（见 #startClient 中的 createRTCPeerConnection）。
   */
  getFallbackLatency = (): Record<number, number | undefined> => ({
    [configure.user!.id]: pingStore.ping,
  });

  /**
   * 客户端的连接以**自身** userId 为键，但延时的对端是房主。
   * 若不覆写，基类实现会按该键查到自己的昵称，tooltip 就会显示「自己 23ms」，
   * 让用户误读为另一个玩家的延时。此处改为返回房主（Player.One）的昵称。
   */
  getNickname = (_userId: number): string | undefined => this.roles[Player.One]?.nickname;

  #onSignal = async (event: CustomEvent<SignalDetail>) => {
    const { signal } = event.detail;
    try {
      switch (signal.type) {
        case SignalType.ANSWER:
          await this.connMap.get(configure.user!.id)?.setRemoteDescription(new RTCSessionDescription(signal.data));
          break;
        case SignalType.NEW_ICE_CANDIDATE:
          await this.connMap.get(configure.user!.id)?.addIceCandidate(signal.data);
          break;
      }
    } catch (err) {
      // No remoteDescription.
      // Set remote answer error
      logger.error(err);
    }
  };

  #startClient = async () => {
    const conn = this.createRTCPeerConnection(configure.user!.id);

    /**
     * 不按顺序接收消息的问题
     * 1. 帧可能乱序，可以在帧数据上添加帧数，但需要复制内存（性能消耗多少？）
     * 2. ping 值不准确
     */
    const channel = conn.createDataChannel('msg', { ordered: false });
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      clearTimeout(this.#restartTimer);
      // `deleteUser` assign `null`
      channel.onclose = () => {
        delete this.roles[Player.One];
        this.emitMessage(new RoleAnswer(this.roles));
        this.#restart();
      };
      this.channelMap.set(conn, channel);
      // 也许是重连
      this.send(new RoleOffer(this.getPlayer(configure.user!.id)));

      const textMsg = new TextMsg(['page.room.enterRoomMsg', configure.user!.nickname]).toSystemRole();
      this.send(textMsg);

      this.#sendPing();
    };
    channel.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data) as ChannelMessage;
        switch (msg.type) {
          case ChannelMessageType.PING:
            pingStore({ ping: Date.now() - msg.timestamp });
            break;
          case ChannelMessageType.ROLE_ANSWER:
            this.roles = (msg as RoleAnswer).roles;
            this.emitMessage(msg);
            break;
          default:
            this.emitMessage(msg);
            break;
        }
      } else {
        // compressed frame
        this.emitMessage(data);
      }
    };

    conn.addEventListener('icecandidate', (event) => {
      event.candidate &&
        sendSignal(this.#host, {
          type: SignalType.NEW_ICE_CANDIDATE,
          data: event.candidate,
        });
    });

    conn.addEventListener('icecandidateerror', (event) => {
      logger.error(event);
    });

    conn.addEventListener('track', ({ streams }) => {
      this.#audio.srcObject = streams[0];
      if (this.#audio.paused) {
        this.#audio.muted = true;
        this.#audio.play().catch(() => {
          //
        });
      }
    });

    await conn.setLocalDescription(await conn.createOffer());
    await sendSignal(this.#host, {
      type: SignalType.OFFER,
      data: conn.localDescription,
    });
    this.#restartTimer = window.setTimeout(() => this.#restart(), 2000);
  };

  #sendPing = () => {
    this.send(new Ping(pingStore.ping), false);
    this.#pingTimer = window.setTimeout(this.#sendPing, 1000);
  };

  #restart = () => {
    logger.info('rtc restarting...');
    this.destroy();
    // logout / leave
    if (configure.user?.playing) {
      this.start({ host: this.#host, stream: this.stream, audio: this.#audio });
    }
  };

  start = async ({ host, stream, audio }: { host: number; stream: MediaStream; audio: HTMLAudioElement }) => {
    this.#audio = audio;
    this.#host = host;

    // 发送空流，以便建立起对等链接
    this.stream = stream;

    this.#startClient();

    addEventListener(globalEvents.SIGNAL, this.#onSignal);
  };

  destroy = () => {
    this.connMap.forEach((_, id) => this.deleteUser(id));
    removeEventListener(globalEvents.SIGNAL, this.#onSignal);

    clearTimeout(this.#restartTimer);
    clearTimeout(this.#pingTimer);
    pingStore({ ping: undefined });
  };
}
