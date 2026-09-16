import { commonAnimationOptions } from 'duoyun-ui/lib/animations';
import { sleep } from 'duoyun-ui/lib/timer';
import type { ElementOf } from 'duoyun-ui/lib/types';
import { createCacheStore } from 'duoyun-ui/lib/utils';
import frontmatter from 'front-matter';
import { configure } from 'src/configure';
import { localStorageKeys } from 'src/constants';
import type {
  EnterLobbyMutation,
  EventSubscription,
  GetFriendsQuery,
  GetMessagesQuery,
  GetRecordQuery,
} from 'src/generated/graphql';
import type { GetCommentsQuery, GetGamesQuery, GetRoomsQuery } from 'src/generated/guestgraphql';

export type GameAttributes = {
  ad_text?: string;
  ad_link?: string;
  ref?: string;
};

export function convertGame(game: ElementOf<GetGamesQuery['games']>): Game {
  const { body, attributes } = frontmatter<GameAttributes>(game.description);
  return { ...game, attributes: attributes, description: body };
}

export type Game = ElementOf<GetGamesQuery['games']> & { attributes: GameAttributes };
export type Room = ElementOf<GetRoomsQuery['rooms']>;
export type Invite = ElementOf<GetFriendsQuery['invites']>;
export type Friend = ElementOf<GetFriendsQuery['friends']>;
export type Comment = ElementOf<GetCommentsQuery['comments']>;
export type GameRecord = GetRecordQuery['record'];
export type Message = ElementOf<GetMessagesQuery['messages']>;
export type LobbyInfo = EnterLobbyMutation['enterLobby'];
export type LobbyMessage = Exclude<EventSubscription['event']['lobbyMessage'], undefined>;

interface Store {
  games: Record<number, Game | undefined>;
  gameIds?: number[];
  comment: Record<
    number, // gameId
    | {
        comments: Record<number /**userId */, Comment | undefined>;
        userIds?: number[];
      }
    | undefined
  >;
  record: Record<number, GameRecord | undefined>;
  topGameIds?: number[];
  favoriteIds?: number[];
  recentGameIds?: number[];
  rooms: Record<number, Room | undefined>;
  roomIds?: number[];
  lobbyInfo?: LobbyInfo;
  lobbyMessage: LobbyMessage[];
}

// 清理旧版本 store 缓存（带用户名前缀的 key）
// 私有化部署重装数据库后游戏 id 会重新分配，旧缓存与远端不一致会导致
// 房间内游戏 ROM 匹配失败（ROM load fail），升级 key 后旧缓存整体失效
for (const key of Object.keys(localStorage)) {
  if (key.endsWith('@store_v2')) localStorage.removeItem(key);
}

export const { store } = createCacheStore<Store>(
  localStorageKeys.STORE_LOCAL_STORAGE_KEY,
  {
    games: {},
    comment: {},
    rooms: {},
    record: {},
    lobbyMessage: [],
  },
  {
    prefix: () => configure.user?.username,
    depStore: configure,
    cacheExcludeKeys: ['roomIds', 'rooms', 'lobbyMessage'],
  },
);

export function clearLobbyMessage() {
  store({ lobbyMessage: [] });
}

interface FriendStore {
  draft: Record<number, string | undefined>;
  messages: Record<number, Message | undefined>;
  messageIds: Record<number, number[] | undefined>;
  invites: Record<number, Invite | undefined>;
  inviteIds?: number[];
  friends: Record<number, Friend | undefined>;
  friendIds?: number[];
  recentFriendChat?: number;
  friendChatState?: number;
}

export const { store: friendStore } = createCacheStore<FriendStore>(
  localStorageKeys.FRIEND_CHAT_STORAGE_KEY,
  {
    draft: {},
    messageIds: {},
    messages: {},
    invites: {},
    friends: {},
  },
  {
    prefix: () => configure.user?.username,
    depStore: configure,
  },
);

export function changeFriendChatDraft(friendId: number, body?: string) {
  friendStore({ draft: { ...friendStore.draft, [friendId]: body } });
}

export const toggleFriendChatState = async (id?: number) => {
  if (id && id === friendStore.friendChatState) {
    // re-focus on friend chat
    friendStore({ friendChatState: undefined });
  }
  // wait close animation
  await sleep(Number(commonAnimationOptions.duration));
  friendStore({
    recentFriendChat: id || friendStore.friendChatState || friendStore.recentFriendChat,
    friendChatState: id,
  });
};
