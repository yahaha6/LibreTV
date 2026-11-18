'use client';

import { MAX_HISTORY, db } from './db';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import { MAX_SYNC_PROGRESS, SYNC_FORMAT_NAME, SYNC_FORMAT_VERSION, type SyncSnapshot } from './cloud-sync-format';

/** 本机最近一次与云端成功同步（上传或恢复）的时间，只用于界面展示 */
const LAST_SYNC_KEY = 'libretv-cloud-last-sync';

export function readLastSync(): { at: number; direction: 'up' | 'down' } | null {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: unknown; direction?: unknown };
    if (typeof v.at !== 'number' || (v.direction !== 'up' && v.direction !== 'down')) return null;
    return { at: v.at, direction: v.direction };
  } catch {
    return null;
  }
}

export function recordLastSync(direction: 'up' | 'down'): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, JSON.stringify({ at: Date.now(), direction }));
  } catch {
    /* 存储不可用时只是不显示上次同步时间 */
  }
}

/** 采集本机当前的设置、观看历史与逐集进度 */
export async function buildSnapshot(): Promise<SyncSnapshot> {
  // 先 flush 节流缓冲，确保上传的是最新设置而不是 800ms 前的旧快照
  flushPendingPersist();
  const [history, progress] = await Promise.all([
    db.history.orderBy('timestamp').reverse().limit(MAX_HISTORY).toArray(),
    db.progress.orderBy('updatedAt').reverse().limit(MAX_SYNC_PROGRESS).toArray(),
  ]);
  return {
    name: SYNC_FORMAT_NAME,
    version: SYNC_FORMAT_VERSION,
    updatedAt: Date.now(),
    settings: localStorage.getItem(PERSIST_KEY),
    history,
    progress,
  };
}

/**
 * 把云端快照应用到本机：
 * - 设置（含点播源、直播源、订阅、收藏）以云端为准整体覆盖；
 * - 观看历史与逐集进度按时间戳合并，同一条目保留较新的记录，本机独有的记录不会丢。
 */
export async function applySnapshot(snap: SyncSnapshot): Promise<void> {
  if (snap.settings) {
    // 先 flush 旧状态再写入，否则节流缓冲稍后 flush 会用旧设置覆盖刚恢复的设置
    flushPendingPersist();
    localStorage.setItem(PERSIST_KEY, snap.settings);
  }

  await db.transaction('rw', db.history, db.progress, async () => {
    const localHistory = new Map((await db.history.bulkGet(snap.history.map((h) => h.id))).map((h) => [h?.id, h]));
    const newerHistory = snap.history.filter((h) => {
      const local = localHistory.get(h.id);
      return !local || h.timestamp > local.timestamp;
    });
    if (newerHistory.length) await db.history.bulkPut(newerHistory);

    const localProgress = new Map((await db.progress.bulkGet(snap.progress.map((p) => p.key))).map((p) => [p?.key, p]));
    const newerProgress = snap.progress.filter((p) => {
      const local = localProgress.get(p.key);
      return !local || p.updatedAt > local.updatedAt;
    });
    if (newerProgress.length) await db.progress.bulkPut(newerProgress);

    // 合并后历史可能超过上限：按时间淘汰最旧的记录，与 upsertHistory 的上限保持一致
    const total = await db.history.count();
    if (total > MAX_HISTORY) {
      const stale = await db.history.orderBy('timestamp').limit(total - MAX_HISTORY).primaryKeys();
      await db.history.bulkDelete(stale);
    }
  });
}
