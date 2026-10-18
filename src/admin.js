// The admin panel: one route tree, one HTML document, one stylesheet.

import { readArchive } from "./archive.js";
import { clearMinuteQuota, minuteQuota } from "./llm.js";
import { DEFAULT_PERSONAS, MODES, MODE_LABELS } from "./prompt.js";
import {
  DEFAULT_MODEL_POOL,
  SAFETY_CATEGORY_KEYS,
  SAFETY_LEVELS,
  THINKING_LEVELS,
  bumpStats,
  loadConfig,
  loadQuota,
  saveConfig,
  saveQuota,
} from "./store.js";
import { getKeyPoolStatus } from "./keyPool.js";

const COOKIE = "sayyad_admin";
const MEDIA_KINDS = ["image", "video", "audio"];

const html = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.timingSafeEqual !== "function" && typeof crypto.timingSafeEqual === "function") {
  try {
    crypto.subtle.timingSafeEqual = crypto.timingSafeEqual;
  } catch {}
}

/** Constant-time comparison to prevent timing attacks. */
export function timingSafeEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    const enc = new TextEncoder();
    const bufA = enc.encode(a);
    const bufB = enc.encode(b);
    if (bufA.byteLength !== bufB.byteLength) return false;
    const fn = crypto.subtle?.timingSafeEqual ?? crypto.timingSafeEqual;
    if (typeof fn === "function") return fn(bufA, bufB);
    let diff = 0;
    for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
    return diff === 0;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    const fn = crypto.subtle?.timingSafeEqual ?? crypto.timingSafeEqual;
    if (typeof fn === "function") return fn(a, b);
    let diff = 0;
    for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  return false;
}

/** Constant-time password verification using SHA-256 digest + timingSafeEqual. */
export async function verifyPassword(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const bufA = new Uint8Array(hashA);
  const bufB = new Uint8Array(hashB);
  const fn = crypto.subtle?.timingSafeEqual ?? crypto.timingSafeEqual;
  if (typeof fn === "function") return fn(bufA, bufB);
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

const failedLoginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function resetLoginRateLimit() {
  failedLoginAttempts.clear();
}

function getClientIp(req) {
  if (req?.headers?.get && typeof req.headers.get === "function") {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const xri = req.headers.get("x-real-ip");
    if (xri) return xri.trim();
  }
  if (req?.headers) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    const xri = req.headers["x-real-ip"];
    if (xri) return String(xri).trim();
  }
  if (req?.socket?.remoteAddress) return req.socket.remoteAddress;
  return "127.0.0.1";
}

function isLoginRateLimited(ip) {
  const ipKey = String(ip || "127.0.0.1");
  const now = Date.now();
  const list = failedLoginAttempts.get(ipKey) || [];
  const recent = list.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length !== list.length) {
    if (recent.length === 0) failedLoginAttempts.delete(ipKey);
    else failedLoginAttempts.set(ipKey, recent);
  }
  return recent.length >= MAX_FAILED_ATTEMPTS;
}

export function recordFailedLogin(ip) {
  const ipKey = String(ip || "127.0.0.1");
  const now = Date.now();
  const list = failedLoginAttempts.get(ipKey) || [];
  const recent = list.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  // Refresh insertion order so the most recently failing IP is moved to the tail (LRU)
  failedLoginAttempts.delete(ipKey);
  failedLoginAttempts.set(ipKey, recent);

  if (failedLoginAttempts.size > 1000) {
    for (const [k, times] of failedLoginAttempts.entries()) {
      const valid = times.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (valid.length === 0) {
        failedLoginAttempts.delete(k);
      } else if (valid.length !== times.length) {
        failedLoginAttempts.set(k, valid);
      }
    }
    while (failedLoginAttempts.size > 1000) {
      const oldestKey = failedLoginAttempts.keys().next().value;
      if (oldestKey !== undefined) {
        failedLoginAttempts.delete(oldestKey);
      } else {
        break;
      }
    }
  }
}

function clearFailedLogin(ip) {
  failedLoginAttempts.delete(String(ip || "127.0.0.1"));
}

function isHttps(req) {
  try {
    if (req.url && new URL(req.url).protocol === "https:") return true;
  } catch {}
  let proto = "";
  if (req?.headers?.get && typeof req.headers.get === "function") {
    proto = req.headers.get("x-forwarded-proto") ?? "";
    const cfVisitor = req.headers.get("cf-visitor") ?? "";
    if (cfVisitor.includes('"https"')) return true;
  } else if (req?.headers) {
    proto = req.headers["x-forwarded-proto"] ?? "";
  }
  return proto.toLowerCase() === "https";
}

