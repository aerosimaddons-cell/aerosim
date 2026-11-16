/* AEROSIM large-file Worker source. GITHUB_TOKEN must be configured as a Cloudflare Worker secret. */
/* AEROSIM large-file Worker
 * POST /upload  - signed-in users send a file in <=80 MB parts; stored as GitHub release assets.
 * GET  /dl/...  - streams the parts back to the visitor as one file (the GitHub token never leaves this Worker).
 * Secret required: GITHUB_TOKEN (fine-grained token, only the aerosim repo, Contents: read & write).
 */
const OWNER = 'aerosimaddons-cell', REPO = 'aerosim', BRANCH = 'main';
const SUPABASE_URL = 'https://mqczfatgxuhrhrkniulf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_IPnPyVMST_8R-5Rqi2EnnQ_Hae6zwty'; // public key, same one the website uses
const OWNER_ID = '69f5d978-d4c8-4168-9f2f-6fb20cdcfee7'; // AEROSIM owner account, may clean up any mod
const MAX_PART = 80 * 1024 * 1024 + 1024, MAX_PARTS = 14;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition',
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status, error) => json({ error }, status);

const gh = (env, path, init = {}) => fetch(path.startsWith('http') ? path : 'https://api.github.com' + path, {
  ...init,
  headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'aerosim-large-files', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) },
});

async function getUser(req) {
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: auth, apikey: SUPABASE_KEY } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') ? u : null;
}

const tagFor = (uid, modId) => `m-${uid}-${modId}`;
const okName = n => /^[A-Za-z0-9._-]{1,120}$/.test(n || '');
const okKind = k => k === 'pc' || k === 'and';

async function getRelease(env, tag) {
  const r = await gh(env, `/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Storage lookup failed (' + r.status + ')');
  return r.json();
}
async function ensureRelease(env, tag) {
  let rel = await getRelease(env, tag);
  if (rel) return rel;
  const r = await gh(env, `/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, target_commitish: BRANCH, name: tag, body: 'AEROSIM mod files', make_latest: 'false' }),
  });
  if (!r.ok) { rel = await getRelease(env, tag); if (rel) return rel; throw new Error('Could not create storage (' + r.status + ')'); }
  return r.json();
}
const delAsset = (env, id) => gh(env, `/repos/${OWNER}/${REPO}/releases/assets/${id}`, { method: 'DELETE' });

async function upload(req, env) {
  const user = await getUser(req);
  if (!user) return fail(401, 'Please sign in again before publishing.');
  const q = new URL(req.url).searchParams;
  const modId = q.get('mod') || '', kind = q.get('kind'), name = q.get('name'), part = +q.get('part'), parts = +q.get('parts');
  if (!/^[0-9a-f-]{36}$/i.test(modId) || !okKind(kind) || !okName(name) || !(part >= 1 && parts >= part && parts <= MAX_PARTS)) return fail(400, 'Bad upload request.');
  const len = +req.headers.get('Content-Length');
  if (!len || len > MAX_PART) return fail(413, 'Upload part is too large.');
  const rel = await ensureRelease(env, tagFor(user.id, modId));
  const prefix = kind + '-';
  const assetName = `${prefix}${name}.part${String(part).padStart(3, '0')}`;
  // First part of a (re)upload replaces any older file of this platform; retries replace the same part.
  for (const a of rel.assets || []) if ((part === 1 && a.name.startsWith(prefix)) || a.name === assetName) await delAsset(env, a.id);
  const up = await gh(env, `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(len) }, body: req.body,
  });
  if (!up.ok) return fail(502, 'Storage upload failed (' + up.status + ').');
  return json({ ok: true, url: `${new URL(req.url).origin}/dl/${user.id}/${modId}/${kind}/${name}` });
}

async function remove(req, env) {
  const user = await getUser(req);
  if (!user) return fail(401, 'Please sign in again.');
  const q = new URL(req.url).searchParams, uid = q.get('uid') || '', modId = q.get('mod') || '', kind = q.get('kind');
  if (!/^[0-9a-f-]{36}$/i.test(uid) || !/^[0-9a-f-]{36}$/i.test(modId) || !okKind(kind)) return fail(400, 'Bad request.');
  if (user.id !== uid && user.id !== OWNER_ID) return fail(403, 'Not allowed.');
  const tag = tagFor(uid, modId), rel = await getRelease(env, tag);
  if (!rel) return json({ ok: true });
  const mine = (rel.assets || []).filter(a => a.name.startsWith(kind + '-'));
  for (const a of mine) await delAsset(env, a.id);
  if ((rel.assets || []).length === mine.length) {
    await gh(env, `/repos/${OWNER}/${REPO}/releases/${rel.id}`, { method: 'DELETE' });
    await gh(env, `/repos/${OWNER}/${REPO}/git/refs/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
  }
  return json({ ok: true });
}

async function download(req, env, ctx) {
  const m = new URL(req.url).pathname.match(/^\/dl\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(pc|and)\/([A-Za-z0-9._-]{1,120})$/i);
  if (!m) return fail(404, 'Not found.');
  const [, uid, modId, kind, name] = m;
  const rel = await getRelease(env, tagFor(uid, modId));
  const pre = `${kind}-${name}.part`;
  const assets = ((rel && rel.assets) || []).filter(a => a.name.startsWith(pre) && a.state === 'uploaded').sort((a, b) => a.name.localeCompare(b.name));
  if (!assets.length) return fail(404, 'File not found.');
  const total = assets.reduce((s, a) => s + a.size, 0);
  const headers = { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(total), 'Cache-Control': 'no-store' };
  if (req.method === 'HEAD') return new Response(null, { headers });
  const open = a => gh(env, `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`, { headers: { Accept: 'application/octet-stream' }, redirect: 'follow' });
  if (assets.length === 1) {
    const r = await open(assets[0]);
    if (!r.ok) return fail(502, 'Storage download failed.');
    return new Response(r.body, { headers });
  }
  const { readable, writable } = new FixedLengthStream(total);
  ctx.waitUntil((async () => {
    try {
      for (const a of assets) {
        const r = await open(a);
        if (!r.ok) throw new Error('part failed ' + r.status);
        await r.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) { try { await writable.abort(e); } catch (_) {} }
  })());
  return new Response(readable, { headers });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.GITHUB_TOKEN) return fail(500, 'Large-file storage is not configured yet.');
    const p = new URL(req.url).pathname;
    try {
      if (req.method === 'POST' && p === '/upload') return await upload(req, env);
      if (req.method === 'POST' && p === '/delete') return await remove(req, env);
      if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/dl/')) return await download(req, env, ctx);
      return fail(404, 'Not found.');
    } catch (e) { return fail(500, e.message || 'Server error.'); }
  },
};