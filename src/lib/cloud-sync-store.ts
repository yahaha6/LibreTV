/**
 * 云同步存储：通过 Cloudflare KV 的 REST API 读写一份配置快照。
 *
 * 刻意走 REST 而不是 Worker 的 KV 绑定：
 * - Docker / Node / Cloudflare Workers 三种部署方式都能用同一份代码；
 * - 不依赖构建适配器暴露 env 绑定（绑定在 Next.js 路由里拿不到时会静默失效）。
 *
 * 需要部署者配置三个环境变量（缺任意一个即视为未启用云同步）：
 *   SYNC_CF_ACCOUNT_ID      Cloudflare 账户 ID
 *   SYNC_CF_KV_NAMESPACE_ID KV 命名空间 ID
 *   SYNC_CF_API_TOKEN       仅授予 Workers KV Storage:Edit 权限的 API Token
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** KV 中存放快照的键名；格式升级时换键名，避免新旧客户端互相覆盖 */
export const SYNC_KEY = 'libretv-sync-v1';

/** 单份快照体积上限（KV 单值上限 25 MiB，这里留足余量） */
export const MAX_SYNC_BYTES = 5 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 15_000;

/** KV 「键不存在」的错误码：首次使用时云端还没有数据，属于正常情况 */
const KV_KEY_NOT_FOUND = 10009;

export interface KvConfig {
  accountId: string;
  namespaceId: string;
  token: string;
}

export function getKvConfig(): KvConfig | null {
  const accountId = process.env.SYNC_CF_ACCOUNT_ID?.trim();
  const namespaceId = process.env.SYNC_CF_KV_NAMESPACE_ID?.trim();
  const token = process.env.SYNC_CF_API_TOKEN?.trim();
  if (!accountId || !namespaceId || !token) return null;
  return { accountId, namespaceId, token };
}

export class KvError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'KvError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function valueUrl(cfg: KvConfig): string {
  return (
    `${API_BASE}/accounts/${encodeURIComponent(cfg.accountId)}` +
    `/storage/kv/namespaces/${encodeURIComponent(cfg.namespaceId)}` +
    `/values/${encodeURIComponent(SYNC_KEY)}`
  );
}

async function readErrors(res: Response): Promise<{ code?: number; message: string }> {
  try {
    const data = (await res.json()) as { errors?: { code?: number; message?: string }[] };
    const first = data?.errors?.[0];
    if (first) return { code: first.code, message: `${first.code ?? ''} ${first.message ?? ''}`.trim() };
  } catch {
    /* 非 JSON 响应，退回状态码 */
  }
  return { message: `HTTP ${res.status}` };
}

/** 常见失败给出可操作的提示，而不是只抛状态码 */
function hintFor(status: number): string {
  if (status === 401 || status === 403) return '（请检查 SYNC_CF_API_TOKEN 是否有效、是否有 Workers KV Storage 编辑权限）';
  if (status === 404) return '（请检查 SYNC_CF_ACCOUNT_ID 与 SYNC_CF_KV_NAMESPACE_ID 是否正确）';
  return '';
}

/** 读取快照原文；云端还没有数据时返回 null */
export async function kvGet(cfg: KvConfig, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const res = await fetchImpl(valueUrl(cfg), {
    headers: { Authorization: `Bearer ${cfg.token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return res.text();
  const err = await readErrors(res);
  if (res.status === 404 && (err.code === KV_KEY_NOT_FOUND || err.code === undefined)) return null;
  throw new KvError(`读取云端数据失败: ${err.message}${hintFor(res.status)}`, res.status);
}

/** 写入快照原文（整体覆盖） */
export async function kvPut(cfg: KvConfig, value: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const res = await fetchImpl(valueUrl(cfg), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: value,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return;
  const err = await readErrors(res);
  throw new KvError(`写入云端数据失败: ${err.message}${hintFor(res.status)}`, res.status);
}
