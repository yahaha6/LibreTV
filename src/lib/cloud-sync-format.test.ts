import { describe, expect, it } from 'vitest';
import { MAX_SYNC_PROGRESS, SYNC_FORMAT_NAME, parseSnapshot, summarizeSnapshot } from './cloud-sync-format';

const base = { name: SYNC_FORMAT_NAME, version: 1, updatedAt: 1700000000000 };

describe('parseSnapshot', () => {
  it('rejects non-snapshot payloads', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot([])).toBeNull();
    expect(parseSnapshot({ ...base, name: 'LibreTV-Settings' })).toBeNull();
    expect(parseSnapshot({ ...base, updatedAt: 'x' })).toBeNull();
    expect(parseSnapshot({ ...base, version: 99 })).toBeNull();
    expect(parseSnapshot({ ...base, settings: 123 })).toBeNull();
  });

  it('keeps valid history, rebuilds ids and drops broken entries', () => {
    const snap = parseSnapshot({
      ...base,
      settings: '{"state":{}}',
      history: [
        { sourceKey: 'a', vodId: '1', title: 'T', episodeIndex: 2, totalEpisodes: 10, playbackPosition: 30, duration: 60, timestamp: 5, id: 'forged' },
        { sourceKey: '', vodId: '2', timestamp: 1 },
        { sourceKey: 'b', vodId: '3' },
        'junk',
      ],
    });
    expect(snap).not.toBeNull();
    expect(snap!.history).toHaveLength(1);
    expect(snap!.history[0]).toMatchObject({ id: 'a_1', sourceKey: 'a', vodId: '1', episodeIndex: 2, timestamp: 5 });
    expect(snap!.progress).toEqual([]);
  });

  it('caps progress to the most recent entries', () => {
    const progress = Array.from({ length: MAX_SYNC_PROGRESS + 5 }, (_, i) => ({ key: `k${i}`, position: 1, duration: 2, updatedAt: i }));
    const snap = parseSnapshot({ ...base, settings: null, progress });
    expect(snap!.progress).toHaveLength(MAX_SYNC_PROGRESS);
    expect(snap!.progress[0].updatedAt).toBe(MAX_SYNC_PROGRESS + 4);
  });
});

describe('summarizeSnapshot', () => {
  it('counts sources, subscriptions and history', () => {
    const settings = JSON.stringify({ state: { customAPIs: [1, 2], liveSubscriptions: [1], subscriptions: [] } });
    const snap = parseSnapshot({ ...base, settings, history: [{ sourceKey: 'a', vodId: '1', timestamp: 1 }] })!;
    expect(summarizeSnapshot(snap)).toBe('2 个点播源、1 个直播源、0 个订阅、1 条观看历史');
  });
});
