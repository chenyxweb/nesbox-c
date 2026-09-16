#!/usr/bin/env node
/**
 * NESBox 游戏数据增量本地化脚本 (更新已有部署使用)
 *
 * 数据源: 官方 NESBox API (https://api.xianqiao.wang/nesbox/guestgraphql)
 *
 * 功能:
 *   1. 从官方 API 获取所有游戏数据
 *   2. 对比 .url-cache.json，仅下载新增/缺失的资源
 *   3. 生成 UPSERT SQL (INSERT ... ON CONFLICT (name) DO UPDATE)
 *      - 新游戏: INSERT
 *      - 已有游戏: UPDATE rom/preview/screenshots/description/updated_at
 *      - 保留用户可能已设置的 platform/series/kind/max_player 等字段
 *
 * 使用:
 *   # 1. 运行增量本地化 (下载新资源 + 生成 SQL)
 *   node deploy/scripts/localize-incremental.mjs
 *
 *   # 2. 将生成的 SQL 应用到数据库
 *   docker compose -f deploy/docker-compose.yml exec -T postgres \
 *     psql -U nesbox -d nesbox < deploy/postgres/init/03-games-update.sql
 *
 * 环境变量 (可选):
 *   NESBOX_API_URL          官方 API 地址
 *   LOCAL_FILES_URL_PREFIX  本地化后 URL 前缀 (默认 /files)
 *   LOCALIZE_CONCURRENCY    下载并发数 (默认 6)
 *   LOCALIZE_RETRIES        下载重试次数 (默认 3)
 *
 * 输出:
 *   deploy/data/...                     新增的资源文件
 *   deploy/data/.url-cache.json         更新后的 URL 缓存
 *   deploy/postgres/init/03-games-update.sql   UPSERT SQL
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exit } from 'node:process';

import {
  buildUrlInfoMap,
  CONCURRENCY,
  DATA_DIR,
  DEPLOY_DIR,
  downloadAllUrls,
  escapeSqlString,
  fetchGamesFromApi,
  loadCache,
  LOCAL_FILES_URL_PREFIX,
  localizeRow,
  log,
  NESBOX_API_URL,
} from './lib.mjs';

const OUTPUT_SQL = join(DEPLOY_DIR, 'postgres/init/03-games-update.sql');

/**
 * 将游戏行转换为 INSERT VALUES 元组
 * 保留官方 id，确保跨部署 id 一致性（与 localize-games.mjs 的 COPY 行为对齐）
 */
