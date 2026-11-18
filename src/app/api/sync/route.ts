import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { KvError, MAX_SYNC_BYTES, getKvConfig, kvGet, kvPut } from '@/lib/cloud-sync-store';
import { parseSnapshot } from '@/lib/cloud-sync-format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_CONFIGURED =
  '服务器未启用云同步：需要配置 SYNC_CF_ACCOUNT_ID、SYNC_CF_KV_NAMESPACE_ID、SYNC_CF_API_TOKEN 三个环境变量';

const NO_STORE = { 'Cache-Control': 'no-store' };

function kvFailure(err: unknown): NextResponse {
  // KvError：Cloudflare 明确返回了错误；其余（超时、网络中断）按网关超时处理
  if (err instanceof KvError) return NextResponse.json({ error: err.message }, { status: 502, headers: NO_STORE });
  const message = err instanceof Error && err.name === 'TimeoutError' ? '连接 Cloudflare KV 超时' : '连接 Cloudflare KV 失败';
  return NextResponse.json({ error: message }, { status: 504, headers: NO_STORE });
}

/** 读取云端快照；云端还没有数据时返回 { snapshot: null } */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const cfg = getKvConfig();
  if (!cfg) return jsonError(NOT_CONFIGURED, 501);

  try {
    const raw = await kvGet(cfg);
    if (raw === null) return NextResponse.json({ snapshot: null }, { headers: NO_STORE });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError('云端数据已损坏，请重新上传', 500);
    }
    const snapshot = parseSnapshot(parsed);
    if (!snapshot) return jsonError('云端数据格式不受支持，请重新上传', 500);
    return NextResponse.json({ snapshot }, { headers: NO_STORE });
  } catch (err) {
    return kvFailure(err);
  }
}

/** 用请求体中的快照整体覆盖云端数据 */
export async function PUT(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const cfg = getKvConfig();
  if (!cfg) return jsonError(NOT_CONFIGURED, 501);

  const body = await req.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_SYNC_BYTES) {
    return jsonError('同步数据过大（超过 5 MB），请先清理部分观看历史', 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonError('请求内容不是合法 JSON', 400);
  }
  const snapshot = parseSnapshot(parsed);
  if (!snapshot) return jsonError('同步数据格式不正确', 400);

  try {
    // 存规范化后的快照：丢弃损坏条目与未知字段，云端只保留已知结构
    await kvPut(cfg, JSON.stringify(snapshot));
    return NextResponse.json({ ok: true, updatedAt: snapshot.updatedAt }, { headers: NO_STORE });
  } catch (err) {
    return kvFailure(err);
  }
}
