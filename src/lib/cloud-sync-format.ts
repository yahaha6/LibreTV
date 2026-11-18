import type { HistoryEntry, ProgressEntry } from './db';

/**
 * 云同步快照格式（服务端校验与客户端读写共用，不依赖浏览器 API）。
 *
 * - settings：zustand 持久化的设置原文（含点播源、直播源、订阅、收藏与偏好），恢复时整体覆盖；
 * - history / progress：观看历史与逐集进度，恢复时按时间戳合并，保留较新的一条。
 */
export const SYNC_FORMAT_NAME = 'LibreTV-Sync';
export const SYNC_FORMAT_VERSION = 1;

/** 逐集进度条数上限：只同步最近的这些条，避免长期使用后快照无限膨胀 */
export const MAX_SYNC_PROGRESS = 3000;

export interface SyncSnapshot {
  name: typeof SYNC_FORMAT_NAME;
  version: number;
  updatedAt: number;
  settings: string | null;
  history: HistoryEntry[];
  progress: ProgressEntry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function toHistory(v: unknown): HistoryEntry | null {
  if (!isObj(v)) return null;
  const { sourceKey, vodId, title, episodeIndex, totalEpisodes, playbackPosition, duration, timestamp } = v;
  if (!isStr(sourceKey) || !sourceKey || !isStr(vodId) || !vodId) return null;
  if (!isNum(timestamp)) return null;
  return {
    id: `${sourceKey}_${vodId}`,
    sourceKey,
    sourceUrl: isStr(v.sourceUrl) ? v.sourceUrl : undefined,
    vodId,
    title: isStr(title) && title ? title : '未知视频',
    pic: isStr(v.pic) ? v.pic : undefined,
    episodeIndex: isNum(episodeIndex) ? episodeIndex : 0,
    totalEpisodes: isNum(totalEpisodes) ? totalEpisodes : 0,
    playbackPosition: isNum(playbackPosition) ? playbackPosition : 0,
    duration: isNum(duration) ? duration : 0,
    timestamp,
  };
}

function toProgress(v: unknown): ProgressEntry | null {
  if (!isObj(v)) return null;
  const { key, position, duration, updatedAt } = v;
  if (!isStr(key) || !key || !isNum(position) || !isNum(updatedAt)) return null;
  return { key, position, duration: isNum(duration) ? duration : 0, updatedAt };
}

/** 宽松解析：丢弃损坏的条目，整体格式不对时返回 null */
export function parseSnapshot(raw: unknown): SyncSnapshot | null {
  if (!isObj(raw)) return null;
  if (raw.name !== SYNC_FORMAT_NAME || !isNum(raw.version) || !isNum(raw.updatedAt)) return null;
  if (raw.version > SYNC_FORMAT_VERSION) return null;
  if (raw.settings !== null && raw.settings !== undefined && !isStr(raw.settings)) return null;
  const history = (Array.isArray(raw.history) ? raw.history : []).map(toHistory).filter((h): h is HistoryEntry => h !== null);
  const progress = (Array.isArray(raw.progress) ? raw.progress : [])
    .map(toProgress)
    .filter((p): p is ProgressEntry => p !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SYNC_PROGRESS);
  return {
    name: SYNC_FORMAT_NAME,
    version: raw.version,
    updatedAt: raw.updatedAt,
    settings: isStr(raw.settings) ? raw.settings : null,
    history,
    progress,
  };
}

/** 快照内容概要，用于恢复前确认 */
export function summarizeSnapshot(snap: SyncSnapshot): string {
  const parts: string[] = [];
  if (snap.settings) {
    try {
      const state = (JSON.parse(snap.settings) as { state?: Record<string, unknown> }).state ?? {};
      const count = (k: string) => (Array.isArray(state[k]) ? (state[k] as unknown[]).length : 0);
      parts.push(`${count('customAPIs')} 个点播源`, `${count('liveSubscriptions')} 个直播源`, `${count('subscriptions')} 个订阅`);
    } catch {
      /* 设置片段损坏时只跳过统计 */
    }
  }
  parts.push(`${snap.history.length} 条观看历史`);
  return parts.join('、');
}
