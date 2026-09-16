#!/usr/bin/env node
/**
 * NESBox 游戏数据完整本地化脚本 (首次部署使用)
 *
 * 数据源: 官方 NESBox API (https://api.xianqiao.wang/nesbox/guestgraphql)
 *
 * 功能:
 *   1. 从官方 API 获取所有游戏数据
 *   2. 提取并下载所有远程资源 (ROM / 预览图 / 截图 / description 内嵌图片)
 *   3. 生成本地化后的 SQL 文件 (COPY 格式)，URL 替换为 /files/... 相对路径
 *
 * 使用:
 *   node deploy/scripts/localize-games.mjs
 *
 * 环境变量 (可选，参见 .env.example):
 *   NESBOX_API_URL          官方 API 地址
 *   LOCAL_FILES_URL_PREFIX  本地化后 URL 前缀 (默认 /files)
 *   LOCALIZE_CONCURRENCY    下载并发数 (默认 6)
 *   LOCALIZE_RETRIES        下载重试次数 (默认 3)
 *
 * 输出:
 *   deploy/data/roms/*              ROM 文件
 *   deploy/data/previews/*          预览图
 *   deploy/data/screenshots/*       截图
 *   deploy/data/description/*       description 内嵌图片
 *   deploy/data/.url-cache.json     URL → 本地路径映射缓存
 *   deploy/postgres/init/02-games.sql   本地化后的 SQL (COPY 格式)
 *
 * 增量更新请使用: localize-incremental.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exit } from 'node:process';

import {
  buildUrlInfoMap,
  downloadAllUrls,
  escapeCopyField,
  fetchGamesFromApi,
  loadCache,
  localizeRow,
  log,
  saveCache,
  DATA_DIR,
  DEPLOY_DIR,
  NESBOX_API_URL,
  LOCAL_FILES_URL_PREFIX,
  CONCURRENCY,
} from './lib.mjs';

const OUTPUT_SQL = join(DEPLOY_DIR, 'postgres/init/02-games.sql');

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log('NESBox 游戏数据完整本地化 (首次部署)');
  log('═══════════════════════════════════════════════════════════');
  log(`数据源:         ${NESBOX_API_URL}`);
  log(`本地资源前缀:   ${LOCAL_FILES_URL_PREFIX}`);
  log(`下载并发数:     ${CONCURRENCY}`);
  log(`数据输出目录:   ${DATA_DIR}`);
  log('');

  // ---------- 1. 从 API 获取游戏数据 ----------
  log('[1/5] 获取游戏数据 …');
  const { columns, rows, topGames } = await fetchGamesFromApi();
  log(`  共 ${rows.length} 条游戏记录`);
  log(`  推荐游戏: ${topGames.length} 条`);

  const colIdx = Object.fromEntries(columns.map((c, i) => [c, i]));

  // ---------- 2. 提取所有待下载 URL ----------
  log('[2/5] 提取远程资源 URL …');
  const cache = loadCache();
  const urlInfo = buildUrlInfoMap(rows, colIdx, cache);
  const totalUrls = urlInfo.size;
  const cachedCount = [...urlInfo.values()].filter((v) => v.cached).length;
  log(`  共 ${totalUrls} 个唯一 URL，缓存命中 ${cachedCount}，待下载 ${totalUrls - cachedCount}`);

  // ---------- 3. 并发下载 ----------
  log('[3/5] 下载远程资源 …');
  const { downloaded, failed, failedUrls } = await downloadAllUrls(urlInfo, cache);
  log(`  下载完成: 成功 ${downloaded}, 失败 ${failed}, 缓存命中 ${cachedCount}`);

  if (failedUrls.length) {
    const failLog = join(DATA_DIR, '.failed-downloads.json');
    writeFileSync(failLog, JSON.stringify(failedUrls, null, 2));
    log(`  ⚠ 失败列表已写入: ${failLog}`);
    log('  提示: 重新运行脚本可重试失败项 (已下载的会跳过)');
  }

  // ---------- 4. 生成本地化 SQL (COPY 格式) ----------
  log('[4/5] 生成本地化 SQL …');
  const copyColumns = columns.join(', ');
  const outLines = [
    '-- ============================================================',
    '-- NESBox 游戏数据 (本地化版本, COPY 格式)',
    `-- 由 localize-games.mjs 生成于 ${new Date().toISOString()}`,
    `-- 数据源: ${NESBOX_API_URL}`,
    `-- 共 ${rows.length} 条记录，${totalUrls} 个资源已本地化`,
    '--',
    '-- 此文件由 postgres 容器首次启动时自动执行',
    '-- 如需更新已有数据库，请使用 localize-incremental.mjs',
    '-- ============================================================',
    '',
    'BEGIN;',
    '',
    `COPY public.games (${copyColumns}) FROM stdin;`,
  ];

  for (const row of rows) {
    const localized = localizeRow(row, colIdx, urlInfo);
    outLines.push(localized.map(escapeCopyField).join('\t'));
  }

  outLines.push('\\.');
  outLines.push('');

  // 重置序列值，确保后续 INSERT 不会主键冲突
  const maxId = rows.reduce((max, r) => Math.max(max, parseInt(r[colIdx.id], 10) || 0), 0);
  outLines.push(`SELECT pg_catalog.setval('public.games_id_seq', ${maxId}, true);`);
  outLines.push('');
  outLines.push('COMMIT;');
  outLines.push('');

  mkdirSync(dirname(OUTPUT_SQL), { recursive: true });
  writeFileSync(OUTPUT_SQL, outLines.join('\n'));
  log(`  ✓ 已写入: ${OUTPUT_SQL} (${(outLines.join('\n').length / 1024).toFixed(1)} KB)`);

  // ---------- 5. 汇总 ----------
  log('');
  log('═══════════════════════════════════════════════════════════');
  log('本地化完成');
  log('═══════════════════════════════════════════════════════════');
  log(`游戏记录:     ${rows.length}`);
  log(`资源 URL:     ${totalUrls} (成功 ${downloaded + cachedCount}, 失败 ${failed})`);
  log(`数据目录:     ${DATA_DIR}`);
  log(`SQL 输出:     ${OUTPUT_SQL}`);
  log('');
  log('下一步:');
  log('  cd deploy && docker compose up -d --build');
  log('');

  if (failed > 0) {
    log(`⚠ 有 ${failed} 个资源下载失败，对应游戏可能无法正常加载`);
    log(`  查看失败列表: ${join(DATA_DIR, '.failed-downloads.json')}`);
    log('  重新运行本脚本可重试失败项');
    exit(2);
  }
}

main().catch((err) => {
  console.error('[localize] 致命错误:', err);
  exit(1);
});
