/**
 * NESBox 本地化脚本公共库
 * 被 localize-games.mjs 与 localize-incremental.mjs 共享
 *
 * 数据源: 官方 NESBox API (https://api.xianqiao.wang/nesbox/guestgraphql)
 */

import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { env, stdout } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// ============================================================
// 路径与配置
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEPLOY_DIR = resolve(__dirname, '..');
export const DATA_DIR = join(DEPLOY_DIR, 'data');
export const CACHE_FILE = join(DATA_DIR, '.url-cache.json');

// 官方 NESBox API 端点（guestgraphql 无需认证）
export const NESBOX_API_URL =
  env.NESBOX_API_URL || 'https://api.xianqiao.wang/nesbox/guestgraphql';

export const LOCAL_FILES_URL_PREFIX = (env.LOCAL_FILES_URL_PREFIX || '/files').replace(/\/$/, '');
export const CONCURRENCY = Math.max(1, parseInt(env.LOCALIZE_CONCURRENCY || '6', 10));
export const RETRIES = Math.max(1, parseInt(env.LOCALIZE_RETRIES || '3', 10));

export const CATEGORY_DIRS = {
  rom: 'roms',
  preview: 'previews',
  screenshot: 'screenshots',
  description: 'description',
};

// 数据库列顺序（与 01-schema.sql 中的 games 表一致）
export const GAME_COLUMNS = [
  'id',
  'name',
  'description',
  'preview',
  'deleted_at',
  'created_at',
  'updated_at',
  'rom',
  'screenshots',
  'platform',
  'series',
  'kind',
  'max_player',
];

// ============================================================
// 工具函数
// ============================================================

export const log = (msg) => stdout.write(`[localize] ${msg}\n`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hashUrl(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

export function inferExtension(url, contentType = '') {
  try {
    const ext = extname(new URL(url).pathname);
    if (ext && ext.length <= 10) return ext.toLowerCase();
  } catch {
    /* ignore */
  }
  const mimeMap = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/octet-stream': '.bin',
  };
  const ct = contentType.split(';')[0].trim().toLowerCase();
  return mimeMap[ct] || '.bin';
}

export async function downloadFile(url, destPath, attempt = 1) {
  const tmpPath = `${destPath}.tmp`;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
      headers: { 'User-Agent': 'nesbox-localize/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    mkdirSync(dirname(destPath), { recursive: true });
    const contentType = response.headers.get('content-type') || '';
    await pipeline(response.body, createWriteStream(tmpPath));
    renameSync(tmpPath, destPath);
    return { ok: true, size: statSync(destPath).size, contentType };
  } catch (err) {
    // 清理残留的临时文件，避免磁盘垃圾
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.failed`);
    } catch { /* ignore */ }
    if (attempt >= RETRIES) return { ok: false, error: err.message };
    log(`  ↻ retry ${attempt}/${RETRIES} ${url.slice(0, 80)}… (${err.message})`);
    await sleep(1000 * attempt);
    return downloadFile(url, destPath, attempt + 1);
  }
}

export async function runWithConcurrency(tasks, limit) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ============================================================
// URL 缓存
// ============================================================

export function loadCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    } catch {
      /* corrupted */
    }
  }
  return {};
}

export function saveCache(cache) {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ============================================================
// 官方 API 数据获取
// ============================================================

/** 毫秒时间戳 → PostgreSQL timestamp 格式 */
function msToTimestamp(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

/** GraphQL 枚举值 → 数据库存储格式（小写） */
function enumToDb(value) {
  if (!value) return null;
  return value.toLowerCase();
}

// GraphQL 查询：获取所有游戏
const GET_GAMES_QUERY = `
query getGames {
  games {
    id
    name
    description
    preview
    createdAt
    updatedAt
    rom
    screenshots
    platform
    kind
    series
    maxPlayer
  }
  topGames
}
`;

/**
 * 从官方 NESBox API 获取游戏数据
 * @returns {Promise<{columns: string[], rows: (string|number|null)[][], topGames: number[]}>}
 */
export async function fetchGamesFromApi() {
  log(`  API: ${NESBOX_API_URL}`);

  const res = await fetch(`${NESBOX_API_URL}?operationName=getGames`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': 'nesbox-localize/1.0',
      'Origin': 'https://nesbox.xianqiao.wang',
      'Referer': 'https://nesbox.xianqiao.wang/',
    },
    body: JSON.stringify({ query: GET_GAMES_QUERY, variables: {} }),
  });

  if (!res.ok) {
    throw new Error(`API 请求失败: HTTP ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL 错误: ${JSON.stringify(json.errors)}`);
  }

  const games = json.data?.games || [];
  const topGames = json.data?.topGames || [];

  if (games.length === 0) {
    throw new Error('API 返回空数据');
  }

  // 转换为 { columns, rows } 格式（与数据库 COPY 格式兼容）
  const rows = games.map((game) => [
    game.id,
    game.name,
    game.description || '',
    game.preview || '',
    null, // deleted_at
    msToTimestamp(game.createdAt),
    msToTimestamp(game.updatedAt),
    game.rom || '',
    (game.screenshots || []).join(','),
    enumToDb(game.platform),
    enumToDb(game.series),
    enumToDb(game.kind),
    game.maxPlayer,
  ]);

  log(`  获取到 ${games.length} 条游戏`);
  return { columns: GAME_COLUMNS, rows, topGames };
}

// ============================================================
// SQL 生成辅助
// ============================================================

/** 转义 pg_dump COPY 格式字段值 */
export function escapeCopyField(value) {
  if (value === null || value === undefined) return '\\N';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** 转义 PostgreSQL 字符串字面量 (单引号 → 两个单引号) */
export function escapeSqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ============================================================
// URL 提取与判断
// ============================================================

export function extractMarkdownUrls(text) {
  if (!text) return [];
  const urls = new Set();
  // markdown 图片/链接: ![alt](url) 或 [text](url)
  const re = /!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) urls.add(m[1]);
  // 裸 URL: 匹配 ASCII 可打印字符 (0x21-0x7E)，避免将中文/全角符号误包含
  const re2 = /https?:\/\/[!-~]+/g;
  while ((m = re2.exec(text)) !== null) {
    const url = m[0]
      // 去除 markdown 链接残留: ](http://... 或 [text](url)
      .replace(/\]\(.*$/, '')
      .replace(/\[.*$/, '')
      // 去除末尾的括号、引号、反斜杠
      .replace(/[<>"')\]\\]+$/, '')
      // 去除末尾的标点
      .replace(/[.,;:!?]+$/, '');
    if (url) urls.add(url);
  }
  return [...urls];
}

export function needsLocalization(url) {
  if (!url) return false;
  if (url.startsWith('/')) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

// ============================================================
// 核心: 从游戏行提取所有 URL 并构造 urlInfo Map
// ============================================================

/**
 * @param {(string|number|null)[][]} rows  游戏数据行
 * @param {Object}     colIdx              列名 → 索引映射
 * @param {Object}     cache               URL 缓存
 * @returns {Map<string, {category, localPath, localUrl, ext, cached}>}
 */
export function buildUrlInfoMap(rows, colIdx, cache) {
  const urlInfo = new Map();

  const addUrl = (url, category) => {
    if (!needsLocalization(url)) return;
    if (urlInfo.has(url)) return;
    const cached = cache[url];
    const hash = hashUrl(url);
    const ext = cached?.ext || inferExtension(url, cached?.contentType || '');
    const subdir = CATEGORY_DIRS[category] || category;
    const filename = `${hash}${ext}`;
    const localPath = join(DATA_DIR, subdir, filename);
    const localUrl = `${LOCAL_FILES_URL_PREFIX}/${subdir}/${filename}`;
    urlInfo.set(url, { category, localPath, localUrl, ext, cached: !!cached });
  };

  for (const row of rows) {
    const preview = row[colIdx.preview];
    const rom = row[colIdx.rom];
    const screenshots = row[colIdx.screenshots];
    const description = row[colIdx.description];

    if (preview) addUrl(String(preview), 'preview');
    if (rom) addUrl(String(rom), 'rom');
    if (screenshots) {
      for (const u of String(screenshots).split(',').map((s) => s.trim()).filter(Boolean)) {
        addUrl(u, 'screenshot');
      }
    }
    if (description) {
      for (const u of extractMarkdownUrls(String(description))) addUrl(u, 'description');
    }
  }

  return urlInfo;
}

/**
 * 并发下载所有未缓存的 URL，更新 cache
 * 下载后会根据实际 Content-Type 修正扩展名（如 URL 无扩展名时）
 */
export async function downloadAllUrls(urlInfo, cache) {
  const toDownload = [...urlInfo.entries()].filter(([, v]) => !v.cached);
  let downloaded = 0;
  let failed = 0;
  const failedUrls = [];

  const tasks = toDownload.map(([url, info]) => async () => {
    // 二次检查: 文件可能已被其他进程下载
    if (existsSync(info.localPath)) {
      downloaded++;
      cache[url] = { ext: info.ext, localUrl: info.localUrl, size: statSync(info.localPath).size };
      return;
    }
    const result = await downloadFile(url, info.localPath);
    if (result.ok) {
      downloaded++;
      // 根据实际 Content-Type 修正扩展名
      let finalExt = info.ext;
      let finalLocalUrl = info.localUrl;
      const inferredFromMime = inferExtension(url, result.contentType);
      if (info.ext === '.bin' && inferredFromMime !== '.bin') {
        finalExt = inferredFromMime;
        const newPath = info.localPath.replace(/\.bin$/, finalExt);
        try {
          renameSync(info.localPath, newPath);
          finalLocalUrl = info.localUrl.replace(/\.bin$/, finalExt);
          info.ext = finalExt;
          info.localPath = newPath;
          info.localUrl = finalLocalUrl;
        } catch { /* 重命名失败则保持原样 */ }
      }
      cache[url] = {
        ext: finalExt,
        localUrl: finalLocalUrl,
        size: result.size,
        contentType: result.contentType,
        downloadedAt: new Date().toISOString(),
      };
      if (downloaded % 10 === 0 || downloaded === toDownload.length) {
        log(`  进度: ${downloaded}/${toDownload.length} (失败 ${failed})`);
      }
    } else {
      failed++;
      failedUrls.push({ url, error: result.error });
      log(`  ✗ 失败: ${url.slice(0, 80)}… → ${result.error}`);
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);
  saveCache(cache);

  return { downloaded, failed, failedUrls, total: toDownload.length };
}

/**
 * 将一行游戏中的远程 URL 替换为本地路径
 */
export function localizeRow(row, colIdx, urlInfo) {
  const newRow = [...row];

  const preview = newRow[colIdx.preview];
  if (preview && urlInfo.has(String(preview))) {
    newRow[colIdx.preview] = urlInfo.get(String(preview)).localUrl;
  }

  const rom = newRow[colIdx.rom];
  if (rom && urlInfo.has(String(rom))) {
    newRow[colIdx.rom] = urlInfo.get(String(rom)).localUrl;
  }

  const screenshots = newRow[colIdx.screenshots];
  if (screenshots) {
    newRow[colIdx.screenshots] = String(screenshots)
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => (urlInfo.has(u) ? urlInfo.get(u).localUrl : u))
      .join(',');
  }

  const description = newRow[colIdx.description];
  if (description) {
    let newDesc = String(description);
    // 按 URL 长度降序排序，避免短 URL 是长 URL 前缀时替换错误
    const sortedUrls = [...urlInfo.keys()].sort((a, b) => b.length - a.length);
    for (const url of sortedUrls) {
      if (newDesc.includes(url)) {
        newDesc = newDesc.split(url).join(urlInfo.get(url).localUrl);
      }
    }
    newRow[colIdx.description] = newDesc;
  }

  return newRow;
}
