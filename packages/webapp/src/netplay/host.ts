/**
 * 未实现 https://docs.libretro.com/development/retroarch/netplay/
 */

import { Player } from '@mantou/nes';
import { configure } from 'src/configure';
import { globalEvents, RTCTransportType, type SignalDetail, SignalType } from 'src/constants';
import { logger } from 'src/logger';
import {
  type ChannelMessage,
  ChannelMessageType,
  type KeyDownMsg,
  type Ping,
  type PointerMoveMsg,
  type Role,
  RoleAnswer,
  RoleOffer,
  RTCBasic,
  TextMsg,
} from 'src/netplay/common';
import { sendSignal } from 'src/services/api';

export class RTCHost extends RTCBasic {
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

  #setRoles = (userId: number, msg: RoleOffer) => {
    const role: Role = { userId, username: msg.username, nickname: msg.nickname };
    const player = this.getPlayer(userId);

    if (msg.roleType === null) {
      // leave
      delete this.roles[player!];
    } else if ([Player.Two, Player.Three, Player.Four].includes(msg.roleType!) && !this.roles[msg.roleType!]) {
      // join
      delete this.roles[player!];
      this.roles[msg.roleType!] = role;
    } else {
      // auto
      if (player === undefined) {
        if (!this.roles[Player.Two]) {
          this.roles[Player.Two] = role;
        } else if (!this.roles[Player.Three]) {
          this.roles[Player.Three] = role;
        } else if (!this.roles[Player.Four]) {
          this.roles[Player.Four] = role;
        }
      }
    }
  };

  #emitAnswer = () => {
    const roleAnswer = new RoleAnswer(this.roles);
    this.channelMap.forEach((channel) => channel.send(roleAnswer.toString()));
    this.emitMessage(roleAnswer);
  };

  #onDataChannel = (userId: number, conn: RTCPeerConnection, channel: RTCDataChannel) => {
    channel.onopen = () => {
      this.channelMap.set(conn, channel);

      channel.onclose = () => {
        const nickname = Object.values(this.roles).find((role) => role?.userId === userId)?.nickname || '';

        this.deleteUser(userId);
        delete this.roles[this.getPlayer(userId)!];
        this.#emitAnswer();

        const textMsg = new TextMsg(['page.room.leaveRoomMsg', nickname]).toSystemRole();
        this.channelMap.forEach((channel) => channel.send(textMsg.toString()));
        this.emitMessage(textMsg);
      };
    };
    channel.onmessage = ({ data }: MessageEvent<string>) => {
      const msg = JSON.parse(data) as ChannelMessage;
      switch (msg.type) {
        case ChannelMessageType.CHAT_TEXT:
          this.channelMap.forEach((channel, item) => item !== conn && channel.send(data));
          this.emitMessage(msg);
          break;
        case ChannelMessageType.KEYDOWN:
        case ChannelMessageType.KEYUP:
        case ChannelMessageType.POINTER_MOVE: {
          const player = this.getPlayer(userId);
          if (player !== undefined) {
            this.emitMessage({ ...msg, player } as KeyDownMsg | PointerMoveMsg);
          }
          break;
        }
        case ChannelMessageType.ROLE_OFFER:
          this.#setRoles(userId, msg as RoleOffer);
          this.#emitAnswer();
          break;
        case ChannelMessageType.PING:
          channel.send(data);
          channel.clientPrevPing = (msg as Ping).prevPing;
          break;
      }
    };
  };

  #onOffer = async ({ userId, signal }: SignalDetail) => {
    const conn = this.createRTCPeerConnection(userId);
    conn.addEventListener('datachannel', ({ channel }) => this.#onDataChannel(userId, conn, channel));
    conn.addEventListener('icecandidate', (event) => {
      event.candidate &&
        sendSignal(userId, {
          type: SignalType.NEW_ICE_CANDIDATE,
          data: event.candidate,
        });
    });
    await conn.setRemoteDescription(new RTCSessionDescription(signal.data));
    await conn.setLocalDescription(await conn.createAnswer());
    await sendSignal(userId, {
      type: SignalType.ANSWER,
      data: conn.localDescription,
    });
  };

  #onSignal = async (event: CustomEvent<SignalDetail>) => {
    const { userId, signal } = event.detail;
    try {
      switch (signal.type) {
        case SignalType.OFFER:
          this.#onOffer(event.detail);
          break;
        case SignalType.NEW_ICE_CANDIDATE:
          await this.connMap.get(userId)?.addIceCandidate(signal.data);
          break;
      }
    } catch (err) {
      // No remoteDescription.
      // Set remote answer error
      logger.error(err);
    }
  };

  start = async ({ stream }: { host: number; stream: MediaStream; audio: HTMLAudioElement }) => {
    this.roles = {
      [Player.One]: {
        userId: configure.user!.id,
        username: configure.user!.username,
        nickname: configure.user!.nickname,
      },
    };
    this.stream = stream;

    this.emitMessage(new RoleAnswer(this.roles));

    addEventListener(globalEvents.SIGNAL, this.#onSignal);
  };

  destroy = () => {
    this.connMap.forEach((_, id) => this.deleteUser(id));
    removeEventListener(globalEvents.SIGNAL, this.#onSignal);
  };

  needSendFrame = () => {
    return !!this.channelMap.size;
  };

  sendFrame = (frame: Uint8Array, frameNum: number) => {
    if (!frame.length) return;
    this.channelMap.forEach((channel) => {
      // Wait for client to send ping
      // 必须用 undefined 判断：ping 为 0 是合法值，
      // 原先的 falsy 判断会导致该客户端永久收不到帧（画面卡死）
      if (channel.clientPrevPing === undefined) return;

      if (configure.user?.settings.video.rtcImprove === RTCTransportType.CLIP) {
        channel.send(frame);
      } else {
        if (frameNum % 2 === 0) {
          channel.send(frame);
        }
      }
    });
  };

  kickOutRole = (userId: number) => {
    this.#setRoles(userId, new RoleOffer(null));
    this.send(new RoleAnswer(this.roles));
  };

  disablePlayer = (player: Player) => {
    if (this.roles[player]) {
      delete this.roles[player];
    } else {
      this.roles[player] = { userId: 0, nickname: '', username: '' };
    }
    this.send(new RoleAnswer(this.roles));
  };
}
