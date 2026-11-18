import { afterEach, describe, expect, it, vi } from 'vitest';
import { KvError, SYNC_KEY, getKvConfig, kvGet, kvPut } from './cloud-sync-store';

const cfg = { accountId: 'acc', namespaceId: 'ns', token: 'tok' };
const expectedUrl = `https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns/values/${SYNC_KEY}`;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getKvConfig', () => {
  it('requires all three variables', () => {
    vi.stubEnv('SYNC_CF_ACCOUNT_ID', 'acc');
    vi.stubEnv('SYNC_CF_KV_NAMESPACE_ID', 'ns');
    vi.stubEnv('SYNC_CF_API_TOKEN', '');
    expect(getKvConfig()).toBeNull();
    vi.stubEnv('SYNC_CF_API_TOKEN', ' tok ');
    expect(getKvConfig()).toEqual(cfg);
  });
});

describe('kvGet', () => {
  it('returns the stored text with bearer auth', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    await expect(kvGet(cfg, fetchImpl)).resolves.toBe('{"a":1}');
    expect(fetchImpl).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }));
  });

  it('returns null when the key does not exist yet', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { success: false, errors: [{ code: 10009, message: 'get: key not found' }] }));
    await expect(kvGet(cfg, fetchImpl)).resolves.toBeNull();
  });

  it('throws a hinted error for a wrong namespace', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { success: false, errors: [{ code: 10013, message: 'namespace not found' }] }));
    await expect(kvGet(cfg, fetchImpl)).rejects.toThrow(/SYNC_CF_KV_NAMESPACE_ID/);
  });

  it('throws a hinted error for a bad token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
    const err = await kvGet(cfg, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KvError);
    expect((err as KvError).status).toBe(403);
    expect((err as Error).message).toMatch(/SYNC_CF_API_TOKEN/);
  });
});

describe('kvPut', () => {
  it('PUTs the raw value', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true }));
    await kvPut(cfg, 'payload', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ method: 'PUT', body: 'payload' }));
  });

  it('throws KvError on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { success: false, errors: [{ code: 10001, message: 'boom' }] }));
    await expect(kvPut(cfg, 'x', fetchImpl)).rejects.toBeInstanceOf(KvError);
  });
});
