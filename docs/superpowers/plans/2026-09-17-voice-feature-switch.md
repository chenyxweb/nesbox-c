# 语音功能环境变量开关 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `VOICE_ENABLED` 环境变量,默认关闭房间页语音功能(web 与 mt-app 双端不渲染语音按钮)。

**Architecture:** 沿用项目现有构建期注入链路:`.env → docker-compose build.args → Dockerfile ARG/ENV → vite.config.ts define 替换 `process.env.VOICE_ENABLED` 为字符串字面量 → `constants.ts` 导出 `voiceEnabled` 布尔常量 → room.ts / mt-room.ts 挂载点条件渲染。mt-app 手柄按键依赖 `#voiceRef.value?.toggleVoice()` 可选链,元素不渲染时天然短路,无需改动。

**Tech Stack:** Vite define、TypeScript、gemjs 模板、docker-compose build args。

**Spec:** `docs/superpowers/specs/2026-09-17-voice-feature-switch-design.md`

---

### Task 1: webapp 前端开关(常量导出 + 两处挂载点)

**Files:**
- Modify: `packages/webapp/vite.config.ts`(define 块,第 26-42 行)
- Modify: `packages/webapp/src/constants.ts`(第 25 行后)
- Modify: `packages/webapp/src/pages/room.ts`(第 28 行 import、第 423 行挂载点)
- Modify: `packages/webapp/src/pages/mt-room.ts`(第 17 行 import、第 119 行挂载点)

- [ ] **Step 1: vite.config.ts define 注入环境变量**

在 `'process.env.AI_COMPLETIONS_BASE'` 行(第 38 行)与 `'process.env.DEV_ROM_SERVER'`(第 41 行)之间的 define 块中插入:

```ts
      // 私有化部署：房间语音通话开关（留空禁用，非空启用）
      'process.env.VOICE_ENABLED': JSON.stringify(process.env.VOICE_ENABLED ?? ''),
```

- [ ] **Step 2: constants.ts 导出常量**

在 `export const aiCompletionsBase = (process.env.AI_COMPLETIONS_BASE ?? '') as string;`(第 25 行)之后追加:

```ts
// 语音通话功能开关：留空禁用（默认），非空启用（构建期注入）
export const voiceEnabled = Boolean(process.env.VOICE_ENABLED);
```

- [ ] **Step 3: room.ts 条件渲染**

先把第 28 行 import 改为:

```ts
import { type BcMsgEvent, BcMsgType, queryKeys, voiceEnabled } from 'src/constants';
```

再把第 423 行 `<m-room-voice class="icon"></m-room-voice>` 改为:

```ts
        ${voiceEnabled ? html`<m-room-voice class="icon"></m-room-voice>` : ''}
```

- [ ] **Step 4: mt-room.ts 条件渲染**

先把第 17 行 import 改为:

```ts
import { globalEvents, queryKeys, voiceEnabled } from 'src/constants';
```

再把第 119 行 `<m-room-voice ${this.#voiceRef} class="icon" ></m-room-voice>` 改为:

```ts
        ${voiceEnabled ? html`<m-room-voice ${this.#voiceRef} class="icon" ></m-room-voice>` : ''}
```

注意:m-room-voice 的副作用 import(`import 'src/modules/room-voice';` 第 31 行)保留不动——组件注册不依赖挂载,且开关为假时不渲染即不触发任何动作。

- [ ] **Step 5: 类型检查**

Run: `yarn --cwd packages/webapp build`
Expected: vite build 成功退出(exit 0),产物输出到 `packages/webapp/dist`,无类型错误。

- [ ] **Step 6: 冒烟验证开关语义(dev 模式)**

开关判定在运行时(`voiceEnabled` 常量),因此构建产物中 `room-voice.ts` 组件代码仍然存在,**不能用 grep 产物验证显隐**。正确验证方式:

Run: `yarn --cwd packages/webapp start`,打开房间页
Expected: 未设置 `VOICE_ENABLED` 时右下角无麦克风按钮(默认禁用态)。

再临时把 vite.config.ts define 值改为 `JSON.stringify('1')`、重启 dev server,Expected: 按钮出现(启用态)。**验证完成后务必把 define 值改回 `JSON.stringify(process.env.VOICE_ENABLED ?? '')`。**

- [ ] **Step 7: Commit**

```bash
git add packages/webapp/vite.config.ts packages/webapp/src/constants.ts packages/webapp/src/pages/room.ts packages/webapp/src/pages/mt-room.ts
git commit -m "feat: add VOICE_ENABLED config to disable room voice by default"
```

---

### Task 2: deploy 构建链路(build-arg 透传)

**Files:**
- Modify: `deploy/webapp/Dockerfile`(第 7-11 行注释、第 19-36 行 ARG/ENV 块)
- Modify: `deploy/docker-compose.yml`(webapp build.args,第 84-93 行)
- Modify: `deploy/.env.example`("前端构建参数"节,第 58 行后)

- [ ] **Step 1: Dockerfile 注释与 ARG/ENV**

头注释第 11 行 `#   AI_COMPLETIONS_BASE  AI 问答服务地址，留空禁用` 之后追加:

```dockerfile
#   VOICE_ENABLED         房间语音通话开关，留空禁用，非空（如 1）启用
```

第 23 行 `ARG AI_COMPLETIONS_BASE=` 之后追加:

```dockerfile
ARG VOICE_ENABLED=
```

第 27 行 ENV 块中 `AI_COMPLETIONS_BASE=$AI_COMPLETIONS_BASE \` 之后追加:

```dockerfile
    VOICE_ENABLED=$VOICE_ENABLED \
```

- [ ] **Step 2: docker-compose.yml build args**

在第 93 行 `AI_COMPLETIONS_BASE: ${AI_COMPLETIONS_BASE:-}` 之后追加:

```yaml
        # 留空表示禁用房间语音通话功能
        VOICE_ENABLED: ${VOICE_ENABLED:-}
```

- [ ] **Step 3: .env.example 文档**

在第 58 行 `AI_COMPLETIONS_BASE=` 之后追加:

```bash
# 房间语音通话功能开关
# 留空: 禁用（默认）
# 非空: 启用（例如 1）
# 修改后需重新构建 webapp 镜像: docker compose build webapp
VOICE_ENABLED=
```

- [ ] **Step 4: 验证 compose 配置合法**

Run: `docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet`
Expected: exit 0,无 .env 缺失告警(该命令仅解析配置,不构建镜像、不访问网络)。

若本机无 docker compose,替代验证:确认三处改动文本与既有 `AI_COMPLETIONS_BASE` 条目格式逐字对齐。

- [ ] **Step 5: Commit**

```bash
git add deploy/webapp/Dockerfile deploy/docker-compose.yml deploy/.env.example
git commit -m "feat(deploy): pass VOICE_ENABLED build arg to webapp"
```

---

### Task 3: 端到端验证(可选,需可构建环境)

- [ ] **Step 1: 默认禁用态产物检查**

Run:
```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build webapp 2>&1 | tail -5
```
Expected: 镜像构建成功;日志中无 `VOICE_ENABLED` 相关告警。

- [ ] **Step 2: 启用态产物检查(可选)**

Run:
```bash
VOICE_ENABLED=1 docker compose --env-file deploy/.env -f deploy/docker-compose.yml build webapp
```
Expected: 构建成功。启动容器后打开房间页,右下角出现麦克风按钮;默认态(Step 1)镜像则无按钮。