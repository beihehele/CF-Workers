'use strict';

// ─── 配置 ───────────────────────────────────────────────────────────────────

const PREFIX = '/';
const DEFAULT_BLOCKED_UA = ['netcraft'];
const SPEEDTEST_MAX_BYTES = 100_000_000;
const MAX_REDIRECT_DEPTH = 5;

const GH_PATTERNS = {
    releaseArchive: /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i,
    blobRaw: /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i,
    infoGit: /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i,
    rawHost: /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i,
    gist: /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i,
    tags: /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i,
};

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-OpenRouter-Key',
    'access-control-expose-headers': '*',
    'access-control-max-age': '1728000',
};

// ─── 工具函数 ───────────────────────────────────────────────────────────────

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

const text = (body, status = 200, type = 'text/plain') =>
    new Response(body, { status, headers: { 'Content-Type': `${type}; charset=utf-8`, ...CORS } });

const err = (message, status = 500) => json({ code: status, message }, status);

const preflight = () => new Response(null, { status: 204, headers: CORS });

function applyCors(headers) {
    headers.set('access-control-allow-origin', '*');
    headers.set('access-control-expose-headers', '*');
    return headers;
}

function checkGitHubUrl(u) {
    return Object.values(GH_PATTERNS).some((re) => re.test(u));
}