function rowToValuesTuple(row, colIdx, columns) {
  const values = columns.map((col) => {
    const val = row[colIdx[col]];
    if (val === null || val === undefined) return 'NULL';
    return escapeSqlString(val);
  });
  return `(${values.join(', ')})`;
}

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log('NESBox 游戏数据增量本地化 (更新已有部署)');
  log('═══════════════════════════════════════════════════════════');
  log(`数据源:         ${NESBOX_API_URL}`);
  log(`本地资源前缀:   ${LOCAL_FILES_URL_PREFIX}`);
  log(`下载并发数:     ${CONCURRENCY}`);
  log('');

  // ---------- 1. 从 API 获取游戏数据 ----------
  log('[1/5] 获取游戏数据 …');
  const { columns, rows, topGames } = await fetchGamesFromApi();
  log(`  共 ${rows.length} 条游戏记录`);

  const colIdx = Object.fromEntries(columns.map((c, i) => [c, i]));

  // ---------- 2. 提取 URL 并对比缓存 ----------
  log('[2/5] 提取远程资源 URL …');
  const cache = loadCache();
  const urlInfo = buildUrlInfoMap(rows, colIdx, cache);
  const totalUrls = urlInfo.size;
  const cachedCount = [...urlInfo.values()].filter((v) => v.cached).length;
  const newCount = totalUrls - cachedCount;
  log(`  共 ${totalUrls} 个唯一 URL，已缓存 ${cachedCount}，新增 ${newCount}`);

  if (newCount === 0) {
    log('  ✓ 无新增资源需要下载');
  }

  // ---------- 3. 下载新增资源 ----------
  log('[3/5] 下载新增资源 …');
  const { downloaded, failed, failedUrls } = await downloadAllUrls(urlInfo, cache);
  log(`  下载完成: 成功 ${downloaded}, 失败 ${failed}`);

  if (failedUrls.length) {
    const failLog = join(DATA_DIR, '.failed-downloads.json');
    writeFileSync(failLog, JSON.stringify(failedUrls, null, 2));
    log(`  ⚠ 失败列表: ${failLog}`);
  }

  // ---------- 4. 生成 UPSERT SQL ----------
  log('[4/5] 生成增量更新 SQL …');

  const valueColumns = columns;
  const outLines = [
    '-- ============================================================',
    '-- NESBox 游戏数据增量更新 (UPSERT 格式)',
    `-- 由 localize-incremental.mjs 生成于 ${new Date().toISOString()}`,
    `-- 数据源: ${NESBOX_API_URL}`,
    `-- 共 ${rows.length} 条记录，${newCount} 个新增资源`,
    '--',
    '-- 应用方式:',
    '--   docker compose -f deploy/docker-compose.yml exec -T postgres \\',
    '--     psql -U nesbox -d nesbox < deploy/postgres/init/03-games-update.sql',
    '--',
    '-- 行为说明:',
    '--   - 新游戏 (name 不存在): INSERT 带官方 id',
    '--   - 已有游戏 (name 存在): UPDATE 同步官方 id + rom/preview/screenshots/description/updated_at',
    '--   - 保留 platform/series/kind/max_player 等用户可能已编辑的字段',
    '-- ============================================================',
    '',
    'BEGIN;',
    '',
    `INSERT INTO public.games (${valueColumns.join(', ')})`,
    'VALUES',
  ];

  const valueTuples = rows.map((row) => {
    const localized = localizeRow(row, colIdx, urlInfo);
    return `  ${rowToValuesTuple(localized, colIdx, columns)}`;
  });
  outLines.push(valueTuples.join(',\n'));

  outLines.push('ON CONFLICT (name) DO UPDATE SET');
  outLines.push('  id          = EXCLUDED.id,');
  outLines.push('  description = EXCLUDED.description,');
  outLines.push('  preview     = EXCLUDED.preview,');
  outLines.push('  rom         = EXCLUDED.rom,');
  outLines.push('  screenshots = EXCLUDED.screenshots,');
  outLines.push('  updated_at  = EXCLUDED.updated_at,');
  outLines.push('  deleted_at  = EXCLUDED.deleted_at;');
  outLines.push('');

  // 更新序列值
  const maxId = rows.reduce((max, r) => Math.max(max, parseInt(r[colIdx.id], 10) || 0), 0);
  outLines.push(`-- 同步序列值`);
  outLines.push(`SELECT pg_catalog.setval('public.games_id_seq', GREATEST(pg_catalog.last_value, ${maxId}), true);`);
  outLines.push('');
  outLines.push('COMMIT;');
  outLines.push('');

  mkdirSync(dirname(OUTPUT_SQL), { recursive: true });
  writeFileSync(OUTPUT_SQL, outLines.join('\n'));
  log(`  ✓ 已写入: ${OUTPUT_SQL} (${(outLines.join('\n').length / 1024).toFixed(1)} KB)`);

  // ---------- 5. 汇总 ----------
  log('');
  log('═══════════════════════════════════════════════════════════');
  log('增量本地化完成');
  log('═══════════════════════════════════════════════════════════');
  log(`游戏记录:     ${rows.length}`);
  log(`新增资源:     ${newCount} (成功 ${downloaded}, 失败 ${failed})`);
  log(`SQL 输出:     ${OUTPUT_SQL}`);
  log('');
  log('下一步: 将 SQL 应用到数据库');
  log('  docker compose -f deploy/docker-compose.yml exec -T postgres \\');
  log('    psql -U nesbox -d nesbox < deploy/postgres/init/03-games-update.sql');
  log('');

  if (failed > 0) {
    log(`⚠ 有 ${failed} 个资源下载失败`);
    exit(2);
  }
}

main().catch((err) => {
  console.error('[localize] 致命错误:', err);
  exit(1);
});
