(function () {
  const ADMIN = "https://admin.cloud.boosteroid.com/admin/filament/streaming/streaming-user-sessions?filters%5Buser_id%5D%5Bvalue%5D=";

  function text(el) { return el ? (el.innerText || el.textContent || "").trim() : ""; }

  const MAX_POSTS = 10;

  function topArticles() {
    const feed = Array.from(document.querySelectorAll('[role="feed"] [aria-posinset], [role="feed"] > div'))
      .filter((d) => d.querySelector("h2, h3, h4, strong"));
    const top = feed.filter((d) => !feed.some((o) => o !== d && o.contains(d)));
    if (top.length) return top;
    return Array.from(document.querySelectorAll('[role="article"]')).filter(
      (a) => !a.parentElement || !a.parentElement.closest('[role="article"]')
    );
  }

  function norm(s) {
    // Same post, different rendering (hidden tab drops line breaks, "See more" expanded or not).
    return (s || "").replace(/(…|\.\.\.)?\s*See more\s*$/i, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function isChronological() {
    return /[?&]sorting_setting=CHRONOLOGICAL/.test(location.search);
  }

  function postId(article) {
    for (const a of article.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href");
      const m = h.match(/\/(?:posts|permalink)\/(\d+)/) || h.match(/[?&](?:story_fbid|multi_permalinks)=(\d+)/);
      if (m) return { id: m[1], url: new URL(h, location.origin).href.split("?")[0] };
    }
    return null;
  }

  function authorLink(article) {
    return article.querySelector("h2 a[href], h3 a[href], h4 a[href], strong a[href]");
  }

  function postText(article) {
    const msg = article.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
    if (msg) return text(msg);
    let best = "";
    for (const d of article.querySelectorAll('div[dir="auto"]')) {
      const inner = d.closest('[role="article"]');
      if (inner && inner !== article && article.contains(inner)) continue;
      const t = text(d);
      if (t.length > best.length) best = t;
    }
    // Facebook sometimes keeps the same text twice in one block ("abcabc" / "abc\nabc"): keep one copy.
    const twice = best.match(/^([\s\S]{4,}?)\s*\1$/);
    return twice ? twice[1] : best;
  }

  function scanPosts() {
    const out = [];
    for (const art of topArticles().slice(0, MAX_POSTS)) {
      const a = authorLink(art);
      const body = postText(art).replace(/(…|\.\.\.)?\s*See more\s*$/i, "").slice(0, 4000);
      if (!a && !body) continue;
      const link = postId(art);
      out.push({
        id: "h" + hash(norm(text(a)) + "|" + norm(body).slice(0, 120)),
        url: link ? link.url : location.href.split("?")[0], author: text(a),
        author_url: a ? new URL(a.getAttribute("href"), location.origin).href : "",
        text: body, group: document.title.replace(/\s*\|\s*Facebook\s*$/, "")
      });
    }
    return out;
  }

  function isUnread(row) {
    if (row.querySelector('[aria-label*="nread"], [aria-label*="Mark as read"]')) return true;
    const span = row.querySelector("span");
    return !!span && parseInt(getComputedStyle(span).fontWeight, 10) >= 600;
  }

  function scanDms() {
    const out = [], seen = {};
    for (const a of document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')) {
      const m = a.getAttribute("href").match(/\/t\/([^/?#]+)/);
      if (!m || seen[m[1]] || !isUnread(a)) continue;
      seen[m[1]] = 1;
      const lines = text(a).split("\n").map((s) => s.trim()).filter(Boolean);
      out.push({ id: m[1], name: lines[0] || "", snippet: (lines[1] || "").slice(0, 300),
                 url: new URL(a.getAttribute("href"), location.origin).href });
    }
    return out;
  }

  function badge(author, uid) {
    const wrap = document.createElement("span");
    wrap.className = "cmt-uid-wrap";
    function draw(id) {
      wrap.textContent = "";
      if (id) {
        const link = document.createElement("a");
        link.className = "cmt-uid";
        link.href = ADMIN + encodeURIComponent(id);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "User ID " + id;
        wrap.appendChild(link);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = id ? "cmt-uid-edit" : "cmt-uid cmt-uid-none";
      btn.textContent = id ? "edit" : "No User ID";
      btn.title = id ? "Change the User ID" : "Bind a User ID to this person";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const val = prompt("User ID or email of " + (author.name || "this person") + " (leave empty to remove):", id || "");
        if (val === null) return;
        const clean = val.trim();
        btn.textContent = "...";
        chrome.runtime.sendMessage({ type: "cmt-bind", data: { name: author.name, url: author.url, user_id: clean } }, (r) => {
          if (r && r.ok) {
            draw(r.user_id);
            document.querySelectorAll(".cmt-uid-wrap").forEach((w) => { if (w !== wrap && w.dataset.key === wrap.dataset.key) w.cmtDraw(r.user_id); });
          } else {
            draw(id);
            alert(r && r.error ? "User ID not saved: " + r.error : "Could not save the User ID. Is the console reachable?");
          }
        });
      });
      wrap.appendChild(btn);
    }
    const pm = String(author.url || "").match(/\/user\/(\d+)|[?&]id=(\d+)/);
    wrap.dataset.key = pm ? "fb:" + (pm[1] || pm[2]) : (author.url.split("?")[0] || author.name);
    wrap.cmtDraw = draw;
    draw(uid);
    return wrap;
  }

  // A person on a group page: /groups/<group>/user/<id>/ (post headers, comments, hover cards) or a
  // profile link with ?id=. Only short name links get a badge (not photos, not long text links).
  const PERSON_RE = /\/groups\/[^/]+\/user\/(\d+)|[?&]id=(\d+)/;

  function personLinks() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/user/"], a[href*="profile.php?id="]')) {
      if (a.dataset.cmtUid || a.closest(".cmt-uid-wrap") || a.querySelector("img, svg, image")) continue;
      const href = a.getAttribute("href") || "";
      if (!PERSON_RE.test(href)) continue;
      const name = text(a);
      if (!name || name.length > 60 || name.includes("\n")) continue;
      const next = a.nextElementSibling;
      if (next && next.classList && next.classList.contains("cmt-uid-wrap")) { a.dataset.cmtUid = "1"; continue; }
      out.push(a);
    }
    return out;
  }

  function profileHeading() {
    // The person's own group profile page: the badge goes next to the big name.
    if (!PERSON_RE.test(location.pathname) || !/\/user\/\d+/.test(location.pathname)) return null;
    const h = document.querySelector("h1");
    if (!h || h.dataset.cmtUid) return null;
    return h;
  }

  function overlay() {
    if (!location.pathname.startsWith("/groups/")) return;
    const links = personLinks();
    const head = profileHeading();
    const targets = links.map((a) => ({ el: a, name: text(a), url: new URL(a.getAttribute("href"), location.origin).href }));
    if (head) targets.push({ el: head, name: text(head), url: location.href, inside: true });
    if (!targets.length) return;
    targets.forEach((t) => { t.el.dataset.cmtUid = "1"; });
    const authors = targets.map((t) => ({ name: t.name, url: t.url }));
    chrome.runtime.sendMessage({ type: "cmt-userids", authors }, (res) => {
      res = res || {};
      targets.forEach((t, i) => {
        const b = badge(authors[i], res[String(i)] || "");
        if (t.inside) t.el.appendChild(b);
        else t.el.insertAdjacentElement("afterend", b);
      });
    });
  }

  let lastSent = "";

  function scan() {
    const isGroup = location.pathname.startsWith("/groups/");
    const isMsg = location.pathname.startsWith("/messages/");
    if (!isGroup && !isMsg) return;
    setTimeout(() => {
      const payload = { version: chrome.runtime.getManifest().version, hidden: document.hidden, page: isGroup ? "group" : "messages",
                        posts: isGroup && isChronological() ? scanPosts() : [], dms: scanDms() };
      const sig = payload.posts.map((p) => p.id).join(",") + "|" + payload.dms.map((d) => d.id + d.snippet).join(",");
      if (isGroup) overlay();
      if (sig === lastSent && lastSent) return;      // nothing new since the last send on this page
      lastSent = sig;
      chrome.runtime.sendMessage({ type: "cmt-ingest", payload });
    }, 1500);
  }

  function updateBanner() {
    chrome.runtime.sendMessage({ type: "cmt-update-status" }, (r) => {
      if (!r || !r.latest || document.getElementById("cmt-update")) return;
      const bar = document.createElement("div");
      bar.id = "cmt-update";
      bar.innerHTML = '<b>CMT Facebook ' + r.latest + '</b> is available (you have ' + r.current + '). ' +
        '<button data-a="dl">Download update</button>' +
        '<span>Unzip it over the old extension folder, then</span>' +
        '<button data-a="reload">Reload extension</button><button data-a="x">&times;</button>';
      bar.addEventListener("click", (e) => {
        const a = e.target.getAttribute && e.target.getAttribute("data-a");
        if (a === "dl") chrome.runtime.sendMessage({ type: "cmt-update-download" }, (x) => {
          if (!x || !x.ok) alert("Download failed. Use the button in the console's Facebook tab.");
        });
        if (a === "reload") { chrome.runtime.sendMessage({ type: "cmt-reload" }); setTimeout(() => location.reload(), 800); }
        if (a === "x") bar.remove();
      });
      document.body.appendChild(bar);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "cmt-scan") scan(); });
  setTimeout(updateBanner, 4000);
  setTimeout(scan, 6000);
  setTimeout(scan, 20000);
  let t = null;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(overlay, 400); })
    .observe(document.body, { childList: true, subtree: true });
})();