function parseEnvList(value) {
    if (!value) return [];
    const s = value.replace(/[ |"'\r\n]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '');
    return s ? s.split(',').filter(Boolean) : [];
}

/** 解析私有库：GH_REPO=owner/repo@branch */
function parsePrivateRepo(env) {
    const spec = env.GH_REPO;
    if (!spec?.includes('/')) return null;
    const m = spec.match(/^([^/]+)\/([^/@#:]+)(?:[@#:](.+))?$/);
    if (!m) return null;
    return { name: m[1], repo: m[2], branch: m[3] || 'main' };
}

/** 解析 Gist：GIST=user/gist_id */
function parseGist(env) {
    if (!env.GIST) return null;
    const i = env.GIST.indexOf('/');
    if (i <= 0) return null;
    return { user: env.GIST.slice(0, i), id: env.GIST.slice(i + 1) };
}

/** PUBLIC=1|all 或 PUBLIC=github,speedtest */
function isPublicEndpoint(env, name) {
    if (!env.AUTH_TOKEN) return true;
    const pub = env.PUBLIC;
    if (pub === '1' || pub?.toLowerCase() === 'all') return true;
    return !!(pub && parseEnvList(pub).some((p) => p.toLowerCase() === name));
}

/** 404 重定向：HOME=302:url */
function getFallbackRedirect(env) {
    if (env.HOME?.startsWith('302:')) return env.HOME.slice(4);
    return null;
}

/** 首页：HOME=nginx|proxy:url|302:url */
function resolveHome(env) {
    const home = env.HOME;
    if (!home) return { type: 'page' };
    if (home.toLowerCase() === 'nginx') return { type: 'nginx' };
    if (home.startsWith('302:')) return { type: 'redirect', target: home.slice(4) };
    if (home.startsWith('proxy:')) return { type: 'proxy', target: home.slice(6) };
    return { type: 'proxy', target: home };
}

/** 合并默认与自定义拦截 UA */
function getBlockedUA(env) {
    const extra = parseEnvList(env.UA);
    return [...DEFAULT_BLOCKED_UA, ...extra];
}

function isBlockedUA(request, blockedUA) {
    const ua = (request.headers.get('User-Agent') || '').toLowerCase();
    return blockedUA.length > 0 && blockedUA.some((k) => ua.includes(k));
}

/** GitHub REST API 路由：/github/ 但不匹配 /github.com/ */
function isGitHubApiRoute(pathname) {
    return pathname.startsWith('/github/') && !pathname.startsWith('/github.com');
}

/** /raw/ API 路由（精确前缀，避免与 /raw.githubusercontent.com 直连冲突） */
function isRawApiRoute(pathname) {
    return pathname === '/raw' || pathname.startsWith('/raw/');
}

/** 从 Header 或 URL ?token= 获取客户端密钥（Header 优先） */
function getClientToken(request, url) {
    const header = request.headers.get('Authorization');
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const fromQuery = url.searchParams.get('token')?.trim() || null;
    return fromHeader || fromQuery || null;
}

function authRequiredErr() {
    return err('请提供 AUTH_TOKEN（Header: Bearer 或 URL ?token=）', 401);
}

function authInvalidErr() {
    return err('AUTH_TOKEN 无效', 403);
}

/** 时序安全的密钥比较 */
async function secureCompare(provided, expected) {
    const enc = new TextEncoder();
    const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(provided || '')));
    const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(expected || '')));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function validateToken(request, url, env) {
    const token = getClientToken(request, url);
    if (!token) return { ok: false, missing: true };
    if (!env.AUTH_TOKEN) return { ok: false, missing: true };
    const valid = await secureCompare(token, env.AUTH_TOKEN);
    return valid ? { ok: true } : { ok: false, missing: false };
}

async function requireAuthUnlessPublic(request, url, env, endpoint) {
    if (isPublicEndpoint(env, endpoint)) return null;
    const r = await validateToken(request, url, env);
    if (r.ok) return null;
    return r.missing ? authRequiredErr() : authInvalidErr();
}

/** 白名单检查：从 env.WHITE_LIST 读取，支持逗号分隔 */
function checkWhiteList(urlStr, env) {
    const list = parseEnvList(env.WHITE_LIST);
    if (!list.length) return true;
    return list.some((w) => urlStr.includes(w));
}

function buildHeaders(request, env) {
    const h = new Headers(request.headers);
    h.set('User-Agent', 'Cloudflare-Worker');
    if (env.GITHUB_TOKEN) h.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
    if (h.has('accept-language')) h.set('accept-language', h.get('accept-language').replace('zh-CN', 'zh-SG'));
    h.delete('host');
    return h;
}

/** 流式代理 + 重定向改写 */
async function proxyGitHub(targetUrl, reqInit, workerOrigin, depth = 0) {
    if (depth > MAX_REDIRECT_DEPTH) return err('重定向次数过多', 502);

    const res = await fetch(targetUrl, reqInit);
    const headers = new Headers(res.headers);

    if (headers.has('location')) {
        const loc = headers.get('location');
        if (checkGitHubUrl(loc)) {
            headers.set('location', workerOrigin + PREFIX + loc.replace(/^https?:\/\//, ''));
        } else if (loc.startsWith('http')) {
            const newInit = { ...reqInit, redirect: 'manual' }; // 避免修改原对象
            return proxyGitHub(loc, newInit, workerOrigin, depth + 1);
        }
    }

    applyCors(headers);
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.delete('clear-site-data');

    return new Response(res.body, { status: res.status, headers });
}

function httpHandler(request, pathname, workerOrigin, env = {}) {
    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
        return preflight();
    }

    // 去掉前导斜杠再检查白名单
    let urlStr = pathname.replace(/^\/+/, '');
    if (!checkWhiteList(urlStr, env)) return err('路径不在白名单', 403);
    if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;

    return proxyGitHub(urlStr, {
        method: request.method,
        headers: buildHeaders(request, env),
        redirect: 'manual',
        body: request.body,
    }, workerOrigin);
}

function handleDirectGitHubPath(request, url, env) {
    let path = url.href.substring(url.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://');

    if (GH_PATTERNS.releaseArchive.test(path) || GH_PATTERNS.gist.test(path) ||
        GH_PATTERNS.tags.test(path) || GH_PATTERNS.infoGit.test(path) || GH_PATTERNS.rawHost.test(path)) {
        return httpHandler(request, path, url.origin, env);
    }
    if (GH_PATTERNS.blobRaw.test(path)) {
        if (env.JSDELIVR === '1') {
            const cdn = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh');
            return Response.redirect(cdn, 302);
        }
        path = path.replace('/blob/', '/raw/');
        return httpHandler(request, path, url.origin, env);
    }
    return null;
}

function validateQRedirect(q) {
    const path = q.replace(/^https?:\/\//, '');
    const testUrl = path.startsWith('http') ? path : `https://${path}`;
    return checkGitHubUrl(testUrl);
}

function buildMyRawUrl(env, subPath) {
    const repo = parsePrivateRepo(env);
    if (!repo) return null;
    const base = `https://raw.githubusercontent.com/${repo.name}/${repo.repo}/${repo.branch}`;
    return base + (subPath.startsWith('/') ? subPath : `/${subPath}`);
}

/** myRaw 鉴权 */
async function authorizeMyRaw(request, url, env, subPath) {
    if (!env.GH_TOKEN) return { ok: false, response: err('服务未配置 GH_TOKEN', 500) };

    const normalizedPath = decodeURIComponent(subPath.toLowerCase());

    if (env.TOKEN_PATH) {
        const pathConfigs = parseEnvList(env.TOKEN_PATH);

        for (const config of pathConfigs) {
            const at = config.indexOf('@');
            if (at <= 0) continue;
            const requiredToken = config.slice(0, at).trim();
            const pathPart = config.slice(at + 1).trim();
            const normalizedRequired = '/' + pathPart.toLowerCase().replace(/^\//, '');
            const pathMatches = normalizedPath === normalizedRequired
                || normalizedPath.startsWith(normalizedRequired + '/');

            if (!pathMatches) continue;

            const provided = getClientToken(request, url);
            if (!provided) return { ok: false, response: authRequiredErr() };
            if (!await secureCompare(provided, requiredToken)) {
                return { ok: false, response: authInvalidErr() };
            }
            return { ok: true };
        }
    }

    if (!env.AUTH_TOKEN) return { ok: false, response: err('未配置 AUTH_TOKEN', 500) };

    const provided = getClientToken(request, url);
    if (!provided) return { ok: false, response: authRequiredErr() };
    if (!await secureCompare(provided, env.AUTH_TOKEN)) {
        return { ok: false, response: authInvalidErr() };
    }
    return { ok: true };
}

// ─── 主页 ───────────────────────────────────────────────────────────────────

function homePage(origin) {
    const base = origin + '/';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>边缘代理工具箱</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;
background:linear-gradient(135deg,#24292e,#0d1117);color:#f0f6fc;padding:20px}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:1.75rem;text-align:center;margin:1.5rem 0 .5rem}
.sub{text-align:center;opacity:.7;font-size:.9rem;margin-bottom:1.5rem}
.search{position:relative;margin-bottom:1.5rem}
.search input{width:100%;height:50px;padding:0 50px 0 18px;border:2px solid transparent;border-radius:10px;font-size:.95rem}
.search input:focus{outline:none;border-color:#58a6ff}
.search button{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:40px;height:40px;
border:none;border-radius:8px;background:#58a6ff;color:#fff;cursor:pointer;font-size:1.1rem}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:1.25rem;margin-bottom:1rem}
.card h2{font-size:1rem;color:#58a6ff;margin-bottom:.6rem}
.card p,.card li{font-size:.85rem;opacity:.8;line-height:1.7}
code{display:block;background:#161b22;color:#a8d8a8;padding:.6rem .8rem;border-radius:6px;font-size:.78rem;
margin-top:.4rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
code.inline{display:inline;background:transparent;color:#a8d8a8;padding:0;margin:0}
.ep{margin-bottom:.8rem;padding-bottom:.8rem;border-bottom:1px solid rgba(255,255,255,.06)}
.ep:last-child{border:none;margin:0;padding:0}
.tag{font-size:.65rem;background:rgba(255,255,255,.1);padding:.1rem .3rem;border-radius:3px;margin-left:.3rem}
.formula{background:#161b22;border:1px solid rgba(88,166,255,.3);border-radius:8px;padding:.8rem 1rem;
font-size:.9rem;text-align:center;margin:.8rem 0;color:#58a6ff}
.base-row{display:flex;gap:.5rem;align-items:center;margin:.6rem 0}
.base-row code{flex:1;margin:0}
.copy-btn{padding:.35rem .7rem;border:none;border-radius:6px;background:#238636;color:#fff;
font-size:.75rem;cursor:pointer;white-space:nowrap}
.copy-btn:hover{background:#2ea043}
.auth-box{background:#161b22;border-radius:6px;padding:.75rem;margin-top:.6rem;font-size:.82rem;line-height:1.9}
.auth-box dt{color:#58a6ff;font-weight:600;margin-top:.4rem}
.auth-box dt:first-child{margin-top:0}
.auth-box dd{opacity:.85;margin-left:0}
.note{font-size:.78rem;opacity:.65;margin-top:.5rem}
.test-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1rem}
.test-col{min-width:0;display:flex;flex-direction:column}
@media(max-width:640px){.test-grid{grid-template-columns:1fr}}
.test-col h3{font-size:.9rem;margin-bottom:.4rem;opacity:.9}
.test-desc{min-height:2.6rem;margin-top:0!important;margin-bottom:.5rem!important}
.test-row{display:flex;gap:.5rem;align-items:center;margin-bottom:.75rem}
.test-row select{flex:1;min-width:0;height:36px;border-radius:6px;border:1px solid rgba(255,255,255,.15);
background:#161b22;color:#f0f6fc;padding:0 .75rem;font-size:.85rem}
.test-btn{flex-shrink:0;min-width:5.5rem;height:36px;padding:0 1rem;border:none;border-radius:6px;background:#238636;color:#fff;
font-size:.85rem;cursor:pointer;white-space:nowrap}
.test-btn:hover{background:#2ea043}
.test-btn:disabled{opacity:.5;cursor:not-allowed}
.test-btn.blue{background:#58a6ff}
.test-btn.blue:hover{background:#79b8ff}
.result{flex:1;min-height:5rem;padding:.75rem;background:#161b22;border-radius:6px;font-size:.85rem;line-height:1.8}
.result strong{color:#58a6ff}
.result.err{color:#f85149}
.progress{height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}
.progress-bar{height:100%;background:#58a6ff;width:0;transition:width .15s}
footer{text-align:center;opacity:.4;font-size:.75rem;padding:1rem 0}
</style>
</head>
<body>
<div class="wrap">
<h1>边缘代理工具箱</h1>
<p class="sub">GitHub 文件加速 · API 代理 · 存储 · 测速 · OpenRouter</p>
<form class="search" onsubmit="return go(event)">
<input name="q" placeholder="粘贴 GitHub 完整链接（支持 https://），如 https://github.com/user/repo/archive/main.zip">
<button type="submit">→</button>
</form>
<div class="card">
<h2>GitHub 加速 API <span class="tag">对外集成</span></h2>
<p>将下方基址分发给外部调用方，在其后<strong>直接拼接完整 GitHub 地址</strong>即可加速：</p>
<div class="formula">加速地址 = 基址 + GitHub 完整地址</div>
<div class="base-row">
<code id="base-url">${base}</code>
<button type="button" class="copy-btn" onclick="copyBase(this)">复制基址</button>
</div>
<p>示例（支持带 <code class="inline">https://</code> 的完整地址）：</p>
<code>${base}https://github.com/user/repo/archive/main.zip</code>
<code>${base}https://raw.githubusercontent.com/user/repo/main/README.md</code>
<code>${base}https://github.com/user/repo/releases/download/v1.0/app.zip</code>
<p class="note">⚠ 基址必须以 <code class="inline">/</code> 结尾 · 公开仓库 only · 私有库请用 /myRaw/</p>
</div>
<div class="card">
<h2>其他直连格式</h2>
<p>无协议写法同样支持：</p>
<code>${base}github.com/user/repo/archive/main.zip</code>
<code>${base}raw.githubusercontent.com/user/repo/main/README.md</code>
</div>
<div class="card">
<h2>网络测试</h2>
<div class="test-grid">
<div class="test-col">
<h3>下载测速</h3>
<p class="note test-desc">通过 /speedtest 测速（已设 PUBLIC=speedtest 时免鉴权）</p>
<div class="test-row">
<select id="speed-bytes">
<option value="10000000">10 MB</option>
<option value="20000000" selected>20 MB</option>
<option value="50000000">50 MB</option>
</select>
<button type="button" class="test-btn" id="speed-btn" onclick="runSpeed()">开始测速</button>
</div>
<div class="result" id="speed-result">点击「开始测速」开始</div>
</div>
<div class="test-col">
<h3>延迟测试</h3>
<p class="note test-desc">到目标地址往返延迟（各测 5 次取统计）</p>
<div class="test-row">
<select id="latency-target">
<option value="worker">Worker 节点 (/health)</option>
<option value="gstatic" selected>Google — gstatic.com/generate_204</option>
<option value="cloudflare">Cloudflare — cp.cloudflare.com/generate_204</option>
</select>
<button type="button" class="test-btn blue" id="latency-btn" onclick="runLatency()">测延迟</button>
</div>
<div class="result" id="latency-result">点击「测延迟」开始</div>
</div>
</div>
<div class="progress"><div class="progress-bar" id="speed-progress"></div></div>
</div>
<div class="card">
<h2>API 接口</h2>
<div class="ep"><strong>GET /github/{path}</strong> — GitHub REST API<span class="tag">AUTH_TOKEN</span>
<code>GET ${origin}/github/repos/owner/repo/releases/latest</code></div>
<div class="ep"><strong>GET /raw/{path}</strong> — 公开 Raw 短路径<span class="tag">白名单</span>
<code>GET ${origin}/raw/owner/repo/main/README.md</code></div>
<div class="ep"><strong>GET /myRaw/{path}</strong> — 私有库 Raw<span class="tag">AUTH_TOKEN</span>
<code>GET ${origin}/myRaw/config.yaml</code></div>
<div class="ep"><strong>GET /gist?key=</strong> — 固定 Gist 读取<span class="tag">AUTH_TOKEN</span>
<code>GET ${origin}/gist?key=file.txt</code></div>
<div class="ep"><strong>GET /storage</strong> — KV 读取<span class="tag">AUTH_TOKEN</span>
<code>GET ${origin}/storage?filename=a.yaml</code></div>
<div class="ep"><strong>GET /speedtest?bytes=</strong> — 下载测速<span class="tag">公开</span>
<code>GET ${origin}/speedtest?bytes=20000000</code></div>
<div class="ep"><strong>ANY /openrouter/{path}</strong> — OpenRouter API 代理<span class="tag">客户端自带 Key</span>
<code>POST ${origin}/openrouter/chat/completions</code>
<code>Authorization: Bearer YOUR_OPENROUTER_KEY</code></div>
<div class="ep"><strong>GET /health</strong> — 健康检查<span class="tag">公开</span>
<code>GET ${origin}/health</code></div>
<dl class="auth-box">
<dt>鉴权方式</dt>
<dd><code class="inline">Authorization: Bearer YOUR_AUTH_TOKEN</code></dd>
</dl>
</div>
<footer>Edge Proxy Toolbox</footer>
</div>
<script>
const LATENCY_URLS={
worker:null,
gstatic:location.protocol==='https:'?'https://www.gstatic.com/generate_204':'http://gstatic.com/generate_204',
cloudflare:'https://cp.cloudflare.com/generate_204'
};
function go(e){e.preventDefault();const q=document.querySelector('[name=q]').value.trim();if(!q)return false;
let targetUrl = q;
if (!/^https?:\\/\\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
window.open(location.origin + '/' + targetUrl.replace(/^https?:\\/\\//,''),'_blank');
return false}
function copyBase(btn){const t=document.getElementById('base-url').textContent;
navigator.clipboard.writeText(t).then(()=>{btn.textContent='已复制';setTimeout(()=>btn.textContent='复制基址',1500)})}
async function pingOnce(target){
const t0=performance.now();
if(target==='worker'){
await fetch(location.origin+'/health?_='+Date.now(),{cache:'no-store'});
}else{
await fetch(LATENCY_URLS[target],{mode:'no-cors',cache:'no-store'});
}
return performance.now()-t0;
}
async function runLatency(){
const btn=document.getElementById('latency-btn');
const el=document.getElementById('latency-result');
const target=document.getElementById('latency-target').value;
const label=document.getElementById('latency-target').selectedOptions[0].text;
btn.disabled=true;el.className='result';el.textContent='测试中…';
const times=[];
for(let i=0;i<5;i++){
try{times.push(await pingOnce(target));}catch(e){}
if(i<4)await new Promise(r=>setTimeout(r,300));
}
btn.disabled=false;
if(!times.length){el.className='result err';el.textContent='测试失败，请检查网络或目标地址';return;}
const min=Math.min(...times),max=Math.max(...times),avg=times.reduce((a,b)=>a+b,0)/times.length;
el.innerHTML='<strong>'+label+'</strong><br>'
+'最低 <strong>'+min.toFixed(0)+' ms</strong> · 平均 <strong>'+avg.toFixed(0)+' ms</strong> · 最高 <strong>'+max.toFixed(0)+' ms</strong>';
}
async function runSpeed(){
const btn=document.getElementById('speed-btn');
const el=document.getElementById('speed-result');
const bar=document.getElementById('speed-progress');
const bytes=parseInt(document.getElementById('speed-bytes').value,10);
btn.disabled=true;bar.style.width='0';el.className='result';el.textContent='下载中…';
const t0=performance.now();
try{
const res=await fetch(location.origin+'/speedtest?bytes='+bytes+'&_='+Date.now());
if(!res.ok){
const j=await res.json().catch(()=>null);
throw new Error(res.status===401?'需要鉴权：请设置 PUBLIC=speedtest':(j?.message||'测速失败 '+res.status));
}
const reader=res.body.getReader();let received=0;
while(true){
const{done,value}=await reader.read();if(done)break;
received+=value.length;bar.style.width=Math.min(100,received/bytes*100)+'%';
}
const sec=(performance.now()-t0)/1000;
const mbps=(bytes*8/sec/1e6).toFixed(2);
const mbs=(bytes/sec/1e6).toFixed(2);
el.innerHTML='下载 <strong>'+(bytes/1e6).toFixed(0)+' MB</strong> 用时 <strong>'+sec.toFixed(2)+' s</strong><br>'
+'速度 <strong>'+mbps+' Mbps</strong>（'+mbs+' MB/s）';
}catch(e){el.className='result err';el.textContent=e.message;}
btn.disabled=false;
}
</script>
</body></html>`;
}

function nginxPage() {
    return `<!DOCTYPE html><html><head><title>Welcome to nginx!</title></head>
<body style="width:35em;margin:0 auto;font-family:Tahoma,Arial,sans-serif">
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
</body></html>`;
}

// ─── API 路由 ─────────────────────────────────────────────────────────────────

const apiHandlers = {

    async github(request, url, env) {
        const authErr = await requireAuthUnlessPublic(request, url, env, 'github');
        if (authErr) return authErr;
        try {
            const path = url.pathname.replace(/^\/github\//, '');
            const params = new URLSearchParams(url.search);
            params.delete('token');
            const qs = params.toString();
            const target = `https://api.github.com/${path}${qs ? '?' + qs : ''}`;
            const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
            const res = await fetch(target, { method: request.method, headers: buildHeaders(request, env), body });
            const h = applyCors(new Headers(res.headers));
            return new Response(res.body, { status: res.status, headers: h });
        } catch (e) {
            return err('GitHub API 请求失败: ' + e.message);
        }
    },

    async gist(request, url, env) {
        if (request.method !== 'GET') return err('不支持的请求方法', 405);
        const auth = await validateToken(request, url, env);
        if (!auth.ok) return auth.missing ? authRequiredErr() : authInvalidErr();
        const key = url.searchParams.get('key');
        if (!key) return err('请提供 key 参数', 400);
        const gist = parseGist(env);
        if (!gist) return err('未配置 GIST（格式 user/gist_id）', 500);
        try {
            const gistUrl = `https://gist.githubusercontent.com/${gist.user}/${gist.id}/raw/${key}?t=${Date.now()}`;
            const res = await fetch(gistUrl, { headers: { 'User-Agent': 'Cloudflare-Worker' } });
            if (!res.ok) return err('Gist 不存在', res.status);
            const h = applyCors(new Headers(res.headers));
            h.set('Content-Type', res.headers.get('Content-Type') || 'text/plain; charset=utf-8');
            return new Response(res.body, { status: res.status, headers: h });
        } catch (e) {
            return err('获取 Gist 失败: ' + e.message);
        }
    },

    async storage(request, url, env) {
        if (request.method !== 'GET') return err('不支持的请求方法', 405);
        const auth = await validateToken(request, url, env);
        if (!auth.ok) return auth.missing ? authRequiredErr() : authInvalidErr();
        if (!env.SUB_BUCKET) return err('未绑定 SUB_BUCKET', 500);

        const filename = url.searchParams.get('filename');
        if (!filename) return err('请提供 filename 参数', 400);
        const obj = await env.SUB_BUCKET.get(filename);
        if (!obj) return err('未找到该键', 404);
        const ct = obj.httpMetadata?.contentType || 'text/plain; charset=utf-8';
        const h = applyCors(new Headers({ 'Content-Type': ct }));
        return new Response(obj.body, { status: 200, headers: h });
    },

    async speedtest(request, url, env) {
        if (request.method !== 'GET') return err('不支持的请求方法', 405);
        const authErr = await requireAuthUnlessPublic(request, url, env, 'speedtest');
        if (authErr) return authErr;
        const bytes = url.searchParams.get('bytes');
        if (!bytes || !/^\d+$/.test(bytes)) return err('请提供有效的 bytes 参数', 400);
        const size = parseInt(bytes, 10);
        if (size <= 0 || size > SPEEDTEST_MAX_BYTES) return err(`bytes 须在 1~${SPEEDTEST_MAX_BYTES}`, 400);
        try {
            const h = new Headers(request.headers);
            h.set('Referer', 'https://speed.cloudflare.com/');
            const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${size}`, { headers: h });
            return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/octet-stream', ...CORS } });
        } catch (e) {
            return err('测速失败: ' + e.message);
        }
    },

    /** 公开 Raw 短路径代理 */
    async raw(request, url, env) {
        if (request.method !== 'GET') return err('不支持的请求方法', 405);
        const inputPath = url.pathname.replace(/^\/raw\/?/, '');
        if (!inputPath) return err('请提供 GitHub 路径', 400);
        if (!checkWhiteList(inputPath, env)) return err('路径不在白名单', 403);

        const p = inputPath.startsWith('/') ? inputPath : `/${inputPath}`;
        const target = (p.includes('/releases/download/') || p.includes('/archive/'))
            ? `https://github.com${p}`
            : `https://raw.githubusercontent.com${p}`;

        if (!checkGitHubUrl(target)) return err('URL 不在白名单', 403);

        return proxyGitHub(target, { method: 'GET', headers: buildHeaders(request, env), redirect: 'manual' }, url.origin);
    },

    /** 私有库 Raw */
    async myRaw(request, url, env) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return err('不支持的请求方法', 405);

        let subPath = url.pathname.replace(/^\/myRaw\/?/, '');
        if (!subPath) return err('请提供文件路径', 400);
        if (!subPath.startsWith('/')) subPath = '/' + subPath;

        if (/raw\.githubusercontent\.com/i.test(subPath)) {
            return err('请使用短路径，如 /myRaw/config.yaml', 400);
        }

        const githubRawUrl = buildMyRawUrl(env, subPath);
        if (!githubRawUrl) return err('未配置 GH_REPO（格式 owner/repo@branch）', 500);

        const auth = await authorizeMyRaw(request, url, env, subPath);
        if (!auth.ok) return auth.response;

        const headers = new Headers();
        headers.set('User-Agent', 'Cloudflare-Worker');
        headers.set('Authorization', `Bearer ${env.GH_TOKEN}`);

        try {
            const res = await fetch(githubRawUrl, { method: request.method, headers });
            if (res.ok) {
                const h = applyCors(new Headers(res.headers));
                return new Response(res.body, { status: res.status, headers: h });
            }
            return err('无法获取文件，请检查路径或访问权限', res.status);
        } catch (e) {
            return err('私有库请求失败: ' + e.message);
        }
    },

    /** OpenRouter API 代理（使用客户端 Key） */
    async openrouter(request, url, env) {
        const path = url.pathname.replace(/^\/openrouter\/?/, '');
        if (!path) return err('请提供 OpenRouter API 路径', 400);

        // 支持两种路径格式：/openrouter/chat/completions 或 /openrouter/api/v1/chat/completions
        let apiPath = path;
        if (!apiPath.startsWith('api/')) {
            apiPath = 'api/v1/' + apiPath;
        }
        const target = `https://openrouter.ai/${apiPath}${url.search}`;

        // 获取客户端提供的 OpenRouter API Key
        // 优先从独立 Header 获取，若没有则从 Authorization 获取（兼容 Agent 工具的常见配置）
        const clientKey = request.headers.get('X-OpenRouter-Key')
            || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');

        // 如果没有客户端 Key，则尝试使用服务端配置的 Key（可选兜底）
        const finalKey = clientKey || env.OPENROUTER_API_KEY;

        if (!finalKey) {
            return err('请提供 OpenRouter API Key（Header: Authorization: Bearer <key> 或 X-OpenRouter-Key）', 401);
        }

        // 构建转发请求头
        const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${finalKey}`);
        if (env.OPENROUTER_REFERER) headers.set('HTTP-Referer', env.OPENROUTER_REFERER);
        if (env.OPENROUTER_TITLE) headers.set('X-Title', env.OPENROUTER_TITLE);
        headers.delete('host');
        headers.delete('x-forwarded-for');
        headers.delete('x-real-ip');

        try {
            const res = await fetch(target, {
                method: request.method,
                headers,
                body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
                redirect: 'follow'
            });
            const h = applyCors(new Headers(res.headers));
            return new Response(res.body, { status: res.status, headers: h });
        } catch (e) {
            return err('OpenRouter 请求失败: ' + e.message);
        }
    },

    health() {
        return json({ status: 'ok' });
    },
};

// ─── 入口 ─────────────────────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const { pathname } = url;

            if (request.method === 'OPTIONS') return preflight();

            // 合并默认与自定义拦截 UA（缓存到局部变量）
            const blockedUA = getBlockedUA(env);
            if (isBlockedUA(request, blockedUA)) return text(nginxPage(), 200, 'text/html');

            const q = url.searchParams.get('q');
            if (q) {
                if (!validateQRedirect(q)) return err('仅允许 GitHub 链接跳转', 400);
                return Response.redirect(`${url.origin}${PREFIX}${q.replace(/^https?:\/\//, '')}`, 302);
            }

            if (pathname === '/health') return apiHandlers.health();
            if (isGitHubApiRoute(pathname)) return apiHandlers.github(request, url, env);
            if (pathname === '/gist') return apiHandlers.gist(request, url, env);
            if (pathname === '/storage') return apiHandlers.storage(request, url, env);
            if (pathname === '/speedtest') return apiHandlers.speedtest(request, url, env);
            if (isRawApiRoute(pathname)) return apiHandlers.raw(request, url, env);
            if (pathname === '/myRaw' || pathname.startsWith('/myRaw/')) return apiHandlers.myRaw(request, url, env);
            if (pathname === '/openrouter' || pathname.startsWith('/openrouter/')) return apiHandlers.openrouter(request, url, env);

            if (pathname === '/' || pathname === '') {
                const home = resolveHome(env);
                if (home.type === 'redirect') return Response.redirect(home.target, 302);
                if (home.type === 'nginx') return text(nginxPage(), 200, 'text/html');
                if (home.type === 'proxy') return fetch(new Request(home.target, request));
                return text(homePage(url.origin), 200, 'text/html');
            }

            const direct = handleDirectGitHubPath(request, url, env);
            if (direct) return direct;

            const fallback = getFallbackRedirect(env);
            if (fallback) return Response.redirect(fallback, 302);
            return err('未找到该路径', 404);
        } catch (e) {
            return err('服务器错误: ' + e.message);
        }
    },
};
