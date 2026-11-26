if (typeof importScripts === "function") importScripts("config.js");
const IS_FIREFOX = typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent);

const PERIOD_MIN = 5;
const WATCH = /^https:\/\/(www|web)\.facebook\.com\/(groups\/|messages\/)/;

function setup() {
  chrome.alarms.create("cmt-refresh", { periodInMinutes: PERIOD_MIN });
  chrome.alarms.create("cmt-update", { periodInMinutes: 60 });
  checkUpdate();
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

let latest = "";

function newer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

async function checkUpdate() {
  try {
    const cfg = self.CMT_CONFIG || {};
    const res = await fetch(cfg.api + "/api/fb/ext-version", { headers: { "X-CMT-FB-Key": cfg.key || "" } });
    const v = (await res.json()).version || "";
    latest = newer(v, chrome.runtime.getManifest().version) ? v : "";
    await chrome.storage.local.set({ latest });
    chrome.action.setBadgeText({ text: latest ? "NEW" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  } catch (e) {}
}

async function downloadUpdate() {
  const cfg = self.CMT_CONFIG || {};
  const res = await fetch(cfg.api + "/api/fb/ext-download" + (IS_FIREFOX ? "?browser=firefox" : ""), { headers: { "X-CMT-FB-Key": cfg.key || "" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const name = IS_FIREFOX ? "cmt-facebook-firefox.zip" : "cmt-facebook-extension.zip";
  if (IS_FIREFOX && typeof URL.createObjectURL === "function") {
    const url = URL.createObjectURL(await res.blob());
    await chrome.downloads.download({ url, filename: name, conflictAction: "overwrite" });
    return { ok: true };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  await chrome.downloads.download({ url: "data:application/zip;base64," + btoa(bin), filename: name, conflictAction: "overwrite" });
  return { ok: true };
}

chrome.action.onClicked.addListener(() => { if (latest) downloadUpdate().catch(() => {}); else checkUpdate(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "cmt-update") return checkUpdate();
  if (alarm.name !== "cmt-refresh") return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !WATCH.test(tab.url)) continue;
    if (tab.autoDiscardable) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    if (tab.active) {
      const win = await chrome.windows.get(tab.windowId);
      if (win.focused) {
        chrome.tabs.sendMessage(tab.id, { type: "cmt-scan" }).catch(() => {});
        continue;
      }
    }
    const g = tab.url.match(/^(https:\/\/(?:www|web)\.facebook\.com\/groups\/[^/?#]+)\/?(?:\?|#|$)/);
    if (g) chrome.tabs.update(tab.id, { url: g[1] + "/?sorting_setting=CHRONOLOGICAL" });
    else chrome.tabs.reload(tab.id);
  }
});

const UID_TTL_NONE = 15 * 60 * 1000;

function authorKey(a) {
  const m = String(a.url || "").match(/\/user\/(\d+)|[?&]id=(\d+)/);   // same person, any link form
  if (m) return "fb:" + (m[1] || m[2]);
  const u = String(a.url || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  return u || "name:" + String(a.name || "").toLowerCase();
}

async function cacheGet() {
  const d = await chrome.storage.local.get("uid");
  return d.uid || {};
}

async function userIds(authors) {
  const cache = await cacheGet(), now = Date.now(), out = {}, miss = [], missIdx = [];
  authors.forEach((a, i) => {
    const c = cache[authorKey(a)];
    if (c && (c.u || now - c.t < UID_TTL_NONE)) {      // a found User ID is kept for good
      if (c.u) out[String(i)] = c.u;
    } else if (!missIdx.some((j) => authorKey(authors[j]) === authorKey(a))) {
      miss.push(a); missIdx.push(i);
    }
  });
  if (miss.length) {
    try {
      const res = await call("/api/fb/userids", { authors: miss });
      miss.forEach((a, k) => { cache[authorKey(a)] = { u: res[String(k)] || "", t: now }; });
      for (const key of Object.keys(cache)) if (!cache[key].u && now - cache[key].t > UID_TTL_NONE) delete cache[key];
      await chrome.storage.local.set({ uid: cache });
    } catch (e) {}
    authors.forEach((a, i) => { const c = cache[authorKey(a)]; if (c && c.u) out[String(i)] = c.u; });
  }
  return out;
}

async function cachePut(a, uid) {
  const cache = await cacheGet();
  cache[authorKey(a)] = { u: uid || "", t: Date.now() };
  await chrome.storage.local.set({ uid: cache });
}

async function call(path, body) {
  const cfg = self.CMT_CONFIG || {};
  const res = await fetch(cfg.api + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CMT-FB-Key": cfg.key || "" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "cmt-ingest") {
    call("/api/fb/ingest", msg.payload).then(reply, (e) => reply({ error: String(e) }));
    return true;
  }
  if (msg && msg.type === "cmt-update-status") {
    chrome.storage.local.get("latest").then((d) => reply({ latest: latest || d.latest || "", current: chrome.runtime.getManifest().version }));
    return true;
  }
  if (msg && msg.type === "cmt-update-download") {
    downloadUpdate().then(reply, (e) => reply({ error: String(e) }));
    return true;
  }
  if (msg && msg.type === "cmt-reload") {
    chrome.runtime.reload();
    return;
  }
  if (msg && msg.type === "cmt-bind") {
    call("/api/fb/bind", msg.data).then(async (r) => {
      if (r && r.ok) await cachePut(msg.data, r.user_id);
      reply(r);
    }, (e) => reply({ error: String(e) }));
    return true;
  }
  if (msg && msg.type === "cmt-userids") {
    userIds(msg.authors).then(reply, () => reply({}));
    return true;
  }
});