/** Stateless session: the cookie is an HMAC of the admin password, so nothing is stored. */
export async function signSecret(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sayyad-admin-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(req, name) {
  let raw = "";
  if (req?.headers?.get && typeof req.headers.get === "function") {
    raw = req.headers.get("cookie") ?? "";
  } else if (req?.headers?.cookie) {
    raw = req.headers.cookie ?? "";
  }
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

export async function isAuthed(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = readCookie(req, COOKIE);
  if (!cookie) return false;
  try {
    const want = await signSecret(env.ADMIN_PASSWORD);
    return timingSafeEqual(cookie, want);
  } catch {
    return false;
  }
}

const CSS = `
*{box-sizing:border-box}
:root{--bg:#0e1117;--card:#161b25;--line:#242c3a;--fg:#e6edf3;--dim:#8b98a9;--acc:#4c8dff;--ok:#3fb950;--bad:#f85149}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;padding:32px 20px}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:14px;margin:0 0 14px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.sub{color:var(--dim);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}
label{display:block;margin:0 0 6px;font-size:12px;color:var(--dim)}
input[type=text],input[type=password],input[type=number],select,textarea{width:100%;background:#0b0f16;border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:9px 12px;font:inherit;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--acc)}
textarea{resize:vertical;min-height:100px;line-height:1.8;direction:rtl;text-align:right}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.mode{border:1px solid var(--line);border-radius:12px;padding:14px;cursor:pointer;background:#0b0f16}
.mode:hover{border-color:#3a465c}
.mode b{display:block;margin-bottom:4px}
.mode span{font-size:12px;color:var(--dim)}
.mode.on{border-color:var(--acc);background:rgba(76,141,255,.12)}
.switch{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.switch input{width:auto}
button{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:11px 20px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:400}
button:disabled{opacity:.5;cursor:default}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center}
.stat{background:#0b0f16;border:1px solid var(--line);border-radius:12px;padding:14px 8px}
.stat b{display:block;font-size:22px}
.stat span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.muted{color:var(--dim);font-size:13px;word-break:break-word}
.bar{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}
#toast{margin-left:auto;font-size:13px;opacity:0;transition:.2s}
#toast.ok{opacity:1;color:var(--ok)}
#toast.err{opacity:1;color:var(--bad)}
pre{background:#0b0f16;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-height:280px;font-size:12px;direction:ltr;text-align:left;margin-top:12px}
.tabs{display:flex;gap:6px;margin:0 0 18px;border-bottom:1px solid var(--line)}
.tab{padding:10px 18px;border:1px solid transparent;border-bottom:0;border-radius:10px 10px 0 0;cursor:pointer;color:var(--dim)}
.tab:hover{color:var(--fg)}
.tab.on{background:var(--card);border-color:var(--line);color:var(--fg)}
.pane{display:none}.pane.on{display:block}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.mcard{background:#0b0f16;border:1px solid var(--line);border-radius:12px;padding:14px}
.mcard h3{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.mcard .row{margin-top:10px;grid-template-columns:1fr 1fr}
label.check{display:flex;align-items:center;gap:8px;margin:0;color:var(--fg);font-size:14px}
label.check input{width:auto}
.log{display:flex;flex-direction:column;gap:8px}
.item{background:#0b0f16;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.item summary{cursor:pointer;padding:10px 12px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.item summary::-webkit-details-marker{display:none}
.item summary:hover{background:#121722}
.when{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums;min-width:150px}
.who{font-weight:600}
.where{color:var(--dim);font-size:12px}
.prev{color:var(--dim);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:120px;text-align:left}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.tag.on{color:var(--ok);border-color:#1d4423}
.tag.err{color:var(--bad);border-color:#5a1e22;background:rgba(248,81,73,.1)}
.body{border-top:1px solid var(--line);padding:12px}
.body .meta{font-size:12px;color:var(--dim)}
.msg{white-space:pre-wrap;word-break:break-word;background:#111722;border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:8px;direction:rtl;text-align:right}
.replybox{white-space:pre-wrap;word-break:break-word;background:#0d1e16;border:1px solid #1a4427;border-radius:8px;padding:10px;margin-top:8px;direction:rtl;text-align:right}
.errbox{white-space:pre-wrap;word-break:break-word;background:#241113;border:1px solid #5a1e22;border-radius:8px;padding:10px;margin-top:8px;color:#fca5a5;direction:ltr;text-align:left;font-family:ui-monospace,monospace;font-size:13px}
.tracebox{background:#080c14;border:1px solid #1f293d;border-radius:8px;padding:12px;margin-top:10px;font-family:ui-monospace,monospace;font-size:12px;color:#94a3b8;direction:ltr;text-align:left}
.tracetitle{font-weight:700;color:#38bdf8;margin-bottom:8px;font-size:13px}
.traceline{margin:5px 0}
.traceul{margin:4px 0 8px 18px;padding:0;list-style:disc}
.traceul li{margin:3px 0}
.tracebox code{background:#172033;padding:2px 5px;border-radius:4px;color:#e2e8f0;font-size:11px}
`;

const LOGIN = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayyad — Admin</title><style>${CSS}</style></head>
<body><div class="wrap" style="max-width:400px;margin-top:14vh">
<div class="card"><h1>Sayyad</h1><p class="sub" style="margin:0 0 18px">Admin panel</p>
<form method="post" action="/admin/api/login">
<label for="p">Password</label>
<input id="p" name="password" type="password" autofocus required>
<div class="bar"><button type="submit">Sign in</button></div>
</form></div></div></body></html>`;

const DASH = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayyad — Admin</title><style>${CSS}</style></head>
<body><div class="wrap">
<h1>Sayyad</h1>
<p class="sub">Telegram bot on Cloudflare Workers</p>

<div class="tabs">
  <div class="tab on" data-pane="settings">Settings</div>
  <div class="tab" data-pane="media">Media &amp; Safety</div>
  <div class="tab" data-pane="log">Message log <span class="tag" id="logcount">0</span></div>
</div>

<div class="pane on" id="pane-settings">
  <div class="card">
    <h2>Status</h2>
    <div class="switch">
      <input type="checkbox" id="enabled">
      <label for="enabled" style="margin:0">Bot is answering messages</label>
      <a class="muted" style="margin-left:auto" href="/admin/api/logout">Sign out</a>
    </div>
  </div>

  <div class="card">
    <h2>Provider</h2>
    <div class="row">
      <div><label>Provider</label><select id="p_kind">
        <option value="gemini">Gemini (native — video + audio)</option>
        <option value="openai">OpenAI-compatible — text + image</option>
      </select></div>
      <div><label>Model</label><input type="text" id="p_model" dir="ltr"></div>
      <div><label>Thinking</label><select id="p_thinking">__THINKING__</select></div>
    </div>
    <div style="margin-top:14px"><label>Base URL (OpenAI-compatible provider)</label>
      <input type="text" id="p_baseUrl" dir="ltr"></div>
    <p class="muted" style="margin:10px 0 0">Keys live in Cloudflare, not here: <code>GEMINI_API_KEY</code>, <code>API_KEY</code> / <code>OPENROUTER_API_KEY</code>.</p>
  </div>

  <div class="card">
    <h2>Model pool</h2>
    <p class="muted" style="margin:-6px 0 12px">One model per line, strongest first. Gemini quotas are per model, so when one is spent for the day the bot moves to the next. A name the provider does not recognise is parked for the day instead of being retried.</p>
    <textarea id="p_pool" dir="ltr" style="min-height:170px;font-family:ui-monospace,monospace;font-size:13px"></textarea>
    <div class="bar" style="margin-top:14px">
      <button class="ghost" id="poolreset">Reset to defaults</button>
      <button class="ghost" id="poolclear" style="margin-left:8px">Unpark all models</button>
      <span class="muted" id="poolstat"></span>
    </div>
  </div>

  <div class="card">
    <h2>Personality</h2>
    <div class="modes" id="modes"></div>
    <label style="margin-top:16px">Polite / ادب</label><textarea id="p_polite" dir="rtl"></textarea>
    <label style="margin-top:14px">Know-it-all / دانای کل</label><textarea id="p_smart" dir="rtl"></textarea>
    <label style="margin-top:14px">Savage / بددهن و طنز</label><textarea id="p_rude" dir="rtl"></textarea>
    <label style="margin-top:14px">Extra instructions for every mode (optional)</label>
    <textarea id="p_extra" dir="rtl" style="min-height:70px"></textarea>
  </div>

  <div class="card">
    <h2>Voice replies (Gemini Live API)</h2>
    <div class="switch">
      <input type="checkbox" id="v_enabled">
      <label for="v_enabled" style="margin:0">Voice reply to voice notes</label>
    </div>
    <div style="margin-top:12px"><label>Voice Model</label>
      <input type="text" id="v_model" dir="ltr" placeholder="gemini-3.8-live">
    </div>
  </div>

  <div class="card">
    <h2>Limits &amp; diagnostics</h2>
    <div class="row">
      <div><label>Max tokens per reply (200–8000)</label><input type="number" id="p_maxTokens" min="200" max="8000"></div>
      <div><label>Daily request cap (0 = no limit)</label><input type="number" id="p_dailyCap" min="0" max="100000"></div>
    </div>
    <div class="bar"><button id="save">Save changes</button><button class="ghost" id="diag">Run diagnostics</button><span id="toast"></span></div>
    <div id="diagout"></div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <h2>Statistics &amp; Health</h2>
      <button class="ghost" id="clearerrors" style="padding:4px 10px;font-size:12px">Clear errors</button>
    </div>
    <div class="stats">
      <div class="stat"><b id="s_req">0</b><span>Requests</span></div>
      <div class="stat"><b id="s_today">0</b><span>Today</span></div>
      <div class="stat"><b id="s_rep">0</b><span>Replies</span></div>
      <div class="stat"><b id="s_err">0</b><span>Errors</span></div>
    </div>
    <p class="muted" style="margin:14px 0 0" id="s_last"></p>
    <div id="errlist" style="margin-top:12px"></div>
  </div>
</div>

<div class="pane" id="pane-media">
  <div class="card">
    <h2>Media</h2>
    <div class="grid3">
      <div class="mcard">
        <h3>image</h3>
        <label class="check"><input type="checkbox" id="m_image_on"> enabled</label>
        <div class="row">
          <div><label>Max MB</label><input type="number" id="m_image_mb" min="1" max="19"></div>
          <div><label>Per message</label><input type="number" id="m_image_per" min="1" max="4"></div>
        </div>
      </div>
      <div class="mcard">
        <h3>video</h3>
        <label class="check"><input type="checkbox" id="m_video_on"> enabled</label>
        <div class="row">
          <div><label>Max MB</label><input type="number" id="m_video_mb" min="1" max="19"></div>
          <div><label>Per message</label><input type="number" id="m_video_per" min="1" max="4"></div>
        </div>
      </div>
      <div class="mcard">
        <h3>audio</h3>
        <label class="check"><input type="checkbox" id="m_audio_on"> enabled</label>
        <div class="row">
          <div><label>Max MB</label><input type="number" id="m_audio_mb" min="1" max="19"></div>
          <div><label>Per message</label><input type="number" id="m_audio_per" min="1" max="4"></div>
        </div>
      </div>
    </div>
    <p class="muted" style="margin:14px 0 0">Cloudflare's free plan gives 10 ms of CPU per request and base64-encoding a large video does not fit. Keep video small, or move to a paid plan.</p>
  </div>
  <div class="card">
    <h2>Safety settings (Gemini native)</h2>
    <div class="row">
      <div><label>harassment</label><select id="s_harassment">__SAFETY_OPTIONS__</select></div>
      <div><label>hateSpeech</label><select id="s_hateSpeech">__SAFETY_OPTIONS__</select></div>
      <div><label>sexuallyExplicit</label><select id="s_sexuallyExplicit">__SAFETY_OPTIONS__</select></div>
      <div><label>dangerous</label><select id="s_dangerous">__SAFETY_OPTIONS__</select></div>
    </div>
    <p class="muted" style="margin:14px 0 0">Google may refuse BLOCK_NONE for harassment and hate speech on the free tier and silently fall back to a stricter level.</p>
  </div>
  <div class="card"><div class="bar"><button id="save2">Save changes</button><span id="toast2"></span></div></div>
</div>

<div class="pane" id="pane-log">
  <div class="card">
    <h2>Message log</h2>
    <p class="muted" style="margin:-4px 0 14px">The last 200 messages Telegram delivered, newest first. Media is described, never stored.</p>
    <div class="bar" style="margin-bottom:14px"><button id="logrefresh">Refresh</button><span class="muted" id="logmeta"></span></div>
    <div class="log" id="loglist"><p class="muted">Press Refresh to load the archive.</p></div>
  </div>
</div>
</div>
<script>
var MODES = __MODES__, LABELS = __LABELS__;
var SAFETY = __SAFETY__, MEDIAS = __MEDIAS__;
var selected = "smart";

function el(tag, cls, text){
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function toast(msg, kind, which){
  var t = document.getElementById(which || "toast");
  t.textContent = msg; t.className = kind || "";
}
function val(id){ return document.getElementById(id).value; }
function setv(id, v){ document.getElementById(id).value = v; }
function setb(id, v){ document.getElementById(id).checked = !!v; }

function showTab(name){
  var tabs = document.querySelectorAll(".tab");
  for (var i=0;i<tabs.length;i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-pane") === name);
  var panes = document.querySelectorAll(".pane");
  for (var j=0;j<panes.length;j++) panes[j].classList.toggle("on", panes[j].id === "pane-" + name);
}

function stamp(ms){
  var d = new Date(ms), p = function(n){ return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function renderModes(){
  var box = document.getElementById("modes"); box.innerHTML = "";
  MODES.forEach(function(m){
    var d = el("div", "mode" + (m === selected ? " on" : ""));
    d.appendChild(el("b", null, LABELS[m]));
    d.appendChild(el("span", null, m));
    d.onclick = function(){ selected = m; renderModes(); };
    box.appendChild(d);
  });
}

function paint(c, st){
  selected = c.mode; renderModes();
  window._cfg = c;
  setb("enabled", c.enabled !== false);
  setb("v_enabled", c.voice?.enabled !== false);
  setv("v_model", c.voice?.model || "gemini-3.8-live");
  setv("p_kind", c.provider.kind); setv("p_model", c.provider.model);
  setv("p_baseUrl", c.provider.baseUrl); setv("p_thinking", c.thinking);
  setv("p_maxTokens", c.maxTokens); setv("p_dailyCap", c.dailyCap);
  setv("p_extra", c.extra || "");
  setv("p_pool", (c.provider.modelPool || []).join("\\n"));
  MODES.forEach(function(m){ setv("p_" + m, c.personas[m] || ""); });
  MEDIAS.forEach(function(k){
    setb("m_" + k + "_on", c.media[k].enabled);
    setv("m_" + k + "_mb", c.media[k].maxMB);
    setv("m_" + k + "_per", c.media[k].maxPer);
  });
  SAFETY.forEach(function(k){ setv("s_" + k, c.safety[k]); });
  document.getElementById("s_req").textContent = st.requests || 0;
  document.getElementById("s_today").textContent = st.today || 0;
  document.getElementById("s_rep").textContent = st.replies || 0;
  var errEl = document.getElementById("s_err");
  errEl.textContent = st.errors || 0;
  errEl.style.color = (st.errors > 0) ? "var(--bad)" : "inherit";
  document.getElementById("s_last").textContent = "Last request: " + (st.lastUsed || "never") + "  ·  Last error: " + (st.lastError || "none");
  var elist = document.getElementById("errlist");
  if (elist) {
    elist.innerHTML = "";
    var rErr = st.recentErrors || [];
    if (rErr.length) {
      rErr.forEach(function(it){
        var d = el("div", "tag", stamp(it.t) + " · " + it.msg);
        d.style.display = "block";
        d.style.margin = "4px 0";
        d.style.color = "var(--bad)";
        d.style.borderColor = "#491d22";
        d.style.background = "#180f12";
        d.style.padding = "6px 10px";
        elist.appendChild(d);
      });
    }
  }
}

function collect(){
  var body = {
    enabled: document.getElementById("enabled").checked,
    voice: { enabled: document.getElementById("v_enabled").checked, model: val("v_model") },
    mode: selected,
    extra: val("p_extra"),
    maxTokens: val("p_maxTokens"),
    dailyCap: val("p_dailyCap"),
    provider: { kind: val("p_kind"), model: val("p_model"), baseUrl: val("p_baseUrl") },
    modelPool: val("p_pool").split("\\n"),
    thinking: val("p_thinking"),
    media: {},
    safety: {}
  };
  MODES.forEach(function(m){ body["personas." + m] = val("p_" + m); });
  MEDIAS.forEach(function(k){
    body.media[k] = { enabled: document.getElementById("m_" + k + "_on").checked, maxMB: val("m_" + k + "_mb"), maxPer: val("m_" + k + "_per") };
  });
  SAFETY.forEach(function(k){ body.safety[k] = val("s_" + k); });
  return body;
}

function save(ev){
  var b = ev && ev.target;
  if (b) b.disabled = true;
  toast("saving…", "", b && b.id === "save2" ? "toast2" : "toast");
  fetch("/admin/api/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(collect()) })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
    .then(function(r){
      if (b) b.disabled = false;
      var slot = b && b.id === "save2" ? "toast2" : "toast";
      toast(r.ok ? "saved" : "save failed", r.ok ? "ok" : "err", slot);
      if (r.ok) paint(r.j.config, r.j.stats);
    })
    .catch(function(){ if (b) b.disabled = false; toast("network error", "err", b && b.id === "save2" ? "toast2" : "toast"); });
}

function logCard(it){
  var isErr = !!(it.err || it.ok === false);
  var det = el("details", "item" + (isErr ? " err" : ""));
  var sum = document.createElement("summary");
  sum.appendChild(el("span", "when", stamp(it.t)));
  sum.appendChild(el("span", "who", (it.u && it.u.name) || "user"));
  var tagText = !it.a ? "ignored" : isErr ? "error" : "answered";
  var tagCls = "tag" + (!it.a ? "" : isErr ? " err" : " on");
  sum.appendChild(el("span", tagCls, tagText));
  if (it.model) sum.appendChild(el("span", "tag", it.model));
  if (it.ms !== undefined) sum.appendChild(el("span", "tag", it.ms + " ms"));
  if (it.voice !== undefined) {
    if (it.voice) {
      sum.appendChild(el("span", "tag on", "🎙️ voice"));
    } else if (it.verr) {
      sum.appendChild(el("span", "tag err", "voice fallback"));
    }
  } else if (it.verr) {
    sum.appendChild(el("span", "tag err", "voice err"));
  }
  sum.appendChild(el("span", "where", (it.c && it.c.t) || ""));
  sum.appendChild(el("span", "prev", (it.k || "") + " · " + (it.x || "").replace(/\\s+/g, " ").slice(0, 70)));
  det.appendChild(sum);
  var body = el("div", "body");
  var uid = it.u ? it.u.id : "";
  var cid = it.c ? it.c.id : "";
  var metaStr = "user " + uid + "  ·  chat " + cid + "  ·  message " + it.m + "  ·  " + stamp(it.t);
  if (it.model) metaStr += "  ·  model: " + it.model;
  if (it.ms !== undefined) metaStr += "  ·  " + it.ms + " ms";
  if (it.tgOut) metaStr += "  ·  out: " + it.tgOut;
  body.appendChild(el("div", "meta", metaStr));
  if (it.reason) {
    body.appendChild(el("div", "meta", "info: " + it.reason));
  }
  var inMsg = el("div", "msg");
  inMsg.appendChild(el("b", null, "User (" + (it.k || "text") + "): "));
  inMsg.appendChild(document.createTextNode(it.x || "(no text)"));
  body.appendChild(inMsg);
  if (it.reply) {
    var rep = el("div", "replybox");
    rep.appendChild(el("b", null, "AI: "));
    rep.appendChild(document.createTextNode(it.reply));
    body.appendChild(rep);
  }
  if (it.verr) {
    var ver = el("div", "errbox");
    ver.appendChild(el("b", null, "Voice Error: "));
    ver.appendChild(document.createTextNode(it.verr));
    body.appendChild(ver);
  }
  if (it.err) {
    var er = el("div", "errbox");
    er.appendChild(el("b", null, "Error: "));
    er.appendChild(document.createTextNode(it.err));
    body.appendChild(er);
  }
  if (it.trace) {
    var trBox = el("div", "tracebox");
    trBox.appendChild(el("div", "tracetitle", "⚙️ Execution Pipeline Trace:"));

    if (it.trace.intent) {
      var intLine = el("div", "traceline");
      intLine.appendChild(el("b", null, "• Intent: "));
      var isReq = it.trace.intent.requested;
      intLine.appendChild(el("span", "tag" + (isReq ? " on" : ""), isReq ? "🎙️ Voice Requested" : "💬 Text Only"));
      intLine.appendChild(document.createTextNode(" via "));
      intLine.appendChild(el("code", null, it.trace.intent.method || "default"));
      if (it.trace.intent.reason) {
        intLine.appendChild(document.createTextNode(" (" + it.trace.intent.reason + ")"));
      }
      trBox.appendChild(intLine);
    }

    if (it.trace.llm) {
      var llmLine = el("div", "traceline");
      llmLine.appendChild(el("b", null, "• LLM Routing: "));
      if (it.trace.llm.chosenModel) {
        llmLine.appendChild(document.createTextNode("Selected "));
        llmLine.appendChild(el("code", null, it.trace.llm.chosenModel));
      }
      trBox.appendChild(llmLine);

      if (Array.isArray(it.trace.llm.attempts) && it.trace.llm.attempts.length) {
        var attUl = el("ul", "traceul");
        it.trace.llm.attempts.forEach(function(att) {
          var li = el("li", null);
          var icon = att.status === "ok" ? "✅ " : "⚠️ ";
          li.appendChild(document.createTextNode(icon));
          li.appendChild(el("code", null, att.model));
          if (att.keyIndex !== undefined) {
            li.appendChild(document.createTextNode(" (Key #" + (att.keyIndex + 1) + ")"));
          }
          li.appendChild(document.createTextNode(": "));
          li.appendChild(el("b", null, att.status));
          if (att.ms !== undefined) {
            li.appendChild(document.createTextNode(" [" + att.ms + "ms]"));
          }
          if (att.error) {
            li.appendChild(document.createTextNode(" — " + att.error));
          }
          attUl.appendChild(li);
        });
        trBox.appendChild(attUl);
      }
    }

    if (it.trace.voice) {
      var vLine = el("div", "traceline");
      var isVOk = it.trace.voice.status === "delivered";
      vLine.appendChild(el("b", null, "• Voice Synthesis: "));
      vLine.appendChild(document.createTextNode((isVOk ? "✅ " : "❌ ") + "Status: "));
      vLine.appendChild(el("b", null, it.trace.voice.status));
      if (it.trace.voice.chosenModel) {
        vLine.appendChild(document.createTextNode(" (Model: "));
        vLine.appendChild(el("code", null, it.trace.voice.chosenModel));
        vLine.appendChild(document.createTextNode(")"));
      }
      trBox.appendChild(vLine);

      if (Array.isArray(it.trace.voice.attempts) && it.trace.voice.attempts.length) {
        var vUl = el("ul", "traceul");
        it.trace.voice.attempts.forEach(function(vAtt) {
          var li = el("li", null);
          li.appendChild(document.createTextNode(vAtt.ok ? "✅ " : "❌ "));
          li.appendChild(el("code", null, vAtt.model));
          li.appendChild(document.createTextNode(": " + (vAtt.ok ? "Success" : "Failed")));
          if (vAtt.ms !== undefined) {
            li.appendChild(document.createTextNode(" [" + vAtt.ms + "ms]"));
          }
          if (vAtt.error) {
            li.appendChild(document.createTextNode(" — " + vAtt.error));
          }
          vUl.appendChild(li);
        });
        trBox.appendChild(vUl);
      }
    }

    if (it.trace.delivery) {
      var dLine = el("div", "traceline");
      dLine.appendChild(el("b", null, "• Telegram Delivery: "));
      var dKind = it.trace.delivery.kind === "voice" ? "🎙️ Voice Audio File (WAV)"
                : it.trace.delivery.kind === "text_fallback" ? "⚠️ Text Fallback (Voice failed)"
                : "💬 Standard Text";
      dLine.appendChild(el("span", "tag" + (it.trace.delivery.kind === "voice" ? " on" : ""), dKind));
      if (it.trace.delivery.reason) {
        dLine.appendChild(document.createTextNode(" (" + it.trace.delivery.reason + ")"));
      }
      trBox.appendChild(dLine);
    }

    body.appendChild(trBox);
  }
  det.appendChild(body);
  return det;
}

function loadLog(){
  var list = document.getElementById("loglist"), btn = document.getElementById("logrefresh");
  list.innerHTML = ""; list.appendChild(el("p", "muted", "loading…")); btn.disabled = true;
  fetch("/admin/api/log").then(function(r){ return r.json(); }).then(function(d){
    list.innerHTML = "";
    document.getElementById("logcount").textContent = d.count;
    document.getElementById("logmeta").textContent = d.count + " stored · newest first";
    if (!d.items.length) { list.appendChild(el("p", "muted", "Nothing logged yet.")); return; }
    d.items.forEach(function(it){ list.appendChild(logCard(it)); });
  }).catch(function(){
    list.innerHTML = ""; list.appendChild(el("p", "muted", "Could not load the archive."));
  }).then(function(){ btn.disabled = false; });
}

document.querySelectorAll(".tab").forEach(function(t){
  t.onclick = function(){ showTab(t.getAttribute("data-pane")); };
});
document.getElementById("save").onclick = function(e){ save(e); };
document.getElementById("save2").onclick = function(e){ save(e); };
document.getElementById("logrefresh").onclick = loadLog;
var clrBtn = document.getElementById("clearerrors");
if (clrBtn) {
  clrBtn.onclick = function(){
    if (!confirm("Clear error history?")) return;
    fetch("/admin/api/clear-errors", { method: "POST" })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.ok) paint(window._cfg || {}, d.stats); toast("errors cleared", "ok"); });
  };
}

document.getElementById("poolreset").onclick = function(){
  if (!confirm("Replace the pool with the built-in defaults?")) return;
  setv("p_pool", __DEFAULT_POOL__.join("\\n"));
  toast("pool reset — press Save changes to apply", "", "toast");
};

document.getElementById("poolclear").onclick = function(){
  fetch("/admin/api/clear-quota", { method: "POST" })
    .then(function(r){ return r.json(); })
    .then(function(d){ if (d.ok) { showPoolStatus({}); toast("pool quota cleared", "ok"); } });
};

function showPoolStatus(quota){
  var box = document.getElementById("poolstat");
  box.innerHTML = "";
  var names = Object.keys(quota || {});
  if (!names.length) { box.appendChild(el("span", null, "all models available")); return; }
  names.forEach(function(m){
    var diff = (quota[m] || 0) - Date.now();
    var label = diff < 300000 ? " (1m)" : " (daily)";
    box.appendChild(el("span", "tag", m + label + " · back at " + new Date(quota[m]).toISOString().slice(11, 16)));
  });
}

function loadQuota(){
  fetch("/admin/api/quota").then(function(r){ return r.json(); })
    .then(function(d){ showPoolStatus(d.quota); })
    .catch(function(){});
}
document.getElementById("diag").onclick = function(){
  var b = this; b.disabled = true; toast("testing…");
  fetch("/diag?format=json").then(function(r){ return r.json(); }).then(function(d){
    var o = document.getElementById("diagout"); o.innerHTML = "";
    o.appendChild(el("pre", null, JSON.stringify(d, null, 2)));
    toast("done", "ok");
  }).catch(function(){ toast("diagnostics failed", "err"); }).then(function(){ b.disabled = false; });
};

renderModes();
fetch("/admin/api/state").then(function(r){ return r.json(); })
  .then(function(d){ paint(d.config, d.stats); })
  .catch(function(){ toast("could not load config", "err"); });
loadQuota();
</script></body></html>`;

export function renderLogin(error) {
  return LOGIN.replace(
    '<div class="bar"><button type="submit">Sign in</button></div>',
    `<div class="bar"><button type="submit">Sign in</button></div>${error ? `<p class="muted" style="color:var(--bad)">${html(error)}</p>` : ""}`,
  );
}

export function renderDashboard() {
  const options = SAFETY_LEVELS.map((v) => `<option value="${v}">${v}</option>`).join("");
  return DASH
    .replace("__MODES__", JSON.stringify(MODES))
    .replace("__LABELS__", JSON.stringify(MODE_LABELS))
    .replaceAll("__THINKING__", THINKING_LEVELS.map((v) => `<option value="${v}">${v}</option>`).join(""))
    .replaceAll("__SAFETY_OPTIONS__", options)
    .replace("__SAFETY__", JSON.stringify(SAFETY_CATEGORY_KEYS))
    .replace("__MEDIAS__", JSON.stringify(MEDIA_KINDS))
    .replace("__DEFAULT_POOL__", JSON.stringify(DEFAULT_MODEL_POOL));
}

/** Turn whatever the panel posted into a config patch. Unknown keys are dropped. */
export function readPatch(body) {
  const patch = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (MODES.includes(body.mode)) patch.mode = body.mode;
  if (THINKING_LEVELS.includes(body.thinking)) patch.thinking = body.thinking;
  if ("extra" in body) patch.extra = String(body.extra ?? "").slice(0, 4000);
  if ("maxTokens" in body) patch.maxTokens = body.maxTokens;
  if ("dailyCap" in body) patch.dailyCap = body.dailyCap;

  if (body.voice && typeof body.voice === "object") {
    patch.voice = {
      enabled: body.voice.enabled !== false,
      model: typeof body.voice.model === "string" ? body.voice.model.trim() : undefined,
    };
  }

  if (body.provider && typeof body.provider === "object") {
    patch.provider = {
      kind: ["gemini", "openai"].includes(body.provider.kind) ? body.provider.kind : undefined,
      model: body.provider.model,
      baseUrl: body.provider.baseUrl,
      modelPool: body.provider.modelPool ?? body.modelPool,
    };
  } else if (body.modelPool) {
    patch.provider = { modelPool: body.modelPool };
  }
  if (body.media && typeof body.media === "object") {
    patch.media = {};
    for (const k of MEDIA_KINDS) {
      const m = body.media[k];
      if (m) patch.media[k] = { enabled: m.enabled !== false, maxMB: m.maxMB, maxPer: m.maxPer };
    }
  }
  if (body.safety && typeof body.safety === "object") {
    patch.safety = {};
    for (const k of SAFETY_CATEGORY_KEYS) {
      if (SAFETY_LEVELS.includes(body.safety[k])) patch.safety[k] = body.safety[k];
    }
  }
  for (const m of MODES) {
    if (`personas.${m}` in body) patch.personas = { ...(patch.personas ?? {}), [m]: body[`personas.${m}`] };
  }
  return patch;
}

function deepMerge(base, patch) {
  const out = { ...base, ...patch };
  if (patch.media) {
    out.media = { ...base.media };
    for (const k of Object.keys(patch.media)) out.media[k] = { ...base.media[k], ...patch.media[k] };
  }
  if (patch.voice) out.voice = { ...base.voice, ...patch.voice };
  if (patch.provider) out.provider = { ...base.provider, ...patch.provider };
  if (patch.safety) out.safety = { ...base.safety, ...patch.safety };
  if (patch.personas) out.personas = { ...base.personas, ...patch.personas };
  return out;
}

/** The whole /admin subtree. Returns null when the path is not ours. */
export async function handleAdmin(req, env, path) {
  if (path === "/admin" || path === "/admin/") {
    if (await isAuthed(req, env)) {
      return new Response(renderDashboard(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(renderLogin(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (path === "/admin/api/login" && req.method === "POST") {
    const ip = getClientIp(req);
    if (isLoginRateLimited(ip)) {
      return new Response(renderLogin("Too many failed login attempts. Please try again in 5 minutes."), {
        status: 429,
        headers: { "content-type": "text/html; charset=utf-8", "retry-after": "300" },
      });
    }

    const ct = req.headers.get("content-type") ?? "";
    const body = ct.includes("application/json")
      ? await req.json().catch(() => ({}))
      : Object.fromEntries(await req.formData());

    const ok = env.ADMIN_PASSWORD && (await verifyPassword(body.password, env.ADMIN_PASSWORD));
    if (!ok) {
      recordFailedLogin(ip);
      return new Response(renderLogin("Wrong password."), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    clearFailedLogin(ip);
    const secure = isHttps(req) ? "; Secure" : "";
    const cookie = `${COOKIE}=${await signSecret(env.ADMIN_PASSWORD)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`;
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": cookie } });
  }

  if (path === "/admin/api/logout") {
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` } });
  }

  if (path === "/admin/api/clear-errors" && req.method === "POST") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const stats = await bumpStats(env, { resetErrors: true, clearErrors: true, lastError: null });
    return json({ ok: true, stats });
  }

  if (path === "/admin/api/log") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const items = await readArchive(env);
    return json({ count: items.length, items });
  }

  if (path === "/admin/api/keys") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const rawKeys = getKeyPoolStatus(env);
    const keys = rawKeys.map((item) => {
      const key = item.key;
      const masked =
        typeof key === "string"
          ? (key.length > 10 ? key.slice(0, 6) + "..." + key.slice(-4) : (key.length > 2 ? key.slice(0, 2) + "***" : "***"))
          : key;
      const lastError =
        typeof item.lastError === "string"
          ? item.lastError.replace(/key=[^&\s]+/gi, "key=[REDACTED]")
          : item.lastError;
      return { ...item, key: masked, lastError };
    });
    return json({ count: keys.length, keys });
  }

  if (path === "/admin/api/quota") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const daily = await loadQuota(env);
    const combined = { ...daily };
    const now = Date.now();
    for (const [m, resetAt] of minuteQuota.entries()) {
      if (resetAt > now && (!combined[m] || combined[m] < resetAt)) {
        combined[m] = resetAt;
      }
    }
    return json({ quota: combined, now });
  }

  if (path === "/admin/api/clear-quota" && req.method === "POST") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    await saveQuota(env, {});
    clearMinuteQuota();
    return json({ ok: true });
  }

  if (path === "/admin/api/state") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const loaded = await loadConfig(env, DEFAULT_PERSONAS);
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const config = await saveConfig(env, deepMerge(loaded.config, readPatch(body)));
      return json({ ok: true, config, stats: loaded.stats });
    }
    return json({ config: loaded.config, stats: loaded.stats });
  }

  return null;
}

export { json, COOKIE, failedLoginAttempts };