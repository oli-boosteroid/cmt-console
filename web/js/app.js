/* ============================================================
   CMT Console - single-page app (vanilla, no build step).
   Hash routing, themes, command palette, all screens.
   Loaded as classic scripts: config.js (empty data store + tag
   lists), icons.js, api.js, then app.js.
   ============================================================ */
(function () {
  "use strict";
  var D = window.DATA, ICONS = window.ICONS;

  /* App version: read from this script tag's ?v= cache buster so the "Beta v<N>" label always
     matches the deployed build - bump ?v= once in index.html and the label follows automatically. */
  var APP_VERSION = (function () {
    try {
      var s = document.currentScript || document.querySelector('script[src*="app.js"]');
      var m = s && s.src && s.src.match(/[?&]v=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) { return ""; }
  })();

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function ic(name, cls) {
    return '<svg class="' + (cls || "ico") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">' + (ICONS[name] || "") + "</svg>";
  }
  /* Scrub server HTML (Jira renderedFields description/comments) before it goes into innerHTML.
     Jira sanitizes its own rendered output, but this is defense-in-depth: drop active elements and
     event handlers, and neutralize javascript:/data: URLs. DOMParser never executes scripts. */
  /* Allow only real web/mailto schemes into an href, so a stored "javascript:" / "data:" link can't
     execute. Returns "" for anything else (the anchor becomes inert). */
  function safeUrl(u) {
    u = String(u == null ? "" : u).trim();
    return /^(https?:|mailto:)/i.test(u) ? u : "";
  }
  function initials(name) {
    if (!name) return "?";
    var p = String(name).replace(/^[ur]\//, "").replace(/[_.]/g, " ").trim().split(/\s+/);
    var a = (p[0] || "")[0] || "", b = p[1] ? (p[1][0] || "") : "";
    return (a + b).toUpperCase() || "?";   // guard punctuation/slash-only names -> no "UNDEFINED"
  }
  function q(sel, el) { return (el || document).querySelector(sel); }

  var SRC = {
    reddit:   { label: "Reddit ModMail", dot: "var(--src-reddit)" },
    post:     { label: "Reddit Post",    dot: "var(--src-reddit)" },
    discord:  { label: "Discord",        dot: "var(--src-discord)" },
    telegram: { label: "Telegram",       dot: "var(--src-telegram, #29b6f6)" },
    jira:     { label: "Jira",           dot: "var(--src-jira)" },
    facebook: { label: "Facebook",       dot: "var(--src-facebook)" }
  };
  function srcBadge(s) {
    var o = SRC[s] || { label: s, dot: "var(--muted)" };
    return '<span class="badge-src"><i class="sdot" style="background:' + o.dot + '"></i>' + esc(o.label) + "</span>";
  }
  function statusClass(st) { return String(st || "").replace(/\s+/g, "_").toLowerCase(); }
  function statusLabel(st) {
    return String(st || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  /* site-only Reddit ModMail statuses. Mostly DERIVED from the message flow; "In progress"
     is a manual override the mod sets when actively working (e.g. waiting on L2/Jira), "Done" =
     the convo is archived on Reddit. */
  var SITE_STATUS = {
    all: "All", new: "New", needs_review: "Needs review", waiting_user: "Waiting on user",
    in_progress: "In progress", done: "Done"
  };
  /* Derive a conversation's effective status from its messages + archive state + manual override.
     new = no reply from us yet; needs_review = the user replied last (after we had replied);
     waiting_user = we replied last; in_progress = manual override; done = archived. */
  /* For an explicit "Waiting on user" override: flip to Needs Review only if the user's (last) message is
     NEWER than when we set the override. No ack recorded -> old behavior (flip whenever the user spoke
     last). This lets a mod set "Waiting on user" while the user spoke last and have it stick,
     while still surfacing the ticket when the user actually writes again. */
  function _wroteAfterAck(msgTs, ackIso) {
    if (!ackIso) return true;
    var m = _utcDate(msgTs), a = _utcDate(ackIso);
    if (!(m && a)) return true;
    return m.getTime() > a.getTime();
  }
  /* Event-based reopen (Reddit + Discord). A manual "In progress" / "Waiting on user" (and Discord
     "Done" whose close was cancelled) only holds UNTIL THE USER WRITES: a user message that arrives
     AFTER the status was set makes the override stale -> the chat shows Needs review, and once we
     answer it follows the flow (Waiting on user) until someone picks a status by hand again. Because
     it is keyed on the message event (message time > override time), setting In progress while the
     user's message is still the latest STICKS - that message is older than the override. Stale
     overrides are also cleared server-side (consumeStaleOverrides) so the reopen survives our reply. */
  var CONSUMABLE_OV = { in_progress: 1, waiting_user: 1 };
  function redditUserLast(c) {
    var p = (c.messages || []).filter(function (m) { return !m.is_internal; });
    return p.length ? p[p.length - 1].author === c.participant : c.last_author === c.participant;
  }
  function discordUserLast(t) {
    var p = (t.messages_history || []).filter(function (m) { return !m.note; });
    return p.length ? !!p[p.length - 1].is_user : !!t.last_message_is_user;
  }
  function redditOverrideStale(c) {
    // Done counts too: archived from the console it holds until the user writes after it (Reddit then
    // un-archives the convo), even before the bot snapshot has picked up the archived state.
    return !!(c && (CONSUMABLE_OV[c.override_status] || c.override_status === "done") && redditUserLast(c) && _wroteAfterAck(c.ts, c._override_at));
  }
  function discordOverrideStale(t) {
    return !!(t && (CONSUMABLE_OV[t.override_status] || t.override_status === "done") && t.status !== "closed" &&
              discordUserLast(t) && _wroteAfterAck(t.last_message_ts, t._override_at));
  }
  /* Persist the event: once the user has written after a manual status, clear that override (locally +
     /convo-status ""), so after OUR reply the chat follows the flow (Waiting on user) instead of snapping
     back to In progress. Runs after every data load; idempotent across tabs/consoles. */
  var _consuming = {};
  function consumeStaleOverrides() {
    function consume(id, item, ov) {
      var key = id + "|" + (item._override_at || "");
      if (_consuming[key]) return;
      _consuming[key] = 1;
      item.override_status = ""; item._override_at = "";
      if (state._overrides) delete state._overrides[id];
      postConvoStatus(id, "").then(function () {},
        function () { delete _consuming[key]; });   // retry on the next refresh
    }
    (D.redditModmail || []).forEach(function (c) { if (redditOverrideStale(c)) consume(c.id, c, c.override_status); });
    (D.discordTickets || []).forEach(function (t) { if (discordOverrideStale(t)) consume(tid(t), t, t.override_status); });
  }
  function deriveRedditStatus(convo) {
    if (!convo) return "new";
    var ov = convo.override_status;
    // A manual, non-Done override wins over EVERYTHING incl. the archived flag, so a mod can move an
    // archived/Done convo to Needs review / Waiting on user - until the user writes after
    // it (redditOverrideStale), then the flow takes over (Needs review -> Waiting on user after our reply).
    if (ov && !redditOverrideStale(convo)) return ov;
    // Still archived on Reddit -> Done. Once the participant writes again Reddit un-archives the convo
    // (_archived false), a stale "done" override falls through to the flow -> Needs review.
    if (convo._archived) return "done";
    if (convo.site_status === "resolved") return "done";
    if (convo.site_status === "in_progress") return "in_progress";
    var pub = (convo.messages || []).filter(function (m) { return !m.is_internal; });
    // Fallback for the list (messages not loaded yet): use the snapshot's status hints (S3).
    if (!pub.length && typeof convo.mod_replied !== "undefined") {
      if (!convo.mod_replied) return "new";
      return convo.last_author === convo.participant ? "needs_review" : "waiting_user";
    }
    var modReplied = pub.some(function (m) { return m.author !== convo.participant; });
    if (!modReplied) return "new";
    var last = pub[pub.length - 1];
    if (last && last.author === convo.participant) return "needs_review";  // user replied last
    return "waiting_user";                                                 // we replied last
  }
  var REDDIT_STATUSES = [["new", "New"], ["needs_review", "Needs review"], ["waiting_user", "Waiting on user"], ["in_progress", "In progress"], ["done", "Done"]];
  var DISCORD_STATUSES = [["new", "New"], ["in_progress", "In progress"], ["waiting_user", "Waiting on user"], ["needs_review", "Needs review"], ["postponed", "Postponed"], ["done", "Done"]];
  /* One dropdown that IS the status (item S4): shows the current status as its value, lists all our
     statuses, plus "Auto (from flow)" to drop a manual override. */
  function statusSelect(act, ref, cur, opts) {
    return '<div class="dh-status"><select class="mini-select status-select st ' + statusClass(cur) + '" data-act="' + act + '" data-ref="' + esc(ref) + '">' +
      opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") +
      '<option value="__auto__">Auto (from flow)</option></select></div>';
  }
  /* Discord ModMail status priority: closed -> Done (a fresh user reply reopens it); a manual console
     pick (override_status) wins next; then the linked-Jira flow (SO waits Postponed, URG waits In
     progress, either -> Needs review when its Jira reaches CM In Progress / Review, and a user message
     during the wait surfaces it); then a non-Jira Postpone; else the message flow. The transcript is
     lazy-loaded, so list rows without it fall back to first_response_at / last_message_is_user. */
  /* Consistent status label for both ModMail tabs. */
  function mmStatusLabel(k) { return SITE_STATUS[k] || { postponed: "Postponed" }[k] || statusLabel(k); }
  /* Unified status control shown under the username in both ModMail tabs: the current
     (derived) status as a chip + a dropdown to change it. Reddit overrides are persisted; Discord
     options trigger the bot (Postponed opens the confirm modal). */
  function redditStatusControl(convo) { return statusSelect("mstatus", convo.id, deriveRedditStatus(convo), REDDIT_STATUSES); }
  function discordStatusControl(t) {
    var st = deriveDiscordStatus(t);
    return statusSelect("dstatus-select", tid(t), st, DISCORD_STATUSES) +
      (t._idleReview ? '<div class="f-hint" style="margin-top:4px">' + ic("clock", "ico-sm") + " " + esc(DISCORD_IDLE_NOTE) + "</div>" : "");
  }
  function isUrgKey(k) { return String(k || "").toUpperCase().indexOf("URG-") === 0; }               // URG project prefix
  // Render a Jira key chip colour-coded by project so URG (urgent, red) and SO (violet) are told apart
  // at a glance everywhere a key is shown (Jira tab, To-Do, context panel, link picker).
  function jkeyChip(k, style) { return '<span class="jkey' + (isUrgKey(k) ? " urg" : "") + '"' + (style ? ' style="' + style + '"' : "") + ">" + esc(k) + "</span>"; }
  function urgAtReview(k) { return !!k && (D.urgReview || []).some(function (u) { return String(u.key) === String(k); }); }
  /* Discord: a ticket waiting on the user for 3 days with no user message comes back as Needs review so
     someone checks it ("no user messages for 3 days"). The clock runs from our last message or from a
     manual "Waiting on user", whichever is later; any user message (or our reply) restarts it. */
  var DISCORD_IDLE_REVIEW_MS = 3 * 86400000;
  var DISCORD_IDLE_NOTE = "No messages from the user for 3 days - please check";
  function _discordIdleSince(a, b) {
    var da = _utcDate(a), db = _utcDate(b);
    var d = (da && db) ? (da > db ? da : db) : (da || db);
    return !!d && (Date.now() - d.getTime()) >= DISCORD_IDLE_REVIEW_MS;
  }
  function deriveDiscordStatus(t) {
    if (!t) return "new";
    t._idleReview = false;
    // Flow status from the message stream (new / needs_review / waiting_user).
    var flow;
    var pub = (t.messages_history || []).filter(function (m) { return !m.note; });
    if (pub.length) {
      var modReplied = pub.some(function (m) { return !m.is_user; });
      var last = pub[pub.length - 1];
      flow = !modReplied ? "new" : ((last && last.is_user) ? "needs_review" : "waiting_user");
    } else if (!t.first_response_at) {
      flow = "new";
    } else if (typeof t.last_message_is_user !== "undefined") {
      flow = t.last_message_is_user ? "needs_review" : "waiting_user";
    } else {
      flow = "waiting_user";
    }
    var userReplied = (flow === "needs_review");   // the user spoke last -> the ticket needs a reply
    var modLast = (flow === "waiting_user");        // we spoke last (relayed / answered)
    // #1: a closed ticket comes back as Needs review only when the user wrote AFTER it was closed. A user
    // message from before the close (e.g. "ok thanks", then the scheduled close fired) keeps it Done.
    if (t.status === "closed") {
      var lastUserAt = null;
      if (pub.length) { var lm = pub[pub.length - 1]; if (lm && lm.is_user) lastUserAt = _utcDate(lm.timestamp); }
      else if (t.last_message_is_user) lastUserAt = _utcDate(t.last_message_ts);
      var closedAt = _utcDate(t.closed_at);
      if (userReplied && lastUserAt && closedAt && lastUserAt.getTime() > closedAt.getTime()) return "needs_review";
      return "done";
    }
    // #2: a manual console pick (In Progress / Done / Waiting) wins over the flow, so a mod can mark a
    // ticket In Progress WITHOUT replying and it sticks until they change it (or pick Auto from flow).
    // EXCEPTION: "Waiting on user" is by definition a wait FOR the user - the moment the user replies it
    // must surface as Needs Review (then it returns to Waiting on user on its own once we answer again),
    // exactly like the Postponed flow below.
    if (t.override_status) {
      // In progress / Waiting on user / Done (close cancelled) hold until the USER writes after the status
      // was set (discordOverrideStale) -> Needs review, then the flow (Waiting on user once we answer).
      // Set while the user's message is the latest, the override sticks (event-based, see above).
      if (discordOverrideStale(t)) return userReplied ? "needs_review" : flow;
      if (t.override_status === "waiting_user" && !userReplied && _discordIdleSince(t.last_message_ts, t._override_at)) {
        t._idleReview = true; return "needs_review";
      }
      return t.override_status;
    }
    // #3/#5: a linked Jira drives the status. SO links postpone the channel (waiting_for_jira) and get
    // un-postponed by the bot when they reach CM In Progress; URG links (never own the channel state)
    // are detected by key + our URG-in-Review list.
    var keys = (t.jira_keys && t.jira_keys.length) ? t.jira_keys : (t.jira_key ? [t.jira_key] : []);
    var urgKey = keys.filter(isUrgKey)[0];
    var soReachedColumn = !!t.jira_mode_unpostponed && !t.waiting_for_jira;   // SO hit CM In Progress
    var urgReachedColumn = urgAtReview(urgKey);                                // URG hit Review
    // Reached its column -> relay to the user (Needs Review), until we reply (then it follows the flow).
    if ((soReachedColumn || urgReachedColumn) && !modLast) return "needs_review";
    // A fresh user message during the wait always surfaces (Needs Review); otherwise SO waits Postponed,
    // URG waits In Progress, until the Jira reaches its column.
    if (t.waiting_for_jira) return userReplied ? "needs_review" : "postponed";
    if (urgKey && !urgReachedColumn) return userReplied ? "needs_review" : "in_progress";
    // #4: a non-Jira Postponed ticket flips to Needs Review on a fresh user message, back to Postponed
    // once we reply. Postpone otherwise hides the ticket.
    if (t.postponed) return userReplied ? "needs_review" : "postponed";
    if (flow === "waiting_user" && _discordIdleSince(t.last_message_ts)) { t._idleReview = true; return "needs_review"; }
    return flow;
  }

  /* An item "needs attention" (drives the rail count + Monitor) purely by its STATUS, independent
     of whether the chat has been read (V3): a post is New until it gets a reply or is Ignored; a
     ModMail chat counts while New / In progress / Needs review, and drops once we move it on
     (Waiting on user / Postponed / Done). Reading the chat does NOT clear this; only a status
     change does. */
  var ATTN_MM = { new: 1, needs_review: 1 };   // In progress = actively being worked on, not "unread" (item #G)
  function needsAttention(type, item) {
    if (!item) return false;
    if (type === "post") return !item.ignored && !item.has_reply;      // "New" post until replied/ignored
    if (type === "convo") return !!ATTN_MM[deriveRedditStatus(item)];
    if (type === "ticket") return !!ATTN_MM[deriveDiscordStatus(item)];
    return false;
  }
  function convoById(id) { return D.redditModmail.filter(function (c) { return c.id === id; })[0]; }
  /* Stable per-ticket key: real ticket_number is NOT unique (per-user), so route/select by _id. */
  function tid(t) { return t ? String(t._id || t.ticket_number) : ""; }
  function ticketByKey(k) { k = String(k); return D.discordTickets.filter(function (t) { return tid(t) === k || String(t.channel_id) === k; })[0]; }   // resolve by _id OR channel_id (notification links use channel_id)
  /* All absolute times on the site render in Kyiv time (Europe/Kyiv, UTC+2/+3 with automatic
     DST). Intl handles the summer/winter switch. Relative "ago" durations are timezone-agnostic
     and stay as-is. */
  var _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /* Parse a server timestamp to a Date at the correct INSTANT. The bot stores naive UTC (ISO with
     no timezone, e.g. "2026-08-08T12:40:00"); JS would otherwise read that as LOCAL time and be off
     by the local offset - the "3h vs 18m" bug. So we force UTC by appending Z when no zone is set. */
  function _utcDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
      s = s.replace(" ", "T");
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";      // no zone -> it is UTC
    }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  function _kyivParts(d) {
    try {
      var f = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Kyiv", hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
      });
      var o = {}; f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
      return o;
    } catch (e) { return null; }
  }
  /* Full absolute Kyiv timestamp "DD Mon YYYY, HH:MM". */
  function fmtDT(v) {
    var d = _utcDate(v);
    if (!d) return v ? String(v) : "";
    var p = _kyivParts(d);
    if (!p) return "";
    return p.day + " " + _MON[parseInt(p.month, 10) - 1] + " " + p.year + ", " + p.hour + ":" + p.minute;
  }
  /* Compact Kyiv time: "HH:MM" if today, else "DD Mon HH:MM". */
  function fmtKyivShort(v) {
    var d = _utcDate(v); if (!d) return v ? String(v) : "";
    var p = _kyivParts(d); if (!p) return "";
    var now = _kyivParts(new Date()) || {};
    if (p.year === now.year && p.month === now.month && p.day === now.day) return p.hour + ":" + p.minute;
    return p.day + " " + _MON[parseInt(p.month, 10) - 1] + " " + p.hour + ":" + p.minute;
  }
  /* Concrete Kyiv time with the relative elapsed as a supplement, e.g. "15:40 | 18m ago". Shown
     everywhere a timestamp appears (the elapsed time is the addition). */
  function timeText(v) {
    var d = _utcDate(v);
    if (!d) return v ? String(v) : "";           // mock static strings ("8m", "now") pass through
    var rel = agoFrom(v);
    var abs = fmtKyivShort(d);
    return rel === "now" ? abs + " | now" : (rel ? abs + " | " + rel + " ago" : abs);
  }
  function jiraByKey(k) { return D.jira.filter(function (j) { return j.issue_key === k; })[0]; }
  /* Jira browse URL for a key: reuse a known ticket's own url, else derive the base from any loaded
     ticket, else fall back to the team's Jira host. Used to jump straight to Jira for keys the console
     doesn't track. */
  function jiraUrl(key) {
    var j = jiraByKey(key);
    if (j && j.url) return j.url;
    var any = (D.jira || []).filter(function (x) { return x && x.url; })[0];
    if (any && any.url) return String(any.url).replace(/\/browse\/.*$/, "") + "/browse/" + key;
    return "https://bsdesk.atlassian.net/browse/" + key;
  }
  function userById(id) { return D.users.filter(function (u) { return u.id === id; })[0]; }
  function _inList(arr, v, ci) {
    if (!v || !arr) return false; v = String(v); if (ci) v = v.toLowerCase();
    for (var i = 0; i < arr.length; i++) { var x = String(arr[i]); if ((ci ? x.toLowerCase() : x) === v) return true; }
    return false;
  }
  function userByReddit(h) { return D.users.filter(function (u) { return _inList(u.reddits || [u.reddit], h, true); })[0]; }
  function userByDiscordId(did) { return D.users.filter(function (u) { return _inList(u.discord_ids || [u.discord_id], did); })[0]; }
  function userByTelegramId(tid) { return tid ? D.users.filter(function (u) { return _inList(u.telegram_ids || [], String(tid)); })[0] || null : null; }
  /* The User ID shown on a feed card comes from the directory (the one place it is stored), looked up by
     the author's account - never a copy kept on the message. */
  function userIdChip(u) {
    var uid = u && (u.user_ids || [])[0];
    return uid ? '<span class="chip soft mono" style="padding:1px 8px">' + ic("user", "ico-sm") + "User ID " + esc(uid) + "</span>" : "";
  }
  function userByEmail(e) { return D.users.filter(function (u) { return _inList(u.emails || [u.email], String(e || "").trim(), true); })[0] || null; }
  function notesFor(type, ref) { return D.notes.filter(function (n) { return n.context_type === type && String(n.ref) === String(ref); }); }
  /* Resolve a social handle to the team member's unified display name. Empty links now,
     so these are no-ops until accounts are linked in Admin > Users > Identity. */
  function teamByReddit(h) { h = String(h || "").toLowerCase(); return h ? (D.team || []).filter(function (m) { return (m.reddit_username || "").toLowerCase() === h; })[0] : null; }
  function teamByDiscord(name, id) { return (D.team || []).filter(function (m) { return (name && (m.discord_name || "") === name) || (id && String(m.discord_id || "") === String(id)); })[0]; }
  function nameForReddit(h) { var m = teamByReddit(h); return m ? (m.display_name || m.name) : ("u/" + h); }
  /* ---- Inbox read state (shared across the team, items S6/S7) ----
     D.reads maps "<type>:<ref>" -> {c: msg-count seen, at: iso}. An item is unread when its live
     count exceeds the seen count (or it was never seen). Opening it marks it read for everyone. */
  function readKey(type, ref) { return type + ":" + ref; }
  function readRec(type, ref) { return (D.reads || {})[readKey(type, ref)]; }
  function itemCount(type, item) {
    if (type === "convo") return item.msgs_count || (item.messages ? item.messages.length : 0);
    if (type === "ticket") return item.messages_count || (item.messages_history ? item.messages_history.length : 0);
    if (type === "post") return item.num_comments || (item.thread ? Math.max(0, item.thread.length - 1) : 0);
    return 0;
  }
  function newCount(type, item, ref) {
    if (type === "post") return isUnread(type, item, ref) ? 1 : 0;   // W6: reply-to-mod, not comment count
    var r = readRec(type, ref), cur = itemCount(type, item);
    if (!r) return cur;                       // never seen -> everything is new
    return Math.max(0, cur - (r.c || 0));
  }
  function isUnread(type, item, ref) {
    var r = readRec(type, ref), cur = itemCount(type, item);
    if (type === "post") {
      // W6: a plain comment must NOT mark a post unread / pull it out of Ignored - only a USER'S
      // reply to one of OUR mod comments does (bot sets last_reply_to_mod).
      if (!r) return !item.has_reply && !item.ignored;   // a fresh unanswered post is still "new"
      if (!item.last_reply_to_mod) return false;
      var rd = _utcDate(r.at), rp = _utcDate(item.last_reply_to_mod);
      return !!(rp && (!rd || rp.getTime() > rd.getTime()));
    }
    if (!r) return cur > 0;                    // never seen: a convo/ticket that has messages
    return cur > (r.c || 0);
  }
  /* Whether the current user's views should be IGNORED right now (their "read" must not touch the shared,
     team-wide read state). On by default; only applies when we can tell they're off Duty (has a schedule
     and is currently outside their Duty window - Testing/Vacation/Sick/off-shift all count as off Duty). */
  function offDutyReadsIgnored() {
    var u = state.user;
    if (!u) return false;
    if (u.ignore_offduty_reads === false) return false;              // toggle off -> always count
    if (!u.schedule || typeof u.schedule !== "object") return false; // no schedule set -> can't tell -> count
    return statusNow(u).key !== "duty";
  }
  /* A local change (read, replied, Telegram ignore) is written to the server at once, but a refresh
     that started BEFORE it can land AFTER it with the old state and undo it on screen (the chat turns
     unread again). Recent local changes are kept here and laid over every refresh for 60s. */
  var LOCAL_HOLD_MS = 60000;
  function holdLocal(bucket, key, val) {
    var b = state._local || (state._local = {}); (b[bucket] || (b[bucket] = {}))[key] = { v: val, t: Date.now() };
  }
  function heldLocal(bucket) {   // {key: value} of the still-fresh local changes in a bucket
    var b = ((state._local || {})[bucket]) || {}, out = {}, now = Date.now();
    Object.keys(b).forEach(function (k) { if (now - b[k].t < LOCAL_HOLD_MS) out[k] = b[k].v; else delete b[k]; });
    return out;
  }
  function markRead(type, ref, count) {
    if (!ref) return;
    if (offDutyReadsIgnored()) return;   // off-duty peek must not mark chats read for whoever is on shift
    D.reads = D.reads || {};
    D.reads[readKey(type, ref)] = { c: count || 0, at: new Date().toISOString() };
    holdLocal("reads", readKey(type, ref), D.reads[readKey(type, ref)]);
    window.CONSOLE.post("/reads", { ref_type: type, ref: ref, count: count || 0 }).then(function () {}, function () {});
  }
  /* HTML for a list-row avatar: the count of new messages when unread, else the initials. */
  function avatarOrCount(type, item, ref, initialsText) {
    var n = newCount(type, item, ref);
    if (n > 0 && isUnread(type, item, ref)) return '<div class="av unread-av" title="' + n + ' new">' + (n > 99 ? "99+" : n) + "</div>";
    return '<div class="av">' + esc(initialsText) + "</div>";
  }
  function emptyState(icon, title, sub) {
    // First load still running: "Empty" would be a lie, the data just hasn't arrived yet.
    if (state.loadingData) return skeletonRows(6);
    return '<div class="empty">' + ic(icon) + "<h3>" + esc(title) + "</h3><p class=\"muted\">" + esc(sub) + "</p></div>";
  }
  /* Render a message body: image URLs (incl. Discord CDN attachments) become inline images, other
     URLs become links, the rest is escaped text (item T7). */
  function _isImageUrl(u) {
    return /^https?:\/\/\S+$/.test(u) && (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(u) || /(cdn|media)\.disc(ord)?app(?:\.net|\.com)\/attachments\//i.test(u));
  }
  function renderContent(content, fmt) {
    var s = String(content == null ? "" : content), out = "", imgs = "", last = 0, m;
    var txt = fmt ? function (t) { return fmt(esc(t)); } : esc;   // fmt adds inline markdown to escaped text
    // One pass: markdown links [label](url) and bare URLs become anchors (image URLs become thumbnails);
    // every gap of plain text between matches is HTML-escaped, so nothing user-supplied can inject markup.
    var re = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/\S+)/g;
    while ((m = re.exec(s))) {
      out += txt(s.slice(last, m.index));
      last = re.lastIndex;
      if (m[2]) {                                    // markdown link [label](url)
        var safe = safeUrl(m[2]);
        if (safe) { var lbl = (m[1] && m[1].trim()) ? m[1].trim() : m[2]; out += '<a href="' + esc(safe) + '" target="_blank" rel="noopener">' + esc(lbl) + "</a>"; }
        else out += esc(m[0]);
      } else {                                        // bare URL (m[3]); trim trailing sentence punctuation
        var u = m[3], trail = "", tm = /[)\].,!?;:]+$/.exec(u);
        if (tm) { trail = u.slice(u.length - tm[0].length); u = u.slice(0, u.length - tm[0].length); }
        if (_isImageUrl(u)) imgs += '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img class="msg-img" src="' + esc(u) + '" alt="attachment" loading="lazy" data-imgfail="label"></a>';
        else { var safe2 = safeUrl(u); out += safe2 ? ('<a href="' + esc(safe2) + '" target="_blank" rel="noopener">' + esc(u) + "</a>") : esc(u); }
        out += esc(trail);
      }
    }
    out += txt(s.slice(last));
    return out.trim() + (imgs ? '<div class="msg-imgs">' + imgs + "</div>" : "");
  }
  /* Reddit Markdown -> safe HTML for posts, comments and ModMail. Every piece of text is HTML-escaped
     first (renderContent), and only then are the markdown markers turned into tags, so a message can
     never inject its own markup; links still go through safeUrl (http/https only). Covers what Reddit
     users actually write: paragraphs, line breaks, - / * / 1. lists, > quotes, # headings, code,
     **bold**, *italic*, ~~strike~~, `code`, >!spoiler!<, ^superscript. */
  function _mdInline(h) {
    return h
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n][^\n]*?)\*\*/g, "<b>$1</b>")
      .replace(/__([^_\n][^\n]*?)__/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<i>$2</i>")
      .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<i>$2</i>")
      .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
      .replace(/&gt;!([^\n]+?)!&lt;/g, '<span class="md-spoiler">$1</span>')
      .replace(/\\([*_~`>#])/g, "$1")
      .replace(/\bUser ID (\d{3,12})\b/g, function (_, id) {
        return '<a class="mono" href="' + esc(adminSessionsUrl(id)) + '" target="_blank" rel="noopener">User ID ' + id + "</a>";
      });
  }
  function renderMarkdown(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").replace(/&amp;nbsp;|&nbsp;/g, " ").split("\n");
    var html = "", para = [], list = null, i, ln, mm;
    function inline(t) { return renderContent(t, _mdInline); }
    function flushPara() { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } }
    function flushList() { if (list) { html += "<" + list.tag + ">" + list.items.map(function (x) { return "<li>" + inline(x) + "</li>"; }).join("") + "</" + list.tag + ">"; list = null; } }
    for (i = 0; i < lines.length; i++) {
      ln = lines[i];
      if (/^\s*```/.test(ln)) {                                   // fenced code block
        flushPara(); flushList();
        var code = []; for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        html += "<pre><code>" + esc(code.join("\n")) + "</code></pre>"; continue;
      }
      if (!ln.trim()) { flushPara(); flushList(); continue; }
      if ((mm = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(ln))) {         // list item
        flushPara();
        var tag = /\d/.test(mm[1]) ? "ol" : "ul";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push(mm[2]); continue;
      }
      if (list && /^\s{2,}\S/.test(ln)) { list.items[list.items.length - 1] += " " + ln.trim(); continue; }   // wrapped item
      flushList();
      if ((mm = /^\s*(#{1,6})\s+(.*)$/.exec(ln))) { flushPara(); html += '<p class="md-h">' + inline(mm[2]) + "</p>"; continue; }
      if ((mm = /^\s*>(?!!)\s?(.*)$/.exec(ln))) {                  // quote (not a >!spoiler!<)
        flushPara();
        var q = [mm[1]]; while (i + 1 < lines.length && /^\s*>(?!!)/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s*>\s?/, ""));
        html += "<blockquote>" + q.map(inline).join("<br>") + "</blockquote>"; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flushPara(); html += "<hr>"; continue; }
      para.push(ln);
    }
    flushPara(); flushList();
    return '<div class="md">' + html + "</div>";
  }
  /* One-line plain-text preview for list rows: markdown links -> their label/url, newlines collapsed. */
  function previewText(s) {
    return String(s == null ? "" : s)
      .replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, function (_, l, u) { return (l && l.trim()) ? l.trim() : u; })
      .replace(/\s+/g, " ").trim();
  }

  function agoFrom(iso) {
    var d = _utcDate(iso); if (!d) return "";
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "now";
    var m = Math.floor(s / 60); if (m < 60) return m + "m";
    var h = Math.floor(m / 60); if (h < 24) return h + "h";
    var dd = Math.floor(h / 24); if (dd < 7) return dd + "d";
    return Math.floor(dd / 7) + "w";
  }
  /* Discord message timestamps: concrete Kyiv time + elapsed (mock "12:40"/"now" pass through). */
  function shortTime(ts) {
    if (!ts) return "";
    return _utcDate(ts) ? timeText(ts) : String(ts);
  }
  function mapMsg(m) {
    return { author_name: m.author_name, content: m.content, is_user: !!m.is_user,
      timestamp: shortTime(m.timestamp), note: !!m.note };
  }
  function mapDiscordTicket(d) {
    d.metadata = d.metadata || {};
    d.metadata.description = d.metadata.description || "";
    d.metadata.email_or_session = d.metadata.email_or_session || "";
    d.ago = timeText(d.created_at);
    d.tags = d.tags || [];
    /* postpone is a field, not a status. Parked = has postponed_until (plain waiting) OR a
       Jira wait (waiting_for_jira / jira_waiting_reply). A closed ticket is never "postponed". */
    d.postponed = (d.status !== "closed") && !!(d.postponed_until || d.waiting_for_jira || d.jira_waiting_reply);
    /* real linkage: jira_ticket_key (primary) + jira_ticket_keys (all). Feed jira_key
       (list chip + "Jira linked" filter) and jira_keys (context panel shows all). */
    d.jira_keys = (Array.isArray(d.jira_ticket_keys) && d.jira_ticket_keys.length)
      ? d.jira_ticket_keys
      : (d.jira_ticket_key ? [d.jira_ticket_key] : (d.jira_key ? [d.jira_key] : []));
    d.jira_key = d.jira_keys[0] || null;
    if (Array.isArray(d.messages_history)) d.messages_history = d.messages_history.map(mapMsg);
    // Last message for the sidebar (bug #7): prefer the denormalized field, then the loaded
    // transcript's last bubble, then the opener description.
    var lh = (Array.isArray(d.messages_history) && d.messages_history.length) ? d.messages_history[d.messages_history.length - 1] : null;
    if (!d.last_message) d.last_message = (lh && lh.content) || d.metadata.description || "";
    d.last_message_ts = d.last_message_ts || d.last_user_message_at || d.updated_at || d.last_activity || d.created_at;
    d.ts = d.last_message_ts;   // sidebar / Inbox recency = last message time (bug #7)
    d.messages_count = d.messages_count || (Array.isArray(d.messages_history) ? d.messages_history.length : 0);
    return d;
  }
  /* users_emails is per-platform email records; aggregate into "persons" (grouped by
     email, merging reddit/discord identities) so the directory, identity link and 360 work.
     Real records: {email, platform, url, reddit_username?, discord_user_id?, discord_username?}. */
  function buildUsers(recs) {
    var parent = {};
    function find(k) { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; }
    function join(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
    function keysOf(r) {
      var ks = [];
      var em = String(r.email || "").trim().toLowerCase();
      if (em) ks.push("e:" + em);
      if (r.reddit_username) ks.push("r:" + String(r.reddit_username).toLowerCase());
      if (r.discord_user_id) ks.push("d:" + String(r.discord_user_id));
      if (r.facebook_author) ks.push("f:" + String(r.facebook_author).trim().toLowerCase());
      if (r.telegram_user_id) ks.push("t:" + String(r.telegram_user_id));
      return ks;
    }
    var withKeys = recs.map(function (r, i) {
      var ks = keysOf(r); if (!ks.length) ks = ["x:" + i];
      ks.forEach(function (k) { if (!(k in parent)) parent[k] = k; });
      for (var j = 1; j < ks.length; j++) join(ks[0], ks[j]);
      return { r: r, k: ks[0] };
    });
    var by = {}, list = [];
    function push(arr, v) {   // names and emails differ only by case on Reddit/mail: keep one of each
      if (!v) return; var lv = String(v).toLowerCase();
      for (var i = 0; i < arr.length; i++) if (String(arr[i]).toLowerCase() === lv) return;
      arr.push(v);
    }
    withKeys.forEach(function (w) {
      var root = find(w.k), r = w.r, u = by[root];
      if (!u) {
        u = { id: root, reddits: [], discord_ids: [], discord_names: [], facebooks: [], emails: [], platforms: [], user_ids: [], telegram_ids: [],
              reddit: null, discord_id: null, discord_name: null, facebook: null, email: null, session: null, url: null };
        by[root] = u; list.push(u);
      }
      push(u.reddits, r.reddit_username);
      push(u.discord_ids, r.discord_user_id ? String(r.discord_user_id) : "");
      push(u.discord_names, r.discord_username);
      push(u.facebooks, r.facebook_author);
      push(u.emails, r.email);
      push(u.user_ids, r.cloud_user_id ? String(r.cloud_user_id) : "");
      push(u.telegram_ids, r.telegram_user_id ? String(r.telegram_user_id) : "");
      push(u.platforms, r.platform);
      if (!u.url && r.url) u.url = r.url;
    });
    list.forEach(function (u) {   // first value of each kind keeps the old single-value fields working
      u.reddit = u.reddits[0] || null; u.discord_id = u.discord_ids[0] || null; u.discord_name = u.discord_names[0] || null;
      u.facebook = u.facebooks[0] || null; u.email = u.emails[0] || null;
    });
    return list;
  }
  /* On-demand email lookup: the users_emails collection can be large and the bulk load is capped,
     so if a user's email is not already loaded we fetch it targeted by identifier and merge it in.
     Each key is fetched at most once. (fix: emails saved by the bot not showing in the panel) */
  var _emailFetched = {};
  function _mergeEmailRecs(recs) {
    if (!Array.isArray(recs) || !recs.length) return;
    /* The DB keeps ONE record per account (upsert on reddit_username / discord_user_id), so a fresh
       record for the same account REPLACES the one already loaded. Plain concat left the old email
       next to the corrected one until a full reload (duplicate "Email" rows in Identity). */
    var idOf = function (r) {
      if (r.reddit_username) return "r:" + String(r.reddit_username).toLowerCase();
      if (r.discord_user_id) return "d:" + String(r.discord_user_id);
      if (r.facebook_author) return "f:" + String(r.facebook_author).trim().toLowerCase();
      var rm = /reddit\.com\/u(?:ser)?\/([^\/?#\s]+)/i.exec(r.url || ""), dm = /discord(?:app)?\.com\/users\/(\d+)/i.exec(r.url || "");
      return rm ? "r:" + rm[1].toLowerCase() : (dm ? "d:" + dm[1] : "");
    };
    var fresh = {};
    recs.forEach(function (r) { var k = idOf(r); if (k) fresh[k] = true; });
    D._emailRecs = (D._emailRecs || []).filter(function (r) { var k = idOf(r); return !k || !fresh[k]; }).concat(recs);
    D.users = buildUsers(D._emailRecs);
    render();
  }
  /* After Add/Edit Email: update the local directory immediately (the one-time lookup cache would
     otherwise keep showing the old/no email until a full reload). */
  function ensureRedditEmail(handle) {
    if (!handle || userByReddit(handle)) return;
    var k = "r:" + handle; if (_emailFetched[k]) return; _emailFetched[k] = true;
    window.CONSOLE.get("/users-emails?reddit=" + encodeURIComponent(handle)).then(_mergeEmailRecs, function () {});
  }
  function ensureTelegramUser(tid) {
    if (!tid || userByTelegramId(tid)) return;
    var k = "t:" + tid; if (_emailFetched[k]) return; _emailFetched[k] = true;
    window.CONSOLE.get("/users-emails?telegram=" + encodeURIComponent(tid)).then(_mergeEmailRecs, function () {});
  }
  function ensureDiscordEmail(did) {
    if (!did || userByDiscordId(did)) return;
    var k = "d:" + did; if (_emailFetched[k]) return; _emailFetched[k] = true;
    window.CONSOLE.get("/users-emails?discord=" + encodeURIComponent(did)).then(_mergeEmailRecs, function () {});
  }
  function mapNote(n) {
    return { id: n.id, context_type: n.context_type, ref: n.ref, refLabel: n.refLabel,
      text: n.text, author: n.author, ago: timeText(n.created_at) || "now" };
  }
  function mapRedditMsg(m) {
    // console_author = the console operator who actually sent it (Reddit shows the shared bot account).
    return { id: m.id, author: m.author, is_internal: !!m.is_internal, ago: timeText(m.date), body: m.body || "",
             _byOperator: m.console_author || "" };
  }
  function mapRedditConvo(d) {
    return {
      id: d.convo_id, subject: d.subject || "(no subject)", participant: d.participant || "unknown",
      unread: false, ago: timeText(d.last_activity || d.last_updated), ts: d.last_activity || d.last_updated,   // real last message time
      last_author: d.last_public_author || null, mod_replied: d.mod_replied,   // list status hints (S3)
      msgs_count: (d.num_public_messages != null ? d.num_public_messages : (d.num_messages || (Array.isArray(d.messages) ? d.messages.length : 0))),   // public-only: internal [System] notes don't count as new (S6)
      _archived: String(d.state || "").toLowerCase() === "archived",   // Reddit archived -> Done
      override_status: d.override_status || "",                        // manual "in_progress"/"done"
      tags: [],
      preview: d.last_body || "",
      messages: Array.isArray(d.messages) ? d.messages.map(mapRedditMsg) : [],
      _msgsLoaded: Array.isArray(d.messages)   // list omits messages -> lazy-load on open
    };
  }
  /* Convos we've replied to are remembered server-side (item W3) so the LIST status stays correct
     ("Waiting on user", not "New") even before the bot snapshot's mod_replied catches up, and after
     a full reload. We only ever UPGRADE mod_replied to true - the mod did reply. */
  function applyConvoReplied() {
    var r = D.convoReplied || {};
    (D.redditModmail || []).forEach(function (c) { if (r[c.id]) c.mod_replied = true; });
  }
  /* Attach console-side post<->Jira links (item W4) onto posts so the context panel shows them. */
  function applyPostJira() {
    var m = D.postJira || {};
    (D.redditPosts || []).forEach(function (p) { var ks = m[p.id]; if (ks && ks.length) p.jira_keys = ks.slice(); });
  }
  /* Keep an optimistic reply we just sent visible until the backend snapshot actually reflects it.
     Otherwise a mid-flight refresh (list re-map or transcript re-fetch) overwrites our messages with a
     not-yet-updated copy and the reply flickers out until the ~5-min Reddit/Discord snapshot catches up
     (reported regression). Each optimistic message carries _local + _localAt; after any fetch we
     re-append it unless the fetched set already contains it (matched by body) or it has aged out. */
  var LOCAL_MSG_TTL = 12 * 60 * 1000;
  function _mergeLocal(fresh, prev, keyFn) {
    fresh = fresh || [];
    var have = {}; fresh.forEach(function (m) { have[keyFn(m)] = 1; });
    (prev || []).forEach(function (m) {
      if (!m || !m._local) return;
      if (m._localAt && Date.now() - m._localAt > LOCAL_MSG_TTL) return;   // snapshot should have it by now
      if (have[keyFn(m)]) return;                                          // backend now shows it -> drop optimistic copy
      fresh.push(m);
    });
    return fresh;
  }
  function _rKey(m) { return (m.is_internal ? "i:" : "u:") + String(m.body || "").trim(); }
  function _dKey(m) { return (m.note ? "n:" : "u:") + String(m.content || "").trim(); }
  function ensureRedditMessages(convo, force) {
    if (!convo || convo._msgsLoading || (!force && convo._msgsLoaded) || !convo.id) return;
    convo._msgsLoading = true;
    var prev = convo.messages || [];   // preserve just-sent optimistic replies across a re-fetch
    var prevSig = _openSig(prev);
    window.CONSOLE.get("/reddit-modmail/" + encodeURIComponent(convo.id)).then(function (d) {
      convo._msgsLoading = false; convo._msgsLoaded = true;
      convo.messages = _mergeLocal((d && Array.isArray(d.messages)) ? d.messages.map(mapRedditMsg) : [], prev, _rKey);
      if (!force) render(); else if (_openSig(convo.messages) !== prevSig) renderFresh();   // silent re-poll: render only when the transcript changed
    }, function () { convo._msgsLoading = false; convo._msgsLoaded = true; if (!force) render(); });
  }
  /* A Reddit username that belongs to our team: a team member's linked reddit_username (Identity). Used so a human mod's comment shows as OUR reply
     even when they forgot to click Reddit's "distinguish as moderator" shield. */
  function isTeamRedditName(name) {
    var n = String(name || "").trim().toLowerCase();
    if (!n || n === "automoderator" || n === "[deleted]") return false;
    var team = D.team || [];
    for (var j = 0; j < team.length; j++) {
      if (team[j].reddit_username && String(team[j].reddit_username).trim().toLowerCase() === n) return true;
    }
    return false;
  }
  function mapRedditComment(c) {
    var author = c.author || "[deleted]";
    return {
      author: author,
      op: !!c.is_submitter,
      team: !!c.team,                          // our/community reply (mod-distinguished, not AutoMod)
      mod: c.distinguished === "moderator" || isTeamRedditName(author),  // known team mod counts too
      ago: timeText(c.created),
      body: c.body || ""
    };
  }
  /* Map a post's comments, hiding AutoModerator (item T5). */
  function postComments(arr) {
    return (arr || []).filter(function (c) { return String(c.author || "") !== "AutoModerator"; }).map(mapRedditComment);
  }
  function mapRedditPost(d) {
    var hasComments = Array.isArray(d.comments);   // list omits comments -> lazy-load on open
    // First chat bubble = the post's own text; fall back to the title so title-only posts show it (T6).
    var thread = [{ author: d.author, op: true, ago: timeText(d.created), body: d.body || d.title || "" }];
    if (hasComments) thread = thread.concat(postComments(d.comments));
    return {
      id: d.post_id, subreddit: d.subreddit || "", title: d.title || "", author: d.author || "",
      ago: timeText(d.created), created: d.created, ts: d.last_comment_at || d.created,   // real activity: last comment, else post age
      needs_reply: !d.has_reply, has_reply: !!d.has_reply,
      last_reply_to_mod: d.last_user_reply_to_mod_at || null,   // W6: a user replied to OUR mod comment
      tags: [], url: d.url, num_comments: d.num_comments || 0, flair: d.flair || d.link_flair_text || "",
      body: d.body || "", images: Array.isArray(d.images) ? d.images : [],
      thread: thread, _commentsLoaded: hasComments
    };
  }
  function ensureRedditPostComments(post, force) {
    if (!post || post._commentsLoading || (!force && post._commentsLoaded) || !post.id) return;
    post._commentsLoading = true;
    var prevSig = _openSig(post.thread);
    window.CONSOLE.get("/reddit-posts/" + encodeURIComponent(post.id)).then(function (d) {
      post._commentsLoading = false; post._commentsLoaded = true;
      post.thread = [{ author: post.author, op: true, ago: post.ago, body: (d && d.body) || post.body || post.title || "" }]
        .concat((d && Array.isArray(d.comments)) ? postComments(d.comments) : []);
      if (d && typeof d.has_reply !== "undefined") { post.has_reply = !!d.has_reply; post.needs_reply = !d.has_reply; }
      if (d && Array.isArray(d.images)) post.images = d.images;
      if (!force) render(); else if (_openSig(post.thread) !== prevSig) renderFresh();
    }, function () { post._commentsLoading = false; post._commentsLoaded = true; if (!force) render(); });
  }
  /* Real jira_tickets are thin {issue_key, summary, status, url, status_since}; comments/
     L1-tags/reporter come from the Jira REST API (needs creds - not wired). communication_link
     lives on jira_tracked_users. Map status -> the view's category buckets. */
  function jiraCategory(status) {
    var s = String(status || "").toLowerCase();
    if (/(done|closed|resolved|complete|cancel|ready)/.test(s)) return "done";
    if (/(progress|review|dev|testing|qa|investigat)/.test(s)) return "indeterminate";
    return "new";
  }
  /* Which social a Jira ticket is tied to, from its communication link (used to group/filter the
     Jira list by social network). "other" = a link that isn't one of our socials; "none" = no link. */
  var COMM_PLATFORM_META = {
    reddit: { label: "Reddit", icon: "posts" }, facebook: { label: "Facebook", icon: "facebook" },
    discord: { label: "Discord", icon: "discord" }, other: { label: "Other link", icon: "link" }, none: { label: "No link", icon: "link" }
  };
  /* Second team-ticket rule: reporter is one of our registered Jira accounts. Needs the
     bot to store `reporter`/`reporter_id` on jira_tickets AND the admin-managed list
     D.ourJiraUsers (future admin panel + Mongo) - inert until both exist. */
  /* Apply shared tag docs [{context_type, ref, tag}] onto their objects (ticket/convo/post). */
  function applyTags(tagDocs) {
    (tagDocs || []).forEach(function (d) {
      var arr = tagsArrFor(d.context_type, d.ref);
      if (arr && arr.indexOf(d.tag) < 0) arr.push(d.tag);
    });
  }
  function setJira(issues) {
    D.jira = (issues || []).map(function (x) {
      return { issue_key: x.issue_key, summary: cleanJiraSummary(x.summary), status: x.status,
        category: jiraCategory(x.status), url: x.url, communication_link: x.communication_link,
        reporter: x.reporter, reporter_id: x.reporter_id, l1_tags: [], comments: [], status_since: x.status_since || null,
        cm_awaiting_reply: x.cm_awaiting_reply };
    });
  }
  var jiraSyncing = false;
  /* On demand: pull the ticket list from Jira into our local cache, then refresh the view. */
  function jiraSync(silent) {
    if (jiraSyncing) return;
    jiraSyncing = true; if (!silent) render();
    window.CONSOLE.post("/jira-sync", {}).then(function (d) {
      jiraSyncing = false;
      if (d && Array.isArray(d.issues)) setJira(d.issues);
      if (d && d.synced_at) state.jiraSyncedAt = d.synced_at;
      render(); if (!silent) toast("Synced " + ((d && d.synced) || 0) + " Jira tickets");
    }, function () { jiraSyncing = false; render(); if (!silent) toast("Jira sync failed"); });
  }
  /* Global busy indicator: a top progress bar shows whenever a server action is in flight, so nothing
     ever looks "AFK". Reference-counted (many actions can overlap). */
  function busyInc() { state.busyN = (state.busyN || 0) + 1; var b = q("#busy-bar"); if (b) b.classList.add("on"); }
  function busyDec() { state.busyN = Math.max(0, (state.busyN || 0) - 1); if (!state.busyN) { var b = q("#busy-bar"); if (b) b.classList.remove("on"); } }
  /* Enqueue an action for the bot worker and poll until it finishes. */
  function enqueueAction(type, payload, onDone, onFail) {
    busyInc();
    window.CONSOLE.post("/actions", { type: type, payload: payload || {} }).then(function (a) {
      if (!a || !a.id) { busyDec(); if (onFail) onFail(); else toast("Enqueue failed"); return; }
      pollAction(a.id, onDone, 0);
    }, function () { busyDec(); if (onFail) onFail(); else toast("Enqueue failed"); });
  }
  /* A reply that did not go out: drop the optimistic bubble and give the text back to the composer. */
  function sendFailed(refType, ref, text, err) {
    var key = (refType === "convo" ? "modmail/" : "discord/") + ref;
    state.drafts = state.drafts || {};
    if (!state.drafts[key]) state.drafts[key] = text;
    if (refType === "convo") { var c = convoById(ref); if (c) c.messages = (c.messages || []).filter(function (m) { return !(m._local && m.body === text); }); }
    else { var t = ticketByKey(ref); if (t) t.messages_history = (t.messages_history || []).filter(function (m) { return !(m._local && m.content === text); }); }
    render();
    toast("Not sent: " + (err || "unknown error") + ". Your text is back in the reply box.");
  }
  function pollAction(id, onDone, tries) {
    window.CONSOLE.get("/actions/" + id).then(function (a) {
      if (a && (a.status === "done" || a.status === "error")) {
        busyDec();
        if (onDone) onDone(a);
        else toast(a.status === "done" ? "Done" : "Failed: " + (a.error || ""));
        return;
      }
      if (tries < 30) setTimeout(function () { pollAction(id, onDone, tries + 1); }, 1500);
      else { busyDec(); toast("Still working. Press Sync in a moment to see the result"); }
    }, function () { busyDec(); toast("Status check failed"); });
  }
  /* Recent bot-worker actions (audit log) for the admin panel. */
  function loadBotActions() {
    var b = state.botActions;
    if (b.loading) return;
    b.loading = true;
    window.CONSOLE.get("/actions").then(function (list) {
      b.loading = false; b.loaded = true; b.items = Array.isArray(list) ? list : []; render();
    }, function () { b.loading = false; b.loaded = true; render(); });
  }
  /* Re-pull the Known Issues mirror after an admin "Sync now" (or add). */
  function refreshKnown() {
    window.CONSOLE.get("/known-issues").then(function (d) {
      if (d && d.categories) { D.knownIssues = d.categories; state.shotsEnabled = !!d.shots_enabled; if (d.synced_at) state.knownSyncedAt = d.synced_at; render(); }
    }, function () {});
    ensureGameList(true);   // a game's FIRST/last issue changes which games have an ID badge -> re-pull the map
  }
  /* Load the Game-List ID map + config in the BACKGROUND (not part of first paint). Only the Known
     Issues tab (game-ID badges) and the admin panel need them, so keeping them out of hydrate speeds up
     "Loading your workspace". Idempotent; retries on the Known Issues view if it hasn't loaded. */
  function ensureGameList(force) {
    if ((state._gameListReq && !force)) return;
    state._gameListReq = true;
    window.CONSOLE.get("/game-list").then(function (d) {
      if (d && d.by_title && typeof d.by_title === "object") { D.gameList = d.by_title; render(); }
    }, function () { state._gameListReq = false; });
    window.CONSOLE.get("/game-list-config").then(function (d) {
      if (d && typeof d === "object" && !Array.isArray(d)) D.gameListConfig = d;
    }, function () {});
  }
  /* Populate D.* from the API. A slow or failed fetch shows a clean empty state (the loader covers the
     first paint). */
  /* Start-up order: one /poll FIRST records the version of every live list, THEN the lists are read.
     Without that seed the first background poll saw "everything changed" and re-downloaded ~30 lists the
     console had just loaded, on every page open. Because the seed is taken before the reads, a change that
     lands during start-up still shows up as a new version on the next poll. The /poll also warms the
     server's shared list cache, so the reads that follow come back faster. */
  /* Start-up: every list loads at once, in parallel. The version map the background /poll compares
     against is seeded from the ETag of each list we just received (key -> path from /poll-keys), so the
     first load never waits for /poll - on a cold server cache /poll builds all ~30 lists one after
     another (13 s measured on prod). A list without a known ETag is simply refetched by the first poll. */
  function hydrateLive() {
    state.loadingData = true;
    state._pollSeeded = false;
    _resetLiveLists();
    var keysP = window.CONSOLE.get("/poll-keys").then(function (d) { return (d && d.p) || {}; }, function () { return {}; });
    function seed() {
      return keysP.then(function (keys) {
        var pv = state._pollV = state._pollV || {}, et = window.CONSOLE.etags || {};
        Object.keys(keys).forEach(function (k) { if (et[keys[k]]) pv[k] = et[keys[k]]; });
        state._pollSeeded = true;   // even after a failed load: the poll then refetches what is missing
      });
    }
    return _hydrateLiveLists().then(seed, seed);
  }
  /* A start-up fetch failed (server restarting, timeout): forget its /poll version so the next poll
     re-fetches it. Otherwise the poll thinks it is current and the list stays empty until it changes. */
  function _hydrateMiss(key) { if (state._pollV) delete state._pollV[key]; }
  function _resetLiveLists() {
    ["redditModmail", "redditPosts", "discordTickets", "discordForum", "discordMentions",
     "telegramMessages", "jira", "notes", "activity", "feedback", "handoffs", "reports",
     "maintenances", "maintenanceSubs", "events", "bans", "fbPosts", "fbDms", "channelContacts", "users", "team", "roster"].forEach(function (k) { D[k] = []; });
    D.presence = {}; D.knownIssues = {}; D.knownSuggestions = []; D.gameList = {}; D.schedule = { months: [] }; D.gameCards = { weeks: [], image_keys: [] };
    D.leaveRequests = []; D.leaveAll = []; D.leaveConfig = {};
    state.gcLoading = true;   // Game Cards loads in the background: say Loading, not "No weeks yet"
  }
  function _hydrateLiveLists() {
    state.loadingData = true;   // until the lists below land, empty views say Loading, not Empty
    _resetLiveLists();
    var pendingTags = [];
    var ignoredPosts = [];
    var convoOverrides = {}, convoOverridesAt = {};
    // Stage the display lists and swap them into D.* atomically at the end (same reason as refreshLive):
    // a render firing mid-hydration (e.g. the jira-cache one) must not see a RAW list before the
    // replied/override/ignored overlays are applied, or statuses flash New/Needs-review on reload.
    var _hModmail, _hPosts, _hComments, _hTickets, _hTg, _hMentions, _hForum;
    // Speed: only the lists the first screen needs gate the first render. The rest (directories, configs,
    // sheets, reports...) still start now, in parallel, but render on their own when they arrive, so a
    // slow one (e.g. a large directory) does not hold the whole console on "Loading your workspace".
    var bgTasks = [];
    function bg(p) { bgTasks.push(p.then(function () {}, function () {})); return Promise.resolve(); }
    // Jira list comes from our local cache (fast, no live scan). Details load per-ticket on open;
    // refresh the cache with the Sync button. Empty cache on first run -> pull from Jira once.
    window.CONSOLE.get("/jira-cache").then(function (d) {
      if (!d || !Array.isArray(d.issues)) return;
      setJira(d.issues);
      if (d.synced_at) state.jiraSyncedAt = d.synced_at;
      if (!d.issues.length) jiraSync(true);
      else render();
    }, function () { /* failed: the list stays empty */ });
    var tasks = [
      // Forwarded / dismissed Jira markers must be in BEFORE the first paint, or the To-Do briefly shows
      // tickets that were already handled and then drops them (reported flash on load).
      window.CONSOLE.get("/jira-handled").then(function (m) { if (m && typeof m === "object" && !Array.isArray(m)) D.jiraHandled = m; }, function () {}),
      window.CONSOLE.get("/jira-dismissed").then(function (m) { if (m && typeof m === "object" && !Array.isArray(m)) D.jiraDismissed = m; }, function () {}),
      bg(window.CONSOLE.get("/jira-l1-todo").then(function (l) { if (Array.isArray(l)) D.jiraL1 = l; }, function () {})),
      // Only ACTIVE tickets up front (bounded); the closed archive is paged on demand.
      window.CONSOLE.get("/discord-tickets?status=active&limit=3000").then(function (list) {
        if (Array.isArray(list)) _hTickets = list.map(mapDiscordTicket);
      }, function () { /* failed: the list stays empty */ }),
      window.CONSOLE.get("/discord-forum").then(function (list) {
        if (Array.isArray(list)) _hForum = list.map(mapForum);
      }, function () { }),
      window.CONSOLE.get("/forum-status").then(function (m) {
        if (m && typeof m === "object" && !Array.isArray(m)) D.forumStatus = m;   // console Replied/Ignored triage
      }, function () { }),
      window.CONSOLE.get("/discord-mentions").then(function (list) {
        if (Array.isArray(list)) _hMentions = list.map(mapMention);
      }, function () { }),
      window.CONSOLE.get("/telegram-messages").then(function (list) {
        if (Array.isArray(list)) _hTg = list.map(mapTgMsg);
      }, function () { }),
      window.CONSOLE.get("/maintenances").then(function (list) {
        // Flat array of {entity, type, started_at, eta} - feeds both the Add Maintenance entity picker
        // (reads entity/type) and the Maintenance tab's live "running for" timer (started_at).
        if (Array.isArray(list)) D.maintenances = list;
      }, function () { /* failed: the list stays empty */ }),
      window.CONSOLE.get("/maintenance-subs").then(function (list) {
        if (Array.isArray(list)) D.maintenanceSubs = list.map(function (s) {
          return { entity: s.entity, type: s.type, language: s.language, target_type: s.target_type,
                   target_id: s.target_id, reddit_user: s.reddit_user,
                   convo_id: s.reddit_convo_id || (s.target_type === "reddit" ? s.target_id : null) };
        });
      }, function () { /* failed: the list stays empty */ }),
      bg(window.CONSOLE.get("/users-emails").then(function (recs) {
        if (Array.isArray(recs)) { D._emailRecs = recs.slice(); D.users = buildUsers(recs); }
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/notes").then(function (list) {
        if (Array.isArray(list)) D.notes = list.map(mapNote);   // shared, team-wide
      }, function () { /* failed: the list stays empty */ })),
      window.CONSOLE.get("/tags").then(function (list) {
        pendingTags = Array.isArray(list) ? list : [];
      }, function () { _hydrateMiss("tags"); }),
      window.CONSOLE.get("/users").then(function (list) {
        if (Array.isArray(list)) D.team = list;   // real console_users (admins only)
      }, function () { /* failed: the list stays empty */ }),
      bg(window.CONSOLE.get("/presence").then(function (list) {
        if (Array.isArray(list)) { var m = {}; list.forEach(function (p) { if (p.email) m[String(p.email).toLowerCase()] = p.at; }); D.presence = m; }
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/team-roster").then(function (list) {
        if (Array.isArray(list)) D.roster = list;   // full team roster for the home "Team" tab (all users)
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/known-issues").then(function (d) {
        if (d && d.categories) { D.knownIssues = d.categories; state.shotsEnabled = !!d.shots_enabled; if (d.synced_at) state.knownSyncedAt = d.synced_at; }   // Google-Sheet mirror
      }, function () { /* failed: the list stays empty */ })),
      // /game-list + /game-list-config are only needed on the Known Issues tab (game-ID badges) and the
      // admin panel, so they are NOT in this first-paint burst - loaded in the background by
      // ensureGameList() right after hydrate, keeping "Loading your workspace" off their latency.
      bg(window.CONSOLE.get("/schedule").then(function (d) {
        if (d && Array.isArray(d.months)) { D.schedule = { months: d.months }; if (d.synced_at) state.scheduleSyncedAt = d.synced_at; }   // team schedule mirror
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/leave-config").then(function (d) {
        if (d && typeof d === "object" && !Array.isArray(d)) D.leaveConfig = d;
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/leave-requests").then(function (list) {
        if (Array.isArray(list)) D.leaveRequests = list;   // this user's own requests
      }, function () { /* failed: the list stays empty */ })),
      (isAdmin() ? window.CONSOLE.get("/leave-requests?all=1").then(function (list) {
        if (Array.isArray(list)) D.leaveAll = list;   // admin: everyone's requests (approvals + history)
      }, function () {}) : Promise.resolve()),
      bg(window.CONSOLE.get("/game-cards").then(function (d) {
        state.gcLoading = false;
        if (d && Array.isArray(d.weeks)) { D.gameCards = { weeks: d.weeks, image_keys: d.image_keys || [], meta: d.meta || {}, suggestions: d.suggestions || [] }; if (d.synced_at) state.gcSyncedAt = d.synced_at; }
      }, function () { state.gcLoading = false; })),
      bg(window.CONSOLE.get("/game-testing").then(function (d) {
        if (d && Array.isArray(d.tabs)) D.gameTesting = d;
      }, function () {})),
      bg(window.CONSOLE.get("/game-testing-config").then(function (d) {
        if (d && typeof d === "object" && !Array.isArray(d)) D.gameTestingConfig = d;
      }, function () {})),
      bg(window.CONSOLE.get("/game-cards-config").then(function (d) {
        if (d && typeof d === "object" && !Array.isArray(d)) D.gameCardsConfig = d;
      }, function () { /* failed: the list stays empty */ })),
      window.CONSOLE.get("/convo-status").then(function (d) {
        if (d && d.overrides) convoOverrides = d.overrides;   // convo_id -> "in_progress"/"done"
        if (d && d.overrides_at) convoOverridesAt = d.overrides_at;   // when each override was set 
      }, function () { _hydrateMiss("cstatus"); }),
      window.CONSOLE.get("/history-cutoff").then(function (d) {
        var c = d && d.cutoff && _utcDate(d.cutoff);
        if (c) state.historyCutoff = c.getTime();             // move-all-to-History cutoff (R3)
      }, function () { /* failed: the list stays empty */ }),
      bg(window.CONSOLE.get("/fb-group-check").then(function (d) {   // FB group last-checked (item W7)
        if (d) state.fbGroupCheck = { by: d.by || "", at: d.at || "" };
      }, function () { /* failed: the list stays empty */ })),
      window.CONSOLE.get("/app-config").then(function (d) {
        if (d && d.discord_guild_id) state.discordGuildId = String(d.discord_guild_id);
        if (d && d.facebook_group_url) state.fbGroupUrl = String(d.facebook_group_url);
      }, function () { /* failed: the list stays empty */ }),
      window.CONSOLE.get("/reads").then(function (d) {
        if (d && d.reads) D.reads = d.reads;                  // shared Inbox read state (S6)
      }, function () { /* failed: the list stays empty */ }),
      window.CONSOLE.get("/reddit-status").then(function (d) { if (d && typeof d === "object") D.redditStatus = d; }, function () {}),
      bg(window.CONSOLE.get("/fb-notes").then(function (list) {
        if (Array.isArray(list)) D.channelContacts = list;    // Facebook Notes (T8)
      }, function () { /* failed: the list stays empty */ })),
      window.CONSOLE.get("/reddit-modmail").then(function (list) {
        if (Array.isArray(list) && list.length) _hModmail = list.map(mapRedditConvo);
      }, function () { /* failed: the list stays empty */ }),
      window.CONSOLE.get("/reddit-mod-notes").then(function (list) {
        if (Array.isArray(list)) {   // reddit_mod_notes docs -> object keyed by reddit_user
          var byUser = {};
          list.forEach(function (d) {
            if (!d || !d.reddit_user) return;
            d.jira_convos = d.jira_convos || {};
            d.highlighted_convos = d.highlighted_convos || [];
            byUser[d.reddit_user] = d;
          });
          D.modNotes = byUser;
        }
      }, function () { /* failed: the list stays empty */ }),
      window.CONSOLE.get("/reddit-posts").then(function (list) {
        if (Array.isArray(list) && list.length) _hPosts = list.map(mapRedditPost);
      }, function () { /* failed: the list stays empty */ }),
      bg(window.CONSOLE.get("/reddit-comments").then(function (list) {
        if (Array.isArray(list)) _hComments = list;
      }, function () { /* failed: the list stays empty */ })),
      window.CONSOLE.get("/post-flags").then(function (d) {
        if (d && Array.isArray(d.ignored)) ignoredPosts = d.ignored;
        if (d && d.meta) state._ignoreMeta = d.meta;   // per-post {reason, by} for the "Ignored by" caption
      }, function () { _hydrateMiss("flags"); }),
      window.CONSOLE.get("/convo-replied").then(function (d) {   // convos we've replied to (item W3)
        if (d && Array.isArray(d.convos)) { D.convoReplied = {}; d.convos.forEach(function (id) { D.convoReplied[id] = 1; }); }
      }, function () { /* failed: the list stays empty */ }),
      bg(window.CONSOLE.get("/jira-user-link").then(function (d) { if (d && d.links) D.userJira = d.links; }, function () {})),
      bg(window.CONSOLE.get("/post-jira-link").then(function (d) {   // post <-> Jira links (item W4)
        if (d && d.links) D.postJira = d.links;
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/reports?all=1").then(function (list) {
        if (Array.isArray(list)) D.reports = list;   // admin -> all; member -> own
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/templates").then(function (list) {
        if (Array.isArray(list)) D.templates = list;   // server is authoritative live (even if empty)
      }, function () {})),
      bg(window.CONSOLE.get("/variables").then(function (d) {
        if (d && Array.isArray(d.variables) && d.variables.length) D.variables = d.variables;   // else the defaults in config.js
      }, function () {})),
      window.CONSOLE.get("/handoffs").then(function (list) {
        if (Array.isArray(list)) D.handoffs = list.map(mapHandoff);
      }, function () { /* failed: the list stays empty */ }),
      bg(window.CONSOLE.get("/activity").then(function (list) {   // real team action feed (item W9)
        if (Array.isArray(list)) D.activity = list.map(mapActivity);
      }, function () { /* failed: the list stays empty */ })),
      bg(window.CONSOLE.get("/feedback").then(function (list) {   // in-app feedback (item Y)
        if (Array.isArray(list)) D.feedback = list.map(mapFeedback);
      }, function () { /* failed: the list stays empty */ })),
      bg(loadEvents()),
      bg(loadBans()),
      bg(loadFb())
    ];
    return Promise.all(tasks).then(function () {
      // Publish the fetched lists atomically, THEN overlay + render (see the staging note above).
      if (_hModmail) D.redditModmail = _hModmail;
      if (_hPosts) D.redditPosts = _hPosts;
      if (_hComments) D.redditComments = _hComments;
      if (_hTickets) D.discordTickets = _hTickets;
      if (_hTg) D.telegramMessages = _hTg;
      if (_hMentions) D.discordMentions = _hMentions;
      if (_hForum) D.discordForum = _hForum;
      applyTags(pendingTags);   // tags depend on tickets being loaded first
      // Seed the overlay state the partial refresh re-applies on every rebuilt list (see _refreshLive).
      state._tags = pendingTags; state._ignored = ignoredPosts.slice();
      state._overrides = Object.assign({}, convoOverrides); state._overridesAt = Object.assign({}, convoOverridesAt);
      if (ignoredPosts.length) {
        var iset = {}; ignoredPosts.forEach(function (pid) { iset[pid] = true; });
        D.redditPosts.forEach(function (p) { if (iset[p.id]) { p.ignored = true; applyIgnoreMeta(p); } });
      }
      // Apply persisted ModMail status overrides - Reddit convos + Discord tickets.
      D.redditModmail.forEach(function (c) { if (convoOverrides[c.id]) { c.override_status = convoOverrides[c.id]; c._override_at = convoOverridesAt[c.id] || ""; } });
      D.discordTickets.forEach(function (t) { if (convoOverrides[tid(t)]) { t.override_status = convoOverrides[tid(t)]; t._override_at = convoOverridesAt[tid(t)] || ""; } });
      consumeStaleOverrides();   // user wrote after a manual status -> reopen (event-based)
      // "Our Jira accounts" come from each member's linked Jira account id. Empty -> the reporter
      // filter matches nothing extra; the bot keeps its .env fallback.
      var jids = (D.team || []).map(function (m) { return m.jira_account_id; }).filter(Boolean);
      if (jids.length) D.ourJiraUsers = jids;
      applyConvoReplied();   // keep replied convos out of "New" (item W3)
      applyPostJira();       // show post<->Jira links (item W4)
      state.hydrating = false;   // first live load done -> real views (no more loader / mock)
      state.loadingData = false;
      if (!state._pendingRestored) { state._pendingRestored = true; restorePending(); }
      render();
      // A list that failed on a slow start stays blank until the next 30s refresh: re-pull it right away.
      if (!D.redditModmail.length || !D.redditPosts.length || !D.discordTickets.length) setTimeout(refreshLive, 3000);
      showHandoffPopup();   // now that real /handoffs are loaded, surface any left for me / the next shift
      sendPresence();       // announce we're at the console now (agents tab presence)
      startAutoRefresh();   // begin periodic refresh once the first load is in (item S3)
      loadNotifyFeed();     // fill the bell notification center + its unread dot
      loadTodoData(true);   // URG-in-Review + forwarded markers for the To-Do Activity pane (first load)
      ensureGameList();     // game-ID map in the background (not part of first paint)
      Promise.all(bgTasks).then(function () {
        if (_hComments) D.redditComments = _hComments;   // background list landed after the first paint
        if (D.users && D.users.length) consumeStaleOverrides();
        render();
      });
    });
  }
  /* Auto-refresh (item S3): periodically re-pull the dynamic lists so new messages/posts/statuses
     appear without a manual reload. Skips while the user is typing, has a modal/palette open, or has
     a pending send; preserves the open item's already-loaded messages so nothing flickers. */
  var AUTO_REFRESH_MS = 30000;      // presence / bell / To-Do side data
  var POLL_MS = 8000;               // "what changed?" check while the tab is visible
  var POLL_HIDDEN_MS = 60000;       // same check for a hidden tab
  /* The caret is in a field INSIDE the view (composer, inline note, status dropdown). A field outside
     it (topbar search, feedback box, a modeless popover) is not touched by a re-render and never counts. */
  function _typing() {
    var ae = document.activeElement, root = q("#view-root");
    return !!(ae && root && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && root.contains(ae));
  }
  /* A blocking modal / palette / pending send: nothing behind it is re-rendered until it is gone. */
  function _blocked() {
    return !!((state.modal && !state.modeless) || (state.cmdk && state.cmdk.open) || state.pendingSends.length);
  }
  function _busy() { return _typing() || _blocked(); }
  /* New data arrived: full re-render when free, panes-only (render(true)) while the operator is typing,
     nothing while blocked. Whatever was held back is finished on the next focusout / full render. */
  function renderFresh() {
    if (_blocked()) { state._dirty = true; return; }
    if (_typing()) { state._dirty = true; render(true); return; }
    render();
  }
  document.addEventListener("focusout", function () {
    setTimeout(function () { if (state._refreshSig && !_busy() && (state._dirty || visibleSignature() !== state._refreshSig)) render(); }, 0);
  });
  /* Session ended while the console is open (expired cookie, server restart without a fixed secret):
     show the sign-in screen instead of silently keeping stale data on screen. */
  window.addEventListener("console:unauthorized", function () {
    if (!state.user) return;
    state.user = null;
    if (state._autoRefresh) { clearInterval(state._autoRefresh); state._autoRefresh = null; }
    renderLogin(); toast("Your session ended. Sign in again", "error");
  });
  function startAutoRefresh() {
    if (state._autoRefresh) return;
    // One small /poll request every POLL_MS says which lists changed; only those are re-fetched. A
    // hidden tab (console parked on a second monitor) polls once a minute. Presence, the bell and the
    // To-Do side data keep their own 30s cadence while the tab is visible.
    state._autoRefresh = setInterval(function () {
      var now = Date.now();
      if (document.hidden && now - (state._lastPoll || 0) < POLL_HIDDEN_MS) return;
      state._lastPoll = now;
      pollLive();
      if (!document.hidden && now - (state._lastSide || 0) >= AUTO_REFRESH_MS) {
        state._lastSide = now;
        sendPresence(); loadNotifyFeed(); loadTodoData(); refreshSideViews();
      }
    }, POLL_MS);
    // Event-driven top-up: refresh the moment the operator returns to the tab (switching back from
    // Discord/Slack), so they don't wait out the timer to see what changed.
    if (!state._focusRefresh) {
      state._focusRefresh = true;
      var onBack = function () { if (!document.hidden) { state._lastPoll = Date.now(); pollLive(); } };
      window.addEventListener("focus", onBack);
      document.addEventListener("visibilitychange", onBack);
    }
    // Live "running for" timers on the Maintenance tab tick every second, in place (no re-render).
    if (!state._mntTimer) state._mntTimer = setInterval(updateMaintenanceTimers, 1000);
    if (!state._gtTimer) state._gtTimer = setInterval(function () { if (!document.hidden && parseHash().view === "testing") refreshGameTesting(); }, 20000);
  }
  /* Lists the bot writes that are not in the /poll live lane (Mattermost events, the ban channel, the
     Facebook extension). Events and Bans refresh while their page is open, Facebook always (its count is
     in the menu). At most once a minute each, and only when the data really changed is anything redrawn. */
  var SIDE_VIEW_MS = 60000;
  function refreshSideViews() {
    var v = parseHash().view, now = Date.now();
    function after(p, sig) {
      var before = sig();
      p.then(function () { if (sig() !== before) renderFresh(); }, function () {});
    }
    if (v === "events" && now - (state._eventsAt || 0) >= SIDE_VIEW_MS) after(loadEvents(), function () { return JSON.stringify(D.events || []); });
    if (v === "bans" && now - (state._bansAt || 0) >= SIDE_VIEW_MS) after(loadBans(), function () { return JSON.stringify(D.bans || []); });
    if (now - (state._fbAt || 0) >= SIDE_VIEW_MS) after(loadFb(), function () { return JSON.stringify([D.fbPosts || [], D.fbDms || [], D.fbHeartbeat || ""]); });
  }
  /* A stable, time-independent fingerprint of everything the current views render from. If it hasn't
     changed after a refresh, we skip the whole re-render - that is what stops the page from visibly
     "reloading" and jumping every 45s. Deliberately excludes relative timestamps so "2m ago" ticking
     over doesn't force a rebuild. */
  function visibleSignature() {
    var p = [];
    (D.redditModmail || []).forEach(function (c) {
      p.push(c.id + ":" + deriveRedditStatus(c) + ":" + (c.mod_replied ? 1 : 0) + ":" + (c.last_author || "") + ":" + (c.ts || "") + ":" + ((c.tags || []).length));
    });
    (D.redditPosts || []).forEach(function (x) {
      p.push(x.id + ":" + (x.ts || "") + ":" + (x.ignored ? 1 : 0) + ":" + (x.has_reply ? 1 : 0) + ":" + (x.num_comments || 0) + ":" + ((x.jira_keys || []).length) + ":" + ((x.tags || []).length));
    });
    (D.discordTickets || []).forEach(function (t) {
      p.push(tid(t) + ":" + deriveDiscordStatus(t) + ":" + (t.messages_count || 0) + ":" + (t.jira_key || "") + ":" + (t.last_message_ts || "") + ":" + ((t.tags || []).length));
    });
    (D.telegramMessages || []).forEach(function (m) { p.push("tg" + m.id + ":" + (m.answered ? 1 : 0) + ":" + ((m.tags || []).length) + ":" + (m.reply ? 1 : 0) + ":" + (m.ignored ? 1 : 0)); });
    (D.discordMentions || []).forEach(function (m) { p.push("dm" + m.id + ":" + (m.status || "new") + ":" + ((m.tags || []).length)); });
    (D.discordForum || []).forEach(function (f) { p.push("df" + f.id + ":" + ((f.messages || []).length) + ":" + ((f.consoleTags || []).length) + ":" + forumStatus(f)); });
    p.push("rs" + (redditDown() ? 1 : 0));
    p.push("ac" + ((D.activity || []).length) + "fb" + ((D.feedback || []).length) + "rd" + Object.keys(D.reads || {}).length + "rc" + ((D.redditComments || []).length));
    (D.maintenances || []).forEach(function (m) { p.push("mn" + (m.entity || "") + ":" + (m.type || "") + ":" + (m.eta || "") + ":" + (m.started_at || "")); });
    (D.jira || []).forEach(function (j) { p.push("jr" + j.issue_key + ":" + (j.status || "") + ":" + (j.status_since || "")); });
    Object.keys(D.jiraHandled || {}).forEach(function (k) { p.push("jh" + k + ":" + D.jiraHandled[k]); });   // Slack->console handled sync
    return p.join("|");
  }
  /* Coarse marker for just the open item, so we only re-pull its (heavier) transcript when the list
     signals real new activity, not on every timer tick. */
  /* Ask the server which lists changed since we last fetched them and pull only those. Falls back to
     a full refresh (at the old 30s pace) if /poll is unavailable. */
  function pollLive() {
    if (state._polling || state._refreshing || !state._pollSeeded) return;   // not before the first load seeded the map
    state._polling = true;
    var fin = function () { state._polling = false; };
    window.CONSOLE.get("/poll").then(function (d) {
      var v = (d && d.v) || {}, cur = state._pollV || (state._pollV = {}), changed = {}, n = 0;
      Object.keys(v).forEach(function (k) { if (cur[k] !== v[k]) { changed[k] = v[k]; n++; } });
      state._pollTick = (state._pollTick || 0) + 1;
      if (!n) { if (state._pollTick % 4 === 0) refreshOpenItem(); return; }   // quiet: still re-check the open chat every ~30s
      return refreshLive(changed);
    }, function () {
      state._pollFail = (state._pollFail || 0) + 1;
      if (state._pollFail % 4 === 1) return refreshLive();
    }).then(fin, fin);
  }
  /* refreshLive() re-fetches everything; refreshLive({key: etag}) only the lists named in the map. */
  function refreshLive(changed) {
    // One refresh at a time: focus + visibility + the timer can all fire at once, which would triple the
    // requests and let an older response land after a newer one.
    if (state._refreshing) return state._refreshing;
    var p = _refreshLive(changed);
    state._refreshing = p;
    var clear = function () { state._refreshing = null; };
    p.then(clear, clear);
    return p;
  }
  function _refreshLive(changed) {
    var tasks = [];
    var side = false;   // a list outside visibleSignature() changed -> re-render regardless of the signature
    // G(key, path): fetch a list unless this is a partial refresh that doesn't include it. The etag
    // /poll reported is remembered once the fetch succeeds, so a failed fetch is retried next poll.
    var pv = state._pollV || (state._pollV = {});
    function G(key, path) {
      if (changed && !changed[key]) return Promise.reject("unchanged");
      return window.CONSOLE.get(path).then(function (d) { if (changed && changed[key]) pv[key] = changed[key]; return d; });
    }
    // Index the current lists once so the per-row lookups below do not scan the whole list each time.
    var _cById = {}, _pById = {}, _tgById = {}, _mnById = {};
    (D.redditModmail || []).forEach(function (c) { _cById[c.id] = c; });
    (D.redditPosts || []).forEach(function (x) { _pById[x.id] = x; });
    (D.telegramMessages || []).forEach(function (m) { _tgById[m.id] = m; });
    (D.discordMentions || []).forEach(function (m) { _mnById[m.id] = m; });
    // Stage every DISPLAY list in a local and swap them into D.* atomically at the end (see the
    // Promise.all below). Assigning D.* mid-flight would briefly expose the RAW snapshot - before the
    // console-side overlays (replied / override / ignored) are applied - so any render firing in that
    // window flashed the wrong "New / Needs review" status, then corrected it a tick later (the
    // "phantom unread" flicker). Keeping D.* on the previous, fully-overlaid data until the swap fixes it.
    var _modmail, _posts, _comments, _tickets, _tg, _mentions, _forum;
    tasks.push(G("modmail", "/reddit-modmail").then(function (list) {
      if (Array.isArray(list)) _modmail = list.map(mapRedditConvo).map(function (c) {
        var old = _cById[c.id];
        if (old) {
          if (old._msgsLoaded && !c._msgsLoaded) { c.messages = old.messages; c._msgsLoaded = true; }
          else if (c._msgsLoaded) { c.messages = _mergeLocal(c.messages, old.messages, _rKey); }   // keep just-sent reply visible
          // Don't let a stale snapshot downgrade a reply we know happened (item W3).
          if (old.mod_replied && !c.mod_replied) { c.mod_replied = true; if (!c.last_author) c.last_author = old.last_author; }
        }
        return c;
      });
    }, function () {}));
    tasks.push(G("replied", "/convo-replied").then(function (d) {
      if (d && Array.isArray(d.convos)) { D.convoReplied = heldLocal("replied"); d.convos.forEach(function (id) { D.convoReplied[id] = 1; }); }
    }, function () {}));
    tasks.push(G("posts", "/reddit-posts").then(function (list) {
      if (Array.isArray(list) && list.length) _posts = list.map(mapRedditPost).map(function (p) {
        var old = _pById[p.id];
        if (old && old._commentsLoaded && !p._commentsLoaded) { p.thread = old.thread; p._commentsLoaded = true; } return p;
      });
    }, function () {}));
    tasks.push(G("comments", "/reddit-comments").then(function (list) {
      if (Array.isArray(list)) _comments = list;
    }, function () {}));
    tasks.push(G("maint", "/maintenances").then(function (list) {
      if (Array.isArray(list)) D.maintenances = list;
    }, function () {}));
    // Keep the Jira list live (CM In Progress tickets now land in the console store the moment the bot
    // sees the transition). Merge in place so a refresh never wipes per-ticket detail loaded on open.
    tasks.push(G("jira", "/jira-cache").then(function (d) {
      if (!d || !Array.isArray(d.issues)) return;
      if (!D.jira) D.jira = [];
      var have = {}; D.jira.forEach(function (j) { have[j.issue_key] = j; });
      d.issues.forEach(function (x) {
        var j = have[x.issue_key];
        if (!j) {
          D.jira.push({ issue_key: x.issue_key, summary: cleanJiraSummary(x.summary), status: x.status,
            category: jiraCategory(x.status), url: x.url, communication_link: x.communication_link,
            reporter: x.reporter, reporter_id: x.reporter_id, l1_tags: [], comments: [],
            status_since: x.status_since || null, cm_awaiting_reply: x.cm_awaiting_reply });
        } else {
          j.summary = cleanJiraSummary(x.summary); j.status = x.status; j.category = jiraCategory(x.status);
          j.url = x.url; j.status_since = x.status_since || null;
          if (x.communication_link) j.communication_link = x.communication_link;
          if (typeof x.cm_awaiting_reply !== "undefined") j.cm_awaiting_reply = x.cm_awaiting_reply;
        }
      });
      if (d.synced_at) state.jiraSyncedAt = d.synced_at;
    }, function () {}));
    tasks.push(G("tickets", "/discord-tickets?status=active&limit=3000").then(function (list) {
      if (Array.isArray(list)) {
        // The currently-open ticket, resolved against the CURRENT list (the swap happens later). Its
        // transcript is refreshed separately by refreshOpenItem() this same tick, so it is safe to keep.
        var _r = parseHash();
        var openTid = (_r.view === "discord" && _r.id && ticketByKey(_r.id)) ? tid(ticketByKey(_r.id)) : "";
        var _tById = {}; (D.discordTickets || []).forEach(function (t) { _tById[tid(t)] = t; });
        var mapped = list.map(mapDiscordTicket).map(function (t) {
          var old = _tById[tid(t)];
          if (old && old.messages_history) {
            if (t.messages_history) {
              t.messages_history = _mergeLocal(t.messages_history, old.messages_history, _dKey);   // keep just-sent reply visible
            } else if ((t.messages_count || 0) <= (old.messages_count || 0) || tid(t) === openTid) {
              // Reuse the already-loaded transcript ONLY when no new message arrived since we loaded it
              // (or it is the open ticket, refreshed below). If the fresh snapshot shows new activity, the
              // loaded transcript is stale - drop it so the row's status derives from the fresh
              // last_message_is_user, instead of freezing until the operator re-clicks the ticket.
              t.messages_history = old.messages_history;
            }
          }
          return t;
        });
        // The active endpoint omits closed/Done tickets. If the operator already paged in the closed
        // archive, keep those rows so a background refresh doesn't wipe them (QA #1).
        if (state.closedPage && state.closedPage.loaded) {
          var have = {}; mapped.forEach(function (t) { have[tid(t)] = 1; });
          (D.discordTickets || []).forEach(function (t) { if (!have[tid(t)] && deriveDiscordStatus(t) === "done") mapped.push(t); });
        } else {
          // Closed tickets pulled in for a Profile 360 history stay too (else the next tick drops them).
          var have2 = {}; mapped.forEach(function (t) { have2[tid(t)] = 1; });
          (D.discordTickets || []).forEach(function (t) { if (t._hist && !have2[tid(t)]) mapped.push(t); });
        }
        _tickets = mapped;
      }
    }, function () {}));
    tasks.push(G("cstatus", "/convo-status").then(function (d) { state._overrides = (d && d.overrides) || {}; state._overridesAt = (d && d.overrides_at) || {}; }, function () {}));
    tasks.push(G("flags", "/post-flags").then(function (d) { state._ignored = (d && d.ignored) || []; state._ignoreMeta = (d && d.meta) || {}; }, function () {}));
    tasks.push(G("tags", "/tags").then(function (l) { state._tags = Array.isArray(l) ? l : []; }, function () {}));
    tasks.push(G("reads", "/reads").then(function (d) { if (d && d.reads) D.reads = Object.assign(d.reads, heldLocal("reads")); }, function () {}));
    // Telegram / Discord Mentions / Discord Forum weren't auto-refreshed before (item S3 gap) - a new
    // Telegram message needed a full page reload to show. Re-pull them here + fold into the signature.
    tasks.push(G("tg", "/telegram-messages").then(function (list) {
      if (!Array.isArray(list)) return;
      var _tgHeld = heldLocal("tgign");
      var prev = D.telegramMessages || [];
      _tg = list.map(mapTgMsg).map(function (m) {
        var old = _tgById[m.id];
        if (old && old.answered && !m.answered) { m.answered = true; if (!m.reply) m.reply = old.reply; }   // keep just-sent reply until backend confirms
        if (m.id in _tgHeld) m.ignored = _tgHeld[m.id];   // a just-made ignore / un-ignore wins over an older snapshot
        return m;
      });
    }, function () {}));
    tasks.push(G("mentions", "/discord-mentions").then(function (list) {
      if (!Array.isArray(list)) return;
      var prev = D.discordMentions || [];
      _mentions = list.map(mapMention).map(function (m) {
        var old = _mnById[m.id];
        if (old && old.status && old.status !== "new" && (!m.status || m.status === "new")) m.status = old.status;   // keep Replied/Ignored until backend catches up
        return m;
      });
    }, function () {}));
    tasks.push(G("forum", "/discord-forum").then(function (list) { if (Array.isArray(list)) _forum = list.map(mapForum); }, function () {}));
    tasks.push(G("fstatus", "/forum-status").then(function (m) { if (m && typeof m === "object" && !Array.isArray(m)) D.forumStatus = m; }, function () {}));
    tasks.push(G("presence", "/presence").then(function (list) { if (Array.isArray(list)) { var m = {}; list.forEach(function (p) { if (p.email) m[String(p.email).toLowerCase()] = p.at; }); D.presence = m; } }, function () {}));
    // Shared lists (a colleague's note, handoff, template or Jira link) stay live without F5: they are
    // re-fetched only when /poll says they changed.
    function sideLane(key, path, apply) {
      tasks.push(G(key, path).then(function (d) { if (apply(d) !== false) side = true; }, function () {}));
    }
    sideLane("rstatus", "/reddit-status", function (d) { if (!d || typeof d !== "object") return false; D.redditStatus = d; });
    sideLane("notes", "/notes", function (l) { if (!Array.isArray(l)) return false; D.notes = l.map(mapNote); });
    sideLane("handoffs", "/handoffs", function (l) { if (!Array.isArray(l)) return false; D.handoffs = l.map(mapHandoff); state._handoffsFresh = true; });
    sideLane("activity", "/activity", function (l) { if (!Array.isArray(l)) return false; D.activity = l.map(mapActivity); });
    sideLane("feedback", "/feedback", function (l) { if (!Array.isArray(l)) return false; D.feedback = l.map(mapFeedback); });
    sideLane("templates", "/templates", function (l) { if (!Array.isArray(l)) return false; D.templates = l; });
    sideLane("fbnotes", "/fb-notes", function (l) { if (!Array.isArray(l)) return false; D.channelContacts = l; });
    sideLane("fbcheck", "/fb-group-check", function (d) { if (!d) return false; state.fbGroupCheck = { by: d.by || "", at: d.at || "" }; });
    sideLane("roster", "/team-roster", function (l) { if (!Array.isArray(l)) return false; D.roster = l; });
    sideLane("subs", "/maintenance-subs", function (l) {
      if (!Array.isArray(l)) return false;
      D.maintenanceSubs = l.map(function (s) {
        return { entity: s.entity, type: s.type, language: s.language, target_type: s.target_type,
                 target_id: s.target_id, reddit_user: s.reddit_user,
                 convo_id: s.reddit_convo_id || (s.target_type === "reddit" ? s.target_id : null) };
      });
    });
    sideLane("known", "/known-issues", function (d) {
      if (!d || !d.categories) return false;
      D.knownIssues = d.categories; state.shotsEnabled = !!d.shots_enabled; if (d.synced_at) state.knownSyncedAt = d.synced_at;
    });
    sideLane("modnotes", "/reddit-mod-notes", function (l) {
      if (!Array.isArray(l)) return false;
      var byUser = {};
      l.forEach(function (d) {
        if (!d || !d.reddit_user) return;
        d.jira_convos = d.jira_convos || {}; d.highlighted_convos = d.highlighted_convos || [];
        byUser[d.reddit_user] = d;
      });
      D.modNotes = byUser;
    });
    sideLane("postjira", "/post-jira-link", function (d) { if (!d || !d.links) return false; D.postJira = d.links; });
    sideLane("juser", "/jira-user-link", function (d) { if (!d || !d.links) return false; D.userJira = d.links; });
    sideLane("jhandled", "/jira-handled", function (m) { if (!m || typeof m !== "object" || Array.isArray(m)) return false; D.jiraHandled = m; });
    sideLane("jdismissed", "/jira-dismissed", function (m) { if (!m || typeof m !== "object" || Array.isArray(m)) return false; D.jiraDismissed = m; });
    sideLane("jl1", "/jira-l1-todo", function (l) { if (!Array.isArray(l)) return false; D.jiraL1 = l; });
    sideLane("cutoff", "/history-cutoff", function (d) {
      var c = d && d.cutoff && _utcDate(d.cutoff); if (!c) return false;
      state.historyCutoff = c.getTime();
    });
    return Promise.all(tasks).then(function () {
      // Atomic swap: publish every freshly-fetched list at once, THEN apply the overlays below, THEN
      // render - so D.* goes straight from one fully-overlaid state to the next with no raw window.
      if (_modmail) D.redditModmail = _modmail;
      if (_posts) D.redditPosts = _posts;
      if (_comments) D.redditComments = _comments;
      if (_tickets) D.discordTickets = _tickets;
      if (_tg) D.telegramMessages = _tg;
      if (_mentions) D.discordMentions = _mentions;
      if (_forum) D.discordForum = _forum;
      var ov = state._overrides || {}, ovAt = state._overridesAt || {};
      D.redditModmail.forEach(function (c) { if (ov[c.id]) { c.override_status = ov[c.id]; c._override_at = ovAt[c.id] || ""; } });
      D.discordTickets.forEach(function (t) { if (ov[tid(t)]) { t.override_status = ov[tid(t)]; t._override_at = ovAt[tid(t)] || ""; } });
      consumeStaleOverrides();   // user wrote after a manual status -> reopen (event-based)
      if (state._ignored) { var s = {}; state._ignored.forEach(function (p) { s[p] = 1; }); D.redditPosts.forEach(function (p) { if (s[p.id]) { p.ignored = true; applyIgnoreMeta(p); } }); }
      if (state._tags) applyTags(state._tags);
      applyConvoReplied();      // keep replied convos out of "New" (item W3)
      applyPostJira();          // show post<->Jira links (item W4)
      // Always re-pull the open item's transcript on each refresh. The list snapshot's activity
      // markers can lag behind the ticket detail, so gating on them left new messages invisible until
      // an F5 (bug #6). The re-poll is silent - it re-renders only when the transcript actually
      // changed (see _openSig) - so freshness is guaranteed without the page jumping every tick.
      refreshOpenItem();
      // Skip the whole re-render when nothing visible changed - the key to a calm, non-jumpy refresh.
      if (side || visibleSignature() !== state._refreshSig) renderFresh();
      // A handoff note left for me while the console was open: show it now, not after the next reload.
      if (state._handoffsFresh) { state._handoffsFresh = false; if (!_busy()) showHandoffPopup(); }
    });
  }
  /* Re-fetch the messages of the currently-open item so a full refresh (timer, manual, or tab
     re-focus) surfaces new messages on the open ticket, not just in the list. The old transcript
     stays visible until the fresh one arrives (no flicker). */
  /* Coarse signature of an open item's message list: length + last author + last text. Lets a forced
     re-poll skip the re-render when the transcript is unchanged, keeping the refresh calm (bug #6). */
  function _openSig(arr) {
    if (!Array.isArray(arr) || !arr.length) return "0";
    var last = arr[arr.length - 1] || {};
    var body = last.body || last.text || last.content || "";
    var who = last.author || last.user_name || (typeof last.is_user !== "undefined" ? (last.is_user ? "u" : "m") : "");
    return arr.length + "|" + String(who) + "|" + String(body).slice(0, 48);
  }
  function refreshOpenItem() {
    var r = parseHash();
    if (r.view === "discord" && r.id) {
      var t = ticketByKey(r.id); if (t) ensureTranscript(t, true);
    } else if (r.view === "modmail" && r.id) {
      var c = convoById(r.id); if (c) ensureRedditMessages(c, true);
    } else if (r.view === "posts" && r.id) {
      var p = (D.redditPosts || []).filter(function (x) { return x.id === r.id; })[0];
      if (p) ensureRedditPostComments(p, true);
    }
  }
  /* Manual refresh (topbar button): pull everything now, spin the icon, and confirm with a toast. */
  function manualRefresh() {
    var btn = q("#refresh-btn");
    // The button does what F5 does - a full reload of everything - so no list or cached bit is left stale.
    // Typed replies and the 60s send queue survive the reload.
    try {
      var _ta = q("[data-composer]"); state.drafts = state.drafts || {};
      if (_ta && state._threadKey) state.drafts[state._threadKey] = _ta.value;
      sessionStorage.setItem("cmt-drafts", JSON.stringify(state.drafts));
    } catch (e) {}
    savePending();
    if (btn) btn.classList.add("spin");
    location.reload();
    return;
    if (btn) btn.classList.add("spin");
    var done = function () { if (btn) btn.classList.remove("spin"); };
    var p = refreshLive();
    if (p && p.then) p.then(function () { done(); toast("Refreshed"); }, function () { done(); toast("Refresh failed"); });
    else { done(); }
  }
  /* ---------- Screenshots (Cloudflare R2): Known Issues (admin) + Feedback (its author) ----------
     A picked image is shrunk in the browser first (longest side 1920px, WebP, JPEG fallback) so an
     upload is ~100-300 KB instead of a multi-MB phone PNG. Picked files wait in a "stage" (keyed per
     form) until the form is saved, then upload one by one. Previews are data: URLs (the CSP has no blob:). */
  var SHOT_ACCEPT = "image/png,image/jpeg,image/webp";
  function shrinkImage(file) {
    return new Promise(function (ok, fail) {
      if (!file || !/^image\//.test(file.type || "")) { fail("Not an image"); return; }
      var rd = new FileReader();
      rd.onerror = function () { fail("Could not read the image"); };
      rd.onload = function () {
        var img = new Image();
        img.onerror = function () { fail("Unsupported image"); };
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 1920 / Math.max(w, h, 1));
          var c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          var preview = c.toDataURL("image/jpeg", 0.6);
          c.toBlob(function (b) {
            if (b && b.type === "image/webp") { ok({ blob: b, preview: preview }); return; }
            c.toBlob(function (j) { if (j) ok({ blob: j, preview: preview }); else fail("Could not compress the image"); }, "image/jpeg", 0.85);
          }, "image/webp", 0.85);
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }
  function shotStage(key) { state._shotStage = state._shotStage || {}; return state._shotStage[key] || (state._shotStage[key] = []); }
  var SHOT_MAX = { fb: 3, "ki-sug-new": 3 };
  function shotMax(key) { return SHOT_MAX[key] || 6; }
  /* A "pick screenshots" block for a form: staged previews (removable) + an Add button. */
  function shotPicker(key, label) {
    var list = shotStage(key), max = shotMax(key);
    var thumbs = list.map(function (it, i) {
      return '<span class="shot-item"><img class="shot-th" src="' + esc(it.preview) + '" alt="screenshot">' +
        '<button type="button" class="shot-x" data-act="shot-unstage" data-stage="' + esc(key) + '" data-i="' + i + '" title="Remove">&times;</button></span>';
    }).join("");
    var add = list.length < max
      ? '<label class="btn sm ghost shot-add">' + ic("plus", "ico-sm") + esc(label || "Add screenshot") +
        '<input type="file" accept="' + SHOT_ACCEPT + '" multiple hidden data-shot-stage="' + esc(key) + '"></label>'
      : "";
    return '<div class="shot-pick" data-stage="' + esc(key) + '">' + (thumbs ? '<div class="shot-row">' + thumbs + "</div>" : "") + add +
      '<span class="shot-note muted">' + list.length + " / " + max + "</span></div>";
  }
  function redrawShotPicker(key) {
    var el = document.querySelector('.shot-pick[data-stage="' + key + '"]');
    if (!el) return;
    var lbl = el.querySelector(".shot-add"); lbl = lbl ? lbl.textContent : "";
    el.outerHTML = shotPicker(key, lbl || undefined);
  }
  function stageShots(key, files) {
    var list = shotStage(key), room = shotMax(key) - list.length;
    var arr = Array.prototype.slice.call(files || [], 0, Math.max(0, room));
    if (files && files.length > arr.length) toast("Max " + shotMax(key) + " screenshots");
    arr.reduce(function (p, f) {
      return p.then(function () { return shrinkImage(f).then(function (it) { list.push(it); redrawShotPicker(key); }, function (e) { toast(String(e)); }); });
    }, Promise.resolve());
  }
  function uploadShot(path, blob, fields) {
    var fd = new FormData();
    Object.keys(fields || {}).forEach(function (k) { fd.append(k, fields[k]); });
    fd.append("file", blob, "screenshot." + (blob.type === "image/webp" ? "webp" : "jpg"));
    return window.CONSOLE.upload(path, fd).then(function (d) { return d || {}; }, function (st) { return { ok: false, error: "HTTP " + st }; });
  }
  /* Upload everything staged under `key` (in order); resolves to the stored shots. Clears the stage. */
  function uploadStaged(key, path, fields) {
    var list = shotStage(key).slice(); state._shotStage[key] = [];
    var out = [], err = "";
    return list.reduce(function (p, it) {
      return p.then(function () { return uploadShot(path, it.blob, fields).then(function (d) { if (d.ok && d.shot) out.push(d.shot); else err = d.error || "upload failed"; }); });
    }, Promise.resolve()).then(function () {
      if (err) toast("Screenshot: " + err);
      return out;
    });
  }
  function shotThumbs(shots, delAct) {
    if (!shots || !shots.length) return "";
    return '<div class="shot-row">' + shots.map(function (x) {
      return '<span class="shot-item"><a href="' + esc(x.url) + '" target="_blank" rel="noopener"><img class="shot-th" src="' + esc(x.url) + '" alt="screenshot" loading="lazy"></a>' +
        (delAct ? '<button type="button" class="shot-x" data-act="' + delAct + '" data-id="' + esc(x.id) + '" title="Delete screenshot">&times;</button>' : "") + "</span>";
    }).join("") + "</div>";
  }

  /* ---------- Feedback widget (item Y) ---------- */
  function mapFeedback(f) {
    return { id: f.id, category: f.category, message: f.message, status: f.status || "New", shots: f.shots || [],
      by: f.by || "", byEmail: f.by_email || "", edited: !!f.edited_at, ago: timeText(f.created_at) || "now",
      reply: f.reply || "", replyBy: f.reply_by || "", replyAgo: f.reply_at ? (timeText(f.reply_at) || "") : "" };
  }
  function toggleFeedback() {
    var p = q("#feedback-panel"); if (!p) return;
    p.classList.toggle("open");
    if (p.classList.contains("open")) {
      var box = q("#fb-shots"); if (box) box.innerHTML = state.shotsEnabled ? shotPicker("fb") : "";
      var s = q(".fb-cat.on") || q(".fb-cat"); if (s) setTimeout(function () { s.focus(); }, 20);
    }
  }
  /* feedback panel (admin format): category tiles + live character counter. */
  function fbPickCat(btn) {
    var v = btn.getAttribute("data-val"), h = q("#fb-category"); if (h) h.value = v;
    Array.prototype.forEach.call(document.querySelectorAll(".fb-cat"), function (b) {
      var on = b === btn; b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  function fbCount() {
    var m = q("#fb-message"), n = m ? m.value.length : 0, c = q("#fb-count"), bar = q("#fb-bar");
    if (c) c.textContent = n + " / 2000";
    if (bar) bar.style.width = Math.min(100, n / 20) + "%";
  }
  function fbPanelReset() {
    Array.prototype.forEach.call(document.querySelectorAll(".fb-cat"), function (b) { b.classList.remove("on"); b.setAttribute("aria-checked", "false"); });
    fbCount();
  }
  document.addEventListener("input", function (ev) { if (ev.target && ev.target.id === "fb-message") fbCount(); });
  document.addEventListener("paste", function (ev) {
    if (!ev.target || ev.target.id !== "fb-message" || !state.shotsEnabled) return;
    var items = (ev.clipboardData && ev.clipboardData.files) || [];
    var imgs = Array.prototype.filter.call(items, function (f) { return /^image\//.test(f.type || ""); });
    if (imgs.length) { ev.preventDefault(); stageShots("fb", imgs); }
  });
  function closeFeedback() { var p = q("#feedback-panel"); if (p) p.classList.remove("open"); }
  function submitFeedback() {
    var cat = q("#fb-category"), msg = q("#fb-message");
    var category = cat ? cat.value : "", message = msg ? msg.value.trim() : "";
    if (!category) { toast("Pick a category"); if (cat) cat.focus(); return; }
    if (!message) { toast("Describe your feedback"); if (msg) msg.focus(); return; }
    function done(rec) {
      D.feedback = D.feedback || []; D.feedback.unshift(rec);
      if (cat) cat.value = ""; if (msg) msg.value = "";
      fbPanelReset();
      closeFeedback(); render(); toast("Feedback sent");
      if (shotStage("fb").length && /^[0-9a-f]{24}$/.test(String(rec.id || ""))) {
        uploadStaged("fb", "/feedback/" + encodeURIComponent(rec.id) + "/shots", {}).then(function (shots) {
          if (shots.length) { rec.shots = (rec.shots || []).concat(shots); render(); toast(shots.length === 1 ? "Screenshot attached" : shots.length + " screenshots attached"); }
        });
      } else state._shotStage && (state._shotStage.fb = []);
    }
    window.CONSOLE.post("/feedback", { category: category, message: message }).then(function (f) {
        done(mapFeedback(f && f.id ? f : { id: "fb" + Date.now(), category: category, message: message, status: "New", by: myName(), created_at: new Date().toISOString() }));
      }, function () { toast("Could not send feedback"); });
  }
  /* Show the feedback bubble only for a signed-in user. */
  function syncFeedbackFab() {
    var fab = q("#feedback-fab"); if (!fab) return;
    if (state.user) fab.classList.add("show"); else { fab.classList.remove("show"); closeFeedback(); }
  }
  /* The list endpoint omits messages_history/conversation_html; fetch the full
     ticket the first time it's opened, then re-render. */
  function ensureTranscript(t, force) {
    if (!t || t._txLoading || (!force && t._txLoaded)) return;
    if (!t._id) { if (!t.messages_history) t.messages_history = []; return; }
    t._txLoading = true;
    var prevTx = t.messages_history || [];   // preserve just-sent optimistic replies across a re-fetch
    var prevSig = _openSig(prevTx);
    window.CONSOLE.get("/discord-tickets/" + t._id).then(function (full) {
      t.messages_history = _mergeLocal(Array.isArray(full.messages_history) ? full.messages_history.map(mapMsg) : [], prevTx, _dKey);
      t._txLoaded = true; t._txLoading = false;
      if (!force) render(); else if (_openSig(t.messages_history) !== prevSig) renderFresh();
    }, function () { t._txLoading = false; if (!t.messages_history) t.messages_history = []; if (!force) render(); });
  }
  /* Jira description + comments come from the Jira REST API (not Mongo). Fetch on open. */
  function ensureJira(j) {
    if (!j || j._jiraLoaded || j._jiraLoading || !j.issue_key) return;
    j._jiraLoading = true;
    window.CONSOLE.get("/jira-issue/" + encodeURIComponent(j.issue_key)).then(function (d) {
      j._jiraLoading = false; j._jiraLoaded = true;
      if (d && d.configured === false) { j._jiraUnconfigured = true; render(); return; }
      if (d && typeof d.descriptionHtml === "string") j.descriptionHtml = d.descriptionHtml;
      if (d && typeof d.descriptionRaw === "string") j.descriptionRaw = d.descriptionRaw;
      if (d && typeof d.summary === "string" && d.summary) j.summary = d.summary;
      if (d && typeof d.communication_link === "string") j.communication_link = d.communication_link;
      if (d && Array.isArray(d.l1_tags)) j.l1_tags = d.l1_tags;
      if (d && Array.isArray(d.comments)) j.comments = d.comments.map(function (c) {
        return { id: c.id || "", author: c.author || "", authorId: c.authorId || "", editable: !!c.editable,
                 bodyHtml: c.body || "", bodyRaw: c.bodyRaw || "", created: c.created ? fmtDT(c.created) : "" };
      });
      render();
    }, function () { j._jiraLoading = false; j._jiraLoaded = true; render(); });
  }

  /* ---------- state ---------- */
  var state = {
    theme: "light", q: "",
    inboxLeft: "new", inboxReadRange: "1d", discordStatus: "all", discordType: "all", discordJira: "all",
    jiraCat: "all", jiraPlatform: "all", modmailStatus: "all", postFilter: "all", postSort: "activity", feedbackStatus: "all",
    user: null, modal: null, modalValues: {}, modalQuery: "",
    closedPage: { loaded: false, skip: 0, done: false, loading: false },
    botActions: { loaded: false, loading: false, items: [] },
    cmdk: { open: false, query: "", items: [], sel: 0 },
    pendingSends: [], pendingTicker: null,
    historyCutoff: 0, modmailHistory: false, postsHistory: false, jiraHistory: false,   // History view 
    telegramHistory: false, mentionsHistory: false, forumHistory: false,   // History for Telegram / Discord Mentions / Forum
    inboxTab: "todo",                                              // home page tabs: To-Do (default) | Monitor | Team
    scheduleMonth: "", scheduleSyncedAt: "",                       // team schedule: selected month + last sync
    gcWeek: "", gcSyncedAt: "", gcOpen: {}, busyN: 0,              // game cards: selected week, sync, expanded cards; busy counter
    hydrating: false,                                              // live: first data load in flight -> show a loader, never the mock
    discordGuildId: "",                                             // for "Open in Discord" links
    fbGroupUrl: "", fbGroupCheck: null,                            // Facebook group button + last-checked (W7)
    isMobile: false                                                // phone layout: drawer rail + single-pane chats
  };
  var HISTORY_DAYS = 5;
  /* An item is in History if it has had no activity for >5 days, OR it is older than the admin
     "move all to History" cutoff. A new message (newer ts) brings it back automatically. */
  function inHistory(ts) {
    var d = _utcDate(ts); if (!d) return false;
    var t = d.getTime();
    if (Date.now() - t > HISTORY_DAYS * 86400000) return true;
    if (state.historyCutoff && t <= state.historyCutoff) return true;
    return false;
  }
  /* A toggle chip (kept separate from the status filters) that switches a section between the
     normal list and its History (items with no activity for 5+ days). Status filtering still works. */
  /* True while a search query is active. During search, list views span BOTH active and History so
     nothing is hidden by the History partition. */
  function searching() { return !!(state.q && state.q.trim()); }
  function historyToggle(key) {
    var on = state[key];
    return '<button class="filter hist' + (on ? " active" : "") + '" data-act="history-toggle" data-key="' + key + '" title="Items with no activity for 5+ days">' +
      ic("clock", "ico-sm") + (on ? "Back to active" : "History") + "</button>";
  }
  var CLOSED_PAGE = 100;
  /* Closed tickets aren't loaded up front (bounded initial load). Page them in on demand
     when the Closed filter is active; appended to D.discordTickets (deduped by tid). */
  function loadClosed() {
    var c = state.closedPage;
    if (c.loading || c.done) return;
    c.loading = true;
    window.CONSOLE.get("/discord-tickets?status=closed&limit=" + CLOSED_PAGE + "&skip=" + c.skip).then(function (list) {
      c.loading = false;
      if (!Array.isArray(list)) { c.done = true; render(); return; }
      var seen = {}; D.discordTickets.forEach(function (t) { seen[tid(t)] = true; });
      var _add = list.map(mapDiscordTicket).filter(function (t) { return !seen[tid(t)]; });
      _add.forEach(function (t) { D.discordTickets.push(t); }); overlayTickets(_add);
      c.skip += list.length; c.loaded = true;
      if (list.length < CLOSED_PAGE) c.done = true;
      render();
    }, function () { c.loading = false; c.done = true; render(); });
  }

  /* Archive search: the closed archive is paged, so a query also asks the server (name / #number /
     user ID across ALL closed tickets). Each query is fetched once; results join the list. */
  var _closedSearch = {}, _closedSearchT = null;
  function searchClosed(ql) {
    if (!ql || _closedSearch[ql]) return;
    clearTimeout(_closedSearchT);
    _closedSearchT = setTimeout(function () {
      if (_closedSearch[ql]) return;
      _closedSearch[ql] = "loading";
      window.CONSOLE.get("/discord-tickets?status=closed&limit=200&q=" + encodeURIComponent(ql)).then(function (list) {
        _closedSearch[ql] = "done";
        if (Array.isArray(list)) {
          var seen = {}; D.discordTickets.forEach(function (t) { seen[tid(t)] = true; });
          var _add = list.map(mapDiscordTicket).filter(function (t) { return !seen[tid(t)]; });
          _add.forEach(function (t) { t._hist = true; D.discordTickets.push(t); }); overlayTickets(_add);
        }
        render();
      }, function () { _closedSearch[ql] = "done"; render(); });
    }, 400);
  }
  // Cap how many list rows we render at once - a year of backfilled modmail/posts is 1k+ and
  // rendering them all freezes the browser. The count pill still shows the true total; use
  // search/filters to reach anything past the cap.
  var LIST_CAP = 300;
  function capNote(total) {
    return total > LIST_CAP
      ? '<div style="text-align:center;color:var(--muted);font-size:12px;padding:12px 8px">Showing the newest ' + LIST_CAP + ' of ' + total + '. Use search / filters to reach the rest.</div>'
      : "";
  }
  /* v3 tables: list screens render as a real table (head row + rows, ARIA roles). Rows keep every
     data-go / data-act hook of the cards they replace; only the markup shape changed. */
  function qTable(cls, heads, rows) {
    return '<div class="qtable ' + cls + '" role="table"><div class="qrow qhead" role="row">' +
      heads.map(function (h) { return '<span class="qc" role="columnheader">' + esc(h) + "</span>"; }).join("") + "</div>" + rows + "</div>";
  }
  /* "When" in the Inbox tables: the date/time on one line, how long ago under it, so a compact column
     always fits "18 Nov 05:43" + "1d ago" without squeezing Subject / From. */
  function whenHtml(ts) {
    var t = timeText(ts) || "", p = t.split(DOT);
    if (p.length < 2) return esc(t);
    return '<span class="qw-at">' + esc(p[0]) + '</span><span class="qw-ago">' + esc(p.slice(1).join(DOT)) + "</span>";
  }
  function qCell(cls, html, label) {
    return '<span class="qc ' + cls + '" role="cell"' + (label ? ' data-label="' + esc(label) + '"' : "") + ">" + html + "</span>";
  }
  /* Loading state in the shape of what is coming: grey rows instead of a spinner. */
  function skeletonRows(n) {
    var out = "";
    for (var i = 0; i < (n || 6); i++) out += '<div class="sk-row" aria-hidden="true"><span class="sk sk-a"></span><span class="sk sk-b"></span><span class="sk sk-c"></span></div>';
    return '<div class="sk-list" role="status">' + out + '<span class="sr-only">Loading…</span></div>';
  }

  var NAV = [
    { view: "inbox",    go: "#/inbox",    icon: "inbox",    label: "Inbox",          group: "Workspace" },
    { view: "actions",  go: "#/actions",  icon: "bolt",     label: "Quick Actions",  group: "Workspace", perm: "actions" },
    { view: "modmail",  go: "#/modmail",  icon: "mail",     label: "Reddit ModMail", group: "Conversations", perm: "reddit" },
    { view: "posts",    go: "#/posts",    icon: "posts",    label: "Reddit Posts",   group: "Conversations", perm: "posts" },
    { view: "reddit-comments", go: "#/reddit-comments", icon: "reply", label: "Reddit Comments", group: "Conversations", perm: "reddit_comments" },
    { view: "discord",  go: "#/discord",  icon: "discord",  label: "Discord",        group: "Conversations", perm: "discord" },
    { view: "channels", go: "#/channels", icon: "facebook", label: "Facebook",       group: "Conversations", perm: "facebook" },
    { view: "telegram", go: "#/telegram", icon: "send",     label: "Telegram",       group: "Conversations", perm: "telegram" },
    { view: "known",    go: "#/known",    icon: "book",     label: "Known Issues",   group: "Work", perm: "known" },
    { view: "gamecards",go: "#/gamecards",icon: "cards",    label: "Game Cards",     group: "Work", perm: "gamecards" },
    { view: "testing",  go: "#/testing",  icon: "gametest", label: "New Games Testing",   group: "Work", perm: "gamecards" },
    { view: "maintenance", go: "#/maintenance", icon: "wrench", label: "Maintenance", group: "Work", perm: "maintenance" },
    { view: "wishlist", go: "#/wishlist", icon: "wishlist", label: "Wishlist",     group: "Work", perm: "wishlist" },
    { view: "events",   go: "#/events",   icon: "server",   label: "Events",         group: "Monitoring" },
    { view: "bans",     go: "#/bans",     icon: "shield",   label: "Bans",           group: "Monitoring" },
    { view: "notes",    go: "#/notes",    icon: "notes",    label: "Notes",          group: "Work" },
    { view: "schedule", go: "#/schedule", icon: "calendar", label: "Schedule",       group: "Team", perm: "schedule" },
    { view: "feedback", go: "#/feedback", icon: "star",     label: "Feedback",       group: "Team" },
    { view: "replylog", go: "#/replylog", icon: "book",     label: "Reply log", adminOnly: true, group: "Team", perm: "admin" },
    { view: "admin",    go: "#/admin",    icon: "shield",   label: "Admin", adminOnly: true, group: "Team", perm: "admin" }
  ];
  var NAV_BY_VIEW = {}; NAV.forEach(function (n) { NAV_BY_VIEW[n.view] = n; });
  var TITLES = { inbox: "Inbox", modmail: "Reddit ModMail", posts: "Reddit Posts", "reddit-comments": "Reddit Comments", discord: "Discord ModMail", telegram: "Telegram", jira: "Jira", known: "Known Issues", gamecards: "Game Cards", testing: "New Games Testing", replylog: "Reply log", maintenance: "Maintenance", wishlist: "Wishlist", notes: "Notes", channels: "Facebook", actions: "Quick Actions", events: "Events", bans: "Bans", schedule: "Schedule", feedback: "Feedback", admin: "Admin" };
  // Master/detail views: on a phone these show EITHER the list OR one open chat (not all panes at once).
  var SPLIT_VIEWS = { modmail: 1, posts: 1, discord: 1, telegram: 1, jira: 1 };
  function isMobileView() { return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches); }
  /* Reflect the phone layout state on <body> and swap the top-left button between a hamburger (opens
     the section drawer) and a back arrow (returns from an open chat to its list). */
  /* Discord routes carry the tab first (#/discord/forum, #/discord/forum/<post>, #/discord/mentions):
     the open item is the part AFTER the tab, so the tab name alone is a list, not an open chat. Returns
     {id, back}: the open item (or null) and the list a phone Back goes to. */
  function mobileRoute() {
    var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    var view = parts[0] || "modmail";
    if (view === "discord" && /^(forum|mentions|tickets)$/.test(parts[1] || "")) {
      return { view: view, id: parts[2] || null, back: "#/discord/" + parts[1] };
    }
    return { view: view, id: parts[1] || null, back: "#/" + view };
  }
  /* Phone: changing a list filter while a chat/post is open must show the filtered LIST, not keep the
     open item on screen (the filter bar stays visible above the chat). Returns true when it navigated
     (the hashchange re-renders), false when there was nothing to leave. */
  function leaveMobileDetail() {
    if (!state.isMobile) return false;
    var r = mobileRoute();
    if (!r.id || !SPLIT_VIEWS[r.view]) return false;
    location.hash = r.back;
    return true;
  }
  function applyMobileChrome() {
    var r = mobileRoute();
    var inDetail = state.isMobile && !!r.id && SPLIT_VIEWS[r.view];
    document.body.classList.toggle("is-mobile", !!state.isMobile);
    // A chat with a context panel is on screen: mid-width layouts show the Details button for it.
    document.body.classList.toggle("has-ctx", !state.isMobile && !!q(".split.three > .pane.context"));
    document.body.classList.toggle("m-detail", !!inDetail);
    // Close the slide-in drawer only on a real route change - NOT on a same-route background refresh
    // (which would snap the drawer shut while the operator is using it).
    var _h = location.hash || "";
    if (_h !== state._chromeHash) { document.body.classList.remove("rail-open"); document.body.classList.remove("m-ctx"); state._chromeHash = _h; }
    if (!inDetail) document.body.classList.remove("m-ctx");   // context screen only exists inside a chat
    var inCtx = document.body.classList.contains("m-ctx");
    var nt = q("#nav-toggle");
    if (nt) {
      var backArrow = inDetail || inCtx;
      nt.innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">' +
        (backArrow ? '<path d="M15 6l-6 6 6 6"/>' : '<path d="M4 6h16M4 12h16M4 18h10"/>') + "</svg>";
      nt.setAttribute("data-act", inCtx ? "m-ctx-back" : (inDetail ? "mobile-back" : "rail-toggle"));
      nt.setAttribute("title", inCtx ? "Back to chat" : (inDetail ? "Back to list" : "Menu"));
    }
  }

  /* Rail badge count = items that still NEED ATTENTION by status (V3), NOT the read/unread flag.
     So the number persists after the chat is opened and only drops when the status moves on.
     History items (>5d inactive) never count (item T2). */
  function countUnread(type) {
    var n = 0;
    if (type === "convo") D.redditModmail.forEach(function (c) { if (!inHistory(c.ts) && needsAttention("convo", c)) n++; });
    else if (type === "post") D.redditPosts.forEach(function (p) { if (!inHistory(p.ts) && needsAttention("post", p)) n++; });
    else if (type === "ticket") D.discordTickets.forEach(function (t) { if (!inHistory(t.ts) && needsAttention("ticket", t)) n++; });
    return n;
  }
  /* Telegram unread = user messages we haven't answered yet (drives the sidebar count). */
  /* Telegram unread is by VIEW: a message is unread until someone opens the Telegram tab (shared read
     state), regardless of whether we reply - we don't answer many of them. */
  function tgIsUnread(m) { return !readRec("telegram", m.id) && !inHistory(m.ts) && !m.ignored; }
  function tgUnread() { return (D.telegramMessages || []).filter(tgIsUnread).length; }
  /* New (unhandled) Discord moderator-mentions: counts while status is "new" and stays until the
     mod marks it Replied or Ignored. Drives the Discord rail badge + Mentions tab badge. */
  function mentionsNew() { return (D.discordMentions || []).filter(function (m) { return (m.status || "new") === "new" && !inHistory(m.ts); }).length; }


  /* ---------- per-user layout prefs (context panel sections, menu tabs); stored per user in this browser ---------- */
  var CTX_SECTIONS = [
    { key: "tags", label: "Tags" }, { key: "jira", label: "Linked tickets" }, { key: "identity", label: "Identity" },
    { key: "maintenance", label: "Maintenance" }, { key: "proposal", label: "Gaming Proposal" },
    { key: "notes", label: "Notes" }, { key: "handoffs", label: "Shift handoffs" }
  ];
  function prefsKey() { return "cmt-layout-" + ((state.user && state.user.id) || "anon"); }
  function layoutPrefs() {
    if (state._layout && state._layout.k === prefsKey()) return state._layout.v;
    var v = (state.user && state.user.layout) ? JSON.parse(JSON.stringify(state.user.layout)) : null;
    if (!v) { try { v = JSON.parse(localStorage.getItem(prefsKey()) || "null"); } catch (e) {} }
    v = v || {}; v.ctx = v.ctx || { order: [], hidden: {} }; v.nav = v.nav || { order: [], hidden: {} };
    state._layout = { k: prefsKey(), v: v };
    return v;
  }
  function saveLayoutPrefs() {
    var v = layoutPrefs();
    try { localStorage.setItem(prefsKey(), JSON.stringify(v)); } catch (e) {}
    if (state.user) state.user.layout = JSON.parse(JSON.stringify(v));
    clearTimeout(state._layoutSaveT);
    state._layoutSaveT = setTimeout(function () {
      window.CONSOLE.patch("/account-prefs", { layout: v }).then(function () {}, function () { toast("Could not save your layout"); });
    }, 600);
  }
  function orderedKeys(keys, order) {
    var pos = {}; (order || []).forEach(function (k, i) { pos[k] = i; });
    return keys.slice().sort(function (a, b) {
      var pa = a in pos ? pos[a] : 1000 + keys.indexOf(a), pb = b in pos ? pos[b] : 1000 + keys.indexOf(b);
      return pa - pb;
    });
  }
  function navItemsFor() {
    var pr = layoutPrefs().nav, vis = NAV.filter(canSee);
    var keys = orderedKeys(vis.map(function (n) { return n.view; }), pr.order);
    return keys.map(function (k) { return NAV_BY_VIEW[k]; });
  }
  function layoutCustomBody(kind) {
    var pr = layoutPrefs()[kind], items;
    if (kind === "ctx") items = orderedKeys(CTX_SECTIONS.map(function (c) { return c.key; }), pr.order).map(function (k) {
      return CTX_SECTIONS.filter(function (c) { return c.key === k; })[0];
    });
    else items = navItemsFor().map(function (n) { return { key: n.view, label: n.label, group: n.group }; });
    var lockFirst = kind === "nav" ? NAV.filter(canSee)[0].view : "";
    var rows = items.map(function (it, i) {
      var on = !pr.hidden[it.key], locked = it.key === lockFirst;
      return '<div class="lay-row' + (on ? "" : " off") + '">' +
        '<label class="lay-chk"><input type="checkbox" data-act="lay-toggle" data-kind="' + kind + '" data-key="' + esc(it.key) + '"' +
        (on ? " checked" : "") + (locked ? " disabled" : "") + "> " + esc(it.label) + "</label>" +
        (it.group ? '<span class="muted lay-grp">' + esc(it.group) + "</span>" : "") +
        '<button class="icon-btn sm" title="Move up" data-act="lay-move" data-dir="-1" data-kind="' + kind + '" data-key="' + esc(it.key) + '"' + (i ? "" : " disabled") + ">&#8593;</button>" +
        '<button class="icon-btn sm" title="Move down" data-act="lay-move" data-dir="1" data-kind="' + kind + '" data-key="' + esc(it.key) + '"' + (i < items.length - 1 ? "" : " disabled") + ">&#8595;</button></div>";
    }).join("");
    return '<div class="ev-sub">' + (kind === "ctx" ? "Choose which sections show in the right panel and their order." :
      "Choose which tabs show in the left menu and their order (inside each group).") + " Saved to your account, so it follows you on every device.</div>" +
      '<div class="lay-list">' + rows + "</div>" +
      '<button class="gcs-link" data-act="lay-reset" data-kind="' + kind + '">Reset to default</button>';
  }
  function openLayoutCustom(kind) {
    showModal({ title: kind === "ctx" ? "Customize panel" : "Customize menu", close: "Done",
      custom: function () { return layoutCustomBody(kind); } });
  }
  function layoutChanged() { saveLayoutPrefs(); renderRail(); setActiveNav(parseHash().view); render(); if (state.modal) renderModal(); }

  /* ---------- rail ---------- */
  var RAIL_LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">' +
    '<path d="M6 4h9l5 5v5l-2 2h-8l-6 5V6z"/><path d="M8 9h7M8 12.5h4"/></svg>';
  function renderRail() {
    var html = '<div class="brand" title="CMT Console"><div class="brand-mark">' + RAIL_LOGO + "</div>" +
      '<div class="brand-name">CMT Console' + (APP_VERSION ? '<span class="brand-v">v' + esc(APP_VERSION) + "</span>" : "") + "</div></div>";
    html += '<div class="nav-scroll">';
    // Group the sections (Workspace / Conversations / Work / Team) with labelled headers.
    var order = [], byGroup = {};
    var _navHidden = layoutPrefs().nav.hidden, _navFirst = (NAV.filter(canSee)[0] || {}).view;
    navItemsFor().forEach(function (n) {
      if (_navHidden[n.view] && n.view !== _navFirst) return;
      var g = n.group || "";
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(n);
    });
    order.forEach(function (g) {
      html += '<div class="nav-group">' + (g ? '<div class="nav-label">' + esc(g) + "</div>" : "");
      byGroup[g].forEach(function (n) {
        // Rail badges: new messages / new posts per section (NOT on Inbox itself). Suppressed while the
        // first live load is in flight so the mock counts never flash before real data arrives.
        var cnt = (state.hydrating || state.loadingData) ? 0 : (n.view === "modmail" ? countUnread("convo") : n.view === "posts" ? countUnread("post") : n.view === "discord" ? (countUnread("ticket") + mentionsNew()) : n.view === "telegram" ? tgUnread() : n.view === "channels" ? (fbNewCount() || (fbCheckOverdue() ? 1 : 0)) : n.view === "feedback" ? (isAdmin() ? feedbackNew() : 0) : 0);
        var badge = cnt ? '<span class="nbadge">' + (cnt > 99 ? "99+" : cnt) + "</span>" : "";
        if (REDDIT_MAINT_VIEWS[n.view] && redditDown()) badge = '<span class="nbadge off" title="On maintenance">off</span>';
        html += '<button class="nav-btn" data-go="' + n.go + '" data-view="' + n.view + '" title="' + n.label + '">' +
          ic(n.icon) + "<span>" + n.label + "</span>" + badge + "</button>";
      });
      html += "</div>";
    });
    html += "</div>";
    // Foot: collapse / expand toggle (stays reachable in the collapsed rail).
    html += '<div class="rail-foot"><button class="rail-collapse" data-act="rail-collapse" title="Collapse sidebar">' +
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M15 6l-6 6 6 6"/></svg><span>Collapse</span></button>' +
      '<button class="rail-collapse" data-act="customize-nav" title="Customize menu">' + ic("wrench") + "<span>Customize menu</span></button></div>";
    // Rebuilding with innerHTML resets the scroll position: keep it, so opening a section does not
    // throw a scrolled-down menu back to the top.
    var rail = q("#rail"), ns = rail.querySelector(".nav-scroll");
    var keepNav = ns ? ns.scrollTop : 0, keepRail = rail.scrollTop;
    rail.innerHTML = html;
    rail.scrollTop = keepRail;
    ns = rail.querySelector(".nav-scroll"); if (ns) ns.scrollTop = keepNav;
  }
  function setActiveNav(view) {
    Array.prototype.forEach.call(q("#rail").querySelectorAll(".nav-btn"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
  }

  /* ---------- router ---------- */
  function parseHash() {
    var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    return { view: parts[0] || "modmail", id: parts[1] || null };
  }
  var SEARCHABLE_VIEWS = { inbox: 1, modmail: 1, posts: 1, "reddit-comments": 1, discord: 1, telegram: 1, jira: 1, user: 1 };
  /* Live boot: until the first Mongo hydrate finishes, show a calm loader instead of the demo/mock
     data (which used to flash for a second before the real data arrived). */
  function renderLoading(title) {
    q("#view-title").textContent = title || "Loading";
    q("#view-root").innerHTML = '<div class="load-screen sk-screen"><div class="sk sk-title" aria-hidden="true"></div>' + skeletonRows(8) + "</div>";
    renderRail(); applyMobileChrome(); syncFeedbackFab();
  }
  /* render() rebuilds the whole view. render(true) is the "operator is typing" variant: it rebuilds
     only the panes that do not hold the caret (list, context, filters, and the message thread when the
     caret is in the composer), so new messages and statuses keep arriving while a reply is being typed. */
  /* Reddit sections while Reddit refuses the bot's API access: a plain "on maintenance" screen instead
     of stale lists and reply boxes that cannot send. The bot checks once an hour; when Reddit answers,
     /reddit-status flips back through the live poll and the sections return on their own. */
  var REDDIT_VIEWS = { modmail: 1, posts: 1, "reddit-comments": 1 };
  // While the API is blocked every Reddit section keeps working through our Devvit app (cmthelper):
  // events arrive through it and replies / archive / highlight are sent through it within about a
  // minute. No section is on maintenance; a banner on top says the API is still blocked.
  var REDDIT_MAINT_VIEWS = {};
  function redditFallbackBanner() {
    return '<div class="rss-banner' + (state.rssOpen ? " open" : "") + '" data-act="rss-toggle">' + ic("bell", "ico-sm") + "<span><b>Test mode.</b> Reddit is still blocking our API, so ModMail, posts and comments work through our Reddit app (Devvit). Replies, archive and highlight reach Reddit within about a minute. Images in posts may be missing. Normal mode returns on its own when the API is back.</span></div>";
  }
  function redditDown() { return !!(D.redditStatus && D.redditStatus.down); }
  function viewRedditMaintenance() {
    var st = D.redditStatus || {};
    // Plain sentences with exact Kyiv times, one per line.
    var kt = function (v) { var d = _utcDate(v); return d ? fmtKyivShort(d) : ""; };
    var bits = [];
    if (kt(st.since)) bits.push("Unavailable since " + esc(kt(st.since)) + ".");
    if (kt(st.checked_at) && kt(st.next_check_at)) bits.push("Last checked at " + esc(kt(st.checked_at)) + ", next check at " + esc(kt(st.next_check_at)) + ".");
    else if (kt(st.checked_at)) bits.push("Last checked at " + esc(kt(st.checked_at)) + ".");
    return '<div class="page"><div class="page-body">' +
      emptyState("wrench", "Reddit is on maintenance",
        "Reddit is not giving our tools access right now, so ModMail cannot be read or answered from the console. Work with it on reddit.com for the time being. Access is re-checked every hour and ModMail comes back on its own. Posts and Comments keep working in a temporary read-only mode.") +
      (bits.length ? '<div class="muted" style="text-align:center;font-size:12px;line-height:1.7;margin-top:-6px">' + bits.join("<br>") + "</div>" : "") +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:16px">' +
      '<a class="btn" href="https://mod.reddit.com/mail/all" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open ModMail on Reddit</a>" +
      "</div></div></div>";
  }
  function render(soft) {
    var r = parseHash(), html, title = TITLES[r.view] || "CMT";
    // Counters (list headers, tab counts) are hidden until the first load finished: an empty list would
    // otherwise show "0" for a moment on a slow start.
    try { document.body.classList.toggle("loading-data", !!state.loadingData); } catch (e) { /* no body yet */ }
    if (state.hydrating && state.user) { renderLoading(title); return; }
    // Permission gate (defence in depth with the rail filter): a signed-in user who lacks a section's
    // permission cannot reach it by typing/bookmarking its hash - they get an explicit "no access" panel
    // instead of the section's data. Views without a NAV entry (user profile, search) are never gated here.
    var navItem = NAV_BY_VIEW[r.view];
    if (navItem && !canSee(navItem)) {
      html = emptyState("shield", "No access",
        "You don't have permission for this section. Ask an admin to enable it for your account.");
      title = "No access";
    } else if (REDDIT_MAINT_VIEWS[r.view] && redditDown()) {
      html = viewRedditMaintenance();
    } else if (state.q && state.q.trim() && SEARCHABLE_VIEWS[r.view]) {
      // Top search box active on a content view -> global results across all sections (V5).
      html = viewSearch(); title = "Search";
    } else switch (r.view) {
      case "inbox":    html = viewInbox(); break;
      case "modmail":  html = viewModmail(r.id); break;
      case "posts":    html = viewPosts(r.id); break;
      case "reddit-comments": html = viewRedditComments(); break;
      case "discord":  html = viewDiscord(r.id); break;
      case "telegram": html = viewTelegram(r.id); break;
      case "jirachat": html = ""; openJiraChat(r.id); break;
      case "jira":     // the Jira page is gone: a ticket link opens Jira itself, the console returns to the inbox
        if (r.id) window.open(jiraUrl(r.id), "_blank", "noopener");
        setTimeout(function () { location.replace("#/inbox"); }, 0); html = ""; break;
      case "known":    html = viewKnown(r.id); break;
      case "schedule": html = viewSchedule(); break;
      case "gamecards": html = viewGameCards(); break;
      case "testing":  html = viewGameTesting(); break;
      case "replylog": html = isAdmin() ? viewReplyLog() : ""; break;
      case "maintenance": html = viewMaintenance(); break;
      case "wishlist": html = viewWishlist(); break;
      case "notes":    html = viewNotes(); break;
      case "channels": html = viewChannels(); break;
      case "actions":  html = viewActions(); break;
      case "feedback": html = viewFeedback(); break;
      case "events":   html = viewEvents(); break;
      case "bans":     html = viewBans(); break;
      case "admin":    html = isAdmin() ? viewAdmin() : emptyState("shield", "Admins only", "You do not have access to this section."); break;
      case "user":     html = viewUser(r.id); title = "u/" + (r.id || ""); break;
      default:         html = viewInbox(); r.view = "inbox";
    }
    if (REDDIT_VIEWS[r.view] && !REDDIT_MAINT_VIEWS[r.view] && redditDown()) {
      html = '<div class="rss-wrap">' + redditFallbackBanner() + '<div class="rss-body">' + html + "</div></div>";
    }
    // Chat threads should sit at the newest message (item W1). Capture whether the open thread is
    // pinned to the bottom BEFORE we rebuild; keep it pinned on open (route change) and on refresh,
    // but preserve the scroll position if the operator scrolled up to read history.
    var newKey = r.view + "/" + (r.id || "");
    var rootEl = q("#view-root");
    var sameRoute = (newKey === state._threadKey);   // a re-render of the same open item (refresh)
    if (soft === true && sameRoute) {
      var tmp = document.createElement("div"); tmp.innerHTML = html;
      deskEnhance(tmp);
      var ae = document.activeElement;
      [".filters", ".pane.list", ".pane.context", ".thread"].forEach(function (sel) {
        var cur = q(sel, rootEl), next = q(sel, tmp);
        if (!cur || !next || cur.contains(ae) || cur.innerHTML === next.innerHTML) return;
        var sc = sel === ".thread" ? threadScroller(cur) : cur;   // phone: the screen scrolls, not the thread
        var top = sc.scrollTop;
        var stick = sel === ".thread" && (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60);
        cur.innerHTML = next.innerHTML;
        sc.scrollTop = stick ? sc.scrollHeight : top;
      });
      renderRail(); setActiveNav(r.view); enhanceTranslate();
      return;
    }
    var oldThread = q(".thread", rootEl), oldScr = oldThread ? threadScroller(oldThread) : null;
    var savedTop = oldScr ? oldScr.scrollTop : 0;
    var pinned = !sameRoute || !oldScr ||
      (oldScr.scrollHeight - oldScr.scrollTop - oldScr.clientHeight < 60);
    // Preserve the list + context column scroll across a same-route re-render so a data refresh does
    // not scroll the operator's list back to the top or jump the view around.
    var oldList = q(".pane.list", rootEl), listTop = oldList ? oldList.scrollTop : 0;
    var oldCtx = q(".pane.context", rootEl), ctxTop = oldCtx ? oldCtx.scrollTop : 0;
    // Feed-style tabs (Mentions / Telegram) scroll in their own container, not a .pane - preserve it
    // too so acting on a card (Ignore/Replied) doesn't fling the list back to the top.
    var oldDs = q(".ds-scroll, .gc-scroll", rootEl), dsTop = oldDs ? oldDs.scrollTop : 0;
    // Single-column page views (Feedback / Notes / Admin / Channels / Maintenance / Actions -> .page;
    // Known Issues -> .ki-scroll; Schedule -> .sch-scroll/.rota-wrap) scroll in their own container.
    // Preserve it too so acting on the page (e.g. changing a feedback status, replying) doesn't fling
    // the whole page back to the top.
    var oldPg = q(".page, .ki-scroll, .sch-scroll, .rota-wrap", rootEl), pgTop = oldPg ? oldPg.scrollTop : 0;
    // Inner scroll boxes inside a page (e.g. the Admin "Activity monitor") opt in with
    // data-keep-scroll="<id>" so a background refresh doesn't reset them to the top either.
    var keepTops = {};
    Array.prototype.forEach.call(rootEl.querySelectorAll("[data-keep-scroll]"), function (el) {
      keepTops[el.getAttribute("data-keep-scroll")] = el.scrollTop;
    });
    state.drafts = state.drafts || {};
    var oldTa = q("[data-composer]", rootEl), taFocus = false, taSel = null;
    if (oldTa && state._threadKey) {
      state.drafts[state._threadKey] = oldTa.value;
      taFocus = document.activeElement === oldTa;
      try { taSel = [oldTa.selectionStart, oldTa.selectionEnd]; } catch (e) {}
    }
    state._threadKey = newKey;
    q("#view-title").textContent = title;
    rootEl.innerHTML = html;
    deskEnhance(rootEl);
    var newTa = q("[data-composer]", rootEl);
    if (newTa && state.drafts[newKey] && !newTa.value) {
      newTa.value = state.drafts[newKey];
      if (sameRoute && taFocus) { newTa.focus(); try { if (taSel) newTa.setSelectionRange(taSel[0], taSel[1]); } catch (e) {} }
    }
    renderRail();
    setActiveNav(r.view);
    mountResizers();
    enhanceTranslate();   // per-message Translate button + cached RU translation (item W10)
    if (sameRoute) {
      var nl = q(".pane.list", rootEl); if (nl && listTop) nl.scrollTop = listTop;
      var ncx = q(".pane.context", rootEl); if (ncx && ctxTop) ncx.scrollTop = ctxTop;
      var nds = q(".ds-scroll, .gc-scroll", rootEl); if (nds && dsTop) nds.scrollTop = dsTop;
      var npg = q(".page, .ki-scroll, .sch-scroll, .rota-wrap", rootEl); if (npg && pgTop) npg.scrollTop = pgTop;
      Array.prototype.forEach.call(rootEl.querySelectorAll("[data-keep-scroll]"), function (el) {
        var t = keepTops[el.getAttribute("data-keep-scroll")]; if (t) el.scrollTop = t;
      });
    } else {
      // Only auto-scroll the active row into view on a real navigation, never on a background refresh.
      var act = q(".row.active, .jira-row.active", rootEl);
      if (act) act.scrollIntoView({ block: "nearest" });
    }
    var nt = q(".thread", rootEl);
    if (nt) { if (pinned) scrollThreadToEnd(); else threadScroller(nt).scrollTop = savedTop; }
    state._refreshSig = visibleSignature();   // baseline so auto-refresh can skip a no-op re-render
    state._dirty = false;
    applyMobileChrome();   // phone: drawer button / back button + body layout classes
    syncFeedbackFab();   // feedback bubble visible only when signed in (item Y)
  }
  /* Resizable panes: stored widths live as CSS vars on :root (survive re-renders); the
     draggable handles are re-mounted into the freshly rendered .split.three each render. */
  function applyPaneWidths() {
    try {
      var lw = localStorage.getItem("cmt-list-w"), cw = localStorage.getItem("cmt-ctx-w");
      if (lw) document.documentElement.style.setProperty("--list-w", lw + "px");
      if (cw) document.documentElement.style.setProperty("--ctx-w", cw + "px");
    } catch (e) {}
  }
  function mountResizers() {
    var split = q(".split.three"); if (!split || split.querySelector(".col-resizer")) return;
    ["left", "right"].forEach(function (side) {
      var h = document.createElement("div");
      h.className = "col-resizer " + side; h.setAttribute("data-resize", side);
      split.appendChild(h);
    });
  }

  /* ---------- shared context panel (ModMail / Discord / Posts) ---------- */
  function ctxSec(icon, title, inner) {
    return '<div class="ctx-sec"><h3>' + ic(icon, "ico-sm") + esc(title) + "</h3>" + inner + "</div>";
  }
  function kv(k, v) { return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v truncate">' + v + "</span></div>"; }

  /* Email quick-actions under an Identity panel - one consistent behavior everywhere: an email already
     on file shows Copy + Edit; none shows Add. Edit/Add bind to the chat's Reddit user (the add-email
     upsert is profile-URL based); Copy works whenever an email is shown (incl. Discord). */
  var ADMIN_SESSIONS_URL = "https://admin.cloud.boosteroid.com/admin/filament/streaming/streaming-user-sessions?filters%5Buser_id%5D%5Bvalue%5D=";
  function adminSessionsUrl(uid) { return ADMIN_SESSIONS_URL + encodeURIComponent(String(uid).replace(/\D/g, "")); }
  /* User ID quick-actions under an Identity panel. Known ID: open the user's sessions in the cloud
     admin, copy, edit. Only a legacy email on file: look the ID up. Nothing: add the ID. Add/Edit bind
     to the chat's social account (profile URL), so the ID is tied to that Reddit / Discord user. */
  function emailActions(emailUser, email, profileUrl, userId) {
    var canBind = (emailUser && emailUser !== "[deleted]") || !!profileUrl;
    var pf = profileUrl ? ' data-profile="' + esc(profileUrl) + '"' : "";
    var bind = ' data-act="add-email" data-user="' + esc(emailUser || "") + '"' + pf;
    if (userId) {
      return '<a class="btn sm" href="' + esc(adminSessionsUrl(userId)) + '" target="_blank" rel="noopener" title="Open this user\'s sessions in the cloud admin">' + ic("external", "ico-sm") + "Sessions in admin</a>" +
        '<button class="btn sm" data-act="copy-uid" data-uid="' + esc(userId) + '">' + ic("copy", "ico-sm") + "Copy User ID</button>" +
        (canBind ? '<button class="btn sm"' + bind + ' data-uid="' + esc(userId) + '">' + ic("user", "ico-sm") + "Edit User ID</button>" : "");
    }
    var out = "";
    if (email && /@/.test(email)) out += '<button class="btn sm" data-act="find-uid" data-email="' + esc(email) + '"' + (canBind ? ' data-user="' + esc(emailUser || "") + '"' + pf : "") + ">" + ic("user", "ico-sm") + "Find User ID</button>";
    if (canBind) out += '<button class="btn sm"' + bind + ">" + ic("user", "ico-sm") + "Add User ID</button>";
    return out;
  }
  /* email -> Boosteroid User ID resolved through the cloud API (bot action "cloud_user_lookup"). The ID
     is saved on the directory records with that email, so it is found once and shown to everyone. */
  var _uidByEmail = {}, _uidBusy = {};
  function profileUrlFor(emailUser, profileUrl) {
    return profileUrl || (emailUser && emailUser !== "[deleted]" ? "https://www.reddit.com/user/" + emailUser : "");
  }
  /* Show a saved User ID at once: the record of that social account now carries the ID and no email. */
  function applySavedUserId(url, uid) {
    var rm = /reddit\.com\/u(?:ser)?\/([^\/?#\s]+)/i.exec(url || ""), dm = /discord(?:app)?\.com\/users\/(\d+)/i.exec(url || "");
    _mergeEmailRecs([{ email: "", cloud_user_id: String(uid), url: url, platform: rm ? "Reddit" : (dm ? "Discord" : "Other"),
                       reddit_username: rm ? rm[1] : undefined, discord_user_id: dm ? dm[1] : undefined }]);
  }
  function saveUserId(profileUrl, uid, done) {
    window.CONSOLE.post("/users-emails", { user_id: String(uid), profile_url: profileUrl }).then(function () {
      applySavedUserId(profileUrl, uid);
      var dm = /discord(?:app)?\.com\/users\/(\d+)/i.exec(profileUrl || "");
      if (dm && dm[1]) enqueueAction("discord_mention_email", { discord_user_id: dm[1], email: String(uid) }, function () {});   // reflect into Slack
      toast("User ID " + uid + " saved");
      if (done) done();
    }, function () { toast("Could not save the User ID", "error"); });
  }
  function findUserId(email, bindUrl) {
    var key = String(email || "").trim().toLowerCase();
    if (!key || _uidBusy[key]) return;
    _uidBusy[key] = true;
    toast("Looking up the User ID...");
    enqueueAction("cloud_user_lookup", { email: key }, function (a) {
      delete _uidBusy[key];
      var uid = a.status === "done" && a.result && a.result.user_id ? String(a.result.user_id) : "";
      if (!uid) { toast(a.error ? "User ID not found: " + a.error : "User ID not found", "error"); return; }
      _uidByEmail[key] = uid;
      (D._emailRecs || []).forEach(function (r) { if (String(r.email || "").toLowerCase() === key) r.cloud_user_id = uid; });
      D.users = buildUsers(D._emailRecs || []);
      if (bindUrl) { saveUserId(bindUrl, uid); return; }
      renderFresh();
      toast("User ID " + uid);
    }, function () { delete _uidBusy[key]; toast("Could not start the lookup", "error"); });
  }
  function secIdentity(user, fallbackName, fallbackPlatform, fallbackEmail, emailUser, emailProfileUrl) {
    var rows = "", email = "", userId = "";
    if (user) {
      (user.reddits || []).forEach(function (r) { rows += kv("Reddit", '<span class="mono">u/' + esc(r) + "</span>"); });
      (user.discord_names.length ? user.discord_names : user.discord_ids).forEach(function (d) { rows += kv("Discord", esc(d)); });
      (user.facebooks || []).forEach(function (f) { rows += kv("Facebook", esc(f)); });
      (user.user_ids || []).forEach(function (id) { userId = id; rows += kv("User ID", '<a class="mono" href="' + esc(adminSessionsUrl(id)) + '" target="_blank" rel="noopener" title="Open sessions in the cloud admin">' + esc(id) + "</a>"); });
      // A legacy email is shown only until the User ID is known; after that the ID is the identifier.
      (user.emails || []).forEach(function (e, i) { if (!i) email = e; if (!userId) rows += kv("Email", '<span class="mono truncate">' + esc(e) + "</span>"); });
      if (user.session) rows += kv("Session", '<span class="mono truncate">' + esc(user.session) + "</span>");
      var act = userActivity(user), here = parseHash();
      var other = act.convos.filter(function (c) { return !(here.view === "modmail" && here.id === c.id); }).map(function (c) { return ["#/modmail/" + c.id, "ModMail: " + c.subject, c.ago]; })
        .concat(act.tickets.filter(function (t) { return !(here.view === "discord" && String(here.id) === String(tid(t))); }).map(function (t) { return ["#/discord/" + tid(t), "Discord #" + t.ticket_number, t.ago]; }))
        .concat(act.posts.filter(function (p) { return !(here.view === "posts" && here.id === p.id); }).map(function (p) { return ["#/posts/" + p.id, "Post: " + p.title, p.ago]; }));
      if (other.length) rows += '<div class="ctx-sub">Also wrote</div><div class="ctx-list">' + other.slice(0, 6).map(function (o) {
        return '<div class="ctx-item" data-go="' + esc(o[0]) + '"><div class="ci-top"><span class="truncate">' + esc(o[1]) + '</span><span class="rtime">' + esc(o[2] || "") + "</span></div></div>"; }).join("") +
        (other.length > 6 ? '<div class="ctx-empty">and ' + (other.length - 6) + " more in Profile 360</div>" : "") + "</div>";
    } else {
      rows += kv(fallbackPlatform || "User", esc(fallbackName));
      if (fallbackEmail) { email = fallbackEmail; rows += kv("Email", '<span class="mono truncate">' + esc(fallbackEmail) + "</span>"); }
    }
    // An ID looked up this session for an email that has no directory record yet (e.g. a Discord ticket).
    if (!userId && email && _uidByEmail[String(email).toLowerCase()]) {
      userId = _uidByEmail[String(email).toLowerCase()];
      rows = kv("User ID", '<a class="mono" href="' + esc(adminSessionsUrl(userId)) + '" target="_blank" rel="noopener">' + esc(userId) + "</a>") + rows;
    }
    var actions = "";
    if (user) actions += '<button class="btn sm" data-go="#/user/' + esc(user.id) + '">' + ic("user", "ico-sm") + "Profile 360</button>";
    actions += emailActions(emailUser, email, emailProfileUrl, userId);
    var foot = (user ? "" : '<div class="ctx-empty" style="margin-top:6px">Not linked to a known user yet.</div>') +
      (actions ? '<div class="ctx-actions">' + actions + "</div>" : "");
    return ctxSec("user", "Identity", rows + foot);
  }
  /* Older stored titles are the whole Slack line ("X transitioned <title> from A -> B"): keep the title. */
  function cleanJiraSummary(s) {
    s = String(s || "").replace(/^[\s·\-]+/, "");
    var m = /transitioned\s+([\s\S]+?)\s+from\s+[\s\S]+?(?:→|->|⟶|➡)\s*[\s\S]+$/.exec(s);
    return (m ? m[1] : s).trim();
  }
  /* Linked tickets in the side panel: one /jira-brief call per key set gives the URG result and the last
     comment written by a person (Jira automation / system notes skipped). Cached in D.jiraBrief. */
  function ensureJiraBrief(keys) {
    if (!keys.length) return;
    D.jiraBrief = D.jiraBrief || {}; state._briefReq = state._briefReq || {};
    var now = Date.now();
    var need = keys.filter(function (k) { var b = D.jiraBrief[k]; return (!b || now - (b._at || 0) > 120000) && !state._briefReq[k]; });
    if (!need.length) return;
    need.forEach(function (k) { state._briefReq[k] = 1; });
    window.CONSOLE.get("/jira-brief?keys=" + encodeURIComponent(need.join(","))).then(function (d) {
      var items = (d && d.items) || {};
      need.forEach(function (k) { D.jiraBrief[k] = items[k] || { none: true }; D.jiraBrief[k]._at = Date.now(); delete state._briefReq[k]; });
      render();
    }, function () { need.forEach(function (k) { delete state._briefReq[k]; }); });
  }
  function jiraBriefLine(k) {
    var b = (D.jiraBrief || {})[k];
    if (!b) return '<span class="muted">Loading…</span>';
    if (isUrgKey(k)) return b.update_result ? '<b class="jb-res">' + esc(b.update_result) + "</b>" : '<span class="muted">No result yet' + (b.status ? DOT + esc(b.status) : "") + "</span>";
    if (b.last_comment && b.last_comment.body) return '<span class="jb-who">' + esc(b.last_comment.author) + ":</span> " + esc(b.last_comment.body.replace(/\s+/g, " "));
    return '<span class="muted">' + esc(cleanJiraSummary(b.summary) || "No comments yet") + "</span>";
  }
  function secJira(keys, anchor) {
    ensureJiraBrief(keys);
    // "Add Jira Ticket" for any chat (item W4): pick an existing team ticket or create one with the
    // chat's communication link auto-filled. Reddit ModMail, Discord, and Reddit Posts all supported.
    var a = anchor || {};
    var addBtn = a.type
      ? '<div class="ctx-actions"><button class="btn sm" data-act="jira-add" data-anchor-type="' + esc(a.type) + '" data-anchor-ref="' + esc(a.ref) + '" title="Link an existing Jira ticket to this chat">' + ic("plus", "ico-sm") + "Link Jira Ticket</button>" +
        '<button class="btn sm" data-act="jira-new" data-anchor-type="' + esc(a.type) + '" data-anchor-ref="' + esc(a.ref) + '" title="Create a new Jira ticket (full topic form, 1:1 with Slack)">' + ic("plus", "ico-sm") + "Create Ticket</button>" +
        '<button class="btn sm" data-act="create-urgent" data-anchor-type="' + esc(a.type) + '" data-anchor-ref="' + esc(a.ref) + '" title="Create an Urgent Request (URG) linked to this chat">' + ic("bolt", "ico-sm") + "Create Urgent</button></div>"
      : "";
    var inner = keys.length
      ? '<div class="ctx-list">' + keys.map(function (k) {
          var found = jiraByKey(k);
          var j = found || { issue_key: k, summary: "", status: "?" };
          // Current Jira status: the fresh /jira-brief one (2 min), else the console's own list.
          var _st = ((D.jiraBrief || {})[k] || {}).status || (found ? j.status : "");
          var head = '<div class="ci-top">' + jkeyChip(j.issue_key) + (_st ? '<span class="st ' + statusClass(_st) + '" style="flex:0 0 auto">' + esc(_st) + "</span>" : "") + '<span class="truncate" style="font-size:12px;color:var(--muted)">' + esc(cleanJiraSummary(j.summary || ((D.jiraBrief || {})[k] || {}).summary)) + "</span></div>" +
            '<div class="truncate" style="font-size:12.5px;margin-top:4px">' + jiraBriefLine(k) + "</div>";
          // Tracked by the console -> open our Jira view; unknown ("?") -> jump straight to Jira.
          return found
            ? '<div class="ctx-item" data-go="#/jira/' + esc(j.issue_key) + '">' + head + "</div>"
            : '<a class="ctx-item" style="display:block;text-decoration:none;color:inherit" href="' + esc(jiraUrl(k)) + '" target="_blank" rel="noopener" title="Open in Jira (not tracked in the console)">' + head + "</a>";
        }).join("") + "</div>" + addBtn
      : '<div class="ctx-empty">No linked tickets.</div>' + addBtn;
    return ctxSec("link", "Linked tickets", inner);
  }
  function secMaintenance(items, anchor) {
    // Lists the maintenance-end subscriptions for THIS chat (items are already filtered by the
    // caller), plus the action to add one (mirrors the bot's !maintenance / Reddit flow).
    var a = anchor || {};
    var LANG = { en: "EN", ru: "RU", ua: "UA" };
    var list = (items && items.length)
      ? '<div class="ctx-list">' + items.map(function (s) {
          var lg = LANG[(s.language || "").toLowerCase()] || (s.language || "").toUpperCase();
          return '<div class="ctx-item"><div class="ci-top"><span class="truncate">' + esc(s.entity || "") +
            (lg ? " (" + esc(lg) + ")" : "") + '</span><span class="st">' + esc(s.type || "") + "</span></div>" +
            '<div class="muted" style="font-size:12px;margin-top:2px">The user is told automatically when it ends.</div></div>';
        }).join("") + "</div>"
      : "";
    var add = '<div class="ctx-actions"><button class="btn sm" data-act="add-maintenance" data-ctx-type="' + esc(a.type || "") + '" data-ctx-ref="' + esc(a.ref || "") + '">' + ic("plus", "ico-sm") + "Add Maintenance</button></div>";
    return ctxSec("wrench", "Maintenance", list + add);
  }
  var NOTAG_MARK = "no-tag-needed";   // reserved tag = "intentionally left untagged" (dismisses the alert)
  /* An item needs a tag when it has no tags at all (neither a real tag nor the ignore marker). Drives
     the yellow alert on posts/chats until a tag is added or "Ignore Tag" is used (item: tag alerts). */
  function needsTag(type, ref) { var a = tagsArrFor(type, ref); return !!a && a.length === 0; }
  function tagAlert(type, ref) {
    return needsTag(type, ref) ? '<span class="tag-alert" title="No tag set - add a tag or use Ignore Tag in the side panel">!</span>' : "";
  }
  function setTagIgnore(type, ref, want) {
    var arr = tagsArrFor(type, ref); if (!arr) return;
    function done() { render(); if (state.modal) renderModal(); }
    var has = arr.indexOf(NOTAG_MARK) >= 0;
    if (want) {
      if (has) { done(); return; }
      window.CONSOLE.post("/tags", { context_type: type, ref: ref, tag: NOTAG_MARK }).then(function () { _tagsLocal(type, ref, NOTAG_MARK, true); arr.push(NOTAG_MARK); logActivity("dismissed no-tag alert", type + " " + ref); done(); toast("Tag alert dismissed"); }, function () { toast("Could not save"); }); return;
    } else {
      if (!has) { done(); return; }
      window.CONSOLE.del("/tags?context_type=" + encodeURIComponent(type) + "&ref=" + encodeURIComponent(ref) + "&tag=" + encodeURIComponent(NOTAG_MARK)).then(function () { _tagsLocal(type, ref, NOTAG_MARK, false); var i = arr.indexOf(NOTAG_MARK); if (i >= 0) arr.splice(i, 1); done(); toast("Tag alert restored"); }, function () { toast("Could not save"); }); return;
    }
  }
  function secTags(tags, anchor) {
    var a = anchor || { type: "", ref: "" };
    tags = tags || [];
    var ignored = tags.indexOf(NOTAG_MARK) >= 0;
    var real = tags.filter(function (t) { return t !== NOTAG_MARK; });
    var chips = real.length
      ? real.map(function (t) {
          return '<span class="chip">' + ic("tag", "ico-sm") + esc(t) +
            '<button class="chip-x" title="Remove tag" data-act="tag-del" data-tag-type="' + esc(a.type) + '" data-tag-ref="' + esc(a.ref) + '" data-tag="' + esc(t) + '">' + ic("x", "ico-sm") + "</button></span>";
        }).join("")
      : (ignored ? '<span class="ctx-empty">No tag needed (alert dismissed).</span>' : '<span class="ctx-empty">No tags.</span>');
    var opts = (D.issueTags || []).map(function (t) { return '<option value="' + esc(t) + '">'; }).join("");
    var openKey = "tag|" + a.type + "|" + a.ref, isOpen = state.ctxAdd === openKey || !a.type;
    var add = isOpen ? '<div class="note-add" style="margin-top:10px"><input placeholder="Add a tag..." list="tag-suggestions" data-tag-input>' +
      '<datalist id="tag-suggestions">' + opts + "</datalist>" +
      '<button class="btn sm iconly" data-act="tag-add" data-tag-type="' + esc(a.type) + '" data-tag-ref="' + esc(a.ref) + '">' + ic("plus", "ico-sm") + "</button></div>" : "";
    var ignoreBtn = !a.type ? ""
      : ignored ? '<button class="btn sm" data-act="tag-unignore" data-tag-type="' + esc(a.type) + '" data-tag-ref="' + esc(a.ref) + '">' + ic("bell", "ico-sm") + "Restore tag alert</button>"
      : (real.length ? "" : '<button class="btn sm" data-act="tag-ignore" data-tag-type="' + esc(a.type) + '" data-tag-ref="' + esc(a.ref) + '">' + ic("x", "ico-sm") + "Ignore Tag</button>");
    var actions = (a.type && !isOpen ? '<button class="btn sm" data-act="ctx-add-open" data-key="' + esc(openKey) + '">' + ic("plus", "ico-sm") + "Add Tag</button>" : "") + ignoreBtn;
    return ctxSec("tag", "Tags", '<div class="tagwrap">' + chips + "</div>" + add + (actions ? '<div class="ctx-actions">' + actions + "</div>" : ""));
  }
  function secNotes(notes, anchor) {
    var inner = notes.length
      ? '<div class="ctx-list">' + notes.map(function (n) {
          return '<div class="note" style="box-shadow:none"><div class="ntext" style="font-size:13px">' + esc(n.text) + '</div><div class="nfoot">' + esc(n.author) + DOT + esc(n.ago) + "</div></div>";
        }).join("") + "</div>"
      : '<div class="ctx-empty">No notes yet.</div>';
    var openKey = "note|" + anchor.type + "|" + anchor.ref;
    var add = state.ctxAdd === openKey
      ? '<div class="note-add" style="margin-top:10px"><input placeholder="Add a note..." data-note-input>' +
        '<button class="btn sm iconly" data-act="note-add" data-ctx-type="' + esc(anchor.type) + '" data-ctx-ref="' + esc(anchor.ref) + '" data-ctx-label="' + esc(anchor.label) + '">' + ic("plus", "ico-sm") + "</button></div>"
      : '<div class="ctx-actions"><button class="btn sm" data-act="ctx-add-open" data-key="' + esc(openKey) + '">' + ic("plus", "ico-sm") + "Add note</button></div>";
    return ctxSec("notes", "Notes", inner + add);
  }
  function secHandoffs(anchor) {
    var a = anchor || {};
    var mine = (D.handoffs || []).filter(function (h) { return h.context_type === a.type && String(h.ref) === String(a.ref); });
    var inner = mine.length
      ? '<div class="ctx-list">' + mine.map(function (h) {
          return '<div class="note" style="box-shadow:none"><div class="ntext" style="font-size:13px">' + esc(h.text) + '</div><div class="nfoot">' + esc(h.from) + DOT + "for " + esc(h.to) + DOT + esc(h.ago) + "</div></div>";
        }).join("") + "</div>"
      : '<div class="ctx-empty">No handoffs for this chat.</div>';
    inner += '<div class="ctx-actions"><button class="btn sm" data-act="handoff-chat" data-ctx-type="' + esc(a.type || "") + '" data-ctx-ref="' + esc(a.ref || "") + '" data-ctx-label="' + esc(a.label || "") + '">' + ic("reply", "ico-sm") + "Leave handoff for this chat</button></div>";
    return ctxSec("reply", "Shift handoffs", inner);
  }
  /* Gaming Proposal section for a chat's context panel: send a game to the wishlist from
     any social (Reddit ModMail / Discord / Posts / Forum), and list proposals already added from this
     chat so the panel shows what was submitted here. */
  function secProposal(anchor) {
    var a = anchor || {};
    if (!a.type) return "";
    var key = a.type + ":" + a.ref;
    var added = (state.proposalsAdded && state.proposalsAdded[key]) || [];
    var list = added.length
      ? '<div class="ctx-list">' + added.map(function (n) {
          return '<div class="ctx-item"><div class="ci-top"><span class="truncate">' + ic("check", "ico-sm") + " " + esc(n) + "</span></div></div>";
        }).join("") + "</div>"
      : "";
    var btn = '<div class="ctx-actions"><button class="btn sm" data-act="proposal-add" data-anchor-type="' + esc(a.type) + '" data-anchor-ref="' + esc(a.ref) + '">' + ic("plus", "ico-sm") + "Add Gaming Proposal</button></div>";
    return ctxSec("plus", "Gaming Proposal", list + btn);
  }
  function ctxTabPref() {
    if (state.ctxTab) return state.ctxTab;
    try { state.ctxTab = localStorage.getItem("cmt-ctx-tab") || ""; } catch (e) { state.ctxTab = ""; }
    return state.ctxTab;
  }
  function contextPanel(cfg) {
    // Tags first, then linked tickets: the most used sections, no scrolling to reach them (laptop / phone).
    var build = {
      tags: function () { return secTags(cfg.tags || [], cfg.noteAnchor); },
      jira: function () { return cfg.hideJira ? "" : secJira(cfg.jiraKeys || [], cfg.noteAnchor); },
      identity: function () { return secIdentity(cfg.user, cfg.fallbackName, cfg.fallbackPlatform, cfg.fallbackEmail, cfg.emailUser, cfg.emailProfileUrl); },
      maintenance: function () { return cfg.hideMaintenance ? "" : secMaintenance(cfg.maintenance || [], cfg.noteAnchor); },
      proposal: function () { return secProposal(cfg.noteAnchor); },
      notes: function () { return secNotes(cfg.notes || [], cfg.noteAnchor); },
      handoffs: function () { return cfg.noteAnchor ? secHandoffs(cfg.noteAnchor) : ""; }
    };
    var pr = layoutPrefs().ctx;
    // Dispatch desk: the sections become tabs (plus "All", the old stacked view); the choice is kept per browser.
    var tabKeys = [], panes = [];
    orderedKeys(CTX_SECTIONS.map(function (c) { return c.key; }), pr.order).forEach(function (k) {
      if (pr.hidden[k]) return;
      var h = build[k]();
      if (!h) return;
      tabKeys.push(k);
      panes.push('<div class="ctx-pane" data-ctx-pane="' + k + '">' + h + "</div>");
    });
    var curTab = ctxTabPref();
    if (curTab !== "all" && tabKeys.indexOf(curTab) < 0) curTab = tabKeys[0] || "all";
    var tabLabel = {};
    CTX_SECTIONS.forEach(function (c) { tabLabel[c.key] = c.label; });
    var strip = '<div class="ctx-tabs" role="tablist" aria-label="Chat context">' + tabKeys.concat(["all"]).map(function (k) {
      var on = k === curTab;
      return '<button class="ctx-tab' + (on ? " on" : "") + '" role="tab" aria-selected="' + (on ? "true" : "false") + '" data-act="ctx-tab" data-key="' + k + '">' + esc(k === "all" ? "All" : tabLabel[k]) + "</button>";
    }).join("") + "</div>";
    var html = strip + panes.join("");
    return '<div class="pane context" data-ctx-tab="' + curTab + '">' + html +
      '<div class="ctx-customize"><button class="gcs-link" data-act="customize-ctx">' + ic("wrench", "ico-sm") + "Customize panel</button></div></div>";
  }

  var DOT = " | "; /* meta separator */
  /* The Jira transfer buttons keep their Russian labels to match the Slack flow (language rule). */
  // Jira comment texts the team posts (kept in Russian on purpose); the buttons show English labels.
  var PEREDANO = "Передано";
  var PEREDANO_ZAKRYTO = "Передано, закрыто";

  /* ---------- Inbox ---------- */
  /* Unified Inbox items across Reddit ModMail, Discord ModMail, and Reddit Posts (items S6/S7). */
  function inboxItems() {
    var items = [];
    D.redditModmail.forEach(function (c) {
      var last = c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
      items.push({ type: "convo", ref: c.id, icon: "mail", src: "reddit", title: c.subject, who: "u/" + c.participant,
        sub: (last && last.body) || c.preview || "", ts: c.ts, status: deriveRedditStatus(c), go: "#/modmail/" + c.id, obj: c });
    });
    D.discordTickets.forEach(function (t) {
      items.push({ type: "ticket", ref: tid(t), icon: "discord", src: "discord", title: "#" + t.ticket_number + DOT + t.user_name,
        who: t.user_name, sub: t.last_message || t.metadata.description || "", ts: t.ts, status: deriveDiscordStatus(t), go: "#/discord/" + tid(t), obj: t });
    });
    D.redditPosts.forEach(function (p) {
      items.push({ type: "post", ref: p.id, icon: "posts", src: "post", title: p.title, who: p.subreddit + DOT + "u/" + p.author,
        sub: (p.thread && p.thread[0] && p.thread[0].body) || p.body || "", ts: p.ts,
        status: (p.ignored ? "ignored" : (p.has_reply ? "replied" : "new")), go: "#/posts/" + p.id, obj: p });
    });
    // Jira tickets handed to the community team (status "CM In Progress") - the same transition
    // that fires a Slack notification. Surfaced in Monitor so the team notices the handoff (U3).
    D.jira.forEach(function (j) {
      if (j.status !== "CM In Progress") return;
      items.push({ type: "jira", ref: j.issue_key, icon: "jira", src: "jira", title: j.issue_key + DOT + j.summary,
        who: j.reporter ? "u/" + j.reporter : "Jira", sub: "Moved to CM In Progress", ts: j.status_since,
        status: "cm_in_progress", go: chatForJira(j) || ("#/jirachat/" + j.issue_key), jiraKey: j.issue_key, obj: j });
    });
    (D.urgReview || []).forEach(function (u) {
      items.push({ type: "urg", ref: u.key, icon: "jira", src: "jira", title: u.key + DOT + cleanJiraSummary(u.summary),
        who: "URG" + DOT + "Review", sub: u.update_result || "", ts: u.updated, status: "urg_review",
        go: chatForJira({ issue_key: u.key, communication_link: u.communication_link }) || ("#/jirachat/" + u.key), jiraKey: u.key, obj: u });
    });
    // Discord forum posts (needs a reply = last message not from the team) + moderator mentions.
    (D.discordForum || []).forEach(function (f) {
      var msgs = f.messages || [], last = msgs[msgs.length - 1];
      items.push({ type: "dforum", ref: f.id, icon: "discord", src: "discord", title: f.title,
        who: (f.forum || "Forum") + DOT + f.author, sub: (last && last.content) || "", ts: f.ts,
        status: forumStatus(f), go: "#/discord/forum/" + f.id, obj: f });
    });
    (D.discordMentions || []).forEach(function (m) {
      items.push({ type: "dmention", ref: m.id, icon: "discord", src: "discord", title: "Mention in #" + m.channel_name,
        who: m.author, sub: m.content, ts: m.ts, status: m.status || "new", go: "#/discord/mentions/" + m.id, obj: m });
    });
    return items;
  }
  var INBOX_TERMINAL_MM = { done: 1, waiting_user: 1, postponed: 1 };   // ModMail leaves Monitor at these
  function inboxStatusLabel(it) {
    if (it.type === "jira") return "CM In Progress";
    if (it.type === "urg") return "URG Review";
    return it.type === "post" ? (it.status === "ignored" ? "Ignored" : (it.status === "replied" ? "Replied" : "No reply")) : mmStatusLabel(it.status);
  }
  function inboxCard(it) {
    var n = newCount(it.type, it.obj, it.ref), unread = isUnread(it.type, it.obj, it.ref);
    var lead = (n > 0 && unread) ? '<span class="unread-av qc-n" title="' + n + ' new">' + (n > 99 ? "99+" : n) + "</span>" : "";
    return '<div class="qrow mon-row' + (unread ? " is-unread" : "") + '" role="row" data-go="' + it.go + '">' +
      qCell("qc-conv", '<span class="qc-line">' + lead + '<span class="fc-title truncate">' + esc(it.title) + "</span></span>" +
        '<span class="fc-sub truncate">' + ((it.jiraKey) ? jiraBriefLine(it.jiraKey) : esc(it.sub)) + "</span>", "Conversation") +
      qCell("qc-status", '<span class="st ' + statusClass(it.status) + '">' + esc(inboxStatusLabel(it)) + "</span>" + srcBadge(it.src), "Status") +
      qCell("qc-who truncate", esc(it.who), "From") +
      qCell("qc-when rtime", whenHtml(it.ts), "When") +
      (it.jiraKey ? '<div class="qc-actions" role="cell"><a class="btn sm ghost" href="' + esc(jiraUrl(it.jiraKey)) + '" target="_blank" rel="noopener" title="Open this ticket in Jira">Open in Jira</a></div>' : "") +
      "</div>";
  }
  /* Inbox hero: a greeting + a few at-a-glance stats. "Needs attention" and "Awaiting reply" are
     scoped to the current shift window (see shiftWindowStart); "Active Jira" is a plain live count. */
  function greetingText() {
    // Today's date in Kyiv time (the team's clock), e.g. "Wednesday, 11 November".
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", weekday: "long", day: "numeric", month: "long" }).format(new Date());
    } catch (e) { return "Today"; }
  }
  var JIRA_TERMINAL = { "Done": 1, "Closed": 1, "Cancelled": 1, "Canceled": 1, "Resolved": 1 };
  /* Shift window for the Inbox stats: scoped to the CURRENT user's working hours. The per-day schedule
     editor (Admin > Users > Working hours -> m.schedule) is the single source of truth; m.hours is just
     its human summary. The window opens at the most recent shift boundary strictly before now - the
     start of the shift you're on, or (when off shift) the end of your last shift (the hand-off). All in
     Europe/Kyiv; overnight shifts (end <= start) supported. Falls back to defaultSchedule() if unset. */
  var _SCHED_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  function shiftWindowStart() {
    var u = state.user; if (!u) return null;
    var sched = (u.schedule && typeof u.schedule === "object") ? u.schedule : defaultSchedule();
    var kp = _kyivParts(new Date()); if (!kp) return null;
    var todayIdx = (new Date(Date.UTC(+kp.year, +kp.month - 1, +kp.day)).getUTCDay() + 6) % 7;  // mon=0..sun=6
    var nowMin = (+kp.hour) * 60 + (+kp.minute), best = null;
    for (var back = 0; back <= 8; back++) {
      var s = sched[_SCHED_ORDER[((todayIdx - back) % 7 + 7) % 7]];
      if (!s || !s.on) continue;
      var st = _tmin(_hhmm(s.start)), en = _tmin(_hhmm(s.end)), overnight = en <= st;
      var starts = back * 1440 + (nowMin - st);                          // shift start boundary (minutes ago)
      var ends = back * 1440 + (nowMin - (overnight ? en + 1440 : en));  // shift end boundary (minutes ago)
      if (starts > 0 && (best === null || starts < best)) best = starts;
      if (ends > 0 && (best === null || ends < best)) best = ends;
    }
    return best === null ? null : Date.now() - best * 60000;
  }

  /* ---------- Agents / presence (home "Team" tab) ----------
     Live presence: each open console pings /presence on load and on every auto-refresh; an agent is
     "online" if seen in the last 3 minutes. Shown alongside their Working-hours shift (on/off shift),
     which is a separate signal (someone can be on shift but not at the console, or vice-versa). */
  var PRESENCE_ONLINE_MS = 3 * 60 * 1000;
  function sendPresence() { window.CONSOLE.post("/presence", {}).then(function () {}, function () {}); }
  function presenceAt(email) { var p = (D.presence || {})[String(email || "").toLowerCase()]; return p ? _utcDate(p) : null; }
  function isOnline(email) { var d = presenceAt(email); return !!d && (Date.now() - d.getTime() < PRESENCE_ONLINE_MS); }
  /* Is `u` inside their Working-hours shift right now (Europe/Kyiv; overnight shifts supported)? */
  function isOnShift(u) {
    var sched = (u && u.schedule && typeof u.schedule === "object") ? u.schedule : null;
    if (!sched) return false;
    var kp = _kyivParts(new Date()); if (!kp) return false;
    var todayIdx = (new Date(Date.UTC(+kp.year, +kp.month - 1, +kp.day)).getUTCDay() + 6) % 7;  // mon=0..sun=6
    var nowMin = (+kp.hour) * 60 + (+kp.minute);
    function within(dayIdx, tail) {
      var s = sched[_SCHED_ORDER[((dayIdx % 7) + 7) % 7]];
      if (!s || !s.on) return false;
      var st = _tmin(_hhmm(s.start)), en = _tmin(_hhmm(s.end)), overnight = en <= st;
      if (tail) return overnight && nowMin < en;      // early-morning tail of an overnight shift from the prev day
      if (overnight) return nowMin >= st;             // late-night part of today's overnight shift
      return nowMin >= st && nowMin < en;             // normal day shift
    }
    return within(todayIdx, false) || within(todayIdx - 1, true);
  }
  /* Today's calendar value for a bound member (VACATION / SICK LEAVE / OFFLINE / a shift / ""). Europe/Kyiv. */
  function calCellToday(memberName) {
    if (!memberName) return "";
    var kp = _kyivParts(new Date()); if (!kp) return "";
    var today = kp.day + "." + kp.month + "." + kp.year;   // dd.mm.yyyy (padded, matches the calendar)
    var months = (D.schedule && D.schedule.months) || [];
    for (var i = 0; i < months.length; i++) {
      var days = months[i].days || [];
      for (var j = 0; j < days.length; j++) {
        if (days[j].date === today) return (days[j].shifts && days[j].shifts[memberName]) || "";
      }
    }
    return "";
  }
  /* Is `nowMin` inside the Testing sub-window of a day slot? */
  function _inTest(s, nowMin) {
    if (!s || !s.test_start || !s.test_end) return false;
    var a = _tmin(_hhmm(s.test_start)), b = _tmin(_hhmm(s.test_end));
    if (a === b) return false;
    return a < b ? (nowMin >= a && nowMin < b) : (nowMin >= a || nowMin < b);
  }
  /* Current availability of a member: {key,label,cls}. A calendar Vacation/Sick day (via the profile's
     schedule_member binding) overrides the profile hours; otherwise the Testing window shows as "Testing",
     the rest of the shift as "On duty", and outside the shift as "Off shift". */
  function statusNow(u) {
    var cell = String(calCellToday(u && (u.schedule_member || u.display_name || u.name)) || "").toUpperCase();
    if (cell === "VACATION") return { key: "vacation", label: "Vacation", cls: "vac" };
    if (cell === "SICK LEAVE" || cell === "SICK") return { key: "sick", label: "Sick leave", cls: "sick" };
    var sched = (u && u.schedule && typeof u.schedule === "object") ? u.schedule : null;
    if (!sched || !isOnShift(u)) return { key: "off", label: "Off shift", cls: "off" };
    var kp = _kyivParts(new Date()); if (!kp) return { key: "off", label: "Off shift", cls: "off" };
    var todayIdx = (new Date(Date.UTC(+kp.year, +kp.month - 1, +kp.day)).getUTCDay() + 6) % 7;
    var nowMin = (+kp.hour) * 60 + (+kp.minute);
    if (_inTest(sched[_SCHED_ORDER[todayIdx]], nowMin)) return { key: "testing", label: "Testing", cls: "testing" };
    return { key: "duty", label: "On duty", cls: "ok" };
  }
  function agentsList() {
    // Roster visible to every signed-in user (/team-roster); admins also have the fuller D.team.
    var team = (D.roster && D.roster.length) ? D.roster : ((D.team && D.team.length) ? D.team : (D.members || []));
    return team.map(function (m) {
      var email = m.email || m.id || "";
      return { name: m.display_name || m.name || email, email: email,
        online: isOnline(email), lastSeen: presenceAt(email), status: statusNow(m), role: m.role || "" };
    }).sort(function (a, b) { return (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name); });
  }
  function viewTeam() {
    var list = agentsList();
    var onlineN = list.filter(function (a) { return a.online; }).length;
    var cards = list.map(function (a) {
      var initials = (a.name || "?").split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ""; }).join("").toUpperCase();
      var pres = a.online ? "Online" : (a.lastSeen ? "Last seen " + timeText(a.lastSeen.toISOString()) : "Offline");
      return '<div class="agent-card">' +
        '<div class="agent-av">' + esc(initials) + '<span class="pres-dot ' + (a.online ? "on" : "off") + '"></span></div>' +
        '<div class="agent-main"><div class="agent-name truncate">' + esc(a.name) + (a.role === "admin" ? ' <span class="chip soft" style="padding:0 6px">admin</span>' : "") + "</div>" +
        '<div class="agent-sub"><span class="' + (a.online ? "pres-online" : "faint") + '">' + esc(pres) + '</span><span class="st ' + (a.status.cls || "") + '" style="font-size:11px">' + esc(a.status.label) + "</span></div></div></div>";
    }).join("") || emptyState("user", "No agents", "No console users to show yet.");
    return '<div class="agents-wrap"><div class="pane-title" style="margin-bottom:14px"><h2>Team</h2><span class="count-pill">' + onlineN + " online</span></div>" +
      '<div class="agents-grid">' + cards + "</div></div>";
  }

  /* Home screen: the running maintenances next to the To-Do (as in the first demo), newest first, with
     their live "running for" timers. Click opens the Maintenance tab. */
  function inboxMaintPane() {
    var TYPE = { game: "Game", server: "Server", playground: "Server", brazil: "Only for Brazil" };
    var list = (D.maintenances || []).slice().sort(function (a, b) {
      var x = _utcDate(a.started_at), y = _utcDate(b.started_at);
      return (y ? y.getTime() : 0) - (x ? x.getTime() : 0);
    });
    var shown = list.slice(0, 30);
    var rows = shown.map(function (m) {
      var dt = _utcDate(m.started_at), startMs = dt ? dt.getTime() : 0;
      return '<div class="qrow im-row" role="row" data-go="#/maintenance" style="cursor:pointer">' +
        qCell("qc-name", '<span class="rname truncate">' + esc(m.entity || "-") + "</span>" +
          '<span class="im-sub"><span class="im-type' + (m.type === "brazil" ? " br" : "") + '">' + esc(TYPE[m.type] || m.type || "") + "</span>" +
          (startMs ? '<span class="faint">since ' + esc(fmtKyivShort(dt)) + "</span>" : "") + (m.eta ? '<span class="faint">ETA ' + esc(m.eta) + "</span>" : "") + "</span>", "Name") +
        qCell("qc-timer", '<span class="mnt-timer mono" data-start="' + startMs + '">' + esc(startMs ? fmtDuration(Date.now() - startMs) : "-") + "</span>", "Running") + "</div>";
    }).join("");
    return '<div class="inbox-col im-col"><div class="feed"><div class="pane-title" style="margin-bottom:12px"><h2>Maintenance</h2><span class="muted" style="font-size:13px">Last ' + shown.length + "</span>" +
      '<a class="btn sm ghost" style="margin-left:auto" data-go="#/maintenance">All</a></div>' +
      (rows ? qTable("q-im", ["Name", "Running"], rows)
            : emptyState("wrench", "No maintenance running", "Running game and server maintenances show up here.")) + "</div></div>";
  }
  function viewInbox() {
    var ql = state.q.toLowerCase();
    function okQ(it) { return !ql || (it.title + " " + it.who + " " + it.sub).toLowerCase().indexOf(ql) >= 0; }
    // Monitor board (V4): chats that NEED ATTENTION (New / In progress / Needs review), posts with
    // No reply, and Jira CM handoffs still awaiting one of our Jira users - everything else (Waiting
    // on user, Postponed, Done, replied/ignored posts, answered CM tickets) is hidden. History
    // items (>5d inactive) are excluded too. Sorted by real last activity.
    var monitor = inboxItems().filter(function (it) {
      if (!okQ(it)) return false;
      if (it.type === "jira") return it.status === "cm_in_progress" && it.obj.cm_awaiting_reply !== false;   // newly-arrived / not-yet-answered (V4)
      if (it.type === "urg") return true;
      if (inHistory(it.ts)) return false;
      if (it.type === "post") return it.status === "new";
      if (it.type === "dforum" || it.type === "dmention") return it.status === "new";
      return !INBOX_TERMINAL_MM[it.status];   // New, Needs review AND In progress
    });
    monitor.sort(function (a, b) { var ta = _utcDate(a.ts), tb = _utcDate(b.ts); return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0); });
    ensureJiraBrief(monitor.filter(function (it) { return it.jiraKey; }).slice(0, LIST_CAP).map(function (it) { return it.jiraKey; }));
    var mCards = monitor.slice(0, LIST_CAP).map(inboxCard).join("");
    // First load still running (slow start): show skeletons, not tasks / counts built from empty lists.
    var loading = !!state.loadingData;
    var monPane = '<div class="inbox-col"><div class="feed"><div class="pane-title" style="margin-bottom:12px"><h2>Monitor</h2><span class="count-pill">' + monitor.length + "</span></div>" +
      (loading ? skeletonRows(6) : mCards ? qTable("q-mon", ["Conversation", "Status", "From", "When"], mCards) + capNote(monitor.length) : emptyState("inbox", "Quiet", "No active tickets or new posts right now.")) + "</div></div>";
    // To-Do Activity: everything that needs an action, as tasks. Non-Jira tasks clear themselves the
    // moment the live status changes (replied / ignored / we wrote back); Jira uses a manual flow.
    var todo = todoItems().filter(function (t) { return !ql || (t.title + " " + t.who + " " + t.action).toLowerCase().indexOf(ql) >= 0; });
    var tCards = todo.slice(0, LIST_CAP).map(todoCard).join("");
    // Persistent Shift handoffs surface: stays in the Inbox until Marked done (server-side), not just
    // dismissed on the start-of-shift popup. Each card shows who left it, when, and where.
    var myHo = myHandoffs().filter(function (h) { return !ql || ((h.text || "") + " " + (h.from || "") + " " + (h.refLabel || "")).toLowerCase().indexOf(ql) >= 0; });
    var hoSection = myHo.length ? '<div class="pane-title" style="margin-bottom:12px"><h2>Shift handoffs</h2><span class="count-pill">' + myHo.length + "</span></div>" +
      myHo.map(handoffCard).join("") + '<div style="height:16px"></div>' : "";
    var todoPane = '<div class="inbox-col"><div class="feed">' + hoSection + '<div class="pane-title" style="margin-bottom:12px"><h2>To-Do Activity</h2><span class="count-pill">' + todo.length + "</span></div>" +
      (loading ? skeletonRows(6) : tCards ? qTable("q-todo", ["Task", "Subject", "From", "When"], tCards) : emptyState("check", "No open tasks", "Nothing is waiting for a reply.")) + "</div></div>";
    var sws = shiftWindowStart();
    function inWin(ts) { if (!sws) return true; var d = _utcDate(ts); return !d || d.getTime() >= sws; }
    var needAttn = monitor.filter(function (it) { return inWin(it.ts); }).length;
    var awaiting = todo.filter(function (t) { return t.kind === "reply" && inWin(t.ts); }).length;
    var swLabel = sws ? "since " + fmtKyivShort(new Date(sws)) : "";
    // one slim, clickable summary strip instead of three big half-empty cards (Active Jira is gone
    // with the Jira page). Counts come from the same live statuses as the lists.
    function _cnt(st) {
      return (D.redditModmail || []).filter(function (c) { return !inHistory(c.ts) && deriveRedditStatus(c) === st; }).length +
             (D.discordTickets || []).filter(function (t) { return deriveDiscordStatus(t) === st; }).length;
    }
    function sstat(n, label, cls, go, color) {
      return '<button class="sstat ' + cls + '"' + (go ? ' data-go="' + go + '"' : ' data-act="inbox-tab" data-tab="monitor"') + '><b' + (color ? ' style="color:' + color + '"' : "") + ">" + (loading ? "&middot;&middot;&middot;" : n) + "</b><span>" + esc(label) + "</span></button>";
    }
    var hero = '<div class="inbox-hero"><div class="hero-top"><div class="greeting">' + esc(greetingText()) + "</div>" + "__TABS__" + "</div>" +
      '<div class="sstrip">' +
        sstat(_cnt("needs_review"), "Needs review", "s-rev") +
        sstat(_cnt("waiting_user"), "Waiting on user", "s-wait") +
        sstat(_cnt("new"), "New", "s-new") +
        sstat(awaiting, "Awaiting reply", "") +
        sstat((D.maintenances || []).length, "Maintenances", "s-mnt", "#/maintenance") +
        '<span class="sstrip-note">' + esc(swLabel ? "Your shift " + swLabel : "") + "</span>" +
      "</div></div>";
    // To-Do (default) | Monitor | Team - three separate tabs. Old "board" state maps to To-Do.
    var tab = state.inboxTab === "team" ? "team" : (state.inboxTab === "monitor" ? "monitor" : "todo");
    function _tc(n) { return (n && !loading) ? ' <span class="tab-count">' + n + "</span>" : ""; }
    var tabbar = '<div class="home-tabs">' +
      '<button class="home-tab' + (tab === "todo" ? " active" : "") + '" data-act="inbox-tab" data-tab="todo">' + ic("check", "ico-sm") + "To-Do" + _tc(todo.length) + "</button>" +
      '<button class="home-tab' + (tab === "monitor" ? " active" : "") + '" data-act="inbox-tab" data-tab="monitor">' + ic("inbox", "ico-sm") + "Monitor" + _tc(monitor.length) + "</button>" +
      '<button class="home-tab' + (tab === "team" ? " active" : "") + '" data-act="inbox-tab" data-tab="team">' + ic("user", "ico-sm") + "Team</button></div>";
    var body = tab === "team" ? viewTeam()
      : (tab === "monitor" ? '<div class="inbox-cols one">' + monPane + "</div>"
         : '<div class="inbox-cols todo-split">' + todoPane + inboxMaintPane() + "</div>");
    return '<div class="inbox-wrap">' + hero.replace("__TABS__", tabbar) + body + "</div>";
  }
  /* To-Do tasks derived live from the current state. Reply/post tasks auto-clear via status; the two
     Jira kinds carry a manual flow that mirrors the Slack buttons (see todoCard). */
  var FB_CHECK_MS = 4 * 60 * 60 * 1000;   // remind to check the Facebook group after 4h without a check
  /* The FB group is "overdue" (drives the To-Do reminder AND the Facebook rail badge) when a group link
     is configured and it hasn't been opened/checked in FB_CHECK_MS. */
  function fbCheckOverdue() {
    if (!fbGroupUrl() || state.fbGroupCheck == null) return false;   // not loaded yet -> unknown, not "never checked"
    var at = state.fbGroupCheck && state.fbGroupCheck.at;
    var last = at ? _utcDate(at) : null;
    return !last || (Date.now() - last.getTime()) >= FB_CHECK_MS;
  }
  function todoItems() {
    var tasks = [], handled = D.jiraHandled || {}, dismissed = D.jiraDismissed || {};
    D.redditPosts.forEach(function (p) {
      if (p.ignored || p.has_reply || inHistory(p.ts)) return;
      tasks.push({ kind: "reply", src: "post", title: p.title, who: p.subreddit + DOT + "u/" + p.author,
        action: "Respond to post", go: "#/posts/" + p.id, ts: p.ts });
    });
    D.redditModmail.forEach(function (c) {
      var st = deriveRedditStatus(c);
      if ((st !== "new" && st !== "needs_review") || inHistory(c.ts)) return;
      tasks.push({ kind: "reply", src: "reddit", title: c.subject, who: "u/" + c.participant,
        action: "Respond in Reddit", go: "#/modmail/" + c.id, ts: c.ts });
    });
    D.discordTickets.forEach(function (t) {
      var st = deriveDiscordStatus(t);
      if ((st !== "new" && st !== "needs_review") || inHistory(t.ts)) return;
      tasks.push({ kind: "reply", src: "discord", title: "#" + t.ticket_number + DOT + t.user_name, who: t.user_name,
        action: "Respond in Discord", go: "#/discord/" + tid(t), ts: t.ts });
    });
    var STUCK_MS = 5 * 24 * 3600 * 1000, _nowMs = Date.now();   // "stuck in CM In Progress" threshold: 5 days, matching the old Slack alert
    // Until the forwarded/dismissed markers have loaded we can't tell which tickets are handled: show no
    // Jira cards rather than flash ones that are already done.
    ((!D.jiraHandled || !D.jiraDismissed) ? [] : D.jira).forEach(function (j) {
      if (j.status !== "CM In Progress") return;
      if (dismissed[j.issue_key] === (j.status_since || "")) return;   // manually dismissed -> hidden until it moves (item: Dismiss)
      var dropped = (j.cm_awaiting_reply === false) ||
        (handled[j.issue_key] && handled[j.issue_key] === (j.status_since || ""));   // answered/forwarded this cycle
      if (!dropped) {
        tasks.push({ kind: "jira_so", src: "jira", ref: j.issue_key, title: j.issue_key + DOT + j.summary,
          who: "SO - CM In Progress", action: "Transfer to the user", ext: j.url || "", go: chatForJira(j) || ("#/jirachat/" + j.issue_key), ts: j.status_since, since: j.status_since || "" });
        return;
      }
      // Already answered/forwarded but STILL sitting in CM In Progress for 5+ days -> resurface it as
      // "stuck" so it doesn't silently rot (mirrors the old Slack "stuck in CM In Progress" alert).
      var since = _utcDate(j.status_since);
      if (since && (_nowMs - since.getTime()) >= STUCK_MS) {
        tasks.push({ kind: "jira_stuck", src: "jira", ref: j.issue_key, title: j.issue_key + DOT + j.summary,
          who: "SO - stuck in CM In Progress 5d+", action: "Transfer to the user", ext: j.url || "", go: chatForJira(j) || ("#/jirachat/" + j.issue_key), ts: j.status_since, since: j.status_since || "" });
      }
    });
    (D.urgReview || []).forEach(function (u) {
      if (dismissed[u.key] === (u.updated || "")) return;   // manually dismissed
      // Surface the URG "Update result" (Fixed / Disabled / ...) next to the transfer action so the
      // operator sees the resolution without opening Jira.
      var recs = (u.recipients && u.recipients.length) ? u.recipients : [{ rid: "", email: "", link: u.communication_link }];
      var total = u.recipients_total || recs.length;
      recs.forEach(function (rc, i) {
        var many = total > 1;
        tasks.push({ kind: "jira_urg", src: "jira", ref: u.key, rid: rc.rid, title: u.key + DOT + u.summary,
          who: "URG - Review" + (u.update_result ? DOT + u.update_result : "") + (many ? DOT + "User " + (total - recs.length + i + 1) + " of " + total : "") + (rc.email ? DOT + rc.email : ""),
          action: "Transfer to the user",
          ext: u.url || "", go: chatForJira({ issue_key: u.key, communication_link: rc.link || u.communication_link }) || ("#/jirachat/" + u.key), ts: u.updated, since: u.updated || "" });
      });
    });
    (D.jiraL1 || []).forEach(function (x) {
      var tg = l1Target(x);
      tasks.push({ kind: "jira_l1", src: "jira", ref: x.id, title: x.issue_key + (x.summary ? DOT + x.summary : ""),
        who: tg.label + (x.added_by && x.added_by !== "linked chat" ? DOT + "added by " + x.added_by : ""),
        action: "Update the user - L1 In Progress", ext: x.url || "", go: tg.go || ("#/jirachat/" + x.issue_key), ts: x.entered_at, hasComment: !!x.has_comment });
    });
    (D.discordForum || []).forEach(function (f) {
      if (forumStatus(f) !== "new" || inHistory(f.ts)) return;   // needs a reply, respecting Replied/Ignored triage
      tasks.push({ kind: "reply", src: "discord", title: f.title, who: (f.forum || "Forum") + DOT + f.author,
        action: "Respond in Discord forum", go: "#/discord/forum/" + f.id, ts: f.ts });
    });
    (D.discordMentions || []).forEach(function (m) {
      if ((m.status || "new") !== "new" || inHistory(m.ts)) return;   // dropped once moved to History 
      tasks.push({ kind: "reply", src: "discord", title: "Mention in #" + m.channel_name, who: m.author,
        action: "Respond to mention", go: "#/discord/mentions/" + m.id, ts: m.ts });
    });
    (D.telegramMessages || []).forEach(function (m) {
      if (m.answered || m.ignored || inHistory(m.ts)) return;   // unanswered Telegram messages 
      tasks.push({ kind: "reply", src: "telegram", title: (m.is_comment ? "Comment" : "Chat") + (m.text ? DOT + String(m.text).slice(0, 60) : ""),
        who: "@" + (m.username || m.user || ""), action: "Respond in Telegram", go: "#/telegram", ts: m.ts });
    });
    // Facebook group SLA - a console-only unread To-Do reminder (NOT a Telegram alert anymore). Shows
    // when the group has a link configured AND it hasn't been opened/checked in FB_CHECK_MS; it clears
    // itself the moment someone opens the group (that POSTs /fb-group-check, updating state.fbGroupCheck).
    if (fbCheckOverdue()) {
      var _fbAt = state.fbGroupCheck && state.fbGroupCheck.at;
      tasks.push({ kind: "fbcheck", src: "facebook", title: "Check the Facebook group",
        who: _fbAt ? "Last checked " + timeText(_fbAt) : "Never checked", unread: true,
        action: "Open the Facebook group", go: "#/channels", ts: _fbAt || null });
    }
    tasks.sort(function (a, b) { var ta = _utcDate(a.ts), tb = _utcDate(b.ts); return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0); });
    return tasks;
  }
  /* Who an L1 follow-up is for, resolved against what the console already knows: a User ID opens that
     person's profile, a Discord / Reddit link opens the chat. */
  function l1Target(x) {
    var v = String(x.value || "");
    if (x.kind === "uid") {
      var u = (D.users || []).filter(function (p) { return _inList(p.user_ids, v); })[0];
      var nm = u ? (u.reddit ? "u/" + u.reddit : (u.discord_name || u.facebook || "")) : "";
      return { label: "User ID " + v + (nm ? DOT + nm : ""), go: u ? "#/user/" + u.id : "" };
    }
    if (x.kind === "discord") {
      var t = ticketByKey(v);
      return t ? { label: "Discord #" + t.ticket_number + DOT + t.user_name, go: "#/discord/" + tid(t) } : { label: "Discord ticket", go: "" };
    }
    if (x.kind === "reddit") {
      var c = convoById(v);
      return c ? { label: "Reddit u/" + c.participant, go: "#/modmail/" + c.id } : { label: "Reddit modmail " + v, go: "#/modmail/" + v };
    }
    if (x.kind === "session") return { label: "Session " + v.slice(0, 8), go: "" };
    return { label: x.label || v, go: "" };
  }
  /* Done on an L1 follow-up: the ticket's status is never changed. If the user came from one of our Jira
     comments, the server answers "Передано" under that comment; if that fails the card comes back. */
  function l1Done(id) {
    var item = (D.jiraL1 || []).filter(function (x) { return x.id === id; })[0];
    D.jiraL1 = (D.jiraL1 || []).filter(function (x) { return x.id !== id; });
    render();
    window.CONSOLE.postMsg("/jira-l1-todo", { id: id }).then(function (res) {
      if (res.status >= 200 && res.status < 300) {
        toast(res.data && res.data.replied ? "Done - replied \"Передано\" under the comment" : "Marked as done");
        logActivity("updated user for " + String(id).split("|")[0], "");
        return;
      }
      if (item) { D.jiraL1 = (D.jiraL1 || []).concat([item]); render(); }
      toast((res.data && res.data.error) || "Could not save, try again", "error");
    }, function () {
      if (item) { D.jiraL1 = (D.jiraL1 || []).concat([item]); render(); }
      toast("Could not save, try again", "error");
    });
  }
  function todoCard(t) {
    var meta = qCell("qc-task", '<span class="td-action">' + esc(t.action) + "</span>" + srcBadge(t.src), "Task") +
      qCell("qc-subj truncate", esc(t.title), "Subject") +
      qCell("qc-who truncate", esc(t.who), "From") +
      qCell("qc-when rtime", t.ts ? whenHtml(t.ts) : "", "When");
    var jiraLink = '<a class="btn sm ghost" href="' + esc(t.ext || "#") + '" target="_blank" rel="noopener">Open in Jira</a>';
    // Dismiss just hides the card (no Jira change), until the ticket re-enters this status.
    // Clicking a Jira card opens the chat it came from (when known); Jira itself has its own button.
    var goAttr = t.go ? ' data-go="' + esc(t.go) + '" style="cursor:pointer" title="Open the chat"' : "";
    var dismissBtn = '<button class="btn sm ghost" data-act="td-dismiss" data-key="' + esc(t.ref) + '" data-since="' + esc(t.since || "") + '" title="Hide this notification (no Jira change)">Dismiss</button>';
    if (t.kind === "jira_so" || t.kind === "jira_stuck") {
      return '<div class="qrow td-card td-so" role="row"' + goAttr + '>' + meta +
        '<div class="td-actions qc-actions" role="cell"><button class="btn sm primary" data-act="td-so-forward" data-key="' + esc(t.ref) + '" data-since="' + esc(t.since || "") + '" title="Posts the comment \u201c' + PEREDANO + '\u201d">Forwarded</button>' +
        '<button class="btn sm" data-act="td-so-closed" data-key="' + esc(t.ref) + '" data-since="' + esc(t.since || "") + '" title="Posts the comment \u201c' + PEREDANO_ZAKRYTO + '\u201d and moves the ticket to Done">Closed</button>' + jiraLink + dismissBtn + "</div></div>";
    }
    if (t.kind === "jira_l1") {
      return '<div class="qrow td-card td-l1" role="row"' + goAttr + '>' + meta +
        '<div class="td-actions qc-actions" role="cell"><button class="btn sm primary" data-act="td-l1-done" data-id="' + esc(t.ref) + '" title="' + (t.hasComment ? "Reply &quot;Передано&quot; under our Jira comment about this user (the ticket status is not changed)" : "Mark as done (no Jira change)") + '">Done</button>' + jiraLink + "</div></div>";
    }
    if (t.kind === "jira_urg") {
      return '<div class="qrow td-card td-urg" role="row"' + goAttr + '>' + meta +
        '<div class="td-actions qc-actions" role="cell"><button class="btn sm primary" data-act="td-urg-transfer" data-key="' + esc(t.ref) + '" data-rid="' + esc(t.rid || "") + '" data-since="' + esc(t.since || "") + '">Done</button>' + jiraLink + dismissBtn + "</div></div>";
    }
    if (t.kind === "fbcheck") {   // unread reminder card (glows) - opens the Facebook tab to check the group
      return '<div class="qrow td-card td-unread" role="row" data-go="' + esc(t.go) + '" style="cursor:pointer" title="unread">' + meta + "</div>";
    }
    return '<div class="qrow td-card" role="row" data-go="' + esc(t.go) + '" style="cursor:pointer">' + meta + "</div>";
  }
  /* Pull the two Jira-backed To-Do sources: URG tickets in Review (the console doesn't fetch URG in its
     normal SO scan) and the console-side "forwarded" markers (SO Передано, which doesn't change status). */
  var _todoTick = 0;
  function loadTodoData(force) {
    if (parseHash().view !== "inbox") return;   // the To-Do pane only exists on the Monitor page - don't poll elsewhere
    // Forwarded / dismissed markers: read once by the start-up load (before the first paint), then kept
    // fresh by the /poll live lane (keys jhandled / jdismissed) - fetched again only when they change.
    // URG-in-Review is a LIVE Jira REST call - throttle it to roughly every 3 minutes (force on first load).
    if (!force && (_todoTick++ % 2 !== 0)) return;
    window.CONSOLE.get("/jira-urg-review").then(function (d) { if (d && Array.isArray(d.items)) { D.urgReview = d.items; if (parseHash().view === "inbox") render(); } }, function () {});
  }
  /* Jira To-Do buttons. All of them run ONE function in the bot (services/jira_todo.py) through the
     action queue - the same one the Slack buttons call - so the Jira comment / Done, the console marker
     and the Slack card are always handled together, and two people pressing at once do it only once. */
  function jiraTodo(op, key, opts, after) {
    opts = opts || {};
    enqueueAction("jira_todo", { op: op, key: key, rid: opts.rid || "", since: opts.since || "" }, function (r) {
      if (r.status !== "done") { toast("Failed: " + (r.error || "unknown error"), "error"); return; }
      after(r.result || {});
      render();
    }, function () { toast("Could not reach the server", "error"); });
  }
  function todoDismiss(key, since) {   // hide a Jira To-Do card without any Jira change
    jiraTodo("dismiss", key, { since: since }, function () {
      (D.jiraDismissed = D.jiraDismissed || {})[key] = since || "";
      logActivity("dismissed Jira To-Do " + key, "");
      toast("Dismissed: " + key);
    });
  }
  function todoSoForward(key, since) {   // SO "Forwarded": comment only, the ticket keeps its status
    jiraTodo("forward", key, { since: since }, function (r) {
      (D.jiraHandled = D.jiraHandled || {})[key] = since || "";
      logActivity("forwarded Jira " + key + " (" + PEREDANO + ")", "");
      toast(r.already ? "Already forwarded by someone else: " + key
        : (r.comment_skipped ? "Forwarded (no comment: the user wrote last): " : "Forwarded: ") + key);
    });
  }
  function todoJiraClose(key, since) {   // SO "Closed": comment + Done
    jiraTodo("close", key, { since: since }, function (r) {
      D.jira = (D.jira || []).map(function (j) { if (j.issue_key === key) j.status = r.status || "Done"; return j; });
      logActivity("closed Jira " + key, PEREDANO_ZAKRYTO);
      toast(r.already ? "Already closed by someone else: " + key : "Closed: " + key);
    });
  }
  /* URG Done: with several users, Done on one card marks only that user; the ticket goes to Done when the
     last of our users is transferred. */
  function urgTransferOne(key, rid, since) {
    jiraTodo("urg_done", key, { rid: rid, since: since }, function (r) {
      D.urgReview = (D.urgReview || []).map(function (u) {
        if (u.key !== key) return u;
        u.recipients = rid ? (u.recipients || []).filter(function (x) { return x.rid !== rid; }) : [];
        return u;
      }).filter(function (u) { return u.key !== key || (u.recipients || []).length; });
      logActivity("transferred URG " + key + (rid ? " user" : ""), rid || "");
      toast(r.already ? "Already done by someone else: " + key
        : (r.left ? ("Transferred. " + r.left + " user" + (r.left > 1 ? "s" : "") + " still waiting on " + key) : (key + " is Done")), "ok");
    });
  }

  /* ---------- Global search (V5) ----------
     The top search box searches EVERYTHING at once (ModMail, Posts, Discord, Jira, users) - not just
     the current page - and matches on email too (the cmdk blobs carry it). Whenever the query is
     non-empty on a content view, this replaces the section view; clearing it (or opening a result)
     returns to normal. */
  function viewSearch() {
    var terms = state.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    var res = cmdkAll().filter(function (i) {
      if (i.cat === "Navigate") return false;   // content results only
      var hay = (i.search || (i.title + " " + (i.sub || ""))).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
    var groups = {}, order = [];
    res.forEach(function (i) { if (!groups[i.cat]) { groups[i.cat] = []; order.push(i.cat); } groups[i.cat].push(i); });
    var body = res.length ? order.map(function (cat) {
      return '<div class="pane-head" style="position:static;padding:14px 16px 6px;border-bottom:none"><div class="pane-title"><h2 style="font-size:13px;color:var(--muted)">' + esc(cat) + '</h2><span class="count-pill">' + groups[cat].length + "</span></div></div>" +
        groups[cat].slice(0, 100).map(function (i) {
          return '<div class="row" data-go="' + esc(i.go || "#") + '"><div class="av">' + ic(i.icon) + "</div>" +
            '<div class="rmain"><div class="rtop"><span class="rname truncate">' + esc(i.title) + "</span></div>" +
            (i.sub ? '<div class="rsub truncate">' + esc(i.sub) + "</div>" : "") + "</div></div>";
        }).join("");
    }).join("") : emptyState("inbox", "Nothing found", "No matches across ModMail, Posts, Discord, Jira, or users (name or User ID).");
    return '<div class="split" style="grid-template-columns:1fr"><div class="pane list" style="border-right:none">' +
      '<div class="pane-head"><div class="pane-title"><h2>Search</h2><span class="count-pill">' + res.length + "</span></div>" +
      '<div class="muted" style="font-size:12px;margin-top:4px">Results across all sections. Clear the search box to go back.</div></div>' +
      body + "</div></div>";
  }

  /* ---------- Reddit ModMail ---------- */
  /* Console-visible message list for a Reddit convo: hide the mods-only "[Console] ..."
     audit notes (console-side noise), and use "[Console] Public reply sent - X" to attribute the
     matching public reply to operator X, so the console shows who actually sent it instead of the
     shared bot account. */
  function redditDisplayMessages(convo) {
    var out = [];
    (convo.messages || []).forEach(function (m) {
      if (m.is_internal) {
        var mm = /^\s*\[Console\]\s*(.*)$/i.exec(m.body || "");
        if (mm) {
          var pr = /^Public reply sent\s*-\s*(.+)$/i.exec((mm[1] || "").trim());
          if (pr) {
            for (var i = out.length - 1; i >= 0; i--) {
              if (!out[i].is_internal && out[i].author !== convo.participant) { out[i]._byOperator = pr[1].trim(); break; }
            }
          }
          return;   // drop the [Console] audit note from the console view
        }
      }
      out.push(m);
    });
    return out;
  }
  function viewModmail(id) {
    var ql = state.q.toLowerCase();
    var list = D.redditModmail.filter(function (c) {
      var okH = searching() || (state.modmailHistory ? inHistory(c.ts) : !inHistory(c.ts));   // History; search spans both
      var okS = state.modmailStatus === "all" || deriveRedditStatus(c) === state.modmailStatus;
      var okQ = !ql || (c.subject + " " + c.participant).toLowerCase().indexOf(ql) >= 0;
      return okH && okS && okQ;
    });
    if (!id && list.length && !state.isMobile) id = list[0].id;   // phone: list first, open on tap
    var convo = convoById(id);
    if (convo) {
      ensureRedditEmail(convo.participant);   // pull this user's email on demand
      if (isUnread("convo", convo, convo.id)) markRead("convo", convo.id, convo.msgs_count);   // viewing = read (S6)
    }
    var _mmPool = (D.redditModmail || []).filter(function (c) { return state.modmailHistory ? inHistory(c.ts) : !inHistory(c.ts); });
    var statusChips = historyToggle("modmailHistory") + Object.keys(SITE_STATUS).map(function (k) {
      var n = k === "all" ? _mmPool.length : _mmPool.filter(function (c) { return deriveRedditStatus(c) === k; }).length;
      return '<button class="filter' + (state.modmailStatus === k ? " active" : "") + '" data-act="filter" data-group="modmailStatus" data-val="' + k + '">' + esc(SITE_STATUS[k]) + (n ? '<span class="fcount">' + n + "</span>" : "") + "</button>";
    }).join("");
    var rows = list.slice(0, LIST_CAP).map(function (c) {
      var mn = D.modNotes && D.modNotes[c.participant];
      var hl = !!(mn && (mn.highlighted_convos || []).indexOf(c.id) >= 0);
      var st = deriveRedditStatus(c);
      // Under the nick: the last PUBLIC (non-internal) message, so the row never previews an internal
      // "[Console] ..." / "[System] ..." note (which isn't shown as a normal bubble anyway). Matches the
      // snapshot's server-side last_body (also public-only), so opened and unopened rows agree; falls back
      // to that snapshot preview when a list row has no messages loaded yet, then to the subject.
      var _pub = (c.messages && c.messages.length) ? c.messages.filter(function (m) { return !m.is_internal; }) : null;
      var lastMsg = (_pub && _pub.length) ? _pub[_pub.length - 1].body : c.preview;
      var rowSub = previewText(lastMsg) || c.subject;
      return '<div class="row' + (c.id === id ? " active" : "") + '" data-go="#/modmail/' + c.id + '">' +
        avatarOrCount("convo", c, c.id, initials(c.participant)) +
        '<div class="rmain"><div class="rtop"><span class="rname truncate">u/' + esc(c.participant) + "</span>" + tagAlert("convo", c.id) + '<span class="rtime">' + esc(c.ago) + "</span></div>" +
        '<div class="rsub truncate" title="' + esc(c.subject) + '">' + esc(rowSub) + "</div>" +
        '<div class="rmeta">' + (c.unread ? '<span class="dot"></span>' : "") +
        '<span class="st ' + statusClass(st) + '" style="font-size:11px">' + esc(SITE_STATUS[st] || st) + "</span>" +
        (hl ? '<span class="chip accent" style="padding:1px 8px">' + ic("star", "ico-sm") + "linked</span>" : "") + "</div></div></div>";
    }).join("");
    var listPane = '<div class="pane list"><div class="pane-head"><div class="pane-title"><h2>Reddit ModMail</h2><span class="count-pill">' + list.length + "</span></div></div>" +
      (rows ? rows + capNote(list.length) : emptyState("mail", "Empty", "No conversations.")) + "</div>";
    // status filters in a full-width top bar (same as Discord), not wrapped inside the list column
    function mmWrap(inner) { return '<div class="ds-view"><div class="ds-tabbar"><div class="topfilters"><div class="filters fscroll">' + statusChips + '</div></div></div><div class="ds-body">' + inner + "</div></div>"; }
    if (!convo) return mmWrap('<div class="split three">' + listPane + '<div class="pane detail">' + emptyState("mail", "Select a conversation", "Pick one from the list on the left.") + '</div><div class="pane context"></div></div>');

    if (!convo._msgsLoaded) ensureRedditMessages(convo);
    var msgs = (!convo._msgsLoaded)
      ? '<div class="empty" style="padding:24px"><p class="muted">Loading conversation…</p></div>'
      : redditDisplayMessages(convo).map(function (m) {
        var internal = m.is_internal;
        var cls = internal ? "internal" : (m.author === convo.participant ? "in" : "out");
        // Mod messages show the team member's unified display name when their Reddit account is linked;
        // a console reply is attributed to the operator who actually sent it.
        // Sent from the console: show the operator, plus the account it actually went out as.
        var modName = m._byOperator ? esc(m._byOperator) + (m._byOperator !== m.author ? ' <span class="faint">via u/' + esc(m.author) + "</span>" : "")
          : (function () { var tm = teamByReddit(m.author); return esc(tm ? (tm.display_name || tm.name) : m.author); })();
        var meta = (m.author === convo.participant ? "u/" + esc(m.author) : modName + DOT + "mod") + DOT + esc(m.ago);
        var tag = internal ? '<span class="tag">' + ic("shield", "ico-sm") + "Mods only" + DOT + esc(m._byOperator || m.author) + '</span><div style="margin-top:5px">' : "";
        return '<div class="msg ' + cls + '">' + (internal ? "" : '<div class="meta">' + meta + "</div>") +
          '<div class="bubble">' + tag + renderMarkdown(m.body) + (internal ? "</div>" : "") + "</div></div>";
      }).join("");
    var hlNow = !!(D.modNotes && D.modNotes[convo.participant] &&
      (D.modNotes[convo.participant].highlighted_convos || []).indexOf(convo.id) >= 0);
    var detail = '<div class="pane detail">' +
      // Status chip + change dropdown live under the username. Add Jira / Add Email are in
      // the side panel now (no duplicate buttons here); Highlight + Archive stay as row actions.
      '<div class="detail-head"><div class="dh-main"><h2 class="truncate">u/' + esc(convo.participant) + '</h2><div class="dh-sub truncate">' + esc(convo.subject) + "</div>" +
      redditStatusControl(convo) + "</div>" +
      '<div class="detail-actions">' +
      '<button class="btn sm ghost iconly' + (hlNow ? " accent" : "") + '" title="' + (hlNow ? "Remove highlight" : "Highlight") + '" data-act="highlight" data-convo="' + esc(convo.id) + '" data-user="' + esc(convo.participant) + '">' + ic("star", "ico-sm") + "</button>" +
      '<button class="btn sm ghost iconly" title="Archive on Reddit" data-act="archive" data-convo="' + esc(convo.id) + '">' + ic("archive", "ico-sm") + "</button>" +
      '<a class="btn sm ghost" href="https://mod.reddit.com/mail/all/' + esc(convo.id) + '" target="_blank" rel="noopener" title="Open this conversation on Reddit">' + ic("external", "ico-sm") + "Open on Reddit</a>" +
      (isAdmin() ? '<button class="btn sm ghost iconly" title="Delete from the console (admin; Reddit is not touched)" data-act="convo-delete" data-convo="' + esc(convo.id) + '">' + ic("x", "ico-sm") + "</button>" : "") +
      "</div></div>" +
      '<div class="thread">' + msgs + renderPending("convo", convo.id) + "</div>" +
      '<div class="composer" style="flex-direction:column;align-items:stretch;gap:8px">' +
      '<textarea placeholder="Write a message to u/' + esc(convo.participant) + ' ..." data-composer></textarea>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn sm ghost" data-act="tpl-pick" title="Insert a reply template">' + ic("notes", "ico-sm") + "Templates</button>" +
      '<button class="btn sm ghost" data-act="tr-compose" title="Translate what you typed to English (you still send it manually)">' + ic("reply", "ico-sm") + "Translate &rarr; EN</button>" +
      '<div class="spacer"></div>' +
      '<button class="btn mods" title="Internal, mods only (not sent to the user)" data-act="send" data-convo="' + convo.id + '" data-kind="internal">' + ic("shield", "ico-sm") + "Mods-Only</button>" +
      '<button class="btn primary" title="Public reply from the community account" data-act="send" data-convo="' + convo.id + '" data-kind="user">' + ic("send", "ico-sm") + "Reply to user</button>" +
      "</div></div></div>";

    var user = userByReddit(convo.participant);
    var mn = (D.modNotes && D.modNotes[convo.participant]) || { jira_convos: {} };
    var jiraKeys = Object.keys(mn.jira_convos || {}).filter(function (k) { return mn.jira_convos[k] === convo.id; });
    var ctx = contextPanel({
      user: user, fallbackName: "u/" + convo.participant, fallbackPlatform: "Reddit",
      emailUser: convo.participant,        // Add Email quick-action under the profile 
      jiraKeys: jiraKeys,
      maintenance: D.maintenanceSubs.filter(function (s) { return s.convo_id === convo.id; }),
      tags: convo.tags,
      notes: notesFor("convo", convo.id).concat(notesFor("user", convo.participant)),
      noteAnchor: { type: "convo", ref: convo.id, label: "ModMail: " + convo.subject }
    });
    return mmWrap('<div class="split three">' + listPane + detail + ctx + "</div>");
  }

  /* ---------- Maintenance tab ----------
     Live view of every active game + server maintenance, with a "running for" timer that ticks each
     second IN PLACE (updateMaintenanceTimers, no re-render). Source: /maintenances (the bot's
     active_maintenances collection; started_at is when the maintenance was registered). */
  function fmtDuration(ms) {
    if (!(ms > 0)) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d > 0 ? d + "d " : "") + p(h) + ":" + p(m) + ":" + p(s);
  }
  function updateMaintenanceTimers() {
    var els = document.querySelectorAll(".mnt-timer, .ev-timer");
    if (!els.length) return;
    var now = Date.now();
    Array.prototype.forEach.call(els, function (el) {
      var start = parseInt(el.getAttribute("data-start"), 10);
      if (start) el.textContent = fmtDuration(now - start);
    });
  }
  /* datetime-local <input> values are naive LOCAL wall-clock ("YYYY-MM-DDTHH:MM"); convert to/from a
     real Date so we store/read a proper UTC instant (what the timer + Kyiv display run off). */
  function _toLocalInput(d) {
    if (!d || isNaN(d.getTime())) return "";
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function _nowLocalInput() { return _toLocalInput(new Date()); }
  function mntRow(m) {
    var dt = _utcDate(m.started_at);
    var startMs = dt ? dt.getTime() : 0;
    var isBrazil = m.type === "brazil";
    var actions = "";
    if (isAdmin()) {
      if (isBrazil) {   // console-only category: edit (name + start date) and plain remove
        actions = '<button class="btn sm ghost" data-act="mnt-edit-brazil" data-entity="' + esc(m.entity || "") + '" title="Edit name / start date">' + ic("notes", "ico-sm") + "Edit</button>" +
          '<button class="btn sm ghost" data-act="mnt-end" data-entity="' + esc(m.entity || "") + '" data-type="brazil" title="End (remove) this maintenance">' + ic("check", "ico-sm") + "End</button>";
      } else {          // API-fed: End forces the bot's maintenance-end flow (Slack + subscribers)
        // (No "To Brazil" button: Brazil-only maintenances are sorted automatically.)
        actions = '<button class="btn sm ghost" data-act="mnt-end" data-entity="' + esc(m.entity || "") + '" data-type="' + esc(m.type || "") + '" title="Force the bot to mark this maintenance ended">' + ic("check", "ico-sm") + "End</button>";
      }
    }
    return '<div class="qrow mnt-row" role="row">' +
      qCell("qc-name", '<span class="mnt-name" title="' + esc(m.entity || "") + '">' + esc(m.entity || "-") + "</span>" +
        (m.eta ? '<span class="chip soft">ETA ' + esc(m.eta) + "</span>" : ""), "Name") +
      qCell("qc-timer", '<span class="mnt-timer mono" data-start="' + startMs + '">' + esc(startMs ? fmtDuration(Date.now() - startMs) : "-") + "</span>", "Running") +
      qCell("qc-when", startMs ? '<span class="mnt-since">since ' + esc(fmtKyivShort(dt)) + "</span>" : "", "Since") +
      (isAdmin() ? '<div class="qc-actions mnt-actions" role="cell">' + actions + "</div>" : "") +
      "</div>";
  }
  /* End a maintenance. Brazil (console-only) is a plain delete - no Slack, no subscriber notices.
     Game/Server forces the bot's real maintenance-end flow via the console->bot action queue
     (maintenance_end): Slack end notice + Discord/Reddit completion notices + drop the active record. */
  /* A game maintenance that is really Brazil-only (the sender didn't tag it [Brazil]): move it to the
     Brazil list, keeping its start time. The name loses a [Brazil] tag if it has one. */
  function confirmEndMaintenance(entity, type) {
    if (!entity) return;
    if (type === "brazil") {
      showModal({ title: "End maintenance", submit: "End maintenance", close: "Cancel",
        intro: '<p class="muted" style="margin:0;line-height:1.55">This removes <b>' + esc(entity) + '</b> from the Maintenance In Brazil list. Console-only - no Slack or subscriber notices. Continue?</p>',
        onSubmit: function () {
          window.CONSOLE.post("/brazil-maintenance/end", { entity: entity }).then(function () {
            D.maintenances = (D.maintenances || []).filter(function (m) { return !(m.entity === entity && m.type === "brazil"); });
            render(); toast("Maintenance ended: " + entity);
          }, function (s) { toast(s === 403 ? "Admins only" : "Failed to end"); });
        } });
      return;
    }
    showModal({ title: "End maintenance", submit: "End maintenance", close: "Cancel",
      intro: '<p class="muted" style="margin:0;line-height:1.55">This forces the bot to treat <b>' + esc(entity) + '</b> as finished: it posts the maintenance-end notice to Slack, sends the completion notice to any subscribed Discord/Reddit threads, and removes it from the active list. Continue?</p>',
      onSubmit: function () {
        enqueueAction("maintenance_end", { entity: entity, type: type }, function (a) {
          if (a && a.status === "done") {
            D.maintenances = (D.maintenances || []).filter(function (m) { return !(m.entity === entity && m.type === type); });
            render();
            toast("Maintenance ended: " + entity);
          } else { toast("Failed: " + ((a && a.error) || "")); }
        });
      } });
  }
  /* Admin-only: add or edit a "Maintenance In Brazil" entry (console-only category, NOT tied to the
     API). `orig` present -> editing; renaming drops the old record then creates the new one. */
  function addBrazilMaintenance(orig) {
    var editing = !!(orig && orig.entity);
    showModal({ title: editing ? "Edit Brazil maintenance" : "Add Brazil maintenance",
      submit: editing ? "Save" : "Add", close: "Cancel",
      initial: { entity: editing ? orig.entity : "",
                 started_at: editing ? _toLocalInput(_utcDate(orig.started_at)) : _nowLocalInput() },
      fields: [
        { id: "entity", label: "Game / entity", type: "text", required: true, placeholder: "e.g. Grand Theft Auto V" },
        { id: "started_at", label: "Start date & time", type: "datetime", hint: "Defaults to now if left blank." }
      ],
      onSubmit: function (v) {
        var name = (v.entity || "").trim();
        if (!name) { toast("Enter a game/entity name"); return; }
        var iso = v.started_at ? new Date(v.started_at).toISOString() : new Date().toISOString();
        function afterSave() {
          D.maintenances = (D.maintenances || []).filter(function (m) {
            return !(m.type === "brazil" && (m.entity === name || (editing && m.entity === orig.entity)));
          });
          D.maintenances.push({ entity: name, type: "brazil", started_at: iso, eta: "" });
          render(); toast(editing ? "Saved" : "Brazil maintenance added");
        }
        function doAdd() {
          // push_sheet only on a fresh add (a new game maintenance start) - never on an edit/rename,
          // so we never duplicate a Google Sheet row for a ticket that is already logged.
          window.CONSOLE.post("/brazil-maintenance", { entity: name, started_at: iso, push_sheet: !editing })
            .then(afterSave, function (s) { toast(s === 403 ? "Admins only" : "Save failed"); });
        }
        if (editing && orig.entity !== name) {   // rename: remove the old record first
          window.CONSOLE.post("/brazil-maintenance/end", { entity: orig.entity }).then(doAdd, doAdd);
        } else { doAdd(); }
      } });
  }
  var _MNT_TABS = [["games", "Games", ["game", "brazil"]], ["playgrounds", "Playgrounds", ["server"]]];
  function mntCategory(title, items, empty, tools) {
    var head = (title || tools)
      ? '<div class="mnt-cat-h"><span class="mnt-cat-title">' + esc(title || "") +
          (title ? ' <span class="stab-count">' + items.length + "</span>" : "") + "</span>" + (tools || "") + "</div>"
      : "";
    var grid = items.length
      ? qTable("q-mnt" + (isAdmin() ? " has-actions" : ""), ["Name", "Running", "Since"].concat(isAdmin() ? ["Actions"] : []), items.map(mntRow).join(""))
      : '<div class="ctx-empty">' + esc(empty) + "</div>";
    return '<div class="mnt-cat">' + head + grid + "</div>";
  }
  function viewMaintenance() {
    var list = D.maintenances || [];
    var tab = state.mntTab || "games";
    if (!_MNT_TABS.some(function (t) { return t[0] === tab; })) tab = "games";
    var subtabs = '<div class="subtabs">' + _MNT_TABS.map(function (t) {
      var n = list.filter(function (m) { return t[2].indexOf(m.type || "") >= 0; }).length;
      return '<button class="stab' + (t[0] === tab ? " active" : "") + '" data-act="mnt-tab" data-tab="' + t[0] + '">' +
        t[1] + ' <span class="stab-count">' + n + "</span></button>";
    }).join("") + "</div>";
    var body;
    if (tab === "games") {
      var games = list.filter(function (m) { return m.type === "game"; });
      var brazil = list.filter(function (m) { return m.type === "brazil"; });
      var addBtn = isAdmin() ? '<button class="btn sm primary" data-act="mnt-add-brazil" title="Add a Brazil maintenance manually">' + ic("plus", "ico-sm") + "Add</button>" : "";
      body = mntCategory("Games", games, "No active game maintenance.", "") +
             mntCategory("Maintenance In Brazil", brazil, "No active Brazil maintenance.", addBtn);
    } else {
      body = mntCategory("", list.filter(function (m) { return m.type === "server"; }), "No active server maintenance.", "");
    }
    return '<div class="page"><div class="page-head"><div><h1>Maintenance</h1></div><span class="count-pill">' + list.length + "</span></div>" +
      '<div class="page-body">' + subtabs + body + "</div></div>";
  }

  /* ---------- Reddit Comments (item: replies to our comments) ----------
     A flat, read-at-a-glance list of comments Redditors left in reply to one of OUR moderator
     comments (source: /reddit-comments, fed by the snapshot's reply_to_mod flag). Each row shows
     the reply, the comment of ours it answered, and its parent post, with links out to Reddit. */
  function viewRedditComments() {
    var ql = state.q.toLowerCase();
    var list = (D.redditComments || []).filter(function (c) {
      return !ql || ((c.body || "") + " " + (c.author || "") + " " + (c.post_title || "") + " " + (c.parent_author || "")).toLowerCase().indexOf(ql) >= 0;
    });
    var rows = list.map(function (c) {
      var postLink = c.post_url
        ? '<a class="rc-post" href="' + esc(c.post_url) + '" target="_blank" rel="noopener">' + ic("posts", "ico-sm") + esc(c.post_title || "post") + "</a>"
        : '<span class="rc-post muted">' + ic("posts", "ico-sm") + esc(c.post_title || "post") + "</span>";
      var parent = (c.parent_author || c.parent_body)
        ? '<div class="rc-parent"><div class="rc-parent-label">' + ic("reply", "ico-sm") + "In reply to our comment" + (c.parent_author ? " by u/" + esc(c.parent_author) : "") + "</div>" +
            (c.parent_body ? '<div class="rc-parent-body">' + esc(c.parent_body) + "</div>" : "") + "</div>"
        : "";
      return '<div class="rc-item">' +
        '<div class="rc-head"><span class="rc-author">u/' + esc(c.author || "[deleted]") + "</span>" +
          '<span class="rc-ago">' + esc(timeText(c.created)) + "</span></div>" +
        parent +
        '<div class="rc-body">' + renderMarkdown(c.body || "") + "</div>" +
        '<div class="rc-foot">' + postLink +
          (c.link ? '<a class="btn sm ghost" href="' + esc(c.link) + '" target="_blank" rel="noopener">' + ic("link", "ico-sm") + "Open on Reddit</a>" : "") +
        "</div></div>";
    }).join("") || emptyState("reply", "No replies to our comments yet", "When a Redditor replies to one of our moderator comments, it shows up here.");
    return '<div class="page"><div class="page-head"><div><h1>Reddit Comments</h1></div><span class="count-pill">' + list.length + "</span></div>" +
      '<div class="page-body"><div class="stack" style="gap:12px">' + rows + "</div></div></div>";
  }

  /* Strip Reddit emoji shortcodes (e.g. ":snoo_sad:") that flairs carry - we can't render the custom
     images, so showing the raw ":name:" is just noise. "Help:snoo_sad:" -> "Help". */
  function cleanFlair(f) { return String(f || "").replace(/:[a-z0-9_+\-]+:/gi, "").replace(/\s{2,}/g, " ").trim(); }
  /* Attach the persisted "Ignored by / reason" (from /post-flags meta) onto a post. */
  function applyIgnoreMeta(p) { var m = (state._ignoreMeta || {})[p.id]; if (m) { p.ignore_reason = m.reason || ""; p.ignored_by = m.by || ""; } }
  /* ---------- Reddit Posts ---------- */
  function viewPosts(id) {
    var ql = state.q.toLowerCase();
    var list = D.redditPosts.filter(function (p) {
      var okH = searching() || (state.postsHistory ? inHistory(p.ts) : !inHistory(p.ts));   // History; search spans both
      // Ignored posts count as closed: they leave the No-reply queue like a replied one.
      var okF = state.postFilter === "all" ? !p.ignored
        : state.postFilter === "answered" ? (p.has_reply && !p.ignored)
        : state.postFilter === "unanswered" ? (!p.has_reply && !p.ignored)
        : state.postFilter === "ignored" ? !!p.ignored
        : true;
      var okQ = !ql || (p.title + " " + p.author + " " + p.subreddit).toLowerCase().indexOf(ql) >= 0;
      return okH && okF && okQ;
    });
    // Default: latest activity, so a post with a fresh comment rises to the top. "Newest posts" = by creation.
    var byNewest = state.postSort === "newest";
    function postSortTime(p) { var d = _utcDate(byNewest ? p.created : p.ts); return d ? d.getTime() : 0; }
    list.sort(function (a, b) { return postSortTime(b) - postSortTime(a); });
    if (!id && list.length && !state.isMobile) id = list[0].id;   // phone: list first, open on tap
    var post = D.redditPosts.filter(function (p) { return p.id === id; })[0];
    if (post) {
      ensureRedditEmail(post.author);   // pull this author's email on demand
      if (isUnread("post", post, post.id)) markRead("post", post.id, post.num_comments);   // viewing = read (S6)
    }
    var filterChips = historyToggle("postsHistory") + [["all", "All"], ["unanswered", "No reply"], ["answered", "Replied"], ["ignored", "Ignored"]]
      .map(function (c) { return '<button class="filter' + (state.postFilter === c[0] ? " active" : "") + '" data-act="filter" data-group="postFilter" data-val="' + c[0] + '">' + c[1] + "</button>"; }).join("");
    filterChips += [["activity", "Latest activity"], ["newest", "Newest posts"]]
      .map(function (c) { return '<button class="filter' + ((byNewest ? "newest" : "activity") === c[0] ? " active" : "") + '" data-act="filter" data-group="postSort" data-val="' + c[0] + '">' + c[1] + "</button>"; }).join("");
    var rows = list.slice(0, LIST_CAP).map(function (p) {
      var stCls = p.ignored ? "muted" : (p.has_reply ? "done" : "open");
      var stTxt = p.ignored ? "Ignored" : (p.has_reply ? "Replied" : "No reply");
      return '<div class="row' + (p.id === id ? " active" : "") + '" data-go="#/posts/' + p.id + '">' +
        avatarOrCount("post", p, p.id, initials(p.author)) +
        '<div class="rmain"><div class="rtop"><span class="rname truncate">' + esc(p.title) + "</span>" + tagAlert("post", p.id) + '<span class="rtime">' + esc(byNewest ? p.ago : timeText(p.ts)) + "</span></div>" +
        '<div class="rsub truncate">' + esc(p.subreddit) + DOT + "u/" + esc(p.author) + "</div>" +
        '<div class="rmeta"><span class="st ' + stCls + '" style="font-size:11px">' + stTxt + "</span>" +
        (cleanFlair(p.flair) ? '<span class="chip soft" style="padding:1px 8px;margin-left:6px">' + esc(cleanFlair(p.flair)) + "</span>" : "") + "</div></div></div>";
    }).join("");
    var listPane = '<div class="pane list"><div class="pane-head"><div class="pane-title"><h2>Reddit Posts</h2><span class="count-pill">' + list.length + "</span></div></div>" +
      (rows ? rows + capNote(list.length) : emptyState("posts", "Empty", "No posts.")) + "</div>";
    // filters + sort in the full-width top bar (same as ModMail / Discord)
    function postsWrap(inner) { return '<div class="ds-view"><div class="ds-tabbar"><div class="topfilters"><div class="filters fscroll">' + filterChips + '</div></div></div><div class="ds-body">' + inner + "</div></div>"; }
    if (!post) return postsWrap('<div class="split three">' + listPane + '<div class="pane detail">' + emptyState("posts", "Select a post", "") + '</div><div class="pane context"></div></div>');
    if (!post._commentsLoaded) ensureRedditPostComments(post);
    var msgs = (!post._commentsLoaded)
      ? '<div class="empty" style="padding:24px"><p class="muted">Loading comments…</p></div>'
      : post.thread.filter(function (m) { return String(m.author || "") !== "AutoModerator"; }).map(function (m) {
        // Our side (out) = community reply OR a distinguished moderator comment (item T5).
        var ours = m.team || m.mod;
        var cls = ours ? "out" : "in";
        var whoName = m.mod ? (nameForReddit(m.author).indexOf("u/") === 0 ? m.author : nameForReddit(m.author)) : m.author;
        var who = (m.mod && teamByReddit(m.author) ? esc(whoName) : "u/" + esc(m.author)) + (m.op ? DOT + "OP" : "") + (m.team ? DOT + "community" : (m.mod ? DOT + "mod" : ""));
        var meta = who + DOT + esc(m.ago);
        return '<div class="msg ' + cls + '"><div class="meta">' + meta + '</div><div class="bubble">' + renderMarkdown(m.body) + "</div></div>";
      }).join("");
    var imgStrip = (post.images && post.images.length)
      ? '<div class="post-images" style="display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px">' +
        post.images.map(function (u) {
          return '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="post image" loading="lazy" style="max-width:220px;max-height:220px;border-radius:8px;object-fit:cover;display:block"></a>';
        }).join("") + "</div>"
      : "";
    // Replying to posts from inside the console is disabled for now: per-user Reddit OAuth needs a
    // redirect URI the separate console and bot servers can't share. Instead we surface a big button
    // that opens the post on Reddit, where a mod replies under their own account. Revisit later.
    var openUrl = post.url || ("https://www.reddit.com/comments/" + encodeURIComponent(post.id));
    var detail = '<div class="pane detail">' +
      // Title + sub + "Ignored by" stack on the left, the labelled Ignore button stays on the title row
      // (on a phone a bare "x" on its own row would read like a close button).
      '<div class="detail-head fh ph"><div class="dh-main"><h2 class="truncate">' + esc(post.title) + '</h2><div class="dh-sub">' + esc(post.subreddit) + DOT + "u/" + esc(post.author) + DOT + esc(post.ago) + (cleanFlair(post.flair) ? " " + '<span class="chip soft" style="padding:1px 8px">' + esc(cleanFlair(post.flair)) + "</span>" : "") + "</div>" +
        (post.ignored && (post.ignored_by || post.ignore_reason)
          ? '<span class="ignored-by">Ignored by: ' + esc(post.ignored_by || "someone") + (post.ignore_reason ? DOT + esc(post.ignore_reason) : "") + "</span>"
          : "") + "</div>" +
      '<div class="detail-actions">' +
        '<button class="btn sm ghost ph-ignore' + (post.ignored ? " accent" : "") + '" data-act="post-ignore" data-post="' + esc(post.id) + '" title="' + (post.ignored ? "Un-ignore this post" : "Ignore - close without replying") + '">' + ic(post.ignored ? "check" : "x", "ico-sm") + (post.ignored ? "Ignored" : "Ignore") + "</button>" +
        "</div></div>" +
      '<div class="thread">' + imgStrip + msgs + renderPending("post", post.id) + "</div>" +
      '<div class="composer" style="flex-direction:column;align-items:stretch;gap:10px">' +
      '<div class="hint">To reply, open the post on Reddit and answer there under your own account.</div>' +
      '<a class="btn primary lg" href="' + esc(openUrl) + '" target="_blank" rel="noopener" style="justify-content:center">' + ic("external", "ico-sm") + "Open post on Reddit</a>" +
      "</div></div>";
    var user = userByReddit(post.author);
    var ctx = contextPanel({
      user: user, fallbackName: "u/" + post.author, fallbackPlatform: "Reddit",
      emailUser: post.author,          // Add Email quick-action binds to the post's Reddit user
      jiraKeys: post.jira_keys || [],  // Add Jira Ticket now works for posts too (item W4)
      hideMaintenance: true,           // Maintenance doesn't apply to a post
      tags: post.tags,
      notes: notesFor("post", post.id).concat(user ? notesFor("user", user.id) : []),
      noteAnchor: { type: "post", ref: post.id, label: "Post: " + post.title }
    });
    return postsWrap('<div class="split three">' + listPane + detail + ctx + "</div>");
  }

  /* ---------- Discord: Tickets / Forum / Mentions tabs ---------- */
  function discordTabs(active) {
    var counts = { tickets: countUnread("ticket"), mentions: mentionsNew() };
    return '<div class="subtabs">' + [["tickets", "Tickets"], ["mentions", "Mentions"], ["forum", "Forum"]].map(function (x) {
      var c = counts[x[0]] || 0;
      var b = c ? ' <span class="nbadge">' + (c > 99 ? "99+" : c) + "</span>" : "";
      return '<button class="stab' + (x[0] === active ? " active" : "") + '" data-act="discord-tab" data-tab="' + x[0] + '">' + x[1] + b + "</button>";
    }).join("") + "</div>";
  }
  /* Wrap any Discord tab's content in the shared view: a fixed tab bar on top + the content below,
     so switching Tickets/Forum/Mentions never shifts the tab buttons. */
  function dsWrap(active, content) {
    // the Tickets status line + Filters live in this top bar (whole page width), not in the list column
    var bar = active === "tickets" && state._dsFilterBar ? state._dsFilterBar : "";
    return '<div class="ds-view"><div class="ds-tabbar">' + discordTabs(active) + bar + '</div><div class="ds-body">' + content + "</div></div>";
  }
  function dsStatusPill(st) { var cls = { new: "open", open: "open", replied: "done", ignored: "backlog" }[st] || "open"; return '<span class="st ' + cls + '">' + statusLabel(st || "new") + "</span>"; }
  function forumTagsAll() { var s = {}; (D.discordForum || []).forEach(function (f) { (f.tags || []).forEach(function (t) { s[t] = 1; }); }); return Object.keys(s); }
  /* Live-data mappers (backend docs already match the mock shape; just normalize the id + defaults). */
  function mapForum(x) { x.id = x.id || x._id; x.tags = x.tags || []; x.messages = x.messages || []; x.ts = x.ts || x.last_activity || x.created_at || x.created; return x; }
  /* A forum post's To-Do status: a console Replied/Ignored override (manual triage) wins; otherwise
     derive - "new" (needs a reply) when the last message is the user's, else "replied". */
  function forumStatus(f) {
    var ov = D.forumStatus && D.forumStatus[f.id];
    if (ov === "replied" || ov === "ignored") return ov;
    var msgs = f.messages || [], last = msgs[msgs.length - 1];
    return (!last || last.is_user) ? "new" : "replied";
  }
  function mapMention(x) { x.id = x.id || x._id; x.status = x.status || "new"; x.ts = x.ts || x.created_at || x.created; return x; }
  function mapTgMsg(x) { x.id = x.id || x._id; x.answered = !!x.answered; x.ignored = !!x.ignored; x.ts = x.ts || x.created_at || x.date; x.wishlist_added = x.wishlist_added || ""; return x; }
  /* Add-Tag UI for the feed views (Mentions / Telegram) that have no context panel: existing tag chips
     (removable) + an "Add Tag" button that opens the same tag editor used in Posts / ModMail. */
  function cardTags(type, ref) {
    var tags = tagsArrFor(type, ref) || [];
    var chips = tags.map(function (t) {
      return '<span class="chip" style="padding:2px 8px">' + ic("tag", "ico-sm") + esc(t) +
        '<button class="chip-x" title="Remove tag" data-act="tag-del" data-tag-type="' + esc(type) + '" data-tag-ref="' + esc(ref) + '" data-tag="' + esc(t) + '">' + ic("x", "ico-sm") + "</button></span>";
    }).join("");
    return '<div class="tagwrap" style="margin-top:9px;align-items:center">' + chips +
      '<button class="btn sm ghost" data-act="tag-open" data-tag-type="' + esc(type) + '" data-tag-ref="' + esc(ref) + '">' + ic("tag", "ico-sm") + "Add Tag</button></div>";
  }
  function openTagEditor(type, ref) {
    showModal({ modeless: true, title: "Tags", close: "Close",
      custom: function () { return secTags(tagsArrFor(type, ref) || [], { type: type, ref: ref }); } });
  }

  /* Discord forum posts, grouped by source forum (Suggestions / Help Centre / Discussion). Read-only in
     the console — replies happen in Discord (the "Open in Discord" button jumps to the thread). */
  var FORUM_CATS = ["Suggestions", "Help Centre", "Discussion"];
  function viewDiscordForum() {
    var ql = state.q.toLowerCase();
    var fcat = state.forumCat || "all", ftag = state.forumTag || "all";
    var showHist = state.forumHistory;
    var list = (D.discordForum || []).filter(function (f) {
      var okC = fcat === "all" || (f.forum || "") === fcat;
      var okT = ftag === "all" || (f.tags || []).indexOf(ftag) >= 0;
      var okQ = !ql || (f.title + " " + f.author + " " + (f.forum || "") + " " + (f.tags || []).join(" ")).toLowerCase().indexOf(ql) >= 0;
      var itemHist = inHistory(f.ts);
      return okC && okT && okQ && (searching() || (showHist ? itemHist : !itemHist));
    });
    var sel = state.forumSel;
    if (!sel && list.length && !state.isMobile) sel = list[0].id;
    var f = (D.discordForum || []).filter(function (x) { return x.id === sel; })[0];
    var catChips = [["all", "All"]].concat(FORUM_CATS.map(function (c) { return [c, c]; }))
      .map(function (c) { return '<button class="filter' + (fcat === c[0] ? " active" : "") + '" data-act="filter" data-group="forumCat" data-val="' + esc(c[0]) + '">' + esc(c[1]) + "</button>"; }).join("");
    var tagChips = [["all", "All tags"]].concat(forumTagsAll().map(function (t) { return [t, t]; }))
      .map(function (c) { return '<button class="filter' + (ftag === c[0] ? " active" : "") + '" data-act="filter" data-group="forumTag" data-val="' + esc(c[0]) + '">' + esc(c[1]) + "</button>"; }).join("");
    var rows = list.map(function (x) {
      var tags = (x.tags || []).map(function (t) { return '<span class="chip soft" style="padding:1px 8px">' + esc(t) + "</span>"; }).join("");
      return '<div class="row' + (x.id === sel ? " active" : "") + '" data-go="#/discord/forum/' + esc(x.id) + '">' +
        '<div class="av">' + esc(initials(x.author)) + "</div>" +
        '<div class="rmain"><div class="rtop"><span class="rname truncate">' + esc(x.title) + '</span><span class="rtime">' + esc(x.ago) + "</span></div>" +
        '<div class="rsub truncate">' + esc(x.author) + "</div>" +
        '<div class="rmeta"><span class="chip accent" style="padding:1px 8px">' + esc(x.forum || "") + "</span>" + tags + "</div></div></div>";
    }).join("");
    var listPane = '<div class="pane list"><div class="pane-head">' +
      '<div class="pane-title"><h2>Forum</h2><span class="count-pill">' + list.length + "</span></div>" +
      '<div class="filters">' + catChips + '</div><div class="filters">' + tagChips + historyToggle("forumHistory") + "</div></div>" +
      (rows || emptyState("discord", "Empty", showHist ? "No archived forum posts." : "No forum posts.")) + "</div>";
    if (!f) return dsWrap("forum", '<div class="split three">' + listPane + '<div class="pane detail">' + emptyState("discord", "Select a forum post", "") + '</div><div class="pane context"></div></div>');
    var msgs = (f.messages || []).map(function (m) {
      var cls = m.is_user ? "in" : "out";
      return '<div class="msg ' + cls + '"><div class="meta">' + esc(m.author) + (m.is_user ? "" : DOT + "team") + DOT + esc(m.timestamp) + '</div><div class="bubble">' + renderContent(m.content) + "</div></div>";
    }).join("");
    var openUrl = state.discordGuildId && f.thread_id ? "https://discord.com/channels/" + esc(state.discordGuildId) + "/" + esc(f.thread_id) : "";
    var tagRow = (f.tags || []).map(function (t) { return '<span class="chip soft" style="padding:1px 8px">' + esc(t) + "</span>"; }).join("");
    var fst = forumStatus(f);
    var detail = '<div class="pane detail">' +
      '<div class="detail-head fh"><div class="dh-main"><h2 class="truncate">' + esc(f.title) + '</h2><div class="dh-sub truncate">' + esc(f.author) + DOT + esc(f.ago) + "</div>" +
      '<div class="dh-status">' + dsStatusPill(fst) + (f.forum ? '<span class="chip accent" style="padding:1px 8px">' + esc(f.forum) + "</span>" : "") + tagRow + "</div></div>" +
      '<div class="detail-actions">' +
      (openUrl ? '<a class="btn sm ghost" href="' + openUrl + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open in Discord</a>" : "") +
      "</div></div>" +
      '<div class="thread">' + msgs + "</div>" +
      '<div class="composer" style="flex-direction:column;align-items:stretch;gap:10px">' +
      '<div class="hint">To reply, open this post in Discord and answer in the thread. Mark it Replied or Ignored to clear it from the To-Do.</div>' +
      '<div class="row-gap" style="gap:8px;flex-wrap:wrap">' +
      (openUrl ? '<a class="btn primary" href="' + openUrl + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open in Discord</a>" : "") +
      '<button class="btn sm' + (fst === "replied" ? " primary" : " ghost") + '" data-act="forum-status" data-id="' + esc(f.id) + '" data-val="replied">' + ic("check", "ico-sm") + "Replied</button>" +
      '<button class="btn sm' + (fst === "ignored" ? " primary" : " ghost") + '" data-act="forum-status" data-id="' + esc(f.id) + '" data-val="ignored">Ignored</button>' +
      "</div></div></div>";
    var user = userByDiscordId(f.author_id);
    var ctx = contextPanel({
      user: user, fallbackName: f.author, fallbackPlatform: "Discord",
      jiraKeys: f.jira_keys || [], hideMaintenance: true, tags: tagsArrFor("forum", f.id) || [],
      notes: notesFor("forum", f.id), noteAnchor: { type: "forum", ref: f.id, label: "Forum: " + f.title }
    });
    return dsWrap("forum", '<div class="split three">' + listPane + detail + ctx + "</div>");
  }

  /* Discord moderator mentions across server channels - a plain notification feed (like Monitor), NOT a
     chat. Each card jumps to Discord to reply; Replied/Ignored are manual triage. */
  function viewDiscordMentions() {
    var ql = state.q.toLowerCase();
    var mstat = state.mentionStatus || "all";
    var showHistM = state.mentionsHistory;
    var list = (D.discordMentions || []).filter(function (m) {
      var okS = mstat === "all" || (m.status || "new") === mstat;
      var okQ = !ql || (m.author + " " + m.channel_name + " " + m.content).toLowerCase().indexOf(ql) >= 0;
      var itemHist = inHistory(m.ts);
      return okS && okQ && (searching() || (showHistM ? itemHist : !itemHist));
    });
    var statusChips = [["all", "All"], ["new", "New"], ["replied", "Replied"], ["ignored", "Ignored"]]
      .map(function (c) { return '<button class="filter' + (mstat === c[0] ? " active" : "") + '" data-act="filter" data-group="mentionStatus" data-val="' + c[0] + '">' + c[1] + "</button>"; }).join("") + historyToggle("mentionsHistory");
    var cards = list.map(function (m) {
      var openUrl = state.discordGuildId && m.channel_id ? "https://discord.com/channels/" + esc(state.discordGuildId) + "/" + esc(m.channel_id) + "/" + esc(m.message_id) : "";
      var u = userByDiscordId(m.author_id); if (!u) ensureDiscordEmail(m.author_id);
      var emailChip = userIdChip(u);
      return '<div class="feed-card td-card" style="cursor:default"><div class="fc-main">' +
        '<div class="td-top">' + dsStatusPill(m.status || "new") +
        '<span class="chip soft" style="padding:1px 8px">' + ic("discord", "ico-sm") + "#" + esc(m.channel_name) + "</span>" +
        '<span class="rtime" style="margin-left:auto">' + esc(m.ago) + "</span></div>" +
        '<div class="fc-title truncate" style="margin-top:7px">' + esc(m.author) + "</div>" +
        '<div class="fc-sub">' + renderContent(m.content) + "</div>" +
        '<div class="rmeta" style="margin-top:9px;gap:7px">' + emailChip + emailActions(m.author_id, "", m.author_id ? "https://discord.com/users/" + m.author_id : "", u && (u.user_ids || [])[0]) + "</div>" +
        cardTags("mention", m.id) +
        '<div class="td-actions">' +
        (openUrl ? '<a class="btn sm primary" href="' + openUrl + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open in Discord</a>" : "") +
        '<button class="btn sm' + (m.status === "replied" ? " primary" : "") + '" data-act="mention-status" data-id="' + esc(m.id) + '" data-val="replied">Replied</button>' +
        '<button class="btn sm' + (m.status === "ignored" ? " primary" : "") + '" data-act="mention-status" data-id="' + esc(m.id) + '" data-val="ignored">Ignored</button>' +
        "</div></div></div>";
    }).join("");
    var body = list.length ? cards : emptyState("discord", showHistM ? "No history" : "No mentions", showHistM ? "No archived mentions." : "No moderator mentions right now.");
    var inner = '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
      '<div style="padding:14px 20px 12px;border-bottom:1px solid var(--border);background:var(--surface);flex:none">' +
      '<div class="pane-title"><h2>Mentions</h2><span class="count-pill">' + list.length + "</span></div>" +
      '<div class="filters">' + statusChips + "</div></div>" +
      '<div class="ds-scroll" style="flex:1;min-height:0;overflow:auto"><div class="feed">' + body + "</div></div></div>";
    return dsWrap("mentions", inner);
  }

  /* ---------- Discord ModMail ---------- */
  function viewDiscord(num) {
    // Sub-routes for deep-links from Monitor / To-Do / notifications: #/discord/forum/<id>, #/discord/mentions/<id>.
    var subId = (location.hash.replace(/^#\/?/, "").split("/").filter(Boolean))[2] || "";
    if (num === "forum") { state.discordTab = "forum"; if (subId) state.forumSel = subId; return viewDiscordForum(); }
    if (num === "mentions") { state.discordTab = "mentions"; if (subId) state.mentionSel = subId; return viewDiscordMentions(); }
    if (num) state.discordTab = "tickets";   // a deep-link to a specific ticket opens the Tickets tab
    var tab = state.discordTab || "tickets";
    if (tab === "forum") return viewDiscordForum();
    if (tab === "mentions") return viewDiscordMentions();
    var ql = state.q.toLowerCase();
    /* Archive (like Reddit History): closed tickets live ONLY there. The active list, its counts and
       chips never include them, so opening an old ticket (Profile 360, search) does not grow the totals. */
    if (state.discordStatus === "done") { state.discordStatus = "all"; state.discordArchive = true; }
    var _routeT = num ? ticketByKey(num) : null;
    if (_routeT && state._dsAutoFor !== String(num)) {   // a deep-link to a closed ticket opens the Archive once
      state._dsAutoFor = String(num);
      if (deriveDiscordStatus(_routeT) === "done") state.discordArchive = true;
    }
    var arch = !!state.discordArchive;
    // Closed tickets are paged in on demand (not in the initial active load); search goes to the server.
    if (arch && !state.closedPage.loaded && !state.closedPage.loading) loadClosed();
    if (arch && ql) searchClosed(ql);
    var _pool = D.discordTickets.filter(function (t) { return (deriveDiscordStatus(t) === "done") === arch; });
    var list = _pool.filter(function (t) {
      var okS = arch || state.discordStatus === "all" || deriveDiscordStatus(t) === state.discordStatus;
      var okT = state.discordType === "all" || t.ticket_type === state.discordType;
      var okJ = state.discordJira === "all" || (state.discordJira === "linked" ? !!t.jira_key : !t.jira_key);
      var okQ = !ql || ("#" + t.ticket_number + " " + t.user_name + " " + t.metadata.description).toLowerCase().indexOf(ql) >= 0;
      return okS && okT && okJ && okQ;
    });
    // Sort by the LAST message time, most-recent first, so a ticket with a fresh reply never sits below an
    // older one. ts == last_message_ts.
    list.sort(function (a, b) { var ta = _utcDate(a.ts), tb = _utcDate(b.ts); return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0); });
    if (!num && list.length && !state.isMobile) num = tid(list[0]);   // phone: list first, open on tap
    var t = ticketByKey(num);
    if (t) num = tid(t);   // normalize a channel_id route (from a notification) to the ticket's own key
    if (t) {
      ensureDiscordEmail(t.user_id);   // pull this user's email on demand
      if (isUnread("ticket", t, tid(t))) markRead("ticket", tid(t), t.messages_count);   // viewing = read (S6)
    }
    var archChip = '<button class="filter hist' + (arch ? " active" : "") + '" data-act="ds-archive" title="Closed tickets">' +
      ic("archive", "ico-sm") + (arch ? "Back to active" : "Archive") + "</button>";
    var statusChips = archChip + (arch ? "" : [["all", "All"], ["new", "New"], ["in_progress", "In progress"], ["waiting_user", "Waiting on user"], ["needs_review", "Needs review"], ["postponed", "Postponed"]]
      .map(function (c) {
        var n = c[0] === "all" ? _pool.length : _pool.filter(function (t) { return deriveDiscordStatus(t) === c[0]; }).length;
        return '<button class="filter' + (state.discordStatus === c[0] ? " active" : "") + '" data-act="filter" data-group="discordStatus" data-val="' + c[0] + '">' + c[1] + (n ? '<span class="fcount">' + n + "</span>" : "") + "</button>"; }).join(""));
    var typeChips = [["all", "Any type"], ["service", "Service"], ["server", "Server"]]
      .map(function (c) { return '<button class="filter' + (state.discordType === c[0] ? " active" : "") + '" data-act="filter" data-group="discordType" data-val="' + c[0] + '">' + c[1] + "</button>"; }).join("");
    var jiraChips = [["all", "Any Jira"], ["linked", "Jira linked"], ["none", "No Jira"]]
      .map(function (c) { return '<button class="filter' + (state.discordJira === c[0] ? " active" : "") + '" data-act="filter" data-group="discordJira" data-val="' + c[0] + '">' + c[1] + "</button>"; }).join("");
    var rows = list.map(function (x) {
      return '<div class="row' + (tid(x) === String(num) ? " active" : "") + '" data-go="#/discord/' + tid(x) + '">' +
        avatarOrCount("ticket", x, tid(x), initials(x.user_name)) +
        '<div class="rmain"><div class="rtop"><span class="rname truncate">#' + x.ticket_number + DOT + esc(x.user_name) + "</span>" + tagAlert("ticket", tid(x)) + '<span class="rtime">' + esc(timeText(x.last_message_ts || x.ts) || x.ago) + "</span></div>" +
        '<div class="rsub truncate">' + esc(x.last_message || x.metadata.description) + "</div>" +
        '<div class="rmeta"><span class="st ' + statusClass(deriveDiscordStatus(x)) + '">' + mmStatusLabel(deriveDiscordStatus(x)) + '</span><span class="chip soft" style="padding:1px 8px">' + esc(x.ticket_type) + "</span>" +
        (x.postponed && deriveDiscordStatus(x) !== "postponed" ? '<span class="chip soft" style="padding:1px 8px">' + ic("clock", "ico-sm") + "Postponed</span>" : "") +
        (x._idleReview ? '<span class="chip soft" style="padding:1px 8px" title="' + esc(DISCORD_IDLE_NOTE) + '">' + ic("clock", "ico-sm") + "No user reply 3d</span>" : "") +
        (x.jira_key ? '<span class="chip accent" style="padding:1px 8px">' + ic("jira", "ico-sm") + esc(x.jira_key) + "</span>" : "") + "</div></div></div>";
    }).join("");
    var closedLive = arch;
    var listBody = rows || (closedLive && (state.closedPage.loading || !state.closedPage.loaded || (ql && _closedSearch[ql] === "loading"))
      ? '<div class="empty" style="padding:24px"><p class="muted">Loading closed tickets…</p></div>'
      : emptyState("discord", "Empty", arch ? "No closed tickets." : "No tickets."));
    var moreBtn = (closedLive && rows && !ql && !state.closedPage.done)
      ? '<div style="padding:12px;text-align:center"><button class="btn sm ghost" data-act="load-closed"' + (state.closedPage.loading ? " disabled" : "") + ">" + (state.closedPage.loading ? "Loading…" : "Load more closed") + "</button></div>"
      : "";
    state._dsFilterBar = '<div class="topfilters">' + (function () {
        var nAct = (state.discordType !== "all" ? 1 : 0) + (state.discordJira !== "all" ? 1 : 0);
        var TL = { service: "Type: Service", server: "Type: Server" }, JL = { linked: "Jira linked", none: "No Jira" };
        var tags = (state.discordType !== "all" ? '<button class="ftag" data-act="filter" data-group="discordType" data-val="all">' + esc(TL[state.discordType] || state.discordType) + ' <span aria-hidden="true">&times;</span></button>' : "") +
                   (state.discordJira !== "all" ? '<button class="ftag" data-act="filter" data-group="discordJira" data-val="all">' + esc(JL[state.discordJira] || state.discordJira) + ' <span aria-hidden="true">&times;</span></button>' : "");
        var pop = state.dsFiltersOpen ? '<div class="fpop"><div class="fpop-l">Type</div><div class="filters">' + typeChips + '</div><div class="fpop-l">Jira</div><div class="filters">' + jiraChips + "</div></div>" : "";
        return '<div class="filters fscroll">' + statusChips + "</div>" +
          '<div class="fbar"><button class="btn sm' + (state.dsFiltersOpen ? " on" : "") + '" data-act="ds-filters">Filters' + (nAct ? ' <span class="fcount on">' + nAct + "</span>" : "") + "</button>" + tags + "</div>" + pop + "</div>";
      })();
    var listPane = '<div class="pane list"><div class="pane-head"><div class="pane-title"><h2>' + (arch ? "Archive" : "Tickets") + '</h2><span class="count-pill">' + list.length + "</span></div>" +
"</div>" +
      listBody + moreBtn + "</div>";
    if (!t) return dsWrap("tickets", '<div class="split three">' + listPane + '<div class="pane detail">' + emptyState("discord", "Select a ticket", "") + '</div><div class="pane context"></div></div>');
    if (!t.messages_history) ensureTranscript(t);   // live: fetch transcript on first open
    var msgs = !t.messages_history
      ? '<div class="empty" style="padding:24px"><p class="muted">Loading transcript…</p></div>'
      : t.messages_history.map(function (m) {
        // Mod messages show the team member's unified display name when their Discord is linked.
        var modName = (function () { var tm = m.is_user ? null : teamByDiscord(m.author_name, null); return tm ? (tm.display_name || tm.name) : esc(m.author_name); })();
        if (m.note) {
          return '<div class="msg internal"><div class="bubble"><span class="tag">' + ic("shield", "ico-sm") + "Internal note" + DOT + modName + '</span><div style="margin-top:5px">' + renderContent(m.content) + "</div></div></div>";
        }
        var cls = m.is_user ? "in" : "out";
        var meta = (m.is_user ? esc(m.author_name) : modName + DOT + "mod") + DOT + esc(m.timestamp);
        return '<div class="msg ' + cls + '"><div class="meta">' + meta + '</div><div class="bubble">' + renderContent(m.content) + "</div></div>";
      }).join("");
    var _mu = userByDiscordId(t.user_id) || userByEmail(t.metadata.email_or_session);
    var _mraw = String(t.metadata.email_or_session || "");
    var _muid = (_mu && _mu.user_ids && _mu.user_ids[0]) || _uidByEmail[_mraw.toLowerCase()] || (/^User ID\s*\d+$/i.test(_mraw) ? _mraw.replace(/\D/g, "") : "");
    var _mident = _muid ? '<a class="mono" href="' + esc(adminSessionsUrl(_muid)) + '" target="_blank" rel="noopener">' + esc(_muid) + "</a>"
      : (/@/.test(_mraw) ? '<span class="muted">not looked up yet</span>' : '<span class="mono truncate">' + esc(_mraw || "none") + "</span>");
    var metaBlock = '<div class="section-note">' +
      '<div class="kv"><span class="k">Type</span><span class="v">' + esc(t.ticket_type) + "</span></div>" +
      '<div class="kv"><span class="k">' + (_muid || /@/.test(_mraw) ? "User ID" : "Session") + '</span><span class="v truncate">' + _mident + "</span></div>" +
      '<div class="kv"><span class="k">Created</span><span class="v">' + esc(fmtDT(t.created_at)) + "</span></div>" +
      (t.postponed ? '<div class="kv"><span class="k">Postponed</span><span class="v">until ' + esc(fmtDT(t.postponed_until)) + (t.postpone_reason ? DOT + esc(t.postpone_reason) : "") + "</span></div>" : "") +
      '<div class="kv"><span class="k">Messages</span><span class="v">' + t.messages_count + "</span></div></div>";
    // The opening message (the modal description) lives only in the header; duplicate it into the
    // thread as the first user bubble, like Reddit ModMail/Posts (T6). Skip if the transcript's
    // first user message already is that text (avoid a literal double).
    var firstMsg = t.messages_history && t.messages_history[0];
    var dupOpen = firstMsg && firstMsg.is_user && String(firstMsg.content || "").trim() === String(t.metadata.description || "").trim();
    var openMsg = (t.metadata.description && !dupOpen)
      ? '<div class="msg in"><div class="meta">' + esc(t.user_name) + DOT + esc(fmtDT(t.created_at)) + '</div><div class="bubble">' + renderContent(t.metadata.description) + "</div></div>"
      : "";
    var detail = '<div class="pane detail">' +
      // Status chip + change dropdown under the username, unified with Reddit ModMail.
      '<div class="detail-head"><div class="dh-main"><h2 class="truncate">#' + t.ticket_number + DOT + esc(t.user_name) + '</h2><div class="dh-sub truncate">' + esc(t.metadata.description) + "</div>" +
      discordStatusControl(t) + "</div>" +
      '<div class="detail-actions">' +
      (state.discordGuildId && t.channel_id ? '<a class="btn sm ghost" href="https://discord.com/channels/' + esc(state.discordGuildId) + "/" + esc(t.channel_id) + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open in Discord</a>" : "") +
      "</div></div>" +
      '<div class="thread">' + metaBlock + openMsg + msgs + renderPending("ticket", tid(t)) + "</div>" +
      '<div class="composer" style="flex-direction:column;align-items:stretch;gap:8px">' +
      '<textarea placeholder="Message on ticket #' + t.ticket_number + ' ..." data-composer></textarea>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn sm ghost" data-act="tpl-pick" title="Insert a reply template">' + ic("notes", "ico-sm") + "Templates</button>" +
      '<button class="btn sm ghost" data-act="tr-compose" title="Translate what you typed to English (you still send it manually)">' + ic("reply", "ico-sm") + "Translate &rarr; EN</button>" +
      '<div class="spacer"></div>' +
      '<button class="btn mods" title="Internal note, like a message without !say (not sent to the user)" data-act="dsend" data-ticket="' + tid(t) + '" data-kind="note">' + ic("shield", "ico-sm") + "Send note</button>" +
      '<button class="btn primary" title="Send to the user (like !say)" data-act="dsend" data-ticket="' + tid(t) + '" data-kind="user">' + ic("send", "ico-sm") + "Send to user</button>" +
      "</div></div></div>";
    var user = userByDiscordId(t.user_id) || userByEmail(t.metadata.email_or_session);
    if (t.user_id) ensureUserTickets([t.user_id]);   // closed tickets of this user ("Also wrote")
    var ctx = contextPanel({
      user: user, fallbackName: t.user_name, fallbackPlatform: "Discord", fallbackEmail: t.metadata.email_or_session,
      emailUser: t.user_id ? String(t.user_id) : "",                          // Edit Email in Discord ModMail (real DB write)
      emailProfileUrl: t.user_id ? "https://discord.com/users/" + t.user_id : "",  // binds to discord_user_id, not a Reddit guess
      jiraKeys: t.jira_keys && t.jira_keys.length ? t.jira_keys : (t.jira_key ? [t.jira_key] : []),
      maintenance: (D.maintenanceSubs || []).filter(function (s) { return s.target_type === "discord" && String(s.target_id) === String(t.channel_id); }),
      tags: t.tags,
      notes: notesFor("ticket", tid(t)).concat(user ? notesFor("user", user.id) : []),
      noteAnchor: { type: "ticket", ref: tid(t), label: "Discord #" + t.ticket_number }
    });
    return dsWrap("tickets", '<div class="split three">' + listPane + detail + ctx + "</div>");
  }

  /* ---------- Telegram (linked discussion chat: user comments under posts + general chat) ---------- */
  /* Read: the bot snapshots user messages (excludes channel posts + chat admins). Reply: MTProto "as the
     channel". answered=false drives the sidebar unread count. Add Suggestion pre-fills the wishlist form. */
  function viewTelegram() {
    var ql = state.q.toLowerCase();
    var tstat = state.tgStatus || "all";
    var showHistT = state.telegramHistory;
    // Read status is by VIEW, not by answer: opening the Telegram tab marks its messages seen.
    (D.telegramMessages || []).forEach(function (m) { if (!inHistory(m.ts) && tgIsUnread(m)) markRead("telegram", m.id, 1); });
    var list = (D.telegramMessages || []).filter(function (m) {
      var okS = tstat === "all" ? true
        : tstat === "unanswered" ? (!m.answered && !m.ignored)
        : tstat === "answered" ? (m.answered && !m.ignored)
        : tstat === "ignored" ? !!m.ignored : true;
      var okQ = !ql || (m.user + " " + m.username + " " + m.text).toLowerCase().indexOf(ql) >= 0;
      var itemHist = inHistory(m.ts);
      return okS && okQ && (searching() || (showHistT ? itemHist : !itemHist));
    });
    var _tgPool = (D.telegramMessages || []).filter(function (m) { return showHistT ? inHistory(m.ts) : !inHistory(m.ts); });
    var _tgN = { all: _tgPool.length,
      unanswered: _tgPool.filter(function (m) { return !m.answered && !m.ignored; }).length,
      answered: _tgPool.filter(function (m) { return m.answered && !m.ignored; }).length,
      ignored: _tgPool.filter(function (m) { return !!m.ignored; }).length };
    var statusChips = [["all", "All"], ["unanswered", "Unanswered"], ["answered", "Answered"], ["ignored", "Ignored"]]
      .map(function (c) { return '<button class="filter' + (tstat === c[0] ? " active" : "") + '" data-act="filter" data-group="tgStatus" data-val="' + c[0] + '">' + c[1] + (_tgN[c[0]] ? '<span class="fcount">' + _tgN[c[0]] + "</span>" : "") + "</button>"; }).join("") + historyToggle("telegramHistory");
    function tgCard(m) {
      // Link straight to the message inside the discussion group (private supergroup: t.me/c/<id>/<msg>),
      // not to the user's profile. Fall back to the profile only if we somehow lack the chat/message ids.
      var tgUrl = (m.chat_id && m.message_id)
        ? "https://t.me/c/" + String(m.chat_id).replace(/^-100/, "") + "/" + m.message_id
        : (m.username ? "https://t.me/" + m.username : "");
      var tgImgUrl = (window.CONSOLE ? window.CONSOLE.base : "/api/console") + "/telegram-image?id=" + encodeURIComponent(m.id);
      var u = userByTelegramId(m.user_id); if (!u) ensureTelegramUser(m.user_id);
      var emailChip = userIdChip(u);
      var srcTag = m.is_comment ? ic("posts", "ico-sm") + "Comment" + (m.post_title ? DOT + esc(m.post_title) : "") : ic("send", "ico-sm") + "Chat";
      return '<div class="feed-card td-card" style="cursor:default"><div class="fc-main">' +
        '<div class="td-top"><input type="checkbox" class="tg-check" data-act="tg-select" data-id="' + esc(m.id) + '"' + ((state.tgSel && state.tgSel[m.id]) ? " checked" : "") + ' title="Select for bulk Ignore"> ' +
        '<span class="st ' + (m.ignored ? "backlog" : (m.answered ? "done" : "new")) + '">' + (m.ignored ? "Ignored" : (m.answered ? "Answered" : "Unanswered")) + "</span>" +
        '<span class="chip soft" style="padding:1px 8px">' + srcTag + "</span>" +
        '<span class="rtime" style="margin-left:auto">' + esc(m.time) + "</span></div>" +
        '<div class="fc-title" style="margin-top:7px">' + esc(m.user) + ' <span class="muted" style="font-weight:400">@' + esc(m.username) + "</span></div>" +
        '<div class="fc-sub">' + renderContent(m.text) + "</div>" +
        (m.has_image ? '<div class="msg-imgs"><a href="' + esc(tgImgUrl) + '" target="_blank" rel="noopener"><img class="msg-img" src="' + esc(tgImgUrl) + '" alt="photo" loading="lazy" data-imgfail="drop"></a></div>' : "") +
        (m.answered && m.reply ? '<div class="tg-reply">' + ic("reply", "ico-sm") + '<div><div class="tgr-label">' +
          (m.answered_via === "telegram" ? "Replied in Telegram" + (m.answered_by ? " | " + esc(m.answered_by) : "")
            : (m.answered_by ? "Reply | " + esc(m.answered_by) : "Channel reply")) + "</div>" + renderContent(m.reply) + "</div></div>" : "") +
        (m.wishlist_added ? '<div class="tg-reply tg-wish">' + ic("plus", "ico-sm") + '<div><div class="tgr-label">Added to wishlist</div>' + esc(m.wishlist_added) + "</div></div>" : "") +
        '<div class="rmeta" style="margin-top:9px;gap:7px">' + emailChip + emailActions(m.username, "", "", u && (u.user_ids || [])[0]) + "</div>" +
        cardTags("telegram", m.id) +
        '<div class="td-actions">' +
        '<button class="btn sm primary" data-act="tg-reply" data-id="' + esc(m.id) + '">' + ic("reply", "ico-sm") + "Reply</button>" +
        '<button class="btn sm" data-act="add-suggestion" data-id="' + esc(m.id) + '" title="Send this as a Gaming Proposal (wishlist)">' + ic("plus", "ico-sm") + "Gaming Proposal</button>" +
        '<button class="btn sm' + (m.ignored ? " primary" : "") + '" data-act="tg-ignore" data-id="' + esc(m.id) + '" title="' + (m.ignored ? "Un-ignore this message" : "Ignore - no reply needed") + '">' + ic(m.ignored ? "check" : "x", "ico-sm") + (m.ignored ? "Ignored" : "Ignore") + "</button>" +
        (tgUrl ? '<a class="btn sm ghost" href="' + esc(tgUrl) + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open in Telegram</a>" : "") +
        "</div></div></div>";
    }
    state._tgOrder = list.map(function (m) { return m.id; });   // shift-click range selection follows this order
    var cards;
    if (state.isMobile) {
      cards = list.map(tgCard).join("");
    } else {
      // desktop: compact list (checkbox, who, where, when, text, status) + the open message on the right
      var open = list.filter(function (m) { return m.id === state.tgOpen; })[0] || list[0];
      var allSel = list.length && list.every(function (m) { return state.tgSel && state.tgSel[m.id]; });
      var rowsHtml = list.map(function (m) {
        var st = m.ignored ? "ignored" : (m.answered ? "replied" : "new");
        var where = m.is_comment ? "Comment" + (m.post_title ? DOT + m.post_title : "") : "Chat";
        return '<div class="row tg-row' + (open && open.id === m.id ? " active" : "") + '" data-act="tg-open" data-id="' + esc(m.id) + '">' +
          '<input type="checkbox" class="tg-check" data-act="tg-select" data-id="' + esc(m.id) + '"' + ((state.tgSel && state.tgSel[m.id]) ? " checked" : "") + ' aria-label="Select">' +
          '<div class="rmain"><div class="rtop"><span class="rname truncate">' + esc(m.user) + ' <span class="muted" style="font-weight:400">@' + esc(m.username) + DOT + esc(where) + '</span></span><span class="rtime">' + esc(m.time) + "</span></div>" +
          '<div class="rsub tg-text">' + esc(previewText(m.text)) + "</div>" +
          '<div class="rmeta"><span class="st ' + st + '">' + (m.ignored ? "Ignored" : (m.answered ? "Answered" : "Unanswered")) + "</span></div></div></div>";
      }).join("");
      cards = '<div class="tg-md"><div class="tg-list"><div class="tg-list-h"><input type="checkbox" class="tg-check" data-act="tg-select-all"' + (allSel ? " checked" : "") + ' aria-label="Select all shown"><span class="muted">Select all ' + list.length + " shown" + '</span><span class="muted" style="margin-left:auto">Shift+click selects a range</span></div>' + rowsHtml + "</div>" +
        '<div class="tg-detail">' + (open ? tgCard(open) : "") + "</div></div>";
    }
    var body = list.length ? cards : emptyState("send", showHistT ? "No history" : "No messages", showHistT ? "No archived Telegram messages." : "No Telegram messages right now.");
    var selCount = Object.keys(state.tgSel || {}).filter(function (k) { return state.tgSel[k]; }).length;
    var bulkBar = selCount ? '<div class="tg-bulk"><b>' + selCount + " selected</b>" +
      '<button class="btn sm primary" data-act="tg-bulk-ignore">' + ic("x", "ico-sm") + "Ignore selected</button>" +
      '<button class="btn sm ghost" data-act="tg-clear-sel">Clear</button></div>' : "";
    return '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
      '<div style="padding:14px 20px 12px;border-bottom:1px solid var(--border);background:var(--surface);flex:none">' +
      '<div class="pane-title"><h2>Telegram</h2><span class="count-pill">' + list.length + "</span></div>" +
      '<div class="filters">' + statusChips + "</div>" + bulkBar + "</div>" +
      '<div class="ds-scroll" style="flex:1;min-height:0;overflow:auto"><div class="feed' + (state.isMobile ? "" : " tg-feed") + '">' + body + "</div></div></div>";
  }
  /* Reply to a Telegram user in a movable (modeless) popover, so the message list stays readable behind
     it. Templates + translate work on the composer inside; Send posts via MTProto "as the group". */
  function openTgReply(id, prefill) {
    var m = (D.telegramMessages || []).filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    state._tgReplyId = id;
    showModal({
      modeless: true, title: "Reply to @" + m.username, close: "Close",
      custom: function () {
        return '<div class="section-note" style="margin-bottom:10px">' + esc(m.text) + "</div>" +
          '<textarea class="f-input" data-composer placeholder="Reply as the group (sent via MTProto) …" style="min-height:120px">' + esc(typeof prefill === "string" ? prefill : (m.answered && m.reply ? m.reply : "")) + "</textarea>" +
          '<div class="row-gap" style="margin-top:10px;gap:8px;flex-wrap:wrap">' +
          '<button class="btn sm ghost" data-act="tpl-pick" title="Insert a reply template">' + ic("notes", "ico-sm") + "Templates</button>" +
          '<button class="btn sm ghost" data-act="tr-compose" title="Translate to English">' + ic("reply", "ico-sm") + "Translate &rarr; EN</button>" +
          '<button class="btn sm ghost" data-act="add-suggestion" data-id="' + esc(m.id) + '" title="Send this as a Gaming Proposal (wishlist)">' + ic("plus", "ico-sm") + "Gaming Proposal</button>" +
          '<div class="spacer"></div>' +
          '<button class="btn primary" data-act="tg-send" data-id="' + esc(m.id) + '">' + ic("send", "ico-sm") + "Send reply</button>" +
          "</div>";
      }
    });
  }
  /* Gaming Proposal (game -> our wishlist). The same bot function as the Slack "Gaming proposal" modal
     (services/team_forms.submit_game_proposal) via the add_suggestion action. Platform options mirror the
     Slack modal 1:1. Pre-fills the game name (e.g. from a Telegram message). */
  var PROPOSAL_PLATFORMS = ["Steam", "Epic", "Xbox", "EA", "Battle.net", "Ubisoft", "Rockstar", "Other"];
  var PROPOSAL_TYPES = ["Feature", "Payment Method", "Feedback", "Gamepad", "Proposal"];
  /* When opened from a Telegram message button (tgMsgId set), mark that message "added to wishlist: X"
     on success so it's visible on the card (and persisted on the telegram_messages doc by the worker). */
  function markTgWishlisted(id, name) {
    var m = (D.telegramMessages || []).filter(function (x) { return x.id === id; })[0];
    if (m) { m.wishlist_added = name; render(); }
  }
  /* Open the Gaming Proposal modal prefilled from a chat, and record on success which chat it came
     from so the context panel can show it. */
  function openProposalForChat(anchor) {
    var prefill = "";
    if (anchor.type === "convo") { var c = convoById(anchor.ref); prefill = c ? c.subject : ""; }
    else if (anchor.type === "ticket") { var t = ticketByKey(anchor.ref); prefill = t ? ((t.metadata && t.metadata.description) || "") : ""; }
    else if (anchor.type === "post") { var p = (D.redditPosts || []).filter(function (x) { return x.id === anchor.ref; })[0]; prefill = p ? p.title : ""; }
    else if (anchor.type === "forum") { var f = (D.discordForum || []).filter(function (x) { return x.id === anchor.ref; })[0]; prefill = f ? f.title : ""; }
    openAddSuggestion(prefill, null, anchor);
  }
  function openAddSuggestion(prefill, tgMsgId, anchor) {
    showModal({
      title: "Add Gaming Proposal", submit: "Send to wishlist", close: "Cancel",
      initial: { entity: prefill || "" },
      fields: [
        { id: "entity", label: "The Game", type: "text", required: true, placeholder: "Game title" },
        { id: "entity_type", label: "Platform", type: "select", options: PROPOSAL_PLATFORMS }
      ],
      onSubmit: function (v) {
        var name = (v.entity || "").trim();
        if (!name) { toast("Game name is required"); return; }
        function recordAnchor() {
          if (anchor && anchor.type) {
            var key = anchor.type + ":" + anchor.ref;
            state.proposalsAdded = state.proposalsAdded || {};
            (state.proposalsAdded[key] = state.proposalsAdded[key] || []).push(name);
          }
        }
        enqueueAction("add_suggestion", { entity: name, entity_type: v.entity_type || "Other", tg_msg_id: tgMsgId || "" }, function (r) {
          if (r && r.status === "done") { toast("Sent to wishlist: " + name); state._wlAt = 0; if (tgMsgId) markTgWishlisted(tgMsgId, name); recordAnchor(); render(); }
          else toast("Wishlist send failed" + (r && r.error ? ": " + r.error : ""));
        });
      }
    });
  }
  /* General user Proposal (Feature / Payment Method / Feedback / Gamepad / Proposal). Mirrors the Slack
     "Send user's proposal" modal 1:1 (SLACK_PROPOSAL_API_URL, type "user") via the add_proposal action. */
  function openAddProposal(prefill) {
    showModal({
      title: "Add Proposal", submit: "Send proposal", close: "Cancel",
      initial: { entity: prefill || "" },
      fields: [
        { id: "entity", label: "Describe the Proposal", type: "textarea", required: true, placeholder: "Describe the proposal" },
        { id: "entity_type", label: "Type of Proposal", type: "select", options: PROPOSAL_TYPES }
      ],
      onSubmit: function (v) {
        var text = (v.entity || "").trim();
        if (!text) { toast("Proposal text is required"); return; }
        enqueueAction("add_proposal", { entity: text, entity_type: v.entity_type || "Proposal" }, function (r) { toast(r && r.status === "done" ? "Proposal sent" : "Proposal send failed" + (r && r.error ? ": " + r.error : "")); });
      }
    });
  }

  /* ---------- Jira ---------- */
  /* Map a Jira communication link to the matching console conversation route, or null when the console
     has no such conversation (Facebook/Discord/other) so the caller opens the real link externally
     instead of dumping the user on the Jira tab. */

  /* ---------- Notes ---------- */
  function noteRoute(n) {
    switch (n.context_type) {
      case "user": return "#/user/" + n.ref;
      case "convo": return "#/modmail/" + n.ref;
      case "post": return "#/posts/" + n.ref;
      case "jira": return "#/jirachat/" + n.ref;
      case "ticket": return "#/discord/" + n.ref;
      default: return "";
    }
  }
  function noteIcon(n) { return { user: "user", convo: "mail", post: "posts", jira: "jira", ticket: "discord" }[n.context_type] || "notes"; }

  /* ---------- Known Issues: read/search mirror of the team Google Sheet (Games / Apps / Session /
     Account). Games & Apps are grouped by entity (searchable list -> its issues); Session & Account are
     flat problem lists. Each issue shows Problem, Solution, a Jira link, and a copy-able canned reply.
     "Add issue" writes a new row back to the sheet (via the bot). Filtering uses the top search box. */
  var KNOWN_TABS = [["games", "Games"], ["apps", "Apps"], ["session", "Session"], ["account", "Account"]];
  function knownLabel(cat) { var t = KNOWN_TABS.filter(function (x) { return x[0] === cat; })[0]; return t ? t[1] : cat; }
  function knownData(cat) { var c = (D.knownIssues || {})[cat] || {}; return { has_entity: !!c.has_entity, rows: c.rows || [] }; }
  /* Split a game name into base + launcher, the SAME way services/game_title.py does. "Foo (Xbox)" ->
     {base:"foo", launcher:"xbox"}. Keep the JS + Python in sync. */
  function splitLauncher(t) { var s = String(t || "").trim().replace(/[™®©℠℗]/g, ""); var launcher = ""; var m = s.match(/\s*\(([^)]*)\)\s*$/); if (m) { launcher = m[1].trim().toLowerCase(); s = s.slice(0, m.index); } return { base: s.replace(/\s{2,}/g, " ").trim().toLowerCase(), launcher: launcher }; }
  function gameMatchKey(s) { var x = splitLauncher(s); return x.base + "|" + x.launcher; }
  /* Game-List ID(s) for a Known Issues game entity (mirror of the "Game List" sheet). A "(Xbox)" entity
     resolves only to the Xbox row; a plain name resolves to all platforms. Returns an array or null. */
  function gameIdsFor(title) { var a = (D.gameList || {})[gameMatchKey(title)]; return (a && a.length) ? a : null; }
  function knownIssueCard(r, hideProblem, cat) {
    var link = r.link ? '<a class="btn sm ghost" href="' + esc(safeUrl(r.link)) + '" target="_blank" rel="noopener">' + ic("jira", "ico-sm") + "Open ticket</a>" : "";
    var canned = r.canned
      ? '<div class="ki-canned"><div class="ki-canned-head"><span class="tgr-label">Canned message</span>' +
        '<button class="btn sm ghost" data-act="copy-canned">' + ic("copy", "ico-sm") + "Copy</button></div>" +
        '<div class="ki-canned-body">' + esc(r.canned) + "</div></div>"
      : "";
    var canShot = cat && isAdmin() && state.shotsEnabled;
    var shots = shotThumbs(r.shots, canShot ? "ki-shot-del" : "") +
      ((canShot && (r.shots || []).length < 6)
        ? '<label class="btn sm ghost shot-add">' + ic("plus", "ico-sm") + "Add screenshot" +
          '<input type="file" accept="' + SHOT_ACCEPT + '" multiple hidden data-ki-shot="1" data-cat="' + esc(cat) + '" data-ent="' + esc(r.entity || "") + '" data-problem="' + esc(r.problem || "") + '"></label>'
        : "");
    return '<div class="ki-card">' +
      (!hideProblem && r.problem ? '<div class="ki-problem">' + esc(r.problem) + "</div>" : "") +
      (r.solution ? '<div class="ki-solution">' + renderContent(r.solution) + "</div>" : "") +
      (shots ? '<div class="ki-shots">' + shots + "</div>" : "") +
      (link ? '<div class="ki-foot">' + link + "</div>" : "") + canned + "</div>";
  }
  /* Build the tile list for a tab: Games/Apps -> one tile per entity (game/app) with its issue count;
     Session/Account -> one tile per problem. Each tile carries a lowercased `search` blob for the
     in-place search filter, and a `key` used to open its pop-up. */
  function knownListItems(cat) {
    var d = knownData(cat);
    if (d.has_entity) {
      var map = {}, order = [];
      d.rows.forEach(function (r) { var e = r.entity || "(unnamed)"; if (!map[e]) { map[e] = []; order.push(e); } map[e].push(r); });
      return order.sort(function (a, b) { return a.localeCompare(b); }).map(function (e) {
        var ids = gameIdsFor(e);
        var blob = e + " " + (ids ? ids.join(" ") + " " : "") + map[e].map(function (r) { return (r.problem || "") + " " + (r.solution || "") + " " + (r.canned || ""); }).join(" ");
        return { key: e, title: e, count: map[e].length, ids: ids, search: blob.toLowerCase() };
      });
    }
    return d.rows.map(function (r, i) {
      return { key: String(i), title: r.problem || "(untitled)", sub: r.solution || "",
        search: ((r.problem || "") + " " + (r.solution || "") + " " + (r.canned || "")).toLowerCase() };
    });
  }
  var CHEV = '<svg class="ki-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M9 6l6 6-6 6"/></svg>';
  function viewKnown() {
    ensureGameList();   // load the game-ID map if the background load hasn't landed yet (idempotent)
    var tab = state.knownTab || "games";
    if (!KNOWN_TABS.some(function (t) { return t[0] === tab; })) tab = "games";
    var ql = (state.knownQuery || "").toLowerCase();
    var configured = Object.keys(D.knownIssues || {}).length > 0;
    var subtabs = '<div class="subtabs">' + KNOWN_TABS.map(function (t) {
      return '<button class="stab' + (t[0] === tab ? " active" : "") + '" data-act="known-tab" data-tab="' + t[0] + '">' + t[1] + "</button>";
    }).join("") + "</div>";
    var addBtn = '<button class="btn sm primary" data-act="known-add" data-cat="' + tab + '">' + ic("plus", "ico-sm") + (isAdmin() ? "Add issue" : "Suggest issue") + "</button>";
    var syncBtn = isAdmin() ? '<button class="btn sm ghost" data-act="known-sync" title="Pull the sheet into the console now">' + ic("refresh", "ico-sm") + "Sync</button>" : "";
    var bar = '<div class="ds-tabbar ki-tabbar">' + subtabs + '<div class="ki-tools">' + syncBtn + addBtn + "</div></div>";
    if (!configured) {
      return '<div class="ki-view">' + bar + '<div class="ki-content">' +
        emptyState("book", "Not synced yet", isAdmin() ? "Connect the sheet in Admin → Known issues, then Sync." : "Ask an admin to connect the known-issues sheet.") + "</div></div>";
    }
    var items = knownListItems(tab);
    var shown = 0;
    var tiles = items.map(function (it) {
      var hide = ql && it.search.indexOf(ql) < 0;
      if (!hide) shown++;
      // ID goes on its own small line UNDER the title (not beside it), so it never squeezes the name.
      var idLine = it.ids ? '<div class="ki-tile-id mono" title="Game List ID">ID ' + esc(it.ids.join(", ")) + "</div>" : "";
      return '<button class="ki-tile" data-act="known-open" data-cat="' + tab + '" data-key="' + esc(it.key) + '" data-search="' + esc(it.search) + '"' + (hide ? ' style="display:none"' : "") + ">" +
        '<div class="ki-tile-top"><span class="ki-tile-title truncate">' + esc(it.title) + "</span>" +
        (it.count != null ? '<span class="chip soft" style="padding:1px 8px">' + it.count + "</span>" : "") + CHEV + "</div>" +
        idLine +
        (it.sub ? '<div class="ki-tile-sub">' + esc(it.sub) + "</div>" : "") + "</button>";
    }).join("");
    var searchbar = '<div class="ki-searchbar"><label class="ki-search">' + ic("search", "ico-sm") +
      '<input id="known-search" type="text" autocomplete="off" placeholder="Search ' + knownLabel(tab).toLowerCase() + '…" value="' + esc(state.knownQuery || "") + '"></label>' +
      '<span class="ki-count muted"><b id="known-count">' + shown + "</b> of " + items.length + "</span></div>";
    var synced = state.knownSyncedAt ? '<span class="ki-synced-inline">' + ic("clock", "ico-sm") + "synced " + esc(timeText(state.knownSyncedAt)) + "</span>" : "";
    var grid = items.length ? '<div class="ki-grid" id="known-list">' + tiles + "</div>" : emptyState("book", "Empty", "Nothing in this tab yet.");
    return '<div class="ki-view">' + bar + searchbar + '<div class="ki-content"><div class="ki-scroll">' + grid +
      (synced ? '<div class="ki-synced-foot">' + synced + "</div>" : "") + "</div></div></div>";
  }
  /* Click a tile -> pop-up with the issue(s). Games/Apps show every issue for that entity; Session/
     Account show the single problem (its title is the modal heading, so we hide the repeated problem). */
  function openKnownDetail(cat, key) {
    state._kiOpen = { cat: cat, key: key };
    var d = knownData(cat), title, cards;
    if (d.has_entity) {
      var rows = d.rows.filter(function (r) { return (r.entity || "(unnamed)") === key; });
      if (!rows.length) return;
      title = key; state.knownSel = key;
      var _gid = gameIdsFor(key); if (_gid) title = key + "  (ID " + _gid.join(", ") + ")";
      cards = rows.map(function (r) { return knownIssueCard(r, false, cat); }).join("");
    } else {
      var r0 = d.rows[parseInt(key, 10)];
      if (!r0) return;
      title = r0.problem || "Issue"; state.knownSel = "";
      cards = knownIssueCard(r0, true, cat);
    }
    var addBtn = d.has_entity
      ? '<div class="ki-modal-foot"><button class="btn sm ghost" data-act="known-add" data-cat="' + cat + '">' + ic("plus", "ico-sm") + (isAdmin() ? "Add issue for this " + (cat === "games" ? "game" : "app") : "Suggest issue") + "</button></div>"
      : "";
    showModal({ title: title, close: "Close", custom: function () { return '<div class="ki-modal-list">' + cards + "</div>" + addBtn; } });
  }
  /* Re-pull Known Issues and, if its pop-up is still open, redraw it (after a screenshot change). */
  function reloadKnownDetail() {
    return window.CONSOLE.get("/known-issues").then(function (d) {
      if (!d || !d.categories) return;
      D.knownIssues = d.categories; state.shotsEnabled = !!d.shots_enabled;
      var o = state._kiOpen;
      if (o && state.modal) openKnownDetail(o.cat, o.key); else render();
    }, function () {});
  }
  /* Admin adds screenshots to an EXISTING issue straight from its card. */
  function kiShotsPicked(input) {
    var files = Array.prototype.slice.call(input.files || []);
    var fields = { category: input.getAttribute("data-cat"), problem: input.getAttribute("data-problem"),
                   entities: JSON.stringify(input.getAttribute("data-ent") ? [input.getAttribute("data-ent")] : []) };
    input.value = "";
    if (!files.length) return;
    toast("Uploading screenshot…");
    var key = "ki-card"; state._shotStage = state._shotStage || {}; state._shotStage[key] = [];
    files.slice(0, 6).reduce(function (p, f) {
      return p.then(function () { return shrinkImage(f).then(function (it) { shotStage(key).push(it); }, function (e) { toast(String(e)); }); });
    }, Promise.resolve()).then(function () {
      return uploadStaged(key, "/known-issue-shots", fields);
    }).then(function (shots) { if (shots.length) toast("Screenshot added", "ok"); reloadKnownDetail(); });
  }
  function kiShotDelete(id) {
    if (!window.confirm("Delete this screenshot from the known issue (also on the public page)?")) return;
    window.CONSOLE.del("/known-issue-shots/" + encodeURIComponent(id)).then(function () { toast("Screenshot deleted", "ok"); reloadKnownDetail(); },
      function () { toast("Delete failed"); });
  }
  function fbShotPicked(input) {
    var id = input.getAttribute("data-fb-shot"), file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    var f = (D.feedback || []).filter(function (x) { return String(x.id) === String(id); })[0];
    toast("Uploading screenshot…");
    shrinkImage(file).then(function (it) {
      return uploadShot("/feedback/" + encodeURIComponent(id) + "/shots", it.blob, {}).then(function (d) {
        if (d.ok && d.shot) { if (f) f.shots = (f.shots || []).concat([d.shot]); render(); toast("Screenshot attached", "ok"); }
        else toast("Screenshot: " + (d.error || "upload failed"));
      });
    }, function (e) { toast(String(e)); });
  }
  /* In-place search: show/hide tiles without a full re-render (keeps the input focused as you type). */
  function filterKnownList(query) {
    state.knownQuery = query;
    var ql = (query || "").toLowerCase();
    var list = q("#known-list"); if (!list) return;
    var n = 0;
    Array.prototype.forEach.call(list.querySelectorAll(".ki-tile"), function (t) {
      var ok = !ql || (t.getAttribute("data-search") || "").indexOf(ql) >= 0;
      t.style.display = ok ? "" : "none"; if (ok) n++;
    });
    var c = q("#known-count"); if (c) c.textContent = n;
  }
  /* Add / suggest a known issue. Admins write straight to the sheet (known_issues_add, inserted
     alphabetically by the first column). Regular users submit a SUGGESTION that an admin approves in
     Admin → Known-issues suggestions. Games/Apps pre-fill the entity with the currently-open game/app. */
  function openAddKnownIssue(cat) {
    var admin = isAdmin();
    var hasEnt = knownData(cat).has_entity;
    var entLabel = cat === "games" ? "Game" : (cat === "apps" ? "Application" : "");
    var fields = [];
    if (hasEnt) fields.push(cat === "games"
      ? { id: "entity", label: "Games (one per line)", type: "textarea", required: true, placeholder: "One game per line: the same problem is added for each" }
      : { id: "entity", label: entLabel, type: "text", required: true, placeholder: entLabel + " name" });
    fields.push({ id: "problem", label: "Problem", type: "text", required: true, placeholder: "Short problem title" });
    fields.push({ id: "solution", label: "Solution / Explanation", type: "textarea", placeholder: "How to resolve or explain it" });
    fields.push({ id: "link", label: "Link (Jira)", type: "url", placeholder: "https://bsdesk.atlassian.net/browse/SO-…" });
    fields.push({ id: "canned", label: "Canned message", type: "textarea", placeholder: "Ready-to-send reply for the user" });
    var stageKey = admin ? "ki-add" : "ki-sug-new";
    state._shotStage = state._shotStage || {}; state._shotStage[stageKey] = [];
    var shotField = function () {
      return state.shotsEnabled ? '<div class="field"><label>Screenshots <span class="opt">(optional' + (admin ? ", shown on the public page" : ", up to 3, shown after approval") + ")</span></label>" + shotPicker(stageKey) + "</div>" : "";
    };
    var intro = admin ? shotField : function () {
      return '<div class="section-note" style="margin-bottom:14px">Your suggestion will be added after admin approves it.</div>' + shotField();
    };
    showModal({
      title: (admin ? "Add known issue: " : "Suggest known issue: ") + knownLabel(cat),
      submit: admin ? "Add to sheet" : "Send for review", close: "Cancel",
      intro: intro,
      initial: (hasEnt && state.knownSel) ? { entity: state.knownSel } : {},
      fields: fields,
      onSubmit: function (v) {
        var ents = hasEnt ? kiEntList(v.entity) : [];
        var payload = { category: cat, entity: ents[0] || "", entities: ents, problem: v.problem || "", solution: v.solution || "", link: v.link || "", canned: v.canned || "" };
        if (admin) {
          if (hasEnt) state.knownSel = ents[0] || state.knownSel;
          kiAddRows(payload, function (ok, err) {
            if (ok) {
              toast(ents.length > 1 ? "Added to the sheet for " + ents.length + " games" : "Added to the sheet"); refreshKnown();
              if (shotStage("ki-add").length) uploadStaged("ki-add", "/known-issue-shots", { category: cat, problem: payload.problem, entities: JSON.stringify(ents) })
                .then(function (shots) { if (shots.length) { toast(shots.length === 1 ? "Screenshot added" : shots.length + " screenshots added", "ok"); refreshKnown(); } });
            }
            else toast("Add failed" + (err ? ": " + err : ""));
          });
        } else {
          window.CONSOLE.post("/known-issues-suggest", payload).then(function (r) {
            if (!(r && r.id)) { toast("Could not send suggestion"); return; }
            if (shotStage("ki-sug-new").length && r.upload_token) {
              uploadStaged("ki-sug-new", "/public/known-issues-suggest/" + encodeURIComponent(r.id) + "/shots", { token: r.upload_token })
                .then(function (shots) { toast("Suggestion sent for review" + (shots.length ? " with " + shots.length + " screenshot" + (shots.length > 1 ? "s" : "") : "")); });
            } else toast("Suggestion sent for review");
          }, function () { toast("Could not send suggestion"); });
        }
      }
    });
  }
  /* ---------- Team schedule: monthly grid mirrored from a Google Sheet (view for all; admin edits
     cells + creates new months). Not tied to the reminders/on-shift automation. ---------- */
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function _schParseDate(s) { var m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s || "").trim()); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
  function schWeekday(day) { if (day.weekday) return day.weekday; var d = _schParseDate(day.date); return d ? WEEKDAY_NAMES[d.getDay()] : ""; }
  function schIsWeekend(day) { var d = _schParseDate(day.date); if (d) { var w = d.getDay(); return w === 0 || w === 6; } var s = (day.weekday || "").toLowerCase(); return s.indexOf("sat") === 0 || s.indexOf("sun") === 0; }
  function scheduleMonths() { return (D.schedule && D.schedule.months) || []; }
  /* Only ever show the previous, current and next month (relative to today) - not the whole archive. */
  function _monthOrd(name) { var m = /^(.+)\s+(\d{4})$/.exec(name || ""); if (!m) return 0; var mi = MONTH_NAMES.indexOf(m[1]); return (+m[2]) * 12 + (mi < 0 ? 0 : mi); }
  function _allowedMonthKeys() {
    var now = new Date(), keys = [];
    [-1, 0, 1].forEach(function (off) { var d = new Date(now.getFullYear(), now.getMonth() + off, 1); keys.push(MONTH_NAMES[d.getMonth()] + " " + d.getFullYear()); });
    return keys;
  }
  function visibleScheduleMonths() {
    var allowed = _allowedMonthKeys();
    return scheduleMonths().filter(function (m) { return allowed.indexOf(m.month) >= 0; })
      .sort(function (a, b) { return _monthOrd(a.month) - _monthOrd(b.month); });
  }
  function currentScheduleMonth() {
    var ms = visibleScheduleMonths(); if (!ms.length) return null;
    var byState = ms.filter(function (x) { return x.month === state.scheduleMonth; })[0];
    if (byState) return byState;
    var now = new Date(), curKey = MONTH_NAMES[now.getMonth()] + " " + now.getFullYear();   // default to the current month
    return ms.filter(function (x) { return x.month === curKey; })[0] || ms[0];
  }
  /* Colour a cell by value: VACATION / OFFLINE / day shift / night shift / empty. */
  function schCellClass(v) {
    var s = String(v || "").trim(), u = s.toUpperCase();
    if (u === "VACATION") return "vac";
    if (u === "SICK LEAVE" || u === "SICK") return "sick";
    if (u === "OFFLINE") return "off";
    if (!s) return "empty";
    var mm = /^(\d{1,2}):/.exec(s);
    if (mm) { var h = +mm[1]; if (h >= 20 || h < 8) return "night"; }
    return "day";
  }
  /* SMM lives in the Google Sheet schedule but is intentionally hidden from the console calendar. */
  function schHidden(name) { return /\bSMM\b/i.test(String(name || "")); }   // e.g. "Arthur Kuzmichov (SMM)"
  function _schTodayStr() { var d = new Date(); return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear(); }
  function schInitials(name) { return (name || "?").split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ""; }).join("").toUpperCase(); }
  /* ---- Week rota helpers (members as rows, the 7 days of a week as columns) ---- */
  function _schMondayOf(d) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function _schDmy(d) { return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear(); }
  /* Every loaded date -> which month tab holds it + that tab's members + the day's shifts (so a week that
     straddles two months still resolves each cell, and admin edits target the right month/column). */
  function _schDateMap() {
    var map = {};
    visibleScheduleMonths().forEach(function (mo) { (mo.days || []).forEach(function (d) { map[d.date] = { month: mo.month, members: mo.members || [], shifts: d.shifts || {} }; }); });
    return map;
  }
  function _schRange() {
    var all = [];
    visibleScheduleMonths().forEach(function (mo) { (mo.days || []).forEach(function (d) { var dt = _schParseDate(d.date); if (dt) all.push(dt); }); });
    all.sort(function (a, b) { return a - b; });
    return { min: all[0] || null, max: all[all.length - 1] || null };
  }
  /* A member's representative shift-start hour (the most common across all loaded days), so the rota can
     group people who work the same hours. VACATION/OFFLINE/blank don't count; someone who never has a timed
     shift sorts last. */
  function _schStartKey(member) {
    var counts = {};
    visibleScheduleMonths().forEach(function (mo) {
      (mo.days || []).forEach(function (d) {
        var mt = /^(\d{1,2}):/.exec((((d.shifts || {})[member]) || "").trim());
        if (mt) { var h = +mt[1]; counts[h] = (counts[h] || 0) + 1; }
      });
    });
    var best = null, bestN = 0;
    Object.keys(counts).forEach(function (h) { if (counts[h] > bestN) { bestN = counts[h]; best = +h; } });
    return best == null ? 99 : best;
  }
  /* Team rows: union of members across the loaded months (SMM hidden), ordered by their usual shift start
     (so all the 10:00 people sit together, the night people together, etc.); stable tiebreak = sheet order. */
  function schMemberOrder() {
    var order = [];
    visibleScheduleMonths().forEach(function (mo) { (mo.members || []).forEach(function (mm) { if (!schHidden(mm) && order.indexOf(mm) < 0) order.push(mm); }); });
    return order.map(function (mm, i) { return { mm: mm, i: i, k: _schStartKey(mm) }; })
      .sort(function (a, b) { return a.k - b.k || a.i - b.i; })
      .map(function (x) { return x.mm; });
  }
  function currentWeekStart() {
    var rng = _schRange(), today = new Date(); today.setHours(0, 0, 0, 0);
    var anchor = (rng.min && today < rng.min) ? rng.min : ((rng.max && today > rng.max) ? rng.max : today);
    var ws = state.scheduleWeekStart ? _schMondayOf(new Date(state.scheduleWeekStart)) : _schMondayOf(anchor);
    if (rng.min && ws < _schMondayOf(rng.min)) ws = _schMondayOf(rng.min);
    if (rng.max && ws > _schMondayOf(rng.max)) ws = _schMondayOf(rng.max);
    return ws;
  }
  function _schWeekRangeLabel(ws) {
    var we = new Date(ws); we.setDate(we.getDate() + 6);
    var a = ws.getDate() + " " + MONTH_NAMES[ws.getMonth()].slice(0, 3);
    var b = we.getDate() + " " + MONTH_NAMES[we.getMonth()].slice(0, 3);
    return (ws.getMonth() === we.getMonth() ? ws.getDate() + "–" + b : a + " – " + b) + " " + we.getFullYear();
  }
  /* Week rota: one row per person, one column per day. Everyone's week is visible at once - no "+N more". */
  function scheduleWeekHtml(admin, todayStr) {
    var members = schMemberOrder();
    if (!members.length) return emptyState("calendar", "No people in the schedule yet", "");
    var ws = currentWeekStart(), map = _schDateMap();
    var days = []; for (var i = 0; i < 7; i++) { var d = new Date(ws); d.setDate(d.getDate() + i); days.push(d); }
    var WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    var header = '<div class="rota-corner"></div>' + days.map(function (d, i) {
      var ds = _schDmy(d), isToday = ds === todayStr, we = d.getDay() === 0 || d.getDay() === 6;
      return '<div class="rota-dh' + (isToday ? " today" : "") + (we ? " we" : "") + '"><span class="rota-dw">' + WD[i] + "</span><span class=\"rota-dn\">" + d.getDate() + "</span>" + (isToday ? '<span class="rota-td">today</span>' : "") + "</div>";
    }).join("");
    var rows = members.map(function (mm) {
      var cells = days.map(function (d) {
        var ds = _schDmy(d), cell = map[ds], val = cell ? (cell.shifts[mm] || "") : "";
        var cls = schCellClass(val), isToday = ds === todayStr, we = d.getDay() === 0 || d.getDay() === 6;
        var mi = cell ? cell.members.indexOf(mm) : -1, editable = admin && cell && mi >= 0;
        var label = val ? (cls === "vac" ? "Vacation" : cls === "sick" ? "Sick" : cls === "off" ? "Off" : esc(val)) : "";
        var inner = val ? '<span class="rota-pill ' + cls + '">' + label + "</span>" : (editable ? '<span class="rota-plus">+</span>' : '<span class="rota-off">·</span>');
        var attrs = editable ? ' data-act="sch-cell" data-month="' + esc(cell.month) + '" data-date="' + esc(ds) + '" data-member="' + esc(mm) + '" data-mindex="' + mi + '" data-value="' + esc(val) + '"' : "";
        var tag = editable ? "button" : "div";
        return "<" + tag + ' class="rota-cell' + (isToday ? " today" : "") + (we ? " we" : "") + (editable ? " editable" : "") + '"' + attrs + ">" + inner + "</" + tag + ">";
      }).join("");
      return '<div class="rota-name"><span class="rota-av">' + esc(schInitials(mm)) + '</span><span class="rota-nm truncate" title="' + esc(mm) + '">' + esc(mm) + "</span></div>" + cells;
    }).join("");
    return '<div class="rota-grid">' + header + rows + "</div>";
  }
  function viewSchedule() {
    var admin = isAdmin();
    var ms = visibleScheduleMonths();
    var newBtn = admin ? '<button class="btn sm primary" data-act="sch-new-month">' + ic("plus", "ico-sm") + "New month</button>" : "";
    var syncBtn = admin ? '<button class="btn sm ghost" data-act="sch-sync" title="Pull the schedule sheet now">' + ic("refresh", "ico-sm") + "Sync</button>" : "";
    // Leave controls are available to every user (request their own days off; see their own request status).
    var leaveBtns = '<button class="btn sm leave-cta" data-act="leave-req" data-type="vacation">' + ic("calendar", "ico-sm") + "Request Vacation</button>" +
      '<button class="btn sm leave-cta sick" data-act="leave-req" data-type="sick">' + ic("plus", "ico-sm") + "Request Sick Leave</button>" +
      '<button class="btn sm ghost" data-act="my-leave" title="Your leave requests">' + ic("clock", "ico-sm") + "My requests</button>";
    var myPending = (D.leaveRequests || []).filter(function (r) { return r.status === "pending"; }).length;
    var banner = myPending ? '<div class="leave-banner">' + ic("clock", "ico-sm") + "<span>" + myPending + " leave request" + (myPending > 1 ? "s" : "") + " pending approval.</span>" +
      '<button class="btn xs ghost" data-act="my-leave">View</button></div>' : "";
    if (!ms.length) {
      var bar0 = '<div class="ds-tabbar sch-bar"><div class="sch-picker"></div><div class="ki-tools">' + leaveBtns + syncBtn + newBtn + "</div></div>";
      return '<div class="sch-view">' + bar0 + '<div class="sch-content">' + banner +
        emptyState("calendar", "No schedule yet", admin ? "Connect the schedule sheet in Admin → Schedule, then Sync, or press New month." : "Ask an admin to connect the schedule sheet.") + "</div></div>";
    }
    var m = currentScheduleMonth();
    var view = state.scheduleView === "month" ? "month" : "week";   // week rota is the default
    var legend = '<div class="sch-legend">' +
      '<span class="sl"><i class="sw day"></i>Day</span><span class="sl"><i class="sw night"></i>Night</span>' +
      '<span class="sl"><i class="sw vac"></i>Vacation</span><span class="sl"><i class="sw sick"></i>Sick</span>' +
      '<span class="sl"><i class="sw off"></i>Offline</span></div>';
    var toggle = '<div class="sch-seg" role="tablist">' +
      '<button class="sch-seg-b' + (view === "week" ? " on" : "") + '" data-act="sch-view" data-val="week">' + ic("calendar", "ico-sm") + "Week</button>" +
      '<button class="sch-seg-b' + (view === "month" ? " on" : "") + '" data-act="sch-view" data-val="month">' + ic("notes", "ico-sm") + "Month</button></div>";
    var nav;
    if (view === "week") {
      var ws = currentWeekStart(), rng = _schRange();
      var atStart = rng.min && ws <= _schMondayOf(rng.min), atEnd = rng.max && ws >= _schMondayOf(rng.max);
      nav = '<div class="rota-nav">' +
        '<button class="btn sm ghost iconly" data-act="sch-week" data-dir="-1" title="Previous week"' + (atStart ? " disabled" : "") + ">" + ic("back", "ico-sm") + "</button>" +
        '<span class="rota-range">' + esc(_schWeekRangeLabel(ws)) + "</span>" +
        '<button class="btn sm ghost iconly" data-act="sch-week" data-dir="1" title="Next week"' + (atEnd ? " disabled" : "") + ">" + ic("chevron", "ico-sm") + "</button>" +
        '<button class="btn sm ghost" data-act="sch-week" data-dir="0" title="Jump to this week">Today</button></div>';
    } else {
      nav = '<select class="mini-select sch-select" data-act="sch-month-sel">' +
        ms.map(function (mo) { return '<option value="' + esc(mo.month) + '"' + (mo.month === m.month ? " selected" : "") + ">" + esc(mo.month) + "</option>"; }).join("") + "</select>";
    }
    var bar = '<div class="ds-tabbar sch-bar"><div class="sch-picker">' + toggle + nav + legend + '</div><div class="ki-tools">' + leaveBtns + syncBtn + newBtn + "</div></div>";
    var today = _schTodayStr();
    var content = view === "month" ? scheduleGridHtml(m, admin, today) : scheduleWeekHtml(admin, today);
    var synced = state.scheduleSyncedAt ? '<div class="ki-synced-foot"><span class="ki-synced-inline">' + ic("clock", "ico-sm") + "synced " + esc(timeText(state.scheduleSyncedAt)) + "</span></div>" : "";
    return '<div class="sch-view">' + bar + '<div class="sch-content">' + banner + '<div class="sch-scroll' + (view === "week" ? " rota-wrap" : "") + '">' + content + synced + "</div></div></div>";
  }
  /* Matrix layout: dates down the left, one column per member. Best for scanning a person's whole month. */
  function scheduleGridHtml(m, admin, today) {
    var head = '<tr><th class="sc-dh">Date</th>' +
      m.members.map(function (mm) { return schHidden(mm) ? "" : '<th class="sc-mh" title="' + esc(mm) + '"><span class="sc-av">' + esc(schInitials(mm)) + '</span><span class="sc-mn">' + esc(mm) + "</span></th>"; }).join("") + "</tr>";
    var body = m.days.map(function (day) {
      var weekend = schIsWeekend(day);
      var isToday = day.date === today;
      var dnum = (/^(\d{1,2})\./.exec(day.date) || [0, ""])[1];
      var cells = m.members.map(function (mm, mi) {
        if (schHidden(mm)) return "";
        var val = (day.shifts && day.shifts[mm]) || "";
        var inner = val ? '<span class="sc-pill ' + schCellClass(val) + '">' + esc(val) + "</span>" : (admin ? '<span class="sc-add">+</span>' : "");
        var attrs = admin ? ' data-act="sch-cell" data-month="' + esc(m.month) + '" data-date="' + esc(day.date) + '" data-member="' + esc(mm) + '" data-mindex="' + mi + '" data-value="' + esc(val) + '"' : "";
        return '<td class="sc-c' + (val ? "" : " empty") + (admin ? " editable" : "") + '"' + attrs + ">" + inner + "</td>";
      }).join("");
      return '<tr class="' + (weekend ? "weekend " : "") + (isToday ? "today" : "") + '">' +
        '<td class="sc-dc"><span class="sc-dnum">' + esc(dnum) + '</span><span class="sc-dwk">' + esc(schWeekday(day).slice(0, 3)) + (isToday ? '<span class="sc-tdot" title="Today"></span>' : "") + "</span></td>" +
        cells + "</tr>";
    }).join("");
    return '<table class="sch-table"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
  }
  /* Day editor: list every member with their shift for one date; click a row to edit it
     through the same single-cell editor the grid uses. */
  function openScheduleDay(month, date) {
    var mo = scheduleMonths().filter(function (x) { return x.month === month; })[0]; if (!mo) return;
    var day = (mo.days || []).filter(function (d) { return d.date === date; })[0]; if (!day) return;
    var members = mo.members || [], admin = isAdmin(), wd = schWeekday(day);
    showModal({
      title: date + (wd ? " | " + wd : ""), close: "Close",
      custom: function () {
        return '<div class="sch-day-edit">' + members.map(function (mm, mi) {
          if (schHidden(mm)) return "";
          var val = (day.shifts && day.shifts[mm]) || "";
          var pill = val ? '<span class="sc-pill ' + schCellClass(val) + '">' + esc(val) + "</span>" : '<span class="sch-day-empty">Not scheduled</span>';
          var attrs = admin ? ' data-act="sch-cell" data-month="' + esc(month) + '" data-date="' + esc(date) + '" data-member="' + esc(mm) + '" data-mindex="' + mi + '" data-value="' + esc(val) + '"' : "";
          var tag = admin ? "button" : "div";
          return "<" + tag + ' class="sch-day-row' + (admin ? " editable" : "") + '"' + attrs + '><span class="sc-av sch-day-av">' + esc(schInitials(mm)) + '</span><span class="sch-day-name">' + esc(mm) + "</span>" + pill + "</" + tag + ">";
        }).join("") + "</div>";
      }
    });
  }
  /* Admin cell editor: type a time or pick a quick value (writes back to the sheet). Writes target the
     member by COLUMN INDEX (from the same parse the grid displays) so an edit always hits the cell you
     see - not a same-named column elsewhere. */
  function openScheduleCell(month, date, member, index, value) {
    state._schCell = { month: month, date: date, member: member, index: index };
    var quick = ["10:00-19:00", "15:00-00:00", "21:00-06:00", "06:00-11:00", "15:00-20:00", "10:00-15:00"];
    showModal({
      title: member + " | " + date, close: "Cancel",
      custom: function () {
        return '<div class="sch-edit"><input class="f-input" id="sch-input" placeholder="e.g. 10:00-19:00" value="' + esc(value || "") + '">' +
          '<div class="sch-quick">' + quick.map(function (t) { return '<button class="btn sm ghost" data-act="sch-set" data-val="' + esc(t) + '">' + esc(t) + "</button>"; }).join("") + "</div>" +
          '<div class="sch-quick"><button class="btn sm sch-vac" data-act="sch-set" data-val="VACATION">VACATION</button>' +
          '<button class="btn sm sch-sick" data-act="sch-set" data-val="SICK LEAVE">SICK LEAVE</button>' +
          '<button class="btn sm sch-off" data-act="sch-set" data-val="OFFLINE">OFFLINE</button>' +
          '<button class="btn sm ghost" data-act="sch-set" data-val="">Clear</button>' +
          '<div class="spacer"></div><button class="btn primary" data-act="sch-set-input">' + ic("check", "ico-sm") + "Save</button></div></div>";
      }
    });
  }
  function scheduleSetCell(cell, value) {
    var month = cell.month, date = cell.date, member = cell.member, index = cell.index;
    var mo = scheduleMonths().filter(function (x) { return x.month === month; })[0];
    if (mo) { var day = (mo.days || []).filter(function (d) { return d.date === date; })[0]; if (day) { day.shifts = day.shifts || {}; day.shifts[member] = value; } }
    closeModal(); render();
    enqueueAction("schedule_set", { month: month, date: date, member: member, member_index: index, value: value }, function (r) {
      if (r && r.status === "done") { toast("Saved"); refreshSchedule(); }
      else toast("Save failed" + (r && r.error ? ": " + r.error : ""));
    });
  }
  function openCreateMonth() {
    var now = new Date(), nm = now.getMonth() + 2, ny = now.getFullYear();
    if (nm > 12) { nm -= 12; ny += 1; }
    var members = (currentScheduleMonth() || {}).members || [];
    showModal({
      title: "New month", submit: "Create", close: "Cancel",
      initial: { month: MONTH_NAMES[nm - 1], year: String(ny) },
      fields: [
        { id: "month", label: "Month", type: "select", required: true, options: MONTH_NAMES },
        { id: "year", label: "Year", type: "number", required: true }
      ],
      onSubmit: function (v) {
        var mi = MONTH_NAMES.indexOf(v.month) + 1;
        if (mi < 1) { toast("Pick a month"); return; }
        toast("Creating " + v.month + " " + v.year + "…");
        enqueueAction("schedule_create_month", { month: mi, year: parseInt(v.year, 10), members: members }, function (r) {
          if (r && r.status === "done") { state.scheduleMonth = (r.result && r.result.name) || (v.month + " " + v.year); toast("Created"); refreshSchedule(); }
          else toast("Create failed" + (r && r.error ? ": " + r.error : ""));
        });
      }
    });
  }
  function refreshSchedule() {
    window.CONSOLE.get("/schedule").then(function (d) {
      if (d && Array.isArray(d.months)) { D.schedule = { months: d.months }; if (d.synced_at) state.scheduleSyncedAt = d.synced_at; render(); }
    }, function () {});
  }

  /* ---------- Leave (Vacation / Sick Leave): request -> admin approval -> auto-fill calendar ---------- */
  var VAC_MAX_DAYS = 5, VAC_LEAD_DAYS = 7;
  function _dateInputVal(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function _ymdToDmy(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? (m[3] + "." + m[2] + "." + m[1]) : ""; }
  function _todayMidnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function leaveBalance(type) {
    var u = state.user || {}, lv = u.leave || {}, cfg = D.leaveConfig || {};
    var isVac = type === "vacation";
    var total = (isVac ? (+lv.vac_total || 0) : (+lv.sick_total || 0)) || (isVac ? (+cfg.vac_total || 0) : (+cfg.sick_total || 0));
    var used = isVac ? (+lv.vac_used || 0) : (+lv.sick_used || 0);
    return { total: total, used: used, remaining: total - used, renew: lv.renew || "", renew_note: lv.renew_note || "" };
  }
  /* Working days in [start,end] per THIS user's schedule (keys mon..sun; JS getDay 0=Sun). */
  function _workingDaysInRange(startDmy, endDmy) {
    var sched = (state.user && state.user.schedule) || null;
    var order = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    var a = _schParseDate(startDmy), b = _schParseDate(endDmy);
    if (!a || !b || b < a) return 0;
    var n = 0, d = new Date(a);
    while (d <= b) {
      var slot = sched ? sched[order[d.getDay()]] : null;
      var on = slot ? !!slot.on : (!sched && d.getDay() >= 1 && d.getDay() <= 5);
      if (on) n++;
      d.setDate(d.getDate() + 1);
    }
    return n;
  }
  function updateLeavePreview(type) {
    var el = document.getElementById("lv-preview"); if (!el) return;
    var s = _ymdToDmy((document.getElementById("lv-start") || {}).value);
    var e = _ymdToDmy((document.getElementById("lv-end") || {}).value);
    if (!s || !e) { el.textContent = ""; el.className = "leave-preview"; return; }
    var n = _workingDaysInRange(s, e);
    var over = type === "vacation" && n > VAC_MAX_DAYS;
    el.className = "leave-preview" + (over || n < 1 ? " err" : "");
    el.textContent = n + " working day" + (n === 1 ? "" : "s") +
      (over ? " — over the " + VAC_MAX_DAYS + "-day limit" : (n < 1 ? " — none in this range" : ""));
  }
  function openLeaveRequest(type) {
    var isVac = type === "vacation", bal = leaveBalance(type);
    var minStart = new Date(); minStart.setHours(0, 0, 0, 0);
    if (isVac) minStart.setDate(minStart.getDate() + VAC_LEAD_DAYS);
    state._leaveType = type;
    showModal({ title: isVac ? "Request Vacation" : "Request Sick Leave", close: "Cancel",
      custom: function () {
        return '<div class="leave-form">' +
          '<div class="leave-bal"><b>' + Math.max(0, bal.remaining) + "</b> of " + bal.total + " " + (isVac ? "vacation" : "sick") + " day(s) left" + (bal.renew ? ' <span class="faint">| renews ' + esc(bal.renew) + "</span>" : "") + "</div>" +
          (bal.renew_note ? '<div class="f-hint">' + esc(bal.renew_note) + "</div>" : "") +
          '<div class="leave-grid">' +
            '<label>From<input type="date" lang="en-GB" id="lv-start" data-act="leave-calc" value="' + _dateInputVal(minStart) + '"' + (isVac ? ' min="' + _dateInputVal(minStart) + '"' : "") + "></label>" +
            '<label>To<input type="date" lang="en-GB" id="lv-end" data-act="leave-calc" value="' + _dateInputVal(minStart) + '"' + (isVac ? ' min="' + _dateInputVal(minStart) + '"' : "") + "></label>" +
          "</div>" +
          '<label class="leave-reason">Note (optional)<input type="text" id="lv-reason" placeholder="' + (isVac ? "reason" : "symptoms / details") + '"></label>' +
          '<div id="lv-preview" class="leave-preview"></div>' +
          '<div class="f-hint">' + (isVac ? "Vacation: up to " + VAC_MAX_DAYS + " working days at a time, requested at least " + VAC_LEAD_DAYS + " days before it starts." : "Sick leave can cover past or current days.") + "</div>" +
          '<div class="row-gap" style="margin-top:12px;justify-content:flex-end"><button class="btn primary" data-act="leave-submit" data-type="' + type + '">' + ic("check", "ico-sm") + "Submit request</button></div>" +
          "</div>";
      } });
    setTimeout(function () { updateLeavePreview(type); }, 0);
  }
  function submitLeave(type) {
    var s = _ymdToDmy((document.getElementById("lv-start") || {}).value);
    var e = _ymdToDmy((document.getElementById("lv-end") || {}).value);
    var reason = ((document.getElementById("lv-reason") || {}).value || "").trim();
    if (!s || !e) { toast("Pick both dates"); return; }
    var n = _workingDaysInRange(s, e);
    if (n < 1) { toast("No working days in that range"); return; }
    if (type === "vacation") {
      if (n > VAC_MAX_DAYS) { toast("Vacation is at most " + VAC_MAX_DAYS + " working days"); return; }
      var lead = Math.round((_schParseDate(s) - _todayMidnight()) / 86400000);
      if (lead < VAC_LEAD_DAYS) { toast("Vacation must be requested at least " + VAC_LEAD_DAYS + " days ahead"); return; }
      var bal = leaveBalance("vacation");
      if (n > bal.remaining) { toast("Only " + Math.max(0, bal.remaining) + " vacation day(s) left"); return; }
    }
    busyInc();
    window.CONSOLE.postMsg("/leave-requests", { type: type, start: s, end: e, reason: reason }).then(function (res) {
      busyDec();
      var d = res && res.data;
      if (res && res.status >= 200 && res.status < 300 && d && d.id) {
        D.leaveRequests = D.leaveRequests || []; D.leaveRequests.unshift(d); closeModal(); render(); toast("Request submitted for approval");
      } else {
        toast((d && d.error) ? d.error : "Request failed (check the dates and your balance)");   // show the server's exact reason
      }
    }, function () { busyDec(); toast("Request failed - server unreachable"); });
  }
  /* Prepared email text for a leave request (manual mode): the admin copies this and sends
     the email themselves. Plain text (no emoji / em-dash) so it pastes cleanly. */
  function leaveEmailTemplate(r) {
    // "Mysliai I." (surname + first initial), the format the team sends. Display names are short
    // ("Ivan M."), so the surname comes from the work email: i.mysliai@... -> "Mysliai I.".
    var full = String(r.user_name || "").trim(), parts = full.split(/\s+/);
    var local = String(r.user_email || "").split("@")[0], em = /^([a-z])[a-z]*\.([a-z][a-z'-]+)$/i.exec(local);
    var cap = function (x) { return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); };
    var name;
    if (em) name = cap(em[2]) + " " + (parts[0] ? parts[0].charAt(0) : em[1]).toUpperCase() + ".";
    else if (parts.length >= 2 && !/\.$/.test(parts[parts.length - 1])) name = parts[parts.length - 1] + " " + parts[0].charAt(0).toUpperCase() + ".";
    else name = full || r.user_email || "A team member";
    var kind = r.type === "vacation" ? "vacation leave" : "sick leave";
    var when = (!r.end || r.end === r.start) ? (r.start || "?") : (r.start || "?") + " - " + r.end;
    var body = "Subject: Leave request - " + name + "\n\n" +
      name + " requested " + kind + " for " + when + ".";
    if (r.reason) body += "\nReason: " + r.reason;
    return body;
  }
  function leaveRowHtml(r, forAdmin) {
    var typeLabel = r.type === "vacation" ? "Vacation" : "Sick leave";
    var who = forAdmin ? "<b>" + esc(r.user_name || r.user_email) + "</b> | " : "";
    var actions = "";
    if (forAdmin) {
      var decide = r.status === "pending"
        ? '<button class="btn sm primary" data-act="leave-decide" data-id="' + esc(r.id) + '" data-decision="approve">' + ic("check", "ico-sm") + "Approve</button>" +
          '<button class="btn sm ghost" data-act="leave-decide" data-id="' + esc(r.id) + '" data-decision="reject">Reject</button>'
        : "";
      actions = '<div class="lv-actions">' + decide +
        '<button class="btn sm ghost" data-act="copy-leave" data-id="' + esc(r.id) + '" title="Copy a ready email to send manually">' + ic("copy", "ico-sm") + "Copy email</button></div>";
    }
    return '<div class="lv-item"><div class="lv-top">' + who + '<span class="lv-badge ' + esc(r.status) + '">' + esc(r.status) + "</span> " +
      "<b>" + typeLabel + "</b> | " + esc(r.start) + " – " + esc(r.end) + ' <span class="faint">(' + r.work_days + "d)</span></div>" +
      (r.reason ? '<div class="lv-note"><span class="lv-note-l">Reason</span>' + esc(r.reason) + "</div>" : "") +
      (r.decided_by ? '<div class="lv-note faint">' + esc(r.status) + " by " + esc(r.decided_by) + (r.decide_note ? ": " + esc(r.decide_note) : "") + "</div>" : "") +
      actions + "</div>";
  }
  function openMyLeave() {
    var reqs = D.leaveRequests || [];
    showModal({ title: "My leave requests", close: "Close",
      custom: function () {
        return reqs.length ? '<div class="leave-list">' + reqs.map(function (r) { return leaveRowHtml(r, false); }).join("") + "</div>"
          : '<div class="f-hint">No leave requests yet. Use Request Vacation or Request Sick Leave.</div>';
      } });
  }
  function refreshLeave() {
    window.CONSOLE.get("/leave-requests").then(function (list) { if (Array.isArray(list)) { D.leaveRequests = list; render(); } }, function () {});
    if (isAdmin()) window.CONSOLE.get("/leave-requests?all=1").then(function (list) { if (Array.isArray(list)) { D.leaveAll = list; render(); } }, function () {});
  }
  function decideLeave(id, decision) {
    var note = "";
    if (decision === "reject") { note = window.prompt("Reason (optional):") || ""; }
    busyInc();
    window.CONSOLE.post("/leave-requests/" + encodeURIComponent(id) + "/decide", { decision: decision, note: note }).then(function (r) {
      busyDec();
      if (r && r.id) {
        toast(decision === "approve" ? "Approved. Calendar and balance updated" : "Rejected", "ok");
        refreshLeave();
      } else toast("Failed");
    }, function () { busyDec(); toast("Failed"); });
  }

  /* ---------- Game Cards: weekly game-card sheet. View for all; admins generate (from Steam links),
     edit fields, copy rows, and download the per-card screenshots ZIP. Mirrored from a Google Sheet. ---------- */
  var GC_FIELDS = [
    ["title", "Title"], ["description", "Description"], ["platform", "Platform"],
    ["description_url", "Description URL (If Install)"], ["pegi", "PEGI Age Rating"],
    ["release_date", "Release Date"], ["publisher", "Publisher"], ["developer", "Developer"],
    ["app_link", "App Link"], ["youtube", "Video Link on YouTube"], ["related_apps", "Related Apps"]
  ];
  var GC_LINK_FIELDS = { description_url: 1, app_link: 1, youtube: 1 };
  function gameCardWeeks() { return (D.gameCards && D.gameCards.weeks) || []; }
  function currentGcWeek() { var ws = gameCardWeeks(); if (!ws.length) return null; return ws.filter(function (x) { return x.week === state.gcWeek; })[0] || ws[0]; }
  function gcHasImages(week, title) { return ((D.gameCards && D.gameCards.image_keys) || []).indexOf(week + "||" + String(title || "").trim().toLowerCase()) >= 0; }
  function gcVal(card, key) { return card[key] != null ? String(card[key]) : ""; }
  function gcRowByIndex(w, row) { return (w.rows || []).filter(function (x) { return String(x._row) === String(row); })[0]; }
  /* A card needs attention if Related Apps is empty, or the Trailer is empty / still the bot's YouTube
     *search* fallback (youtube.com/results?search_query=… ) rather than a real trailer link. */
  function gcIsYtSearch(u) { return /youtube\.com\/results|search_query/i.test(String(u || "")); }
  function gcTrailerFilled(c) { var y = gcVal(c, "youtube").trim(); return !!y && !gcIsYtSearch(y); }
  function gcRelatedFilled(c) { return !!gcVal(c, "related_apps").trim(); }
  var GC_CHEV = '<svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M6 9l6 6 6-6"/></svg>';
  function gcDate(v) {
    v = String(v || "").trim(); if (!v) return "";
    var m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
    if (m) return ("0" + m[1]).slice(-2) + "." + ("0" + m[2]).slice(-2) + "." + m[3];
    var d = new Date(v);
    if (!isNaN(d.getTime())) return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear();
    return v;   // unparseable ("Coming soon" etc.) -> as-is
  }
  /* One inline-editable field (input/textarea). Saves on blur via the delegated change handler. */
  function gcEditField(week, c, key, label, warn) {
    var val = gcVal(c, key);
    if (key === "release_date") val = gcDate(val);   // show + edit dates as dd.mm.yyyy, never the raw Date string
    var isLong = (key === "description" || key === "related_apps");
    var attrs = 'data-gc-field="' + key + '" data-gc-row="' + c._row + '" data-gc-week="' + esc(week) + '" placeholder="—"';
    var input = isLong ? '<textarea class="gc-inp" ' + attrs + ' rows="2">' + esc(val) + "</textarea>"
                       : '<input class="gc-inp" ' + attrs + ' value="' + esc(val) + '">';
    // Per-field actions: a Copy button on every field, plus an Open link for URL values
    // (makes the YouTube search-fallback / trailer link clickable).
    var v = String(val).trim();
    var openLink = /^https?:\/\//i.test(v) ? '<a class="gc-fa" href="' + esc(v) + '" target="_blank" rel="noopener" title="Open link">' + ic("external", "ico-sm") + "</a>" : "";
    var copyBtn = v ? '<button type="button" class="gc-fa" data-act="gc-copy" data-text="' + esc(v) + '" title="Copy ' + esc(label) + '">' + ic("copy", "ico-sm") + "</button>" : "";
    var acts = (openLink || copyBtn) ? '<span class="gc-fa-row">' + openLink + copyBtn + "</span>" : "";
    var ids = key === "related_apps" ? '<div class="gc-ids" data-gc-ids="' + esc(v) + '">' + gcIdsText(v) + "</div>" : "";
    return '<div class="gc-fld' + (warn ? " warn" : "") + '"><span class="gc-fl">' + esc(label) + "</span>" + input + acts + ids + "</div>";
  }
  /* Related Apps -> Game-List IDs, shown as a caption under the field. Names are split on ", " (a comma
     inside a title, "Warhammer 40,000", has no space after it). IDs are fetched once per name and cached. */
  function gcRelNames(v) { return String(v || "").split(/,\s+/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function gcIdsText(v) {
    var names = gcRelNames(v); if (!names.length) return "";
    var cache = state.gcIds || (state.gcIds = {}), missing = names.filter(function (n) { return !(n in cache); });
    if (missing.length) gcIdsFetch(missing);
    return "IDs: " + names.map(function (n) {
      if (!(n in cache)) return '<span class="gc-id-wait">…</span>';
      return cache[n] ? esc(cache[n]) : '<span class="gc-id-miss" title="' + esc(n) + ': not in the Game List">?</span>';
    }).join(", ");
  }
  /* Every card of a render asks at once: names are queued and sent together (40 per request), and a
     failed request pauses new ones for 30s so a render loop never hammers the server. */
  function gcIdsFetch(names) {
    if (Date.now() < (state._gcIdsPauseUntil || 0)) return;
    var pend = state._gcIdsPend || (state._gcIdsPend = {}), q = state._gcIdsQueue || (state._gcIdsQueue = []);
    names.forEach(function (n) { if (!pend[n]) { pend[n] = true; q.push(n); } });
    if (!q.length || state._gcIdsTimer) return;
    state._gcIdsTimer = setTimeout(function () {
      state._gcIdsTimer = null;
      var all = state._gcIdsQueue.splice(0);
      for (var i = 0; i < all.length; i += 40) (function (chunk) {
        window.CONSOLE.post("/game-cards-related-ids", { names: chunk }).then(function (d) {
          var ids = (d && d.ids) || {};
          chunk.forEach(function (n) { state.gcIds[n] = ids[n] || ""; delete pend[n]; });
          gcPaintIds();
        }, function () {
          chunk.forEach(function (n) { delete pend[n]; });
          state._gcIdsPauseUntil = Date.now() + 30000;
        });
      })(all.slice(i, i + 40));
    }, 0);
  }
  function gcPaintIds() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-gc-ids]"), function (el) {
      el.innerHTML = gcIdsText(el.getAttribute("data-gc-ids"));
    });
  }
  function gcImagesBtn(week, c) {
    return gcHasImages(week, c.title)
      ? '<a class="btn sm ghost" href="' + esc((window.CONSOLE ? window.CONSOLE.base : "/api/console") + "/game-cards-image?week=" + encodeURIComponent(week) + "&title=" + encodeURIComponent(c.title || "")) + '" download>' + ic("posts", "ico-sm") + "Download images</a>"
      : "";
  }
  function viewGameCards() {
    // Game Cards is a shared, collaborative sheet: everyone (not just admins) can generate + edit.
    var ws = gameCardWeeks();
    var connected = !!(D.gameCardsConfig && D.gameCardsConfig.webapp_url);
    var newBtn = '<button class="btn sm primary" data-act="gc-new-week">' + ic("plus", "ico-sm") + "New week</button>";
    var syncBtn = '<button class="btn sm ghost" data-act="gc-sync" title="Pull the sheet now">' + ic("refresh", "ico-sm") + "Sync</button>";
    if (!ws.length) {
      var bar0 = '<div class="ds-tabbar gc-bar"><div class="sch-picker"></div><div class="ki-tools">' + syncBtn + newBtn + "</div></div>";
      if (state.gcLoading) return '<div class="gc-view">' + bar0 + '<div class="gc-content"><div class="gc-scroll">' + skeletonRows(4) + "</div></div></div>";
      return '<div class="gc-view">' + bar0 + '<div class="gc-content"><div class="gc-scroll"><div class="gc-md"><div class="gc-list"></div><div class="gc-detail">' +
        '<div class="gc-card gc-empty-card">' + emptyState("cards", "No weeks yet", connected ? "Press New week to start this week's cards." : (isAdmin() ? "Connect the sheet in Admin → Game Cards first." : "Ask an admin to connect the game-cards sheet.")) + "</div></div></div></div></div></div>";
    }
    var w = currentGcWeek();
    var picker = '<select class="mini-select sch-select" data-act="gc-week-sel">' +
      ws.map(function (x) { return '<option value="' + esc(x.week) + '"' + (x.week === w.week ? " selected" : "") + ">" + esc(x.week) + "</option>"; }).join("") + "</select>";
    var bar = '<div class="ds-tabbar gc-bar"><div class="sch-picker">' + ic("cards", "ico-sm") + picker + '<span class="gc-count muted">' + (w.rows || []).length + ' cards</span></div><div class="ki-tools">' + syncBtn + newBtn + "</div></div>";
    var ql = state.q.toLowerCase();
    var rows = (w.rows || []).filter(function (c) { return !ql || ((c.title || "") + " " + (c.publisher || "") + " " + (c.platform || "")).toLowerCase().indexOf(ql) >= 0; });
    function cardHtml(c, forceOpen) {
      var relOk = gcRelatedFilled(c), trOk = gcTrailerFilled(c), attn = !(relOk && trOk);
      var open = forceOpen || !!(state.gcOpen && state.gcOpen[w.week + "||" + c._row]);
      var chips = [gcVal(c, "platform"), gcVal(c, "pegi") ? "PEGI " + gcVal(c, "pegi") : "", gcVal(c, "publisher"), gcDate(gcVal(c, "release_date"))]
        .filter(Boolean).map(function (x) { return '<span class="gc-chip">' + esc(x) + "</span>"; }).join("");
      var quick = gcEditField(w.week, c, "youtube", "Trailer", !trOk) + gcEditField(w.week, c, "related_apps", "Related Apps", !relOk);
      // Section comes from how the card was generated: Install -> Description URL is required and
      // shown first (alert when empty); Library -> the field is not used, so it is hidden.
      var section = gcSection(w.week, c), skip = ["youtube", "related_apps"];
      if (section) skip.push("description_url");
      var durl = "";
      if (section === "Install") {
        var durlEmpty = !gcVal(c, "description_url").trim();
        durl = (durlEmpty ? '<div class="gc-alert">' + ic("bell", "ico-sm") + "Install game: Description URL is empty. Add the game's website.</div>" : "") +
          '<div class="gc-durl">' + gcEditField(w.week, c, "description_url", "Description URL (Install)", durlEmpty) + "</div>";
      }
      var full = open ? '<div class="gc-full-grid">' +
        GC_FIELDS.filter(function (f) { return skip.indexOf(f[0]) < 0; }).map(function (f) { return gcEditField(w.week, c, f[0], f[1], false); }).join("") +
        "</div>" + gcImagesBtn(w.week, c) : "";
      var desc = gcVal(c, "description");
      return '<div class="gc-card' + (attn ? " attn" : "") + (open ? " open" : "") + '">' +
        '<div class="gc-head"><div class="gc-title-wrap">' +
          (attn ? '<span class="gc-warn" title="Missing details">!</span>' : "") +
          '<span class="gc-title truncate">' + esc(c.title || "(untitled)") + "</span></div>" +
          '<div class="gc-acts"><button class="btn sm ghost" data-act="gc-copyrow" data-row="' + c._row + '" title="Copy the whole row (tab-separated)">' + ic("copy", "ico-sm") + "Copy</button>" +
          '<button class="btn sm ghost gc-del" data-act="gc-delete" data-row="' + c._row + '" data-title="' + esc(c.title || "") + '" title="Delete this card / duplicate">' + ic("x", "ico-sm") + "Delete</button>" +
          '<button class="btn sm ghost iconly gc-exp" data-act="gc-toggle" data-row="' + c._row + '" title="' + (open ? "Hide details" : "Full details") + '">' + GC_CHEV + "</button></div></div>" +
        (section ? '<div class="gc-sec"><span class="gc-chip">' + esc(section) + "</span></div>" : "") + durl +
        (desc && !open ? '<div class="gc-desc truncate">' + esc(desc) + "</div>" : "") +
        (chips ? '<div class="gc-chips">' + chips + "</div>" : "") +
        '<div class="gc-quick">' + quick + "</div>" +
        (open ? '<div class="gc-full">' + full + "</div>" : "") + "</div>";
    }
    // list of this week's cards on the left, the selected card fully open on the right.
    var sel = rows.filter(function (c) { return String(c._row) === String(state.gcSel); })[0] || rows[0];
    var nNew = ((D.gameCards && D.gameCards.suggestions) || []).length;
    var addLi = '<button class="gc-add" data-act="gc-add-game" title="Add a game from new cards or a Steam link">' +
      '<span class="gc-add-plus">' + ic("plus") + '</span><span class="gc-add-l">Add game</span></button>';
    var cards = '<div class="gc-md"><div class="gc-list">' + rows.map(function (c) {
        var attn = !(gcRelatedFilled(c) && gcTrailerFilled(c));
        var meta = [gcVal(c, "platform"), gcVal(c, "publisher"), gcDate(gcVal(c, "release_date"))].filter(Boolean).join(" | ");
        return '<button class="gc-li' + (c === sel ? " active" : "") + '" data-act="gc-pick" data-row="' + c._row + '">' +
          '<span class="gc-li-t">' + (attn ? '<span class="gc-warn" title="Missing details">!</span>' : "") + '<span class="truncate">' + esc(c.title || "(untitled)") + "</span></span>" +
          (meta ? '<span class="gc-li-m truncate">' + esc(meta) + "</span>" : "") + "</button>";
      }).join("") + addLi + '</div><div class="gc-detail">' +
      (sel ? cardHtml(sel, true) : '<div class="gc-card gc-empty-card">' + emptyState("cards", "No cards in this week yet", "Use Add game on the left.") + "</div>") + "</div></div>";
    var body = cards;
    var synced = state.gcSyncedAt ? '<div class="ki-synced-foot"><span class="ki-synced-inline">' + ic("clock", "ico-sm") + "synced " + esc(timeText(state.gcSyncedAt)) + "</span></div>" : "";
    return '<div class="gc-view">' + bar + '<div class="gc-content"><div class="gc-scroll">' + body + synced + "</div></div></div>";
  }
  function gcSection(week, c) {
    var m = (D.gameCards && D.gameCards.meta) || {};
    var x = m[week + "||" + String(c.title || "").trim().toLowerCase()];
    return (x && x.section) || "";
  }
  /* ---- "New this week": game cards that went live this week (Mattermost) without a card yet ----
     Each game is looked up on Steam by its title without the "(Xbox)" suffix. One exact hit is taken
     automatically; otherwise the operator picks from the candidates (or pastes a link). */
  var GC_SECTIONS = ["Library", "Install"];
  function gcSug(src) {
    state.gcSug = state.gcSug || {};
    if (!state.gcSug[src]) {
      var g = ((D.gameCards && D.gameCards.suggestions) || []).filter(function (x) { return x.source === src; })[0] || {};
      state.gcSug[src] = { on: true, platform: g.platform || "Steam", section: "Library", status: "", matches: [], pick: "", manual: "" };
    }
    return state.gcSug[src];
  }
  function gcSugSearch(g) {
    var st = gcSug(g.source);
    if (st.status) return;
    st.status = "loading";
    window.CONSOLE.get("/game-cards-steam-search?q=" + encodeURIComponent(g.search || g.game)).then(function (list) {
      st.matches = (Array.isArray(list) ? list : []).slice().sort(function (x, y) { return (y.exact ? 1 : 0) - (x.exact ? 1 : 0); }).slice(0, 5);
      var exact = st.matches.filter(function (m) { return m.exact; });
      if (exact.length === 1) { st.pick = exact[0].app_id; st.status = "auto"; }
      else st.status = st.matches.length ? "pick" : "none";
      gcRerender();
    }, function () { st.status = "none"; gcRerender(); });
  }
  function gcSugUrl(st) {
    if (st.pick === "manual") return (st.manual || "").trim();
    var m = st.matches.filter(function (x) { return x.app_id === st.pick; })[0];
    return m ? m.url : "";
  }
  function gcSuggestRows() {
    var list = (D.gameCards && D.gameCards.suggestions) || [];
    if (!list.length) return { html: "", ready: 0 };
    var ready = 0;
    var rows = list.map(function (g) {
      var st = gcSug(g.source);
      if (!st.status) gcSugSearch(g);
      var url = gcSugUrl(st);
      if (st.on && url) ready++;
      var steam;
      if (st.status === "loading" || !st.status) steam = '<span class="muted">Searching Steam...</span>';
      else if (st.status === "auto" && st.pick !== "manual") {
        var m = st.matches.filter(function (x) { return x.app_id === st.pick; })[0];
        steam = '<div class="gcs-opt on">' + '<span class="gcs-opt-pick">' + ic("check", "ico-sm") +
          (m.img ? '<img class="gcs-thumb" src="' + esc(m.img) + '" alt="" loading="lazy">' : "") +
          '<span class="gcs-opt-name">' + esc(m.name) + '</span><span class="muted mono gcs-opt-id">' + esc(m.app_id) + "</span></span>" +
          '<a class="btn sm ghost gcs-open" href="' + esc(m.url) + '" target="_blank" rel="noopener" title="Open on Steam">Steam ' + ic("external", "ico-sm") + "</a>" +
          '<button class="gcs-link" data-act="gcs-repick" data-src="' + esc(g.source) + '">change</button></div>';
      } else {
        var opts = st.matches.map(function (m) {
          // Clicking the row picks it; "Steam" opens the store page in a new tab to check it.
          return '<div class="gcs-opt' + (st.pick === m.app_id ? " on" : "") + '"><label class="gcs-opt-pick">' +
            '<input type="radio" name="gcs-' + esc(g.source) + '" data-gcs="pick" data-src="' + esc(g.source) + '" value="' + esc(m.app_id) + '"' + (st.pick === m.app_id ? " checked" : "") + ">" +
            (m.img ? '<img class="gcs-thumb" src="' + esc(m.img) + '" alt="" loading="lazy">' : '<span class="gcs-thumb"></span>') +
            '<span class="gcs-opt-name">' + esc(m.name) + '</span><span class="muted mono gcs-opt-id">' + esc(m.app_id) + "</span></label>" +
            '<a class="btn sm ghost gcs-open" href="' + esc(m.url) + '" target="_blank" rel="noopener" title="Open on Steam">Steam ' + ic("external", "ico-sm") + "</a></div>";
        }).join("");
        opts += '<label class="gcs-opt"><input type="radio" name="gcs-' + esc(g.source) + '" data-gcs="pick" data-src="' + esc(g.source) + '" value="manual"' + (st.pick === "manual" ? " checked" : "") + ">" +
          '<input class="gcs-manual" data-gcs="manual" data-src="' + esc(g.source) + '" placeholder="Paste a Steam link" value="' + esc(st.manual) + '"></label>';
        steam = (st.status === "none" ? '<div class="gcs-warn">Not found on Steam. Paste the link.</div>' : '<div class="gcs-warn">Several matches. Pick the right one.</div>') +
          '<div class="gcs-opts">' + opts + "</div>";
      }
      function sel(kind, options, val) {
        return '<select class="mini-select" data-gcs="' + kind + '" data-src="' + esc(g.source) + '">' +
          options.map(function (o) { return '<option' + (o === val ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select>";
      }
      return '<div class="gcs-row' + (st.on ? "" : " off") + '">' +
        '<label class="gcs-check"><input type="checkbox" data-gcs="on" data-src="' + esc(g.source) + '"' + (st.on ? " checked" : "") + ">" +
          '<span class="gcs-name">' + esc(g.game) + "</span></label>" +
        '<div class="gcs-sels">' + sel("platform", PROPOSAL_PLATFORMS, st.platform) + sel("section", GC_SECTIONS, st.section) + "</div>" +
        '<div class="gcs-steam">' + steam + "</div></div>";
    }).join("");
    return { html: '<div class="gcs-list">' + rows + "</div>", ready: ready };
  }
  function gcSugGenerate() {
    var w = currentGcWeek(); var week = w && w.week;
    if (!week) { toast("Create a week first"); return; }
    var items = ((D.gameCards && D.gameCards.suggestions) || []).map(function (g) {
      var st = gcSug(g.source);
      return st.on && gcSugUrl(st) ? { url: gcSugUrl(st), platform: st.platform, section: st.section, source: g.source } : null;
    }).filter(Boolean);
    if (!items.length) { toast("Nothing selected"); return; }
    toast("Generating " + items.length + " card(s)... this can take a minute");
    enqueueAction("game_cards_generate", { week: week, items: items }, function (r) {
      if (r && r.status === "done") { state.gcSug = {}; toast("Done" + (r.result && r.result.detail ? ": " + r.result.detail : "")); refreshGameCards(); }
      else toast("Generation failed" + (r && r.error ? ": " + r.error : ""));
    });
  }
  function gcSugChange(el) {
    var st = gcSug(el.getAttribute("data-src")), k = el.getAttribute("data-gcs");
    if (k === "on") st.on = el.checked;
    else if (k === "platform") st.platform = el.value;
    else if (k === "section") st.section = el.value;
    else if (k === "pick") st.pick = el.value;
    else if (k === "manual") { st.manual = el.value; st.pick = "manual"; }
    gcRerender();
  }
  function gcRerender() {
    if (state.modal && state.modal.gcAdd) renderModal();
    else if (parseHash().view === "gamecards") render();
  }
  /* "Add game" (left list): two ways to add cards to the open week -
     from this week's new game cards (Mattermost, matched on Steam) or from pasted Steam links. */
  function openAddGame() {
    var w = currentGcWeek();
    if (!w) { toast("Create a week first"); return; }
    var nNew = ((D.gameCards && D.gameCards.suggestions) || []).length;
    showModal({
      title: "Add game to " + w.week, gcAdd: true, close: "Cancel", submit: "Add",
      initial: { mode: nNew ? "new" : "manual", platform: "Steam", section: "Library" },
      intro: function () {
        var mode = state.modalValues.mode;
        var tabs = '<div class="gca-tabs">' +
          '<button class="gca-tab' + (mode === "new" ? " on" : "") + '" data-act="gca-mode" data-mode="new">From new cards' + (nNew ? " (" + nNew + ")" : "") + "</button>" +
          '<button class="gca-tab' + (mode === "manual" ? " on" : "") + '" data-act="gca-mode" data-mode="manual">Steam link</button></div>';
        if (mode !== "new") { state.modal.submit = "Add"; return tabs; }
        var list = gcSuggestRows();
        state.modal.submit = list.ready ? "Add " + list.ready + " card" + (list.ready > 1 ? "s" : "") : "Add";
        return tabs + (list.html || '<div class="gca-none">No new game cards this week without a card.</div>');
      },
      fields: [
        { id: "links", label: "Steam links (one per line)", type: "textarea", required: true, placeholder: "https://store.steampowered.com/app/...", showWhen: { field: "mode", value: "manual" } },
        { id: "platform", label: "Platform", type: "select", options: PROPOSAL_PLATFORMS, showWhen: { field: "mode", value: "manual" } },
        { id: "section", label: "Section", type: "select", options: GC_SECTIONS, showWhen: { field: "mode", value: "manual" } }
      ],
      onSubmit: function (v) {
        if (v.mode === "new") { gcSugGenerate(); return; }
        if (!(v.links || "").trim()) { toast("Paste at least one Steam link"); return; }
        toast("Generating cards... this can take a minute");
        enqueueAction("game_cards_generate", { week: w.week, links: v.links, platform: v.platform || "Steam", section: v.section || "Library" }, function (r) {
          if (r && r.status === "done") { toast("Done" + (r.result && r.result.detail ? ": " + r.result.detail : "")); refreshGameCards(); }
          else toast("Generation failed" + (r && r.error ? ": " + r.error : ""));
        });
      }
    });
  }

  function gcCopyRow(row) {
    var w = currentGcWeek(); if (!w) return; var c = gcRowByIndex(w, row); if (!c) return;
    copyText(GC_FIELDS.map(function (f) { return gcVal(c, f[0]).replace(/[\t\n]+/g, " "); }).join("\t"), "Row copied. Paste it into the sheet");
  }
  /* Save one inline-edited field to the sheet (on blur). Updates the attention badge/chips in place -
     no full re-render - so editing several fields in a row never loses focus. */
  function gcSaveField(el) {
    var week = el.getAttribute("data-gc-week"), row = el.getAttribute("data-gc-row"), col = el.getAttribute("data-gc-field"), val = el.value;
    var w = currentGcWeek(), c = w && gcRowByIndex(w, row);
    if (c) { if (gcVal(c, col) === String(val)) return; c[col] = val; gcUpdateAttn(el.closest(".gc-card"), c); }
    if (col === "related_apps") {   // refresh the IDs caption for the new list
      var cap = el.closest(".gc-fld") && el.closest(".gc-fld").querySelector("[data-gc-ids]");
      if (cap) { cap.setAttribute("data-gc-ids", String(val).trim()); cap.innerHTML = gcIdsText(String(val).trim()); }
    }
    enqueueAction("game_cards_set", { week: week, row_index: parseInt(row, 10), col: col, value: val }, function (r) {
      if (!(r && r.status === "done")) toast("Save failed" + (r && r.error ? ": " + r.error : ""));
    });
  }
  function gcUpdateAttn(cardEl, c) {
    if (!cardEl) return;
    var relOk = gcRelatedFilled(c), trOk = gcTrailerFilled(c);
    cardEl.classList.toggle("attn", !(relOk && trOk));
    var tw = cardEl.querySelector(".gc-title-wrap"), badge = cardEl.querySelector(".gc-warn");
    if (!(relOk && trOk)) { if (!badge && tw) { badge = document.createElement("span"); badge.className = "gc-warn"; badge.title = "Missing details"; badge.textContent = "!"; tw.insertBefore(badge, tw.firstChild); } }
    else if (badge) { badge.remove(); }
    Array.prototype.forEach.call(cardEl.querySelectorAll(".gc-fld"), function (lbl) {
      var inp = lbl.querySelector("[data-gc-field]"); if (!inp) return;
      var k = inp.getAttribute("data-gc-field");
      if (k === "related_apps") lbl.classList.toggle("warn", !relOk);
      if (k === "youtube") lbl.classList.toggle("warn", !trOk);
    });
  }
  function openCreateWeek() {
    showModal({
      title: "New week", submit: "Create", close: "Cancel",
      fields: [{ id: "week", label: "Week name (sheet tab)", type: "text", required: true, placeholder: "e.g. 18–24 Aug" }],
      onSubmit: function (v) {
        var week = (v.week || "").trim(); if (!week) { toast("Name required"); return; }
        toast("Creating week…");
        enqueueAction("game_cards_create_week", { week: week }, function (r) {
          if (r && r.status === "done") { state.gcWeek = (r.result && r.result.name) || week; toast("Week created"); refreshGameCards(); }
          else toast("Create failed" + (r && r.error ? ": " + r.error : ""));
        });
      }
    });
  }
  /* ---------- Game Testing: the weekly test sheet ("26/10 - 30/10" tabs). Every game gets one dropdown per
     check column (answers come from the sheet's own dropdowns); a pick is written straight to the sheet.
     Split by week, then Xbox / Steam. The bot polls the sheet every minute on Thu/Fri; this view re-reads
     Mongo every 20 s while open, so new games show up within about a minute. ---------- */
  function gtTone(v) {
    v = String(v || "").toLowerCase();
    if (!v) return "";
    if (/^(работает|все норм|да, работает)/.test(v)) return "ok";
    if (/проблем|не работает/.test(v)) return "bad";
    if (/^хз/.test(v)) return "unk";
    return "na";   // Не могу проверить / Онлайна нет / Не поддерживает
  }
  function gtWeeks() {
    var tabs = (D.gameTesting && D.gameTesting.tabs) || [], order = [], by = {};
    tabs.forEach(function (t) {
      var k = t.week_label || t.week;
      if (!by[k]) { by[k] = []; order.push(k); }
      by[k].push(t);
    });
    return { order: order, by: by };
  }
  function viewGameTesting() {
    var W = gtWeeks();
    var connected = !!(D.gameTestingConfig && D.gameTestingConfig.webapp_url);
    var syncBtn = '<button class="btn sm ghost" data-act="gt-sync" title="Pull the sheet now">' + ic("refresh", "ico-sm") + "Sync</button>";
    if (!W.order.length) {
      return '<div class="gc-view"><div class="ds-tabbar gc-bar"><div class="sch-picker"></div><div class="ki-tools">' + syncBtn + "</div></div>" +
        '<div class="gc-content">' + emptyState("gametest", "No test weeks yet", connected ? "Press Sync to read the sheet." : (isAdmin() ? "Connect the sheet in Admin → Game Testing first." : "Ask an admin to connect the testing sheet.")) + "</div></div>";
    }
    var wk = W.by[state.gtWeek] ? state.gtWeek : W.order[0];
    var items = [];   // {tab, row}
    W.by[wk].forEach(function (t) { (t.rows || []).forEach(function (r) { items.push({ tab: t, row: r }); }); });
    var plats = ["Steam", "Xbox"].filter(function (p) { return items.some(function (x) { return (x.row.platform || "Steam") === p; }); });
    var plat = plats.indexOf(state.gtPlat) >= 0 ? state.gtPlat : (plats[0] || "Steam");
    var mine = items.filter(function (x) { return (x.row.platform || "Steam") === plat; });
    var ql = state.q.toLowerCase();
    if (ql) mine = mine.filter(function (x) { return String(x.row.game).toLowerCase().indexOf(ql) >= 0; });
    function todo(x) { return (x.tab.columns || []).some(function (c) { return (c.options || []).length && !(x.row.values || {})[c.name]; }); }   // comments are optional
    var open = mine.filter(todo), done = mine.filter(function (x) { return !todo(x); });
    var picker = '<select class="mini-select sch-select" data-act="gt-week-sel">' +
      W.order.map(function (k) { return '<option value="' + esc(k) + '"' + (k === wk ? " selected" : "") + ">" + esc(k) + "</option>"; }).join("") + "</select>";
    var platTabs = plats.map(function (p) {
      var n = items.filter(function (x) { return (x.row.platform || "Steam") === p && todo(x); }).length;
      return '<button class="filter' + (p === plat ? " active" : "") + '" data-act="gt-plat" data-val="' + p + '">' + p + (n ? '<span class="fcount">' + n + "</span>" : "") + "</button>";
    }).join("");
    var synced = D.gameTesting.synced_at ? '<span class="muted gt-sync">Synced ' + esc(agoFrom(D.gameTesting.synced_at)) + "</span>" : "";
    var bar = '<div class="ds-tabbar gc-bar"><div class="sch-picker">' + ic("check", "ico-sm") + picker +
      '<div class="filters" style="margin-left:8px">' + platTabs + "</div></div><div class=\"ki-tools\">" + synced + syncBtn + "</div></div>";
    function card(x) {
      var r = x.row, t = x.tab;
      var sels = (t.columns || []).map(function (c) {
        var v = (r.values || {})[c.name] || "", opts = (c.options || []).slice();
        var dattr = 'data-act="gt-set" data-week="' + esc(t.week) + '" data-row="' + r.row + '" data-col="' + esc(c.name) + '" data-game="' + esc(r.game) + '"';
        if (!opts.length) {   // a column without a dropdown (comments etc.): free text, saved when the field loses focus
          return '<label class="gt-cell gt-wide"><span class="gt-cl">' + esc(c.name) + '</span><textarea class="gt-sel gt-text" rows="2" placeholder="Add a comment" ' + dattr + ">" + esc(v) + "</textarea></label>";
        }
        if (v && opts.indexOf(v) < 0) opts.unshift(v);
        return '<label class="gt-cell"><span class="gt-cl">' + esc(c.name) + "</span>" +
          '<select class="gt-sel ' + gtTone(v) + '" data-act="gt-set" data-week="' + esc(t.week) + '" data-row="' + r.row + '" data-col="' + esc(c.name) + '" data-game="' + esc(r.game) + '">' +
          '<option value=""' + (v ? "" : " selected") + ">—</option>" +
          opts.map(function (o) { return '<option' + (o === v ? " selected" : "") + ' value="' + esc(o) + '">' + esc(o) + "</option>"; }).join("") +
          "</select></label>";
      }).join("");
      return '<div class="gt-card"><div class="gt-game">' + esc(r.game) + "</div>" + '<div class="gt-grid">' + sels + "</div></div>";
    }
    var body = (open.length ? '<div class="gt-h">To test <span class="muted">' + open.length + "</span></div>" + open.map(card).join("") : "") +
      (done.length ? '<div class="gt-h">Done <span class="muted">' + done.length + "</span></div>" + done.map(card).join("") : "") ||
      emptyState("check", "Nothing here", "No " + plat + " games this week.");
    return '<div class="gc-view">' + bar + '<div class="gc-content ds-scroll" style="overflow:auto">' + body + "</div></div>";
  }
  function refreshGameTesting(force) {
    if (!force && state._gtBusy) return;   // don't overwrite a pick that is still on its way to the sheet
    window.CONSOLE.get("/game-testing").then(function (d) {
      if (d && Array.isArray(d.tabs)) {
        var before = JSON.stringify(D.gameTesting || {});
        D.gameTesting = d;
        if (JSON.stringify(d) !== before && parseHash().view === "testing" && !document.querySelector(".gt-sel:focus")) render();
      }
    }, function () {});
  }
  function gtSet(sel) {
    var week = sel.getAttribute("data-week"), row = +sel.getAttribute("data-row"), col = sel.getAttribute("data-col"), v = sel.value;
    (D.gameTesting.tabs || []).forEach(function (t) { if (t.week === week) (t.rows || []).forEach(function (r) { if (r.row === row) { r.values = r.values || {}; r.values[col] = v; } }); });
    if (sel.tagName === "SELECT") sel.className = "gt-sel " + gtTone(v);
    state._gtBusy = (state._gtBusy || 0) + 1;
    enqueueAction("game_testing_set", { week: week, row: row, col: col, value: v, game: sel.getAttribute("data-game") }, function (r) {
      state._gtBusy = Math.max(0, (state._gtBusy || 1) - 1);
      if (r && r.status === "done") toast("Saved to sheet", "ok");
      else { toast("Not saved" + (r && r.error ? ": " + r.error : "")); refreshGameTesting(true); }
    });
  }
  /* ---------- Reply log (admin): every reply / internal note sent from the console, by person, platform
     and period, for checking answer quality. Data: /admin/reply-log (permanent reply_log collection). ---------- */
  function _rlDay(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function rlState() {
    if (!state.rl) state.rl = { preset: "today", from: "", to: "", author: "", platform: "all", kind: "all", status: "all", q: "" };
    return state.rl;
  }
  function rlRange() {   // local-time [from, to) for the chosen period
    var r = rlState(), t = new Date(), d0 = new Date(t.getFullYear(), t.getMonth(), t.getDate()), day = 864e5;
    switch (r.preset) {
      case "yesterday": return [new Date(d0 - day), d0];
      case "7d": return [new Date(d0 - 6 * day), new Date(+d0 + day)];
      case "30d": return [new Date(d0 - 29 * day), new Date(+d0 + day)];
      case "month": return [new Date(t.getFullYear(), t.getMonth(), 1), new Date(+d0 + day)];
      case "lastmonth": return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 1)];
      case "custom":
        var f = r.from ? new Date(r.from + "T00:00:00") : d0, to = r.to ? new Date(r.to + "T00:00:00") : d0;
        return [f, new Date(+to + day)];
      default: return [d0, new Date(+d0 + day)];
    }
  }
  function loadReplyLog() {
    var rg = rlRange(), key = rg[0].toISOString() + "|" + rg[1].toISOString();
    if (state._rlKey === key && D.replyLog) return;
    state._rlKey = key; state._rlLoading = true;
    window.CONSOLE.get("/admin/reply-log?from=" + encodeURIComponent(rg[0].toISOString()) + "&to=" + encodeURIComponent(rg[1].toISOString())).then(function (d) {
      if (state._rlKey !== key) return;
      D.replyLog = d || { items: [] }; state._rlLoading = false; render();
    }, function () { state._rlLoading = false; D.replyLog = { items: [], error: true }; render(); });
  }
  function rlTarget(it) {   // who the reply went to + a link back into the chat
    var t = it.target;
    if (it.platform === "Reddit") {
      var c = (D.redditModmail || []).filter(function (x) { return String(x.id) === t; })[0];
      return { label: c ? "u/" + c.participant + (c.subject ? DOT + c.subject : "") : "Conversation " + t, go: "#/modmail/" + t };
    }
    if (it.platform === "Discord") {
      var k = (D.discordTickets || []).filter(function (x) { return String(tid(x)) === t || String(x._id) === t; })[0];
      return { label: k ? "Ticket #" + (k.ticket_number || "") + DOT + (k.user_name || "") : "Ticket", go: "#/discord/" + t };
    }
    var m = (D.telegramMessages || []).filter(function (x) { return String(x.id) === t; })[0];
    return { label: m ? (m.user || "") + (m.username ? " @" + m.username : "") : "Telegram message", go: "#/telegram" };
  }
  function rlFiltered() {
    var r = rlState(), ql = (r.q || "").toLowerCase();
    return ((D.replyLog && D.replyLog.items) || []).filter(function (it) {
      if (r.author && it.author_email !== r.author) return false;
      if (r.platform !== "all" && it.platform !== r.platform) return false;
      if (r.kind === "reply" && it.internal) return false;
      if (r.kind === "internal" && !it.internal) return false;
      if (r.status === "failed" && it.status !== "error") return false;
      if (ql && (it.text + " " + it.author_name + " " + rlTarget(it).label).toLowerCase().indexOf(ql) < 0) return false;
      return true;
    });
  }
  function viewReplyLog() {
    loadReplyLog();
    var r = rlState(), all = (D.replyLog && D.replyLog.items) || [], list = rlFiltered();
    function chip(group, val, label, n) {
      return '<button class="filter' + (r[group] === val ? " active" : "") + '" data-act="rl-f" data-group="' + group + '" data-val="' + val + '">' + label + (n ? '<span class="fcount">' + n + "</span>" : "") + "</button>";
    }
    var presets = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["lastmonth", "Last month"], ["custom", "Custom"]]
      .map(function (x) { return chip("preset", x[0], x[1]); }).join("");
    var custom = r.preset === "custom"
      ? '<label class="rl-date">From<input type="date" data-rl-date="from" value="' + esc(r.from || _rlDay(new Date())) + '"></label><label class="rl-date">To<input type="date" data-rl-date="to" value="' + esc(r.to || _rlDay(new Date())) + '"></label>' : "";
    // people in this period (author dropdown + summary cards)
    var people = {};
    all.forEach(function (it) {
      var p = people[it.author_email] || (people[it.author_email] = { email: it.author_email, name: it.author_name || it.author_email, n: 0, rep: 0, note: 0, fail: 0, plat: {} });
      p.n++; if (it.internal) p.note++; else p.rep++; if (it.status === "error") p.fail++; p.plat[it.platform] = (p.plat[it.platform] || 0) + 1;
    });
    var plist = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return b.n - a.n; });
    var authorSel = '<select class="mini-select" data-act="rl-author"><option value="">Everyone</option>' +
      plist.map(function (p) { return '<option value="' + esc(p.email) + '"' + (r.author === p.email ? " selected" : "") + ">" + esc(p.name) + " (" + p.n + ")</option>"; }).join("") + "</select>";
    var platN = function (pl) { return all.filter(function (it) { return it.platform === pl; }).length; };
    var bar = '<div class="ds-tabbar rl-bar"><div class="topfilters"><div class="filters fscroll">' + presets + custom + "</div></div></div>" +
      '<div class="rl-bar2">' + authorSel +
      '<div class="filters">' + chip("platform", "all", "All") + chip("platform", "Reddit", "Reddit", platN("Reddit")) + chip("platform", "Discord", "Discord", platN("Discord")) + chip("platform", "Telegram", "Telegram", platN("Telegram")) + "</div>" +
      '<div class="filters">' + chip("kind", "all", "All types") + chip("kind", "reply", "Replies") + chip("kind", "internal", "Internal notes") + "</div>" +
      '<div class="filters">' + chip("status", "all", "Any status") + chip("status", "failed", "Failed", all.filter(function (it) { return it.status === "error"; }).length) + "</div>" +
      '<input class="f-input rl-q" data-rl-q placeholder="Search text, person, user" value="' + esc(r.q || "") + '">' +
      '<button class="btn sm ghost" data-act="rl-csv">' + ic("posts", "ico-sm") + "CSV</button></div>";
    var cards = plist.length ? '<div class="rl-people">' + plist.map(function (p) {
      var pl = Object.keys(p.plat).map(function (k) { return k + " " + p.plat[k]; }).join(DOT);
      return '<button class="rl-person' + (r.author === p.email ? " active" : "") + '" data-act="rl-person" data-val="' + esc(p.email) + '">' +
        '<b>' + esc(p.name) + '</b><span class="rl-big">' + p.n + "</span>" +
        '<span class="muted">' + p.rep + " replies" + DOT + p.note + " notes" + (p.fail ? DOT + '<span class="rl-fail">' + p.fail + " failed</span>" : "") + "</span>" +
        '<span class="muted">' + esc(pl) + "</span></button>";
    }).join("") + "</div>" : "";
    var rows = list.slice(0, 500).map(function (it) {
      var tg = rlTarget(it), d = new Date(it.at);
      var when = ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      return '<div class="qrow rl-row' + (it.status === "error" ? " failed" : "") + '" role="row">' +
        qCell("qc-when rl-when", when, "Time") +
        qCell("qc-who", "<b>" + esc(it.author_name || it.author_email) + "</b>", "Author") +
        qCell("qc-plat", esc(it.platform), "Platform") +
        qCell("qc-type", it.internal ? '<span class="chip accent">Internal note</span>' : "Reply", "Type") +
        qCell("qc-status", it.status === "error" ? '<span class="rl-fail" title="' + esc(it.error) + '">Not delivered</span>' : (it.status === "pending" || it.status === "processing" ? '<span class="muted">Sending…</span>' : ""), "Status") +
        qCell("qc-to", '<a class="rl-to" href="' + esc(tg.go) + '">' + esc(tg.label) + " " + ic("external", "ico-sm") + "</a>", "To") +
        qCell("qc-text", '<span class="rl-text" data-act="rl-expand">' + esc(it.text) + "</span>", "Text") + "</div>";
    }).join("");
    var body = state._rlLoading && !all.length ? skeletonRows(8)
      : (list.length ? '<div class="rl-count muted">' + list.length + " messages" + (list.length > 500 ? DOT + "showing the newest 500, narrow the filters or export CSV" : "") + "</div>" + qTable("q-rl", ["Time", "Author", "Platform", "Type", "Status", "To", "Text"], rows)
      : emptyState("book", "Nothing found", "No replies match these filters in this period."));
    return '<div class="ds-view rl-view">' + bar + '<div class="ds-body" style="overflow:auto;display:block;padding:0 18px 24px">' + cards + body + "</div></div>";
  }
  function rlCsv() {
    var list = rlFiltered();
    var q = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
    var csv = ["Time,Author,Platform,Type,Status,To,Text"].concat(list.map(function (it) {
      return [it.at, it.author_name || it.author_email, it.platform, it.internal ? "Internal note" : "Reply", it.status, rlTarget(it).label, it.text].map(q).join(",");
    })).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = "reply-log-" + _rlDay(rlRange()[0]) + ".csv"; a.click();
  }
  function refreshGameCards() {
    window.CONSOLE.get("/game-cards").then(function (d) {
      if (d && Array.isArray(d.weeks)) { D.gameCards = { weeks: d.weeks, image_keys: d.image_keys || [], meta: d.meta || {}, suggestions: d.suggestions || [] }; if (d.synced_at) state.gcSyncedAt = d.synced_at; render(); }
    }, function () {});
  }
  function viewNotes() {
    var ql = state.q.toLowerCase();
    var list = D.notes.filter(function (n) { return !ql || (n.text + " " + n.refLabel).toLowerCase().indexOf(ql) >= 0; });
    var cards = list.map(function (n) {
      var route = noteRoute(n);
      return '<div class="note"><div class="nhead">' +
        '<span class="anchor"' + (route ? ' data-go="' + route + '"' : "") + ">" + ic(noteIcon(n), "ico-sm") + esc(n.refLabel) + "</span>" +
        '<span class="row-gap" style="gap:2px;flex:none">' +
        '<button class="icon-btn" title="Edit note" data-act="note-edit" data-id="' + esc(n.id) + '">' + ic("notes", "ico-sm") + "</button>" +
        '<button class="icon-btn" title="Delete note" data-act="note-del" data-id="' + esc(n.id) + '">' + ic("x", "ico-sm") + "</button></span></div>" +
        '<div class="ntext">' + esc(n.text) + '</div><div class="nfoot">' + esc(n.author) + DOT + esc(n.ago) + "</div></div>";
    }).join("");
    var add = '<div class="note-add"><input placeholder="New note (general)..." data-note-input>' +
      '<button class="btn" data-act="note-add" data-ctx-type="general" data-ctx-ref="" data-ctx-label="General">' + ic("plus", "ico-sm") + "Add</button></div>";
    return '<div class="page"><div class="page-head"><div><h1>Notes</h1></div></div>' +
      '<div class="page-body">' + add + '<div class="stack" style="gap:12px">' + (cards || emptyState("notes", "No notes yet", "")) + "</div></div></div>";
  }

  /* Facebook Notes (item T8): simple per-person notes - username, optional chat link, text,
     optional Jira ticket. Console-only. */
  function contactFields() {
    return [
      { id: "username", label: "Username", type: "text", required: true, placeholder: "Person's name" },
      { id: "link", label: "Chat link", type: "url", placeholder: "https://facebook.com/..." },
      { id: "text", label: "Note", type: "textarea", required: true, placeholder: "Anything worth remembering..." },
      { id: "ticket", label: "Jira ticket", type: "text", placeholder: "e.g. SO-160" }
    ];
  }
  function _fbName(c) { return c.username || (c.first || c.last ? ((c.first || "") + " " + (c.last || "")).trim() : "Unnamed"); }
  function _fbText(c) { return c.text != null ? c.text : (c.note || ""); }
  function openContactCreate() {
    showModal({ title: "Add Facebook note", submit: "Add", close: "Cancel", fields: contactFields(),
      onSubmit: function (v) {
        var doc = { username: v.username || "", link: v.link || "", text: v.text || "", ticket: v.ticket || "" };
        window.CONSOLE.post("/fb-notes", doc).then(function (r) { if (r && r.id) { doc.id = r.id; D.channelContacts.unshift(doc); render(); toast("Note added"); } else toast("Failed"); }, function () { toast("Failed"); });
      } });
  }
  function openContactEdit(id) {
    var c = D.channelContacts.filter(function (x) { return x.id === id; })[0]; if (!c) return;
    showModal({ title: "Edit Facebook note", submit: "Save", close: "Cancel", fields: contactFields(),
      initial: { username: _fbName(c), link: c.link, text: _fbText(c), ticket: c.ticket },
      onSubmit: function (v) {
        c.username = v.username; c.link = v.link; c.text = v.text; c.ticket = v.ticket;
        window.CONSOLE.put("/fb-notes/" + encodeURIComponent(id), { username: v.username, link: v.link, text: v.text, ticket: v.ticket }).then(function () {}, function () {});
        toast("Note saved"); render();
      } });
  }
  function deleteContact(id) {
    D.channelContacts = D.channelContacts.filter(function (x) { return x.id !== id; });
    window.CONSOLE.del("/fb-notes/" + encodeURIComponent(id)).then(function () {}, function () {});
    render(); toast("Note deleted");
  }
  /* The Facebook group URL is the single admin "Facebook group link" variable (Admin > Variables &
     links). Falls back to the old env value if that variable is somehow unset. */
  function fbGroupUrl() {
    var v = (D.variables || []).filter(function (x) { return x.id === "fb_group"; })[0];
    return (v && v.value) || state.fbGroupUrl || "";
  }
  /* Open the FB group in a new tab AND record a shared "last checked by <me> now" (item W7). */
  function openFacebookGroup() {
    var url = fbGroupUrl();
    if (url && /facebook\.com\/groups\/[^/?#]+\/?$/.test(url)) url = url.replace(/\/?$/, "/?sorting_setting=CHRONOLOGICAL");   // newest first
    if (url) window.open(url, "_blank", "noopener");
    state.fbGroupCheck = { by: myName(), at: new Date().toISOString() };
    window.CONSOLE.post("/fb-group-check", {}).then(function () {}, function () {});
    render();
  }

  /* ---------- Facebook feed (CMT browser extension -> /api/fb/ingest) ---------- */
  function loadFb() {
    state._fbAt = Date.now();
    return window.CONSOLE.get("/fb-posts").then(function (r) {
      if (r && r.posts) { D.fbPosts = r.posts; D.fbDms = r.dms || []; D.fbHeartbeat = r.heartbeat || ""; D.fbExt = { v: r.ext_version || "", latest: r.ext_latest || "", seen: r.ext_seen || 0, hidden: !!r.ext_hidden }; }
    }, function () {});
  }
  function fbPostById(id) { return (D.fbPosts || []).filter(function (x) { return x.id === id; })[0]; }
  function fbPatch(id, body) {
    var p = fbPostById(id);
    if (p) {
      if (body.tags) p.tags = body.tags;
      if (body.status) p.status = body.status;
    }
    render();
    if ("user_id" in body) toast(/@/.test(String(body.user_id)) ? "Looking the User ID up..." : "Saving...");
    window.CONSOLE.patch("/fb-posts/" + encodeURIComponent(id), body).then(function (d) {
      if (d && d.error) { toast("User ID not saved: " + d.error); return; }
      if (d && "user_id" in body) {
        (D.fbPosts || []).forEach(function (x) { if (p && x.author_key === p.author_key) x.user_id = d.user_id || ""; });
        toast(d.user_id ? "User ID " + d.user_id + " saved" : "User ID removed");
        render();
      }
    }, function (e) { toast("Not saved" + (e && e.message ? ": " + e.message : "")); });
  }
  function fbNewCount() {
    return (D.fbPosts || []).filter(function (p) { return p.status === "new"; }).length +
      (D.fbDms || []).filter(function (d) { return d.status === "new"; }).length;
  }
  function viewFbFeed(tab) {
    var ql = (state.q || "").toLowerCase().trim();
    if (tab === "messages") {
      var dms = (D.fbDms || []).filter(function (d) { return !ql || ((d.name || "") + " " + (d.snippet || "")).toLowerCase().indexOf(ql) >= 0; });
      if (!dms.length) return emptyState("mail", "No new messages", "Unread chats the extension sees show up here.");
      return '<div class="ev-table">' + dms.map(function (d) {
        return '<div class="fbp-card' + (d.status === "new" ? " is-new" : "") + '"><div class="fbp-top">' + ic("mail", "ico-sm") +
          '<b>' + esc(d.name || "Someone") + '</b><span class="muted">sent a new message' + DOT + esc(agoFrom(d.last_seen_unread)) + "</span>" +
          '<div class="spacer"></div>' +
          (safeUrl(d.url) ? '<a class="btn sm ghost" href="' + esc(safeUrl(d.url)) + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open chat</a>" : "") +
          (d.status === "new" ? '<button class="btn sm" data-act="fbdm-seen" data-id="' + esc(d.id) + '">' + ic("check", "ico-sm") + "Seen</button>" : '<span class="muted">Seen</span>') +
          "</div></div>";
      }).join("") + "</div>";
    }
    var f = state.fbFilter || "new";
    var posts = (D.fbPosts || []).filter(function (p) {
      if (f !== "all" && (p.status || "new") !== f) return false;
      if (!ql) return true;
      return [p.author, p.text, p.user_id, (p.tags || []).join(" ")].join(" ").toLowerCase().indexOf(ql) >= 0;
    });
    var cnt = { all: (D.fbPosts || []).length };
    (D.fbPosts || []).forEach(function (p) { var k = p.status || "new"; cnt[k] = (cnt[k] || 0) + 1; });
    var filt = '<div class="ev-nav">' + [["new", "New"], ["handled", "Handled"], ["ignored", "Ignored"], ["all", "All"]].map(function (x) {
      return '<button class="ev-nav-b' + (f === x[0] ? " on" : "") + '" data-act="fb-filter" data-f="' + x[0] + '">' + x[1] + ' <span class="ev-nav-n">' + (cnt[x[0]] || 0) + "</span></button>";
    }).join("") + "</div>";
    var fbTr = state.fbTr || {};
    if (!posts.length) return filt + emptyState("facebook", "No posts here", "New group posts the extension sees show up here.");
    return filt + posts.slice(0, 300).map(function (p) {
      var uid = p.user_id
        ? '<a class="chip accent mono" href="' + esc(adminSessionsUrl(p.user_id)) + '" target="_blank" rel="noopener">User ID ' + esc(p.user_id) + "</a>" +
          '<button class="gcs-link" data-act="fb-bind" data-id="' + esc(p.id) + '">change</button>'
        : '<button class="btn sm ghost" data-act="fb-bind" data-id="' + esc(p.id) + '">' + ic("user", "ico-sm") + "Bind User ID</button>";
      var tags = (p.tags || []).map(function (t) {
        return '<span class="chip">' + ic("tag", "ico-sm") + esc(t) + '<button class="chip-x" title="Remove tag" data-act="fb-untag" data-id="' + esc(p.id) + '" data-tag="' + esc(t) + '">' + ic("x", "ico-sm") + "</button></span>";
      }).join("");
      var st = p.status || "new";
      return '<div class="fbp-card' + (st === "new" ? " is-new" : "") + '">' +
        '<div class="fbp-top">' + ic("facebook", "ico-sm") +
        (safeUrl(p.author_url) ? '<a href="' + esc(safeUrl(p.author_url)) + '" target="_blank" rel="noopener"><b>' + esc(p.author || "Unknown") + "</b></a>" : "<b>" + esc(p.author || "Unknown") + "</b>") +
        uid + '<div class="spacer"></div><span class="muted">' + esc(agoFrom(p.posted_at)) + "</span></div>" +
        '<div class="fbp-text">' + esc(p.text || "(no text)") + "</div>" +
        (fbTr[p.id] ? '<div class="fbp-text fbp-tr">' + esc(fbTr[p.id]) + "</div>" : "") +
        '<div class="rmeta">' + tags + '<button class="btn sm ghost" data-act="fb-tag" data-id="' + esc(p.id) + '">' + ic("tag", "ico-sm") + ((p.tags || []).length ? "Edit tags" : "Add tag") + "</button>" +
        (p.text ? '<button class="btn sm ghost" data-act="fb-translate" data-id="' + esc(p.id) + '">' + (fbTr[p.id] ? "Hide translation" : "Translate") + "</button>" : "") +
        '<div class="spacer"></div>' +
        (safeUrl(p.url) ? '<a class="btn sm ghost" href="' + esc(safeUrl(p.url)) + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open post</a>" : "") +
        (st !== "handled" ? '<button class="btn sm" data-act="fb-status" data-st="handled" data-id="' + esc(p.id) + '">' + ic("check", "ico-sm") + "Handled</button>" : "") +
        (st !== "ignored" ? '<button class="btn sm ghost" data-act="fb-status" data-st="ignored" data-id="' + esc(p.id) + '">Ignore</button>' : "") +
        (st !== "new" ? '<button class="btn sm ghost" data-act="fb-status" data-st="new" data-id="' + esc(p.id) + '">Reopen</button>' : "") +
        (p.handled_by && st !== "new" ? '<span class="muted" style="font-size:12px">' + esc(p.handled_by) + "</span>" : "") +
        "</div></div>";
    }).join("");
  }
  function viewChannels() {
    var ql = state.q.toLowerCase();
    var notes = D.channelContacts.filter(function (c) {
      return !ql || (_fbName(c) + " " + (c.ticket || "") + " " + _fbText(c)).toLowerCase().indexOf(ql) >= 0;
    });
    var rows = notes.map(function (c) {
      var ticket = c.ticket ? '<span class="chip accent" data-go="#/jira/' + esc(c.ticket) + '" style="padding:1px 8px;cursor:pointer">' + ic("jira", "ico-sm") + esc(c.ticket) + "</span>" : "";
      return '<div class="ext-item">' + ic("facebook") + '<div class="fc-main"><div class="fc-top"><span class="fc-title truncate">' + esc(_fbName(c)) + "</span></div>" +
        '<div class="fc-sub">' + esc(_fbText(c)) + "</div>" +
        '<div class="rmeta">' +
        (safeUrl(c.link) ? '<a class="btn sm ghost" href="' + esc(safeUrl(c.link)) + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Open chat</a>" : "") +
        ticket + '<div class="spacer"></div>' +
        '<button class="btn sm ghost iconly" data-act="contact-edit" data-id="' + esc(c.id) + '" title="Edit">' + ic("notes", "ico-sm") + "</button>" +
        '<button class="btn sm ghost iconly" data-act="contact-del" data-id="' + esc(c.id) + '" title="Delete">' + ic("x", "ico-sm") + "</button>" +
        "</div></div></div>";
    }).join("");
    // Open-group button + shared "last checked" indicator (item W7).
    var chk = state.fbGroupCheck || {};
    var lastChecked = chk.at
      ? '<span class="muted" style="font-size:12px">Last checked by ' + esc(chk.by || "someone") + DOT + esc(timeText(chk.at)) + "</span>"
      : '<span class="muted" style="font-size:12px">Not checked yet</span>';
    var groupBtn = fbGroupUrl()
      ? '<button class="btn primary" data-act="fb-group">' + ic("facebook", "ico-sm") + "Open Facebook group</button>"
      : '<span class="muted" style="font-size:12px">Set the "Facebook group link" in Admin &gt; Variables &amp; links to enable this button.</span>';
    var groupBar = '<div class="row-gap" style="justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">' +
      groupBtn + lastChecked + "</div>";
    if (Date.now() - (state._fbAt || 0) > 60000) loadFb().then(function () { if (parseHash().view === "channels") render(); });
    var fbTab = state.fbTab || "posts";
    var newDms = (D.fbDms || []).filter(function (d) { return d.status === "new"; }).length;
    var newPosts = (D.fbPosts || []).filter(function (p) { return p.status === "new"; }).length;
    var fbTabs = '<div class="ev-nav">' + [["posts", "Posts", newPosts], ["messages", "Messages", newDms], ["notes", "Notes", 0]].map(function (t) {
      return '<button class="ev-nav-b' + (fbTab === t[0] ? " on" : "") + '" data-act="fb-tab" data-tab="' + t[0] + '">' + t[1] + (t[2] ? ' <span class="nbadge">' + t[2] + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    var hb = D.fbHeartbeat ? "Extension last sent " + agoFrom(D.fbHeartbeat) : "Extension has not sent anything yet";
    var fx = D.fbExt || {};
    if (D.fbHeartbeat) hb += DOT + (fx.seen || 0) + " post(s) on the page" + (fx.hidden ? " (tab in background)" : "");
    if (fx.v) hb += DOT + "v" + fx.v + (fx.latest && fx.latest !== fx.v ? " (v" + fx.latest + " available, the extension shows an update banner)" : "");
    var hbOld = !D.fbHeartbeat || (Date.now() - (_utcDate(D.fbHeartbeat) || new Date(0)).getTime() > 15 * 60000);
    var adminBar = isAdmin()
      ? '<div class="fb-admin"><span class="' + (hbOld ? "danger-t" : "muted") + '">' + esc(hb) + "</span>" +
        '<a class="btn sm" href="/api/console/fb-extension.zip">' + ic("external", "ico-sm") + "Chrome / Edge</a>" +
        '<a class="btn sm" href="/api/console/fb-extension.zip?browser=firefox">' + ic("external", "ico-sm") + "Firefox</a>" +
        '<span class="muted" style="font-size:12px">Chrome/Edge: unzip, open chrome://extensions, Developer mode, Load unpacked. Firefox: about:debugging, This Firefox, Load Temporary Add-on, pick manifest.json (or install the signed .xpi). Keep the group tab open.</span></div>'
      : "";
    var head = '<div class="page"><div class="page-head"><div><h1>Facebook</h1></div></div><div class="page-body">' + adminBar + groupBar + fbTabs;
    if (fbTab !== "notes") return head + viewFbFeed(fbTab) + "</div></div>";
    return head + '<div class="panel"><div class="panel-head"><h3>' + ic("facebook", "ico-sm") + "Notes</h3><span class=\"count-pill\">" + notes.length + "</span></div>" +
      '<div class="panel-body">' + (rows || '<div class="ctx-empty">No notes yet.</div>') +
      '<button class="btn primary" data-act="contact-new" style="margin-top:14px">' + ic("plus", "ico-sm") + "Add note</button></div></div></div></div>";
  }

  function actRow(main, sub, meta, del) {
    return '<div class="act-row"><div class="ar-main"><div class="truncate">' + main + "</div>" +
      (sub ? '<div class="ar-sub">' + sub + "</div>" : "") + "</div>" +
      (meta ? '<span class="ar-meta">' + esc(meta) + "</span>" : "") + (del || "") + "</div>";
  }
  function panel(icon, title, count, body) {
    return '<div class="panel"><div class="panel-head"><h3>' + ic(icon, "ico-sm") + esc(title) + "</h3>" +
      (count != null ? '<span class="count-pill">' + count + "</span>" : "") + "</div>" +
      '<div class="panel-body">' + body + "</div></div>";
  }
  /* Admin: reminders / SLA-nudge config. Thresholds (minutes) per work type + delivery + check interval.
     Saved to console_config; the bot's reminder scheduler reads it and pings the TG work group + on-shift CM. */
  /* Admin > Data: the numbered database migration steps (services/db_migrations.py). Auto steps run once
     at start-up; steps that delete data show their numbers first (Preview) and run only on Apply. */
  function adminDbPanel() {
    var st = state.dbMig || (state.dbMig = { steps: null, out: {} });
    if (!st.steps && !st.loading) {
      st.loading = true;
      window.CONSOLE.get("/admin/db-migrations").then(function (d) { st.loading = false; st.steps = (d && d.steps) || []; renderFresh(); },
        function () { st.loading = false; st.steps = []; toast("Could not load the migration steps"); });
    }
    var rows = (st.steps || []).map(function (s) {
      var done = s.status === "done";
      var meta = done ? "Done " + esc(timeText(s.applied_at)) + (s.applied_by ? " by " + esc(s.applied_by) : "") : (s.kind === "auto" ? "Runs at start-up" : "Not applied");
      var btns = s.kind === "manual"
        ? '<button class="btn sm" data-act="dbmig-preview" data-id="' + s.id + '">Preview</button>' +
          '<button class="btn sm danger" data-act="dbmig-apply" data-id="' + s.id + '">Apply</button>' : "";
      var out = st.out[s.id] ? '<pre class="mono" style="white-space:pre-wrap;font-size:11px;margin:6px 0 0">' + esc(st.out[s.id]) + "</pre>" : "";
      return '<div class="act-row" style="flex-direction:column;align-items:stretch;gap:6px"><div class="ar-main">' +
        '<span class="truncate"><b>' + s.id + ".</b> " + esc(s.name) + '</span><span class="muted" style="font-size:12px">' + meta + "</span></div>" +
        (btns ? '<div class="row-gap" style="gap:6px">' + btns + "</div>" : "") + out + "</div>";
    }).join("");
    return panel("clock", "Database maintenance", null,
      '<div class="section-note" style="margin-bottom:10px">Numbered database steps. Steps that delete data show the numbers first (Preview) and run only when you press Apply - that cannot be undone. Every step runs once and is logged.</div>' +
      '<button class="btn" data-act="dbmig-report" style="margin-bottom:10px">' + ic("search", "ico-sm") + "Step 0: collections report</button>" +
      (st.steps ? '<div class="stack" style="gap:8px">' + rows + "</div>" : skeletonRows(3)));
  }
  function dbMigRun(id, apply) {
    var st = state.dbMig; if (!st) return;
    var go = function () {
      st.out[id] = apply ? "Applying..." : "Counting..."; render();
      window.CONSOLE.postMsg("/admin/db-migrations/" + id, { apply: apply }).then(function (res) {
        st.out[id] = res.status === 200 ? JSON.stringify(res.data.preview || res.data.applied || res.data, null, 2)
                                        : "Error: " + ((res.data && res.data.error) || res.status);
        if (apply && res.status === 200) st.steps = null;   // reload the statuses
        render();
      }, function () { st.out[id] = "Error: the server did not answer"; render(); });
    };
    if (!apply) { go(); return; }
    window.CONSOLE.postMsg("/admin/db-migrations/" + id, { apply: false }).then(function (res) {
      var nums = res.status === 200 ? JSON.stringify(res.data.preview, null, 1) : "(no preview)";
      if (window.confirm("Apply step " + id + "? This deletes data and cannot be undone.\n\n" + nums)) go();
    });
  }
  function dbReport() {
    toast("Building the report...");
    window.CONSOLE.get("/admin/db-report").then(function (d) {
      var rows = ((d && d.collections) || []).map(function (c) {
        return "<tr><td class=\"mono\">" + esc(c.name) + (c.in_code ? "" : ' <span class="chip soft">not in code</span>') + "</td><td>" +
          (c.count == null ? "?" : c.count) + "</td><td>" + (c.size_mb == null ? "" : c.size_mb + " MB") + "</td><td>" +
          esc(c.last_write ? timeText(c.last_write) : "") + "</td><td>" + (c.with_email || "") + "</td></tr>";
      }).join("");
      var absent = (d && d.in_code_but_absent || []).join(", ");
      showModal({ title: "Collections report", close: "Close", wide: true, custom: function () {
        return '<div style="overflow:auto;max-height:60vh"><table class="tbl" style="width:100%;font-size:12px"><thead><tr><th>Collection</th><th>Documents</th><th>Size</th><th>Last write</th><th>With email</th></tr></thead><tbody>' +
          rows + "</tbody></table></div>" + (absent ? '<div class="muted" style="font-size:12px;margin-top:8px">In the code but not in the database: ' + esc(absent) + "</div>" : "");
      } });
    }, function () { toast("Could not build the report"); });
  }
  function adminRemindersPanel() {
    var r = D.remindersConfig || {};
    function num(key, label, val) {
      return '<div class="var-row"><label>' + esc(label) + "</label>" +
        '<input class="f-input" type="number" min="0" data-rem="' + key + '" value="' + esc(String(val)) + '" style="max-width:130px"></div>';
    }
    function chk(key, label, on) {
      return '<label class="sched-day" style="gap:8px"><input type="checkbox" data-rem="' + key + '"' + (on ? " checked" : "") + "><span>" + esc(label) + "</span></label>";
    }
    var body =
      '<div class="section-note" style="margin-bottom:12px">Nudge the team when work sits too long. Thresholds are in minutes and count <b>only while someone is on shift</b> — if no one is on shift the timers pause and resume when the next shift starts. The bot checks on the interval below and pings the Telegram work group and whoever is on shift right now (via their own notification settings).</div>' +
      '<div style="margin-bottom:14px;display:flex;gap:18px;flex-wrap:wrap">' + chk("enabled", "Reminders enabled", r.enabled !== false) + chk("pause_no_shift", "Pause when nobody is on shift", r.pause_no_shift !== false) + "</div>" +
      '<div class="stack" style="gap:12px">' +
      num("check_every_min", "Check every (min)", r.check_every_min || 15) +
      num("reddit_post_min", "Reddit post: no reply / not ignored (min)", r.reddit_post_min || 120) +
      num("modmail_new_min", "ModMail: New, no reply (min)", r.modmail_new_min || 60) +
      num("modmail_review_min", "ModMail: Needs Review (min)", r.modmail_review_min || 30) +
      num("facebook_min", "Facebook: not checked (min)", r.facebook_min || 240) +
      num("jira_stuck_min", "Jira To-Do: stuck (min)", r.jira_stuck_min || 120) +
      num("mention_min", "Discord mention: unanswered (min)", r.mention_min || 60) +
      "</div>" +
      '<div class="nsub">Delivery</div>' +
      '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px">' +
      chk("to_group", "Telegram work group", r.to_group !== false) +
      chk("to_shift", "On-shift CM (their notification settings)", r.to_shift !== false) +
      "</div>" +
      '<button class="btn primary" data-act="reminders-save">' + ic("check", "ico-sm") + "Save reminders</button>";
    return panel("clock", "Reminders (SLA nudges)", null, body);
  }
  /* Admin: map each Discord forum channel ID to a console category (Suggestions / Help Centre / Discussion).
     Saved to console_config; the bot files new forum posts under the matching category. */
  function adminForumsPanel() {
    var fc = D.forumConfig || {};
    var rows = FORUM_CATS.map(function (cat) {
      return '<div class="var-row"><label>' + esc(cat) + ' — forum channel ID</label>' +
        '<input class="f-input mono" data-forum-cat="' + esc(cat) + '" value="' + esc(fc[cat] || "") + '" placeholder="Discord forum channel ID"></div>';
    }).join("");
    return panel("discord", "Discord forums", null,
      '<div class="section-note" style="margin-bottom:12px">Map each Discord forum channel to a console category. The bot files new posts under the matching category on the Forum tab. Moderators (for Mentions) are taken automatically from each member\'s Discord identity - no separate list here.</div>' +
      '<div class="stack" style="gap:12px">' + rows + "</div>" +
      '<button class="btn primary" data-act="forums-save" style="margin-top:14px">' + ic("check", "ico-sm") + "Save forums</button>");
  }
  function adminKnownPanel() {
    var kc = D.knownConfig || {};
    var gl = D.gameListConfig || {};
    return panel("book", "Known issues", null,
      '<div class="section-note" style="margin-bottom:12px">Connected via a <b>Google Apps Script</b> web app in the sheet, no Google Cloud. In the sheet: <span class="mono">Extensions, Apps Script</span>, paste the bridge script, set a secret, <b>Deploy, Web app</b> (Execute as: me, Access: Anyone), then paste the web-app URL below. On the bot set <span class="mono">KNOWN_ISSUES_SECRET</span> to the same secret. The bot mirrors every tab every ~5 min; new rows are inserted alphabetically.</div>' +
      '<div class="var-row"><label>Apps Script web-app URL</label><input class="f-input mono" data-known-url value="' + esc(kc.webapp_url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="var-row" style="align-items:flex-start"><label>Telegram chats for new issues</label><textarea class="f-input mono" data-known-tg rows="3" placeholder="One chat per line: -1001234567890  or  -1001234567890:TOPIC_ID">' + esc(kc.tg_chats || "") + "</textarea></div>" +
      '<div class="section-note" style="margin-top:6px">Every new row (added here, approved, or typed into the sheet) is posted as <span class="mono">New known issue added: Game - Problem</span> + the solution. The Telegram bot must be a member of each chat.</div>' +
      '<div class="row-gap" style="margin-top:14px;gap:8px"><button class="btn primary" data-act="known-config-save">' + ic("check", "ico-sm") + "Save</button>" +
      '<button class="btn ghost" data-act="known-sync">' + ic("refresh", "ico-sm") + "Sync now</button></div>" +
      '<div class="section-note" style="margin:18px 0 12px">Game List: a separate Apps Script web app over the <b>Game List</b> sheet, so a game shows its ID and the public page can deep-link at <span class="mono">/knownissues/&lt;id&gt;</span>. Deploy the Game List script (Access: Anyone), set <span class="mono">GAME_LIST_SECRET</span> on the bot to its secret, and paste the web-app URL below.</div>' +
      '<div class="var-row"><label>Game List web-app URL</label><input class="f-input mono" data-game-list-url value="' + esc(gl.webapp_url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="row-gap" style="margin-top:14px;gap:8px"><button class="btn primary" data-act="game-list-config-save">' + ic("check", "ico-sm") + "Save</button>" +
      '<button class="btn ghost" data-act="game-list-sync">' + ic("refresh", "ico-sm") + "Sync now</button></div>");
  }
  function adminKnownSuggestionsPanel() {
    var sugs = D.knownSuggestions || [];
    var rows = sugs.map(function (s) {
      return '<div class="act-row ks-row">' +
        '<div class="ar-main"><div class="ks-chips"><span class="chip soft" style="padding:1px 8px">' + esc(knownLabel(s.category)) + "</span>" +
        (s.source === "public" ? '<span class="chip" style="padding:1px 8px;background:var(--amber-soft);color:var(--amber)" title="Submitted from the public /knownissues page">Public</span>' : "") +
        (s.kind === "addition" ? '<span class="chip accent" style="padding:1px 8px" title="Adds a canned message and/or screenshots to an EXISTING issue">Addition</span>' : "") +
        (s.kind === "edit" ? '<span class="chip accent" style="padding:1px 8px" title="Changes the text of an EXISTING issue">Edit: ' + esc(Object.keys(s.changes || {}).join(", ")) + "</span>" : "") +
        kiEnts(s).map(function (g) { return '<span class="chip soft" style="padding:1px 8px">' + esc(g) + "</span>"; }).join("") +
        ((s.shots || []).length ? '<span class="chip soft" style="padding:1px 8px">' + ic("cards", "ico-sm") + " " + s.shots.length + " screenshot" + (s.shots.length > 1 ? "s" : "") + "</span>" : "") +
        '</div><div class="ks-problem">' + esc(s.problem || "") + "</div>" +
        (s.solution ? '<div class="ar-sub">' + esc(s.solution) + "</div>" : "") +
        '<div class="muted" style="font-size:11.5px;margin-top:3px">suggested by ' + esc(s.by || "someone") + "</div></div>" +
        (s.link ? '<div class="ar-sub truncate">' + ic("external", "ico-sm") + " " + esc(s.link) + "</div>" : "") +
        (s.canned ? '<div class="ar-sub" style="font-style:italic">Canned: ' + esc(String(s.canned).slice(0, 140)) + (String(s.canned).length > 140 ? "…" : "") + "</div>" : "") +
        '<div class="row-gap" style="gap:6px;flex:none"><button class="btn sm" data-act="known-sug-review" data-id="' + esc(s.id) + '">' + ic("notes", "ico-sm") + "Review & edit</button>" +
        '<button class="btn sm primary" data-act="known-sug-approve" data-id="' + esc(s.id) + '">Approve</button>' +
        '<button class="btn sm ghost" data-act="known-sug-reject" data-id="' + esc(s.id) + '">Reject</button></div></div>';
    }).join("") || '<div class="ctx-empty">No pending suggestions.</div>';
    return panel("inbox", "Known-issues suggestions", sugs.length, '<div class="act-list">' + rows + "</div>");
  }
  /* Full view of a suggestion: every field the person filled in, editable by the admin, then Approve
     (writes the EDITED version to the sheet), Save changes (keeps it pending) or Reject. */
  function openKnownSuggestionReview(id) {
    var s = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (s.kind === "addition") { openKnownAdditionReview(s); return; }
    if (s.kind === "edit") { openKnownEditReview(s); return; }
    var catLabels = KNOWN_TABS.map(function (t) { return t[1]; });
    var when = s.created_at ? (timeText(s.created_at) || "") : "";
    var meta = '<div class="section-note" style="margin-bottom:12px">' +
      "Suggested by <b>" + esc(s.by || "someone") + "</b>" + (s.by_email ? " (" + esc(s.by_email) + ")" : "") +
      (s.source === "public" ? DOT + "from the public /knownissues page" : DOT + "from the console") + (when ? DOT + esc(when) : "") +
      (s.edited_by ? '<br><span class="muted">Edited by ' + esc(s.edited_by) + "</span>" : "") +
      (s.link && /^https?:\/\//i.test(s.link) ? '<br><a href="' + esc(s.link) + '" target="_blank" rel="noopener">Open the link ' + ic("external", "ico-sm") + "</a>" : "") + "</div>";
    var stageKey = "ki-sug-" + id;
    var introFn = function () {
      var cur = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0] || s;
      var theirs = (cur.shots || []).length
        ? '<div class="field"><label>Screenshots from the suggestion <span class="opt">(published on approve; remove any that should not be public)</span></label>' +
          shotThumbs(cur.shots, "ksug-shot-del").replace(/data-act="ksug-shot-del"/g, 'data-act="ksug-shot-del" data-sug="' + esc(id) + '"') + "</div>"
        : "";
      return meta + theirs + (state.shotsEnabled ? '<div class="field"><label>Add screenshots <span class="opt">(optional, added on approve, shown on the public page)</span></label>' + shotPicker(stageKey) + "</div>" : "");
    };
    showModal({
      title: "Suggestion: " + (s.problem || "known issue"),
      submit: "Approve & add to sheet", close: "Cancel",
      footExtra: '<button class="btn" data-act="known-sug-save" data-id="' + esc(id) + '">Save changes</button>' +
                 '<button class="btn ghost" data-act="known-sug-reject" data-id="' + esc(id) + '">Reject</button>',
      intro: introFn,
      initial: { category: knownLabel(s.category), entity: kiEnts(s).join("\n"), problem: s.problem || "", solution: s.solution || "", link: s.link || "", canned: s.canned || "" },
      fields: [
        { id: "category", label: "Category", type: "select", options: catLabels },
        { id: "entity", label: "Games / Application (one per line)", type: "textarea", placeholder: "Only for Games and Apps. Each line becomes its own row" },
        { id: "problem", label: "Problem", type: "text", required: true },
        { id: "solution", label: "Solution / Explanation", type: "textarea" },
        { id: "link", label: "Link (Jira)", type: "url" },
        { id: "canned", label: "Canned message", type: "textarea" }
      ],
      onSubmit: function (v) { approveKnownSuggestion(id, _ksValues(v)); }
    });
  }
  /* An "addition" suggestion: a canned message and/or screenshots for an EXISTING issue. Approve writes the
     canned message into that sheet row (known_issues_set_canned, never over a filled cell) and attaches the
     screenshots; Reject deletes it and its screenshots. */
  /* An "edit" suggestion: new Problem / Solution / Canned text for an EXISTING issue. The review shows
     what is there now and the proposed text (editable); Approve overwrites those cells of the sheet row. */
  var KI_EDIT_LABELS = { problem: "Problem", solution: "Solution / Explanation", canned: "Canned message" };
  function openKnownEditReview(s) {
    var id = s.id, ch = s.changes || {}, cur = s.current || {};
    var keys = ["problem", "solution", "canned"].filter(function (k) { return k in ch; });
    var intro = '<div class="section-note" style="margin-bottom:12px">Suggested by <b>' + esc(s.by || "someone") + "</b>" +
      (s.created_at ? DOT + esc(timeText(s.created_at) || "") : "") + "<br>For: <b>" + esc(knownLabel(s.category)) +
      (s.entity ? DOT + esc(s.entity) : "") + DOT + esc(s.problem || "") + "</b></div>" +
      keys.map(function (k) {
        return '<div class="field"><label>' + esc(KI_EDIT_LABELS[k]) + ' now</label><div class="ar-sub" style="white-space:pre-wrap">' + esc(cur[k] || "(empty)") + "</div></div>";
      }).join("");
    var initial = {}; keys.forEach(function (k) { initial[k] = ch[k]; });
    showModal({
      title: "Edit: " + (s.problem || "known issue"),
      submit: "Approve", close: "Cancel",
      footExtra: '<button class="btn ghost" data-act="known-sug-reject" data-id="' + esc(id) + '">Reject</button>',
      intro: intro, initial: initial,
      fields: keys.map(function (k) { return { id: k, label: KI_EDIT_LABELS[k] + " (proposed)", type: k === "problem" ? "text" : "textarea", required: k === "problem" }; }),
      onSubmit: function (v) { var set = {}; keys.forEach(function (k) { set[k] = (v[k] || "").trim(); }); approveKnownEdit(id, set); }
    });
  }
  function approveKnownEdit(id, set) {
    var s = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    set = set || s.changes || {};
    if (!Object.keys(set).length) { toast("Nothing to change"); return; }
    toast("Writing the change to the sheet…");
    enqueueAction("known_issues_update", { category: s.category, entity: s.entity || "", problem: s.problem || "", set: set }, function (r) {
      if (r && r.status === "done") {
        window.CONSOLE.del("/known-issues-suggestions/" + encodeURIComponent(id)).then(function () {}, function () {});
        D.knownSuggestions = (D.knownSuggestions || []).filter(function (x) { return x.id !== id; });
        closeModal(); refreshKnown(); render(); toast("Edit approved", "ok");
      } else toast("Not saved" + (r && r.error ? ": " + r.error : "") + ". The suggestion was kept.");
    });
  }
  function openKnownAdditionReview(s) {
    var id = s.id;
    var intro = function () {
      var cur = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0] || s;
      return '<div class="section-note" style="margin-bottom:12px">Suggested by <b>' + esc(cur.by || "someone") + "</b>" +
        (cur.created_at ? DOT + esc(timeText(cur.created_at) || "") : "") + "<br>For: <b>" + esc(knownLabel(cur.category)) +
        (cur.entity ? DOT + esc(cur.entity) : "") + DOT + esc(cur.problem || "") + "</b></div>" +
        ((cur.shots || []).length
          ? '<div class="field"><label>Screenshots <span class="opt">(added to the issue on approve; remove any that should not be public)</span></label>' +
            shotThumbs(cur.shots, "ksug-shot-del").replace(/data-act="ksug-shot-del"/g, 'data-act="ksug-shot-del" data-sug="' + esc(id) + '"') + "</div>"
          : "");
    };
    var hasCanned = !!String(s.canned || "").trim();
    showModal({
      title: "Addition: " + (s.problem || "known issue"),
      submit: "Approve", close: "Cancel",
      footExtra: (hasCanned ? '<button class="btn" data-act="known-sug-save" data-id="' + esc(id) + '">Save changes</button>' : "") +
                 '<button class="btn ghost" data-act="known-sug-reject" data-id="' + esc(id) + '">Reject</button>',
      intro: intro,
      initial: { canned: s.canned || "" },
      fields: hasCanned ? [{ id: "canned", label: "Canned message (written into the sheet row)", type: "textarea", required: true }] : [],
      onSubmit: function (v) { approveKnownAddition(id, hasCanned ? (v.canned || "").trim() : ""); }
    });
  }
  function approveKnownAddition(id, canned) {
    var s = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (canned == null) canned = String(s.canned || "").trim();
    var shots = (s.shots || []).length;
    if (!canned && !shots) { toast("Nothing to add: no canned message and no screenshots"); return; }
    function finish() {
      window.CONSOLE.del("/known-issues-suggestions/" + encodeURIComponent(id)).then(function () {}, function () {});
      D.knownSuggestions = (D.knownSuggestions || []).filter(function (x) { return x.id !== id; });
      closeModal(); refreshKnown(); render(); toast("Addition approved", "ok");
    }
    function doShots() {
      if (!shots) { finish(); return; }
      window.CONSOLE.post("/known-issues-suggestions/" + encodeURIComponent(id) + "/promote-shots",
        { category: s.category, problem: s.problem || "", entities: s.entity ? [s.entity] : [] })
        .then(function (r) { if (r && r.ok) finish(); else toast("Screenshots not added" + (r && r.error ? ": " + r.error : "")); },
              function () { toast("Screenshots not added; the suggestion was kept"); });
    }
    if (!canned) { doShots(); return; }
    toast("Writing the canned message to the sheet…");
    enqueueAction("known_issues_set_canned", { category: s.category, entity: s.entity || "", problem: s.problem || "", canned: canned }, function (r) {
      if (r && r.status === "done") doShots();
      else toast("Canned message not saved" + (r && r.error ? ": " + r.error : "") + ". The suggestion was kept.");
    });
  }
  /* Several games under one problem: "entity" text holds one game per line. */
  function kiEntList(txt) {
    var seen = {}, out = [];
    String(txt || "").split(/\r?\n/).forEach(function (s) { s = s.trim(); if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = 1; out.push(s); } });
    return out.slice(0, 20);
  }
  function kiEnts(s) { return (s.entities && s.entities.length) ? s.entities : (s.entity ? [s.entity] : []); }
  /* Write one sheet row per game (sequentially, the sheet inserts alphabetically); cb(ok, error). */
  function kiAddRows(p, cb) {
    var list = (p.entities && p.entities.length) ? p.entities.slice() : [p.entity || ""];
    (function next(i) {
      if (i >= list.length) { cb(true); return; }
      enqueueAction("known_issues_add", { category: p.category, entity: list[i], problem: p.problem || "", solution: p.solution || "", link: p.link || "", canned: p.canned || "" }, function (r) {
        if (r && r.status === "done") next(i + 1);
        else cb(false, (r && r.error ? r.error : "") + (i ? " (added " + i + " of " + list.length + ")" : ""));
      });
    })(0);
  }
  function _ksValues(v) {
    var cat = (KNOWN_TABS.filter(function (t) { return t[1] === v.category || t[0] === v.category; })[0] || [""])[0];
    var ents = kiEntList(v.entity);
    return { category: cat, entity: ents[0] || "", entities: ents, problem: (v.problem || "").trim(), solution: (v.solution || "").trim(),
             link: (v.link || "").trim(), canned: (v.canned || "").trim() };
  }
  function saveKnownSuggestion(id) {
    syncModalValues();
    var _sa = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0];
    if (_sa && _sa.kind === "addition") {
      var _c = String((state.modalValues || {}).canned || "").trim();
      if (!_c) { toast("Required: Canned message"); return; }
      window.CONSOLE.patch("/known-issues-suggestions/" + encodeURIComponent(id), { canned: _c }).then(function (r) {
        if (r && r.ok) { _sa.canned = _c; _sa.edited_by = myName(); closeModal(); render(); toast("Suggestion updated", "ok"); }
        else toast((r && r.error) || "Save failed");
      }, function () { toast("Save failed"); });
      return;
    }
    var vals = _ksValues(state.modalValues || {});
    if (!vals.problem) { toast("Required: Problem"); return; }
    var s = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0];
    window.CONSOLE.patch("/known-issues-suggestions/" + encodeURIComponent(id), vals).then(function (r) {
      if (r && r.ok) { if (s) { Object.assign(s, vals); s.edited_by = myName(); } closeModal(); render(); toast("Suggestion updated", "ok"); }
      else toast((r && r.error) || "Save failed");
    }, function () { toast("Save failed"); });
  }
  function approveKnownSuggestion(id, edited) {
    var s = (D.knownSuggestions || []).filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (s.kind === "addition") { approveKnownAddition(id); return; }
    if (s.kind === "edit") { approveKnownEdit(id); return; }
    if (edited) s = Object.assign({}, s, edited);
    toast("Adding to the sheet…");
    var ents = kiEnts(s);
    kiAddRows({ category: s.category, entity: ents[0] || "", entities: ents, problem: s.problem, solution: s.solution, link: s.link, canned: s.canned }, function (ok, err) {
      if (ok) {
        var _del = function () { window.CONSOLE.del("/known-issues-suggestions/" + encodeURIComponent(id)).then(function () {}, function () {}); };
        if ((s.shots || []).length) {
          window.CONSOLE.post("/known-issues-suggestions/" + encodeURIComponent(id) + "/promote-shots", { category: s.category, problem: s.problem || "", entities: ents })
            .then(function (r) { if (r && r.moved) refreshKnown(); _del(); }, function () { toast("Screenshots were not moved; the suggestion was kept"); });
        } else _del();
        D.knownSuggestions = (D.knownSuggestions || []).filter(function (x) { return x.id !== id; });
        refreshKnown(); render(); toast(ents.length > 1 ? "Approved & added for " + ents.length + " games" : "Approved & added to the sheet");
        if (shotStage("ki-sug-" + id).length) uploadStaged("ki-sug-" + id, "/known-issue-shots", { category: s.category, problem: s.problem || "", entities: JSON.stringify(ents) })
          .then(function (shots) { if (shots.length) { toast(shots.length === 1 ? "Screenshot added" : shots.length + " screenshots added", "ok"); refreshKnown(); } });
      } else toast("Add failed" + (err ? ": " + err : ""));
    });
  }
  function rejectKnownSuggestion(id) {
    window.CONSOLE.del("/known-issues-suggestions/" + encodeURIComponent(id)).then(function () {
      D.knownSuggestions = (D.knownSuggestions || []).filter(function (x) { return x.id !== id; });
      render(); toast("Suggestion rejected", "ok");
    }, function () { toast("Reject failed"); });
  }
  function adminSchedulePanel() {
    var sc = D.scheduleConfig || {};
    return panel("calendar", "Schedule", null,
      '<div class="section-note" style="margin-bottom:12px">Team schedule via a Google Apps Script web app (same idea as Known issues, on the schedule spreadsheet). Deploy the schedule bridge script, paste its /exec URL here, and set <span class="mono">SCHEDULE_SECRET</span> on the bot (or reuse KNOWN_ISSUES_SECRET). The bot mirrors every month tab; admins edit cells and create new months on the Schedule page.</div>' +
      '<div class="var-row"><label>Apps Script web-app URL</label><input class="f-input mono" data-sched-url value="' + esc(sc.webapp_url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="row-gap" style="margin-top:14px;gap:8px"><button class="btn primary" data-act="sched-config-save">' + ic("check", "ico-sm") + "Save</button>" +
      '<button class="btn ghost" data-act="sch-sync">' + ic("refresh", "ico-sm") + "Sync now</button></div>");
  }
  function adminGameCardsPanel() {
    var gc = D.gameCardsConfig || {};
    return panel("cards", "Game Cards", null,
      '<div class="section-note" style="margin-bottom:12px">Weekly game cards via a Google Apps Script web app on the cards spreadsheet. Deploy the game-cards bridge script, paste its /exec URL here, and set <span class="mono">GAME_CARDS_SECRET</span> on the bot (or reuse KNOWN_ISSUES_SECRET). Generation reuses the Steam generator; screenshots are bundled per card for download.</div>' +
      '<div class="var-row"><label>Apps Script web-app URL</label><input class="f-input mono" data-gc-url value="' + esc(gc.webapp_url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="row-gap" style="margin-top:14px;gap:8px"><button class="btn primary" data-act="gc-config-save">' + ic("check", "ico-sm") + "Save</button>" +
      '<button class="btn ghost" data-act="gc-sync">' + ic("refresh", "ico-sm") + "Sync now</button></div>");
  }
  function adminGameTestingPanel() {
    var gt = D.gameTestingConfig || {};
    return panel("gametest", "New Games Testing", null,
      '<div class="section-note" style="margin-bottom:12px">Weekly test sheet (tabs like <span class="mono">26/10 - 30/10</span>, Steam games on top, Xbox games below the empty gap). Deploy <span class="mono">game_testing_apps_script.gs</span> on the sheet, paste its /exec URL here, and set <span class="mono">GAME_TESTING_SECRET</span> on the bot. The bot reads the sheet every minute on Thursday and Friday.</div>' +
      '<div class="var-row"><label>Apps Script web-app URL</label><input class="f-input mono" data-gt-url value="' + esc(gt.webapp_url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="row-gap" style="margin-top:14px;gap:8px"><button class="btn primary" data-act="gt-config-save">' + ic("check", "ico-sm") + "Save</button>" +
      '<button class="btn ghost" data-act="gt-sync">' + ic("refresh", "ico-sm") + "Sync now</button></div>");
  }
  function adminMaintSheetPanel() {
    var mc = D.maintSheetConfig || {};
    return panel("wrench", "Maintenance sheet", null,
      '<div class="section-note" style="margin-bottom:12px">When a <b>game</b> maintenance starts, one row is appended to a Google Sheet (append-only - existing rows are never touched). General maintenance is logged as <b>All playgrounds</b>, Brazil as <b>Only for Brazil</b>. Deploy the maintenance bridge script on the sheet, paste its /exec URL below, and set <span class="mono">MAINTENANCE_SHEET_SECRET</span> on the bot (or reuse KNOWN_ISSUES_SECRET).</div>' +
      '<div class="var-row"><label>Apps Script web-app URL</label><input class="f-input mono" data-maint-url value="' + esc(mc.webapp_url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="row-gap" style="margin-top:14px;gap:8px"><button class="btn primary" data-act="maint-sheet-config-save">' + ic("check", "ico-sm") + "Save</button></div>");
  }
  /* Admin: Reddit "account flagged as a bot" alert. The bot watches for a sustained 401/403 streak
     from Reddit and pings the TG meeting group, tagging the chosen person. */
  function adminRedditFlagPanel() {
    var c = D.redditFlagAlert || {};
    var tag = String(c.tag == null ? "o.teleshko" : c.tag);
    var tagL = tag.toLowerCase(), matched = false;
    var opts = (D.team || []).map(function (m) {
      var em = String(m.email || ""), sel = !!tagL && (em.toLowerCase() === tagL || em.toLowerCase().split("@")[0] === tagL ||
        String(m.name || "").toLowerCase() === tagL || String(m.alias || "").toLowerCase() === tagL);
      if (sel) matched = true;
      return '<option value="' + esc(em) + '"' + (sel ? " selected" : "") + ">" + esc(m.name || em) + "</option>";
    }).join("");
    if (tag && !matched) opts = '<option value="' + esc(tag) + '" selected>' + esc(tag) + "</option>" + opts;
    opts = '<option value=""' + (tag ? "" : " selected") + ">On-shift CMs</option>" + opts;
    function num(key, label, val, step) {
      return '<div class="var-row"><label>' + esc(label) + "</label>" +
        '<input class="f-input" type="number" min="0" step="' + (step || "1") + '" data-rfa="' + key + '" value="' + esc(String(val)) + '" style="max-width:130px"></div>';
    }
    return panel("posts", "Reddit - flagged account alert", null,
      '<div class="section-note" style="margin-bottom:12px">When Reddit flags the bot account as a bot, every API call returns 401/403 until someone logs in and passes the "I\'m not a robot" check. If that lasts longer than the thresholds below, the bot posts an alert in the Telegram meeting group tagging the person chosen here (their Telegram must be linked in the console), repeats it while still broken, and posts a short note once Reddit works again. Changes apply within a minute.</div>' +
      '<label class="sched-day" style="gap:8px;margin-bottom:14px"><input type="checkbox" data-rfa="enabled"' + (c.enabled !== false ? " checked" : "") + "><span>Alert enabled</span></label>" +
      '<div class="stack" style="gap:12px">' +
      num("alert_minutes", "Alert after (min of continuous 401/403)", c.alert_minutes || 10) +
      num("min_errors", "Minimum failed calls", c.min_errors || 5) +
      num("realert_hours", "Repeat while still broken (hours)", c.realert_hours || 3, "0.25") +
      '<div class="var-row"><label>Tag in Telegram</label><select class="f-input" data-rfa="tag" style="max-width:260px">' + opts + "</select></div>" +
      "</div>" +
      '<button class="btn primary" data-act="reddit-flag-save" style="margin-top:14px">' + ic("check", "ico-sm") + "Save</button>");
  }
  /* Admin: leave policy (default allowance) + the approval queue and history for everyone's requests. */
  function adminLeavePanel() {
    var cfg = D.leaveConfig || {}, all = D.leaveAll || [];
    var pending = all.filter(function (r) { return r.status === "pending"; });
    var decided = all.filter(function (r) { return r.status !== "pending"; }).slice(0, 40);
    var cfgForm = '<div class="section-note" style="margin-bottom:10px">Default yearly allowance per person (override per user in Users → Leave). The bot uses these to compute remaining days.</div>' +
      '<div class="row-gap" style="gap:12px;flex-wrap:wrap;align-items:flex-end">' +
      '<label class="lv-cfg">Vacation days / year<input class="f-input" type="number" data-leave-vac value="' + esc(cfg.vac_total || 0) + '"></label>' +
      '<label class="lv-cfg">Sick days / year<input class="f-input" type="number" data-leave-sick value="' + esc(cfg.sick_total || 0) + '"></label>' +
      '<button class="btn primary" data-act="leave-config-save">' + ic("check", "ico-sm") + "Save policy</button></div>";
    var pendHtml = pending.length ? '<div class="leave-list" style="margin-top:8px">' + pending.map(function (r) { return leaveRowHtml(r, true); }).join("") + "</div>"
      : '<div class="f-hint">No pending requests.</div>';
    var histHtml = decided.length ? '<details class="lv-history"><summary>History (' + decided.length + ")</summary>" +
      '<div class="leave-list">' + decided.map(function (r) { return leaveRowHtml(r, true); }).join("") + "</div></details>" : "";
    return panel("calendar", "Leave requests", pending.length || null,
      cfgForm + '<div class="lv-sec-title">Pending approval</div>' + pendHtml + histHtml);
  }
  function viewActions() {
    // Quick actions as a responsive grid of tiles (icon + title + description) instead of a
    // cramped row of pill buttons - fills the page and reads at a glance.
    // Grouped by what the operator is doing, instead of one long grid.
    var GROUPS = [
      ["Tickets", "bolt", [
        ["create-urgent", "bolt", "Create Urgent Request", "URG ticket, chat link entered by hand", "act-create-urgent"],
        ["create-ticket", "plus", "Create Ticket", "SO ticket, chat link entered by hand", "act-create-ticket"],
        ["link-ticket", "jira", "Link Ticket", "Chat link and session info to an existing ticket", "act-link-ticket"],
        ["issue", "send", "Send Issue", "Log a custom issue to bot"]]],
      ["Users", "user", [
        ["search-email", "search", "Search User ID", "Find a user's ID by their social account"],
        ["add-email", "user", "Add User ID", "Tie a User ID to a social profile"],
        ["search-tickets", "discord", "Search Discord Tickets", "Look up a ticket by number or user"]]],
      ["Proposals", "plus", [
        ["gaming_proposal", "plus", "Add Gaming Proposal", "Send a game to the wishlist", "add-gaming-proposal"],
        ["proposal", "plus", "Add Proposal", "Feature, payment method, feedback…", "add-proposal"]]],
      ["Shift and reports", "notes", [
        ["testing", "gamepad", "Add Testing Session", "Record a test session to DB"],
        ["my-activity", "bolt", "My Activity", "Your tags & testing this shift/week"],
        ["report", "notes", "Send Report", "Send a shift summary"],
        ["weekly", "book", "Send Weekly Report", "Send the weekly team report"]]]
    ];
    function tile(t) {
      var act = t[4] || "modal";
      var extra = act === "modal" ? ' data-modal="' + t[0] + '"' : "";
      return '<button class="act-tile" data-act="' + act + '"' + extra + ">" +
        '<span class="ti">' + ic(t[1], "ico-sm") + "</span>" +
        '<span class="tmain"><span class="ttitle">' + esc(t[2]) + '</span><span class="tdesc">' + esc(t[3]) + "</span></span></button>";
    }
    var quick = GROUPS.map(function (g) {
      return '<div class="act-section-h">' + esc(g[0]) + '</div><div class="act-tiles">' + g[2].map(tile).join("") + "</div>";
    }).join("");

    var mine = D.reports.filter(function (r) { return r.author === D.me.name; });
    var reportRows = mine.map(function (r) {
      var summary = (r.fields[0] && r.fields[0][1]) || "";
      return '<div class="act-row" data-act="report-view" data-id="' + esc(r.id) + '" style="cursor:pointer">' +
        '<div class="ar-main"><div class="row-gap"><span class="chip soft" style="padding:1px 8px">' + (r.type === "weekly" ? "Weekly" : "Daily") + "</span>" +
        '<span class="truncate">' + esc(summary) + "</span></div></div>" +
        '<span class="ar-meta">' + esc(r.date) + "</span></div>";
    }).join("") || '<div class="ctx-empty">No reports sent yet.</div>';
    var reports = panel("notes", "My reports", mine.length,
      '<div class="act-list">' + reportRows + "</div>");

    return '<div class="page"><div class="page-head"><div><h1>Quick Actions</h1></div></div>' +
      '<div class="page-body">' + quick +
      '<div style="margin-top:22px">' + reports + "</div></div></div>";
  }

  /* ---------- Feedback tab (item Y): all submitted Suggestion/Bug items; admins set the status. */
  var FEEDBACK_STATUSES = ["New", "Review", "In Progress", "Done", "Can't add"];
  function feedbackNew() { return (D.feedback || []).filter(function (f) { return (f.status || "New") === "New"; }).length; }
  function viewFeedback() {
    var ql = state.q.toLowerCase();
    var fstat = state.feedbackStatus || "all";
    var list = (D.feedback || []).filter(function (f) {
      if (fstat !== "all" && (f.status || "New") !== fstat) return false;
      return !ql || (f.message + " " + f.category + " " + f.by).toLowerCase().indexOf(ql) >= 0;
    });
    // Sort by status priority (New first), keeping recency within each status (Array.sort is stable).
    var FB_ORDER = { "New": 0, "Review": 1, "In Progress": 2, "Done": 3, "Can't add": 4 };
    list.sort(function (a, b) { return (FB_ORDER[a.status] == null ? 9 : FB_ORDER[a.status]) - (FB_ORDER[b.status] == null ? 9 : FB_ORDER[b.status]); });
    var filterBar = '<div class="filters">' + [["all", "All"]].concat(FEEDBACK_STATUSES.map(function (s) { return [s, s]; }))
      .map(function (c) {
        var cnt = c[0] === "all" ? (D.feedback || []).length : (D.feedback || []).filter(function (f) { return (f.status || "New") === c[0]; }).length;
        return '<button class="filter' + (fstat === c[0] ? " active" : "") + '" data-act="filter" data-group="feedbackStatus" data-val="' + esc(c[0]) + '">' + esc(c[1]) + (cnt ? " (" + cnt + ")" : "") + "</button>";
      }).join("") + "</div>";
    var admin = isAdmin();
    var rows = list.map(function (f) {
      var statusCtrl = admin
        ? '<select class="mini-select status-select st ' + statusClass(f.status) + '" data-act="feedback-status" data-id="' + esc(f.id) + '">' +
            FEEDBACK_STATUSES.map(function (s) { return '<option value="' + esc(s) + '"' + (f.status === s ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select>"
        : '<span class="st ' + statusClass(f.status) + '">' + esc(f.status) + "</span>";
      /* The reply is shown once; an admin edits it with Edit on the reply itself (the reply box only
         stays open while there is no reply yet). */
      var editingReply = admin && state.fbReplyEdit === f.id;
      var replyBlock = (f.reply && !editingReply)
        ? '<div class="fb-reply"><div class="tgr-label">Reply' + (f.replyBy ? " | " + esc(f.replyBy) : "") + (f.replyAgo ? " | " + esc(f.replyAgo) : "") +
          (admin ? ' <button class="btn xs ghost fb-edit-btn" data-act="feedback-reply-edit" data-id="' + esc(f.id) + '" title="Edit the reply">' + ic("notes", "ico-sm") + "Edit</button>" : "") +
          "</div>" + esc(f.reply) + "</div>"
        : "";
      var replyCtrl = (admin && (!f.reply || editingReply))
        ? (editingReply
          ? '<div class="fb-edit" style="margin-top:8px"><textarea class="f-input" data-fb-reply="' + esc(f.id) + '" rows="3">' + esc(f.reply || "") + "</textarea>" +
            '<div class="row-gap" style="gap:8px;margin-top:8px"><button class="btn sm primary" data-act="feedback-reply" data-id="' + esc(f.id) + '">' + ic("check", "ico-sm") + "Save reply</button>" +
            '<button class="btn sm ghost" data-act="feedback-reply-cancel">Cancel</button></div></div>'
          : '<div class="note-add" style="margin-top:8px"><input class="f-input" data-fb-reply="' + esc(f.id) + '" placeholder="Reply to this feedback..."><button class="btn sm" data-act="feedback-reply" data-id="' + esc(f.id) + '">' + ic("reply", "ico-sm") + "Reply</button></div>")
        : "";
      return '<div class="fb-item"><div class="fb-item-top">' +
        '<span class="chip ' + (f.category === "Bug" ? "accent" : "soft") + '" style="padding:1px 9px">' + esc(f.category) + "</span>" +
        statusCtrl + "</div>" +
        (state.fbEdit === f.id
          ? '<div class="fb-edit"><textarea class="f-input" data-fb-edit="' + esc(f.id) + '" rows="3">' + esc(f.message) + "</textarea>" +
            '<div class="row-gap" style="gap:8px;margin-top:8px"><button class="btn sm primary" data-act="feedback-edit-save" data-id="' + esc(f.id) + '">' + ic("check", "ico-sm") + "Save</button>" +
            '<button class="btn sm ghost" data-act="feedback-edit-cancel">Cancel</button></div></div>'
          : '<div class="fb-msg">' + esc(f.message) + "</div>") +
        shotThumbs(f.shots) +
        ((state.shotsEnabled && fbMine(f) && f.status !== "Done" && (f.shots || []).length < 3)
          ? '<label class="btn xs ghost shot-add" style="margin-top:6px">' + ic("plus", "ico-sm") + "Add screenshot" +
            '<input type="file" accept="' + SHOT_ACCEPT + '" hidden data-fb-shot="' + esc(f.id) + '"></label>' : "") +
        '<div class="nfoot">' + esc(f.by || "Someone") + DOT + esc(f.ago) + (f.edited ? DOT + "edited" : "") +
          ((state.fbEdit !== f.id && fbMine(f)) ? ' <button class="btn xs ghost fb-edit-btn" data-act="feedback-edit" data-id="' + esc(f.id) + '" title="Edit this feedback">' + ic("notes", "ico-sm") + "Edit</button>" : "") + "</div>" +
        replyBlock + replyCtrl + "</div>";
    }).join("") || emptyState("star", "No feedback yet", "Send a suggestion or a bug report with the button in the bottom-right corner.");
    return '<div class="page"><div class="page-head"><div><h1>Feedback</h1></div><span class="count-pill">' + list.length + "</span></div>" +
      '<div class="page-body">' + filterBar +
      '<div class="stack" style="gap:12px">' + rows + "</div></div></div>";
  }
  /* ---------- Events (Boosteroid admin-service events from Mattermost) ---------- */
  // Filter tabs. "Games" holds both added and removed games.
  var EVENT_CATS = [
    { key: "",            label: "All" },
    { key: "games",       label: "Games" },
    { key: "game_card",   label: "Game cards" },
    { key: "maintenance", label: "Maintenance" },
    { key: "regional",    label: "Regional" },
    { key: "server",      label: "Servers" }
  ];
  var EVENT_TAB = { new_game: "games", removed: "games", game_card: "game_card", maintenance: "maintenance", regional: "regional", server: "server" };
  function loadEvents() {
    state._eventsAt = Date.now();
    return window.CONSOLE.get("/events").then(function (list) {
      if (Array.isArray(list)) D.events = list;
    }, function () {});
  }
  function fmtSpan(secs) {   // finished maintenance length: "45m", "3h 05m", "2d 4h"
    var m = Math.max(0, Math.round((secs || 0) / 60));
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60); m = m % 60;
    if (h < 24) return h + "h " + (m < 10 ? "0" : "") + m + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  }
  // What the card shows for an event: tone (colour), icon, the action badge, the subject and one line.
  function eventLook(e) {
    var subj = e.game || e.server || "";
    var where = e.region ? " in " + e.region : "";
    switch (e.category) {
      case "new_game":  return { tone: "teal", icon: "gamepad", badge: "New game", subj: subj, line: "" };
      case "game_card": return { tone: "info", icon: "cards",   badge: "New card", subj: subj, line: "" };
      case "maintenance":
      case "regional":
      case "server":
        var srv = e.category === "server";
        if (e.kind === "start") return { tone: "danger", icon: srv ? "server" : "wrench", badge: srv ? "Server down" : "Maintenance",
          subj: subj, line: "" };
        if (e.kind === "end") return { tone: "success", icon: srv ? "server" : "wrench", badge: srv ? "Server up" : "Back online",
          subj: subj, line: "" };
        return { tone: "amber", icon: "server", badge: "Status", subj: subj, line: e.text };
      case "removed": return { tone: "muted", icon: "x", badge: "Removed", subj: subj, line: "" };
      case "status":
        return { tone: e.status_to === "disabled" ? "muted" : "amber", icon: "gamepad",
          badge: e.status_to === "disabled" ? "Disabled" : "Status", subj: subj, line: "" };
      case "bulk": return { tone: "amber", icon: "bolt", badge: "Bulk update", subj: "", line: e.text };
      default:     return { tone: "muted", icon: "bell", badge: "Other", subj: "", line: eventBody(e) };
    }
  }
  // Unrecognised event: show the message body (the stored title is often just "WARNING").
  var EV_NOISE = /^(INFO|WARNING|WARN|ERROR|CRITICAL|DEBUG|Boostore|Streaming|AdminID:.*|AdminEmail:.*|.*admin\.cloud\.boosteroid\.com.*)$/i;
  function eventBody(e) {
    var lines = String(e.raw || e.text || "").split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !EV_NOISE.test(l); });
    return lines.join("\n") || e.text || "";
  }
  /* ---------- Wishlist (our own, written by the bot: services/wishlist_store.py) ----------
     Games requested from Discord, Slack, Telegram and the console, with a status per game
     (open / problematic / rejected / added) and the Monday summaries of past weeks. */
  var WL_TABS = [
    { key: "", label: "All" },
    { key: "open", label: "Open" },
    { key: "problematic", label: "Problematic" },
    { key: "rejected", label: "Rejected" },
    { key: "added", label: "Added" }
  ];
  var WL_SORTS = [
    { key: "total", label: "Most requested" },
    { key: "week", label: "This week" },
    { key: "last", label: "Last request" },
    { key: "first", label: "Newest game" }
  ];
  var WL_TONE = { open: "info", problematic: "amber", rejected: "danger", added: "success" };
  var WL_LABEL = { open: "Open", problematic: "Problematic", rejected: "Rejected", added: "Added" };
  var WL_SOURCE = { discord: "Discord", slack: "Slack", console: "Console", telegram: "Telegram", legacy: "Before" };
  function loadWishlist() {
    state._wlAt = Date.now();
    return Promise.all([
      window.CONSOLE.get("/wishlist").then(function (d) {
        if (d && Array.isArray(d.games)) { D.wishlist = d.games; D.wishlistWeekStart = d.week_start; }
      }, function () {}),
      window.CONSOLE.get("/wishlist/weekly").then(function (list) {
        if (Array.isArray(list)) D.wishlistWeekly = list;
      }, function () {})
    ]);
  }
  function loadWishlistRequests(key) {
    state.wlReq = state.wlReq || {};
    state.wlReq[key] = { loading: true };
    window.CONSOLE.get("/wishlist/requests?key=" + encodeURIComponent(key)).then(function (d) {
      state.wlReq[key] = d || { requests: [] };
      if (parseHash().view === "wishlist") render();
    }, function () { state.wlReq[key] = { error: true }; if (parseHash().view === "wishlist") render(); });
  }
  function wlStatusChip(s) {
    return '<span class="ev-type t-' + (WL_TONE[s] || "muted") + '">' + esc(WL_LABEL[s] || s || "-") + "</span>";
  }
  function wlDay(v) {
    var d = _utcDate(v); if (!d) return "";
    var p = _kyivParts(d); return p ? p.day + " " + _MON[parseInt(p.month, 10) - 1] : "";
  }
  function wlWeekLabel(w) {
    var a = _utcDate(w.week_start), b = _utcDate(w.week_end);
    if (!a || !b) return w.week || "";
    return wlDay(a) + " - " + wlDay(new Date(b.getTime() - 1));
  }
  function viewWishlist() {
    if (Date.now() - (state._wlAt || 0) > 60000) loadWishlist().then(function () {
      if (parseHash().view === "wishlist") render();
    });
    var all = D.wishlist;
    if (!all) return '<div class="page"><div class="page-head"><div><h1>Wishlist</h1></div></div><div class="page-body">' + skeletonRows(8) + "</div></div>";
    var tab = state.wlTab || "", sort = state.wlSort || "total", ql = (state.q || "").toLowerCase().trim();
    var weekReq = 0, weekNew = 0, weekStart = _utcDate(D.wishlistWeekStart), counts = { "": all.length };
    all.forEach(function (g) {
      weekReq += g.week || 0;
      var f = _utcDate(g.first_requested_at);
      if (f && weekStart && f >= weekStart) weekNew++;
      counts[g.status || "open"] = (counts[g.status || "open"] || 0) + 1;
    });
    function tile(tone, label, n, sub) {
      return '<div class="ev-tl' + (n ? " on t-" + tone : "") + '"><div class="ev-tl-label">' + esc(label) + "</div>" +
        '<div class="ev-tl-num">' + n + "</div>" + (sub ? '<div class="ev-tl-row"><span class="ev-tl-name">' + esc(sub) + "</span></div>" : "") + "</div>";
    }
    var tiles = '<div class="ev-tiles">' +
      tile("teal", "Requests this week", weekReq, "Since Monday") +
      tile("teal", "New games this week", weekNew, "") +
      tile("amber", "Problematic", counts.problematic || 0, "Cannot add for now") + "</div>";

    // Monday summaries
    var weeks = D.wishlistWeekly || [];
    var wOpen = state.wlWeekOpen;
    var weekly = weeks.length ? '<div class="wl-weeks">' + weeks.slice(0, 8).map(function (w, i) {
      var isOpen = wOpen ? wOpen === w.week : i === 0;
      var head = '<button class="wl-week-h" data-act="wl-week" data-week="' + esc(w.week) + '">' +
        '<span class="wl-week-l">' + esc(wlWeekLabel(w)) + "</span>" +
        '<span class="ev-det">' + (w.requests || 0) + " requests<span class=\"ev-sep\">|</span>" + (w.games || 0) +
        " games<span class=\"ev-sep\">|</span>" + (w.new_games || 0) + " new</span></button>";
      if (!isOpen) return '<div class="wl-week">' + head + "</div>";
      var src = Object.keys(w.by_source || {}).map(function (k) { return (WL_SOURCE[k] || k) + " " + w.by_source[k]; }).join(", ");
      var top = (w.top || []).map(function (t, n) {
        return '<li><span class="wl-top-n">' + (n + 1) + ".</span> " + esc(t.title) + ' <span class="muted">(' + esc(t.platform) + ")</span>" +
          ' <span class="ev-det">' + t.requests + " this week, " + t.total + " total</span>" + (t.status && t.status !== "open" ? " " + wlStatusChip(t.status) : "") + "</li>";
      }).join("");
      var prob = (w.problematic || []).length ? '<div class="ev-det">Requested but problematic: ' +
        w.problematic.map(function (p) { return esc(p.title) + " (" + esc(p.platform) + ") x" + p.requests; }).join(", ") + "</div>" : "";
      return '<div class="wl-week on">' + head + '<div class="wl-week-b">' +
        (w.requests ? (src ? '<div class="ev-det">By source: ' + esc(src) + "</div>" : "") + (top ? '<ol class="wl-top">' + top + "</ol>" : "") + prob
                    : '<div class="ev-none">No requests that week.</div>') + "</div></div>";
    }).join("") + "</div>" : '<div class="ev-none">The first summary appears on Monday morning for the week before.</div>';

    var tabs = '<div class="ev-nav">' + WL_TABS.map(function (t) {
      return '<button class="ev-nav-b' + (t.key === tab ? " on" : "") + '" data-act="wl-tab" data-tab="' + esc(t.key) + '">' +
        esc(t.label) + ' <span class="ev-nav-n">' + (counts[t.key] || 0) + "</span></button>";
    }).join("") + '</div><div class="wl-sort"><span class="ev-det">Sort by</span>' + WL_SORTS.map(function (s) {
      return '<button class="ev-nav-b' + (s.key === sort ? " on" : "") + '" data-act="wl-sort" data-sort="' + s.key + '">' + esc(s.label) + "</button>";
    }).join("") + "</div>";

    function ts(v) { var d = _utcDate(v); return d ? d.getTime() : 0; }
    var list = all.filter(function (g) {
      if (tab && (g.status || "open") !== tab) return false;
      if (!ql) return true;
      return [g.title, g.platform, g.status_note].join(" ").toLowerCase().indexOf(ql) >= 0;
    });
    list.sort(function (a, b) {
      if (sort === "week") return (b.week || 0) - (a.week || 0) || (b.requests || 0) - (a.requests || 0);
      if (sort === "last") return ts(b.last_requested_at) - ts(a.last_requested_at);
      if (sort === "first") return ts(b.first_requested_at) - ts(a.first_requested_at);
      return (b.requests || 0) - (a.requests || 0) || ts(b.last_requested_at) - ts(a.last_requested_at);
    });
    var open = state.wlOpen || {};
    var canEdit = can("wishlist");
    var rows = list.slice(0, 500).map(function (g) {
      var st = g.status || "open";
      var head = '<div class="ev-tr wl-tr" data-act="wl-toggle" data-key="' + esc(g.key) + '">' +
        '<div class="ev-td ev-name">' + esc(g.title) + (g.status_note && st !== "open" ? '<div class="ev-det wl-note">' + esc(g.status_note) + "</div>" : "") + "</div>" +
        '<div class="ev-td">' + esc(g.platform || "") + "</div>" +
        '<div class="ev-td wl-num">' + (g.requests || 0) + "</div>" +
        '<div class="ev-td wl-num">' + (g.week ? "+" + g.week : '<span class="muted">0</span>') + "</div>" +
        '<div class="ev-td ev-time">' + esc(g.last_requested_at ? fmtKyivShort(g.last_requested_at) : "") + '<span class="ev-ago2">' + esc(g.last_requested_at ? agoFrom(g.last_requested_at) : "") + "</span></div>" +
        '<div class="ev-td">' + wlStatusChip(st) + "</div></div>";
      if (!open[g.key]) return head;
      var btns = !canEdit ? "" : '<div class="wl-acts">' + [
        st !== "problematic" ? ["problematic", "Mark problematic"] : null,
        st !== "rejected" ? ["rejected", "Reject"] : null,
        st !== "added" ? ["added", "Mark added"] : null,
        st !== "open" ? ["open", "Reopen"] : null
      ].filter(Boolean).map(function (b) {
        return '<button class="btn sm' + (b[0] === "problematic" ? " primary" : " ghost") + '" data-act="wl-status" data-key="' + esc(g.key) + '" data-status="' + b[0] + '">' + esc(b[1]) + "</button>";
      }).join("") + "</div>";
      var src = Object.keys(g.by_source || {}).map(function (k) { return (WL_SOURCE[k] || k) + " " + g.by_source[k]; }).join(", ");
      var info = '<div class="ev-det">First request ' + esc(g.first_requested_at ? fmtDT(g.first_requested_at) : "unknown") +
        (src ? '<span class="ev-sep">|</span>' + esc(src) : "") +
        (g.status_by ? '<span class="ev-sep">|</span>' + esc(WL_LABEL[st] || st) + " by " + esc(g.status_by) + (g.status_at ? ", " + esc(fmtDT(g.status_at)) : "") : "") + "</div>";
      var rq = (state.wlReq || {})[g.key];
      var hist;
      if (!rq || rq.loading) hist = '<div class="ev-none">Loading requests…</div>';
      else if (rq.error) hist = '<div class="ev-none">Could not load the requests.</div>';
      else {
        hist = (rq.requests || []).map(function (r) {
          var who = r.requestor || r.author || "-";
          return '<div class="wl-req"><span class="ev-type t-muted">' + esc(WL_SOURCE[r.source] || r.source || "") + "</span>" +
            '<span class="wl-req-who">' + esc(who) + (r.author && r.requestor ? ' <span class="muted">via ' + esc(r.author) + "</span>" : "") + "</span>" +
            (r.url ? '<a class="wl-req-link" href="' + esc(r.url) + '" target="_blank" rel="noopener">link</a>' : "<span></span>") +
            '<span class="ev-time">' + esc(r.created_at ? fmtDT(r.created_at) : "") + "</span></div>";
        }).join("") || '<div class="ev-none">Requests from before this list only have a total count.</div>';
        var sh = (rq.status_history || []).map(function (h) {
          return '<div class="wl-req">' + wlStatusChip(h.status) + '<span class="wl-req-who">' + esc(h.by || "-") + (h.note ? ': <span class="muted">' + esc(h.note) + "</span>" : "") + "</span>" +
            '<span class="ev-time">' + esc(h.at ? fmtDT(h.at) : "") + "</span></div>";
        }).join("");
        if (sh) hist += '<div class="ev-h2 wl-h3">Status changes</div>' + sh;
      }
      return head + '<div class="ban-detail wl-detail">' + info + btns + '<div class="ev-h2 wl-h3">Requests</div>' + hist + "</div>";
    }).join("");
    var table = list.length
      ? '<div class="ev-table"><div class="ev-tr ev-th wl-tr" style="cursor:default"><div class="ev-td">Game</div><div class="ev-td">Platform</div>' +
        '<div class="ev-td wl-num">Requests</div><div class="ev-td wl-num">This week</div><div class="ev-td">Last request</div><div class="ev-td">Status</div></div>' + rows + "</div>" +
        (list.length > 500 ? '<div class="ev-none">Showing 500 of ' + list.length + ". Use search to narrow down.</div>" : "")
      : emptyState("wishlist", all.length ? "Nothing matches" : "No wishlist requests yet", all.length ? "Try another search or filter." : "Requests from Discord, Slack and the console show up here.");
    return '<div class="page"><div class="page-head"><div><h1>Wishlist</h1></div>' +
      '<div><button class="btn primary sm" data-act="add-gaming-proposal">' + ic("plus", "ico-sm") + "Add game</button></div></div>" +
      '<div class="page-body"><div class="ev-h2">This week</div><div class="ev-sub">Search with the box at the top: game, platform or status note.</div>' +
      tiles + '<div class="ev-h2">Weekly summaries</div>' + weekly +
      '<div class="ev-h2">Games</div>' + tabs + table + "</div></div>";
  }
  function openWishlistStatus(key, status) {
    var g = (D.wishlist || []).filter(function (x) { return x.key === key; })[0];
    if (!g) return;
    function send(note) {
      enqueueAction("wishlist_set_status", { key: key, status: status, note: note || "" }, function (r) {
        if (r && r.status === "done") {
          g.status = status; g.status_note = status === "open" ? "" : (note || "");
          g.status_by = (r.result && r.result.status_by) || g.status_by; g.status_at = new Date().toISOString();
          if (state.wlReq) delete state.wlReq[key];
          if (state.wlOpen && state.wlOpen[key]) loadWishlistRequests(key);
          toast(g.title + ": " + (WL_LABEL[status] || status), "ok"); render();
        } else toast("Status change failed" + (r && r.error ? ": " + r.error : ""));
      });
    }
    if (status === "open" || status === "added") { send(""); return; }
    showModal({
      title: (status === "problematic" ? "Mark problematic: " : "Reject: ") + g.title,
      submit: status === "problematic" ? "Mark problematic" : "Reject", close: "Cancel",
      fields: [{ id: "note", label: status === "problematic" ? "Why we cannot add it" : "Why we will not add it", type: "textarea", required: true,
                 placeholder: status === "problematic" ? "e.g. publisher does not allow cloud, anti-cheat, waiting for the license" : "e.g. not available for cloud gaming" }],
      onSubmit: function (v) { send((v.note || "").trim()); }
    });
  }
  /* ---------- Bans (Telegram ban channel, written by the bot's bans_tracker) ---------- */
  var BAN_TABS = [
    { key: "", label: "All" },
    { key: "critical", label: "Critical" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "pending", label: "User ID pending" }
  ];
  function loadBans() {
    state._bansAt = Date.now();
    return window.CONSOLE.get("/bans").then(function (list) {
      if (Array.isArray(list)) D.bans = list;
    }, function () {});
  }
  function banSevTone(sev) {
    var s = String(sev || "").toLowerCase();
    return s === "critical" ? "danger" : s === "high" ? "amber" : s === "medium" ? "info" : "muted";
  }
  function viewBans() {
    if (Date.now() - (state._bansAt || 0) > 60000) loadBans().then(function () {
      if (parseHash().view === "bans") render();
    });
    var all = D.bans || [];
    var tab = state.bansTab || "", ql = (state.q || "").toLowerCase().trim();
    function ts(b) { var d = _utcDate(b.posted_at); return d ? d.getTime() : 0; }
    var dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    var monday = new Date(dayStart.getTime()); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    var today = all.filter(function (b) { return ts(b) >= dayStart.getTime(); });
    var week = all.filter(function (b) { return ts(b) >= monday.getTime(); });
    var critWeek = week.filter(function (b) { return String(b.severity).toLowerCase() === "critical"; });
    var pending = all.filter(function (b) { return b.email_pending; });
    function tile(tone, label, n, sub) {
      return '<div class="ev-tl' + (n ? " on t-" + tone : "") + '"><div class="ev-tl-label">' + esc(label) + "</div>" +
        '<div class="ev-tl-num">' + n + "</div>" + (sub ? '<div class="ev-tl-row"><span class="ev-tl-name">' + esc(sub) + "</span></div>" : "") + "</div>";
    }
    var tiles = '<div class="ev-tiles">' +
      tile("danger", "Banned today", today.length, "") +
      tile("danger", "Banned this week", week.length, "Since Monday") +
      tile("amber", "Critical this week", critWeek.length, "") + "</div>";
    var counts = { "": all.length, pending: pending.length };
    all.forEach(function (b) { var k = String(b.severity || "").toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
    var tabs = '<div class="ev-nav">' + BAN_TABS.filter(function (t) { return !t.key || counts[t.key]; }).map(function (t) {
      return '<button class="ev-nav-b' + (t.key === tab ? " on" : "") + '" data-act="bans-tab" data-tab="' + esc(t.key) + '">' +
        esc(t.label) + ' <span class="ev-nav-n">' + (counts[t.key] || 0) + "</span></button>";
    }).join("") + "</div>";
    var list = all.filter(function (b) {
      if (tab === "pending" ? !b.email_pending : (tab && String(b.severity).toLowerCase() !== tab)) return false;
      if (!ql) return true;
      var hay = [b.user_id, b.reason, (b.warned_by || []).join(" "), (b.sessions || []).join(" ")]
        .concat((b.warns || []).map(function (w) { return w.details; })).join(" ").toLowerCase();
      return hay.indexOf(ql) >= 0;
    });
    function when(v) {
      var d = _utcDate(v);
      return d ? d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    }
    var open = state.banOpen || {};
    var rows = list.slice(0, 500).map(function (b) {
      var user = b.user_id
        ? '<a class="mono" href="' + esc(adminSessionsUrl(b.user_id)) + '" target="_blank" rel="noopener">' + esc(b.user_id) + "</a>"
        : '<span class="muted">User ID pending</span>';
      var head = '<div class="ev-tr ban-tr" data-act="ban-toggle" data-id="' + esc(b.id) + '">' +
        '<div class="ev-td">' + user + "</div>" +
        '<div class="ev-td"><span class="ev-type t-' + banSevTone(b.severity) + '">' + esc(b.severity || "-") + "</span></div>" +
        '<div class="ev-td ev-name">' + esc(b.reason || "") + "</div>" +
        '<div class="ev-td ev-det">' + (b.warns || []).length + " warn" + ((b.warns || []).length === 1 ? "" : "s") +
          '<span class="ev-sep">|</span>' + esc((b.warned_by || []).join(", ")) + "</div>" +
        '<div class="ev-td ev-time">' + esc(when(b.posted_at)) + '<span class="ev-ago2">' + esc(agoFrom(b.posted_at)) + "</span></div></div>";
      if (!open[b.id]) return head;
      var warns = (b.warns || []).map(function (w) {
        return '<div class="ban-warn"><span class="ev-type t-' + banSevTone(w.severity) + '">' + esc(w.severity || "-") + "</span>" +
          '<div class="ban-warn-body"><div class="ev-name">' + esc(w.details || "") + "</div>" +
          '<div class="ev-det">' + esc(w.date || "") + '<span class="ev-sep">|</span>by ' + esc(w.warned_by || "-") +
          (w.session ? '<span class="ev-sep">|</span>Session <span class="mono">' + esc(w.session) + '</span> <button class="gcs-link" data-act="copy-text" data-text="' + esc(w.session) + '">copy</button>' : "") +
          "</div></div></div>";
      }).join("");
      return head + '<div class="ban-detail">' + (warns || '<div class="ev-none">No warns listed.</div>') + "</div>";
    }).join("");
    var table = list.length
      ? '<div class="ev-table"><div class="ev-tr ev-th ban-tr" style="cursor:default"><div class="ev-td">User ID</div><div class="ev-td">Severity</div>' +
        '<div class="ev-td">Reason</div><div class="ev-td">Warns</div><div class="ev-td">Banned</div></div>' + rows + "</div>" +
        (list.length > 500 ? '<div class="ev-none">Showing the newest 500 of ' + list.length + ". Use search to narrow down.</div>" : "")
      : emptyState("shield", all.length ? "Nothing matches" : "No bans yet", all.length ? "Try another search or filter." : "Bans from the Telegram ban channel show up here.");
    return '<div class="page"><div class="page-head"><div><h1>Bans</h1></div></div>' +
      '<div class="page-body"><div class="ev-h2">Overview</div><div class="ev-sub">Search with the box at the top: User ID, session, reason or who warned.</div>' +
      tiles + tabs + table + "</div></div>";
  }

  var MAINT_CATS = { maintenance: 1, regional: 1, server: 1 };
  function viewEvents() {
    // Refresh at most once a minute while the tab is open.
    if (Date.now() - (state._eventsAt || 0) > 60000) loadEvents().then(function () {
      if (parseHash().view === "events") render();
    });
    var cat = state.eventsCat || "", ql = (state.q || "").toLowerCase();
    // Only the event kinds we care about (other admin-service messages are not shown).
    var all = (D.events || []).filter(function (e) { return EVENT_TAB[e.category]; });
    var counts = {}; all.forEach(function (e) { var t = EVENT_TAB[e.category]; counts[t] = (counts[t] || 0) + 1; });
    var ongoing = all.filter(function (e) { return e.kind === "start" && !e.ended_at; });
    var list = all.filter(function (e) {
      return (!cat || EVENT_TAB[e.category] === cat) &&
        (!ql || (String(e.text || "") + " " + (e.game || "") + " " + (e.server || "")).toLowerCase().indexOf(ql) >= 0);
    });

    // ---- Overview tiles: in maintenance now, servers down, removed / added in the last 7 days ----
    // (a removed game that came back, or an added game that was removed again, drops off)
    var weekAgo = Date.now() - 7 * 86400000;
    function ts(e) { var t = _utcDate(e.created_at); return t ? t.getTime() : 0; }
    function laterOf(e, category) {
      return all.some(function (x) { return x.category === category && String(x.game_id) === String(e.game_id) && ts(x) > ts(e); });
    }
    var seenGone = {};
    var gone = all.filter(function (e) {
      if (e.category !== "removed" || ts(e) < weekAgo || laterOf(e, "new_game")) return false;
      var k = e.game_id != null ? "id:" + e.game_id : "n:" + String(e.game || "").toLowerCase();
      if (seenGone[k]) return false;
      seenGone[k] = true; return true;
    });
    // Added: this calendar week (Monday 00:00 local time onwards), one row per game (latest add wins).
    var monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    var seenAdd = {};
    var added = all.filter(function (e) {
      if (e.category !== "new_game" || ts(e) < monday.getTime() || laterOf(e, "removed")) return false;
      var k = e.game_id != null ? "id:" + e.game_id : "n:" + String(e.game || "").toLowerCase();
      if (seenAdd[k]) return false;   // list is newest-first, so the first one seen is the latest
      seenAdd[k] = true; return true;
    });
    function timerOf(e) {
      var s = ts(e); return '<span class="ev-timer mono" data-start="' + s + '">' + esc(fmtDuration(Date.now() - s)) + "</span>";
    }
    function agoOf(e) { return esc(agoFrom(e.created_at)) + " ago"; }
    function tile(tone, label, items, right) {
      var MAX = 5;
      var rows = items.slice(0, MAX).map(function (e) {
        var name = (e.game || e.server || "") + (e.region ? " | " + e.region : "");
        return '<div class="ev-tl-row"><span class="ev-tl-name" title="' + esc(name) + '">' + esc(name) + '</span><span class="ev-tl-t">' + right(e) + "</span></div>";
      }).join("");
      if (items.length > MAX) rows += '<div class="ev-tl-more">+' + (items.length - MAX) + " more</div>";
      return '<div class="ev-tl' + (items.length ? " on t-" + tone : "") + '"><div class="ev-tl-label">' + esc(label) + "</div>" +
        '<div class="ev-tl-num">' + items.length + "</div>" + (rows ? '<div class="ev-tl-list">' + rows + "</div>" : "") + "</div>";
    }
    var tiles = '<div class="ev-tiles">' +
      tile("danger", "Games in maintenance", ongoing.filter(function (e) { return e.category !== "server"; }), timerOf) +
      tile("danger", "Servers down", ongoing.filter(function (e) { return e.category === "server"; }), timerOf) +
      tile("danger", "Removed this week", gone, agoOf) +
      tile("teal", "Added this week", added, agoOf) + "</div>";

    // ---- Plain text tabs (admin style) ----
    var tabs = '<div class="ev-nav">' + EVENT_CATS.filter(function (c) { return !c.key || counts[c.key]; }).map(function (c) {
      var n = c.key ? counts[c.key] : all.length;
      return '<button class="ev-nav-b' + (c.key === cat ? " on" : "") + '" data-act="events-cat" data-cat="' + esc(c.key) + '">' +
        esc(c.label) + ' <span class="ev-nav-n">' + n + "</span></button>";
    }).join("") + "</div>";

    // ---- Events table ----
    function fmtWhen(v) {
      var x = _utcDate(v);
      return x ? x.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    }
    function row(e) {
      var L = eventLook(e), d = _utcDate(e.created_at);
      // A finished maintenance is one row (its end event) with the start - end span.
      var when = (e.kind === "end" && e.started_at) ? esc(fmtWhen(e.started_at)) + " &ndash; " + esc(fmtWhen(e.created_at)) : esc(fmtWhen(e.created_at));
      var det = [];
      if (e.region) det.push(esc(e.region));
      if (e.status_from && e.status_to) det.push(esc(e.status_from) + " &rarr; " + esc(e.status_to));
      if (e.game_id) det.push("ID " + esc(e.game_id));
      var dur = "";
      if (e.duration_s != null) dur = esc(fmtSpan(e.duration_s));
      else if (e.kind === "start" && d) dur = '<span class="ev-live-t"><span class="ev-timer mono" data-start="' + d.getTime() + '">' + esc(fmtDuration(Date.now() - d.getTime())) + "</span></span>";
      return '<div class="ev-tr">' +
        '<div class="ev-td"><span class="ev-type t-' + L.tone + '">' + esc(L.badge) + "</span></div>" +
        '<div class="ev-td ev-name">' + esc(L.subj || L.line || "") + "</div>" +
        '<div class="ev-td ev-det">' + det.join('<span class="ev-sep">|</span>') + "</div>" +
        '<div class="ev-td ev-dur2">' + dur + "</div>" +
        '<div class="ev-td ev-time">' + when + '<span class="ev-ago2">' + esc(agoFrom(e.created_at)) + "</span></div></div>";
    }
    function table(arr, hint) {
      if (!arr.length) return '<div class="ev-none">' + esc(hint) + "</div>";
      return '<div class="ev-table ev-log"><div class="ev-tr ev-th"><div class="ev-td">Event</div><div class="ev-td">Name</div>' +
        '<div class="ev-td">Details</div><div class="ev-td">Duration</div><div class="ev-td">Time</div></div>' + arr.map(row).join("") + "</div>";
    }
    var body;
    if (MAINT_CATS[cat]) {
      // Maintenance / Regional / Servers: Active (started, not ended) and Finished (one row per
      // maintenance: its end, with the duration). Starts that already ended are not repeated.
      var active = list.filter(function (e) { return e.kind === "start" && !e.ended_at; });
      var done = list.filter(function (e) { return e.kind === "end"; });
      var other = list.filter(function (e) { return e.kind !== "start" && e.kind !== "end"; });
      body = '<div class="ev-sec">Active <span class="ev-nav-n">' + active.length + "</span></div>" + table(active, "Nothing in maintenance right now.") +
        '<div class="ev-sec">Finished</div>' + table(done.concat(other), "No finished maintenances yet.");
    } else {
      body = list.length ? table(list, "") : emptyState("server", "No events yet", "Game, maintenance and server events from the admin service show up here.");
    }
    return '<div class="page"><div class="page-head"><div><h1>Events</h1></div></div>' +
      '<div class="page-body"><div class="ev-h2">Overview</div><div class="ev-sub">Added: since Monday. Removed: last 7 days. Times in your timezone.</div>' + tiles + tabs + body + "</div></div>";
  }

  function setFeedbackStatus(id, status) {
    var f = (D.feedback || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (f) f.status = status;
    if (f && status === "Done") f.shots = [];   // the server deletes a Done feedback's screenshots
    window.CONSOLE.patch("/feedback/" + encodeURIComponent(id), { status: status }).then(function () {}, function () { toast("Update failed"); });
    render(); toast("Status: " + status);
  }
  function fbMine(f) {
    var me = (state.user && state.user.email) || "";
    return !!me && !!f.byEmail && f.byEmail.toLowerCase() === me.toLowerCase();
  }
  function saveFeedbackEdit(id, message) {
    if (!message) { toast("Message is required"); return; }
    var f = (D.feedback || []).filter(function (x) { return String(x.id) === String(id); })[0];
    function applyLocal() { if (f) { f.message = message; f.edited = true; } state.fbEdit = null; render(); toast("Feedback updated"); }
    window.CONSOLE.patch("/feedback/" + encodeURIComponent(id), { message: message }).then(applyLocal, function () { toast("Update failed"); });
  }
  function setFeedbackReply(id, reply) {
    var f = (D.feedback || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!reply) { toast("Write a reply first"); return; }
    function applyLocal() { if (f) { f.reply = reply; f.replyBy = myName(); f.replyAgo = "now"; } state.fbReplyEdit = null; render(); toast("Reply saved"); }
    window.CONSOLE.patch("/feedback/" + encodeURIComponent(id), { reply: reply }).then(applyLocal, function () { toast("Update failed"); });
  }

  /* ---------- modal engine (Actions forms, Slack-parity) ---------- */
  var MODALS = {
    "testing": modalTesting, "add-email": modalAddEmail, "issue": modalIssue,
    "my-activity": modalMyActivity,
    "report": modalReport, "weekly": modalWeekly,
    "search-email": modalSearchEmail, "search-tickets": modalSearchTickets,
    "create-user": modalCreateUser, "create-tpl": modalCreateTpl
  };
  var L1_TAG_OPTIONS = ["native_desktop", "native_android", "webclient", "web_tv", "game", "launcher", "subscription", "stream", "web_backend", "tbd"];
  /* Change a ticket's status via Jira transitions (fetched live, since they depend on current status). */
  function openJiraStatus(key) {
    window.CONSOLE.get("/jira-transitions/" + encodeURIComponent(key)).then(function (d) {
      var ts = (d && d.transitions) || [];
      if (!ts.length) { toast("No transitions available"); return; }
      showModal({ title: "Change status", close: "Close", custom: function () {
        return ts.map(function (t) {
          return '<button class="btn" style="width:100%;justify-content:flex-start;margin-bottom:6px" data-act="jira-do-transition" data-key="' + esc(key) + '" data-tid="' + esc(t.id) + '">' +
            esc(t.name) + (t.to ? ' <span class="muted" style="margin-left:6px">-> ' + esc(t.to) + "</span>" : "") + "</button>";
        }).join("");
      } });
    }, function () { toast("Could not load transitions"); });
  }
  function doJiraTransition(btn) {
    var key = btn.getAttribute("data-key"), tid = btn.getAttribute("data-tid");
    closeModal();
    window.CONSOLE.post("/jira-transition", { key: key, transition_id: tid }).then(function (d) {
      if (d && d.ok) { var j = jiraByKey(key); if (j && d.status) j.status = d.status; render(); toast("Status changed" + (d.status ? " to " + d.status : "")); }
      else toast("Status change failed" + (d && d.error ? ": " + d.error : ""));
    }, function () { toast("Status change failed"); });
  }
  function postJiraComment(btn) {
    var key = btn.getAttribute("data-key");
    var pane = btn.closest(".pane"), ta = pane && pane.querySelector("[data-jira-comment]");
    var val = ta && ta.value.trim(); if (!val) { if (ta) ta.focus(); return; }
    window.CONSOLE.post("/jira-comment", { key: key, text: val }).then(function (d) {
      if (d && d.ok) {
        var j = jiraByKey(key);
        if (j) {
          j.comments = j.comments || []; j.comments.push({ author: (state.user && state.user.name) || "You", bodyHtml: esc(val), created: "now" });
          j.cm_awaiting_reply = false;   // we just replied -> drop it from Monitor (V4)
        }
        render(); toast("Comment posted");
      } else toast("Comment failed" + (d && d.error ? ": " + d.error : ""));
    }, function () { toast("Comment failed"); });
  }

  /* ---------- Jira edit: content, comments, fields, attachments ---------- */
  /* An "Attach image / video" row bound to a textarea (by id). The hidden file input uploads to
     the issue and the returned wiki markup is inserted at the cursor. Reused by the description
     editor, the comment editor, and the new-comment composer. */
  function jiraAttachBar(targetId, key) {
    return '<div class="row-gap" style="margin-top:8px;gap:8px;flex-wrap:wrap">' +
      '<input type="file" accept="image/*,video/*" style="display:none" id="file-' + targetId + '" data-act="jira-file" data-target="' + targetId + '" data-key="' + esc(key) + '">' +
      '<button type="button" class="btn sm ghost" data-act="jira-attach-trigger" data-for="file-' + targetId + '">' + ic("plus", "ico-sm") + "Attach image / video</button>" +
      '<span class="muted" id="att-status-' + targetId + '" style="font-size:12px;align-self:center"></span></div>';
  }
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    var pos = s + text.length; ta.selectionStart = ta.selectionEnd = pos;
  }
  function jiraFileChosen(input) {
    var file = input.files && input.files[0]; if (!file) return;
    var targetId = input.getAttribute("data-target"), key = input.getAttribute("data-key");
    var statusEl = document.getElementById("att-status-" + targetId);
    if (statusEl) statusEl.textContent = "Uploading " + file.name + "…";
    var fd = new FormData(); fd.append("key", key); fd.append("file", file);
    window.CONSOLE.upload("/jira-attach", fd).then(function (d) {
      if (d && d.ok) {
        var ta = document.getElementById(targetId);
        if (ta) { insertAtCursor(ta, (ta.value && !/\s$/.test(ta.value) ? "\n" : "") + d.markup + "\n"); ta.focus(); }
        if (statusEl) statusEl.textContent = "Attached " + d.filename + (d.is_image ? " (inline image)" : " (file link)");
      } else if (statusEl) statusEl.textContent = "Upload failed" + (d && d.error ? ": " + d.error : "");
      input.value = "";
    }, function () { if (statusEl) statusEl.textContent = "Upload failed"; input.value = ""; });
  }
  /* Edit summary + description (custom modal so an attach bar can sit inside it). */
  function openJiraEdit(key) {
    var j = jiraByKey(key); if (!j) return;
    if (j.descriptionRaw == null) { ensureJira(j); }
    showModal({ title: "Edit ticket " + key, close: "Cancel", custom: function () {
      return '<div class="field"><label>Summary</label>' +
        '<input class="f-input" id="jira-edit-summary" value="' + esc(j.summary || "") + '"></div>' +
        '<div class="field"><label>Description <span class="opt">(Jira wiki markup)</span></label>' +
        '<textarea class="f-input" id="jira-edit-desc" style="min-height:170px">' + esc(j.descriptionRaw || "") + "</textarea></div>" +
        jiraAttachBar("jira-edit-desc", key) +
        '<div class="row-gap" style="margin-top:14px"><div class="spacer"></div>' +
        '<button class="btn primary" data-act="jira-edit-save" data-key="' + esc(key) + '">' + ic("check", "ico-sm") + "Save changes</button></div>";
    } });
  }
  function saveJiraEdit(btn) {
    var key = btn.getAttribute("data-key");
    var s = document.getElementById("jira-edit-summary"), d = document.getElementById("jira-edit-desc");
    var summary = s ? s.value.trim() : "", desc = d ? d.value : "";
    if (!summary) { toast("Summary cannot be empty", "ok"); return; }
    closeModal();
    window.CONSOLE.post("/jira-issue-edit", { key: key, summary: summary, description: desc }).then(function (r) {
      if (r && r.ok) {
        var j = jiraByKey(key);
        if (j) { j.summary = summary; j.descriptionRaw = desc; j._jiraLoaded = false; ensureJira(j); }
        toast("Ticket updated");
      } else toast("Update failed" + (r && r.error ? ": " + r.error : ""));
    }, function () { toast("Update failed"); });
  }
  /* Edit Communication Link + L1 tags (standard fields modal, prefilled from the ticket). */
  function openJiraFields(key) {
    var j = jiraByKey(key); if (!j) return;
    showModal({ title: "Edit fields - " + key, submit: "Save", close: "Cancel",
      initial: { communication_link: j.communication_link || "", l1_tags: (j.l1_tags || []).slice() },
      onSubmit: function (v) {
        window.CONSOLE.post("/jira-fields", { key: key, communication_link: v.communication_link || "", l1_tags: v.l1_tags || [] }).then(function (r) {
          if (r && r.ok) { var jj = jiraByKey(key); if (jj) { jj.communication_link = v.communication_link || ""; jj.l1_tags = v.l1_tags || []; } render(); toast("Fields updated"); }
          else toast("Update failed" + (r && r.error ? ": " + r.error : ""));
        }, function () { toast("Update failed"); });
      },
      fields: [
        { id: "communication_link", label: "Communication Link", type: "text", placeholder: "Reddit / Facebook / Discord, or a conversation URL" },
        { id: "l1_tags", label: "L1 Tags", type: "multiselect", options: L1_TAG_OPTIONS }
      ] });
  }
  /* Edit an existing (bot-authored) comment. */
  function openJiraCommentEdit(key, cid) {
    var j = jiraByKey(key); if (!j) return;
    var c = (j.comments || []).filter(function (x) { return String(x.id) === String(cid); })[0];
    if (!c) return;
    showModal({ title: "Edit comment", close: "Cancel", custom: function () {
      return '<div class="field"><label>Comment <span class="opt">(Jira wiki markup)</span></label>' +
        '<textarea class="f-input" id="jira-cedit-ta" style="min-height:150px">' + esc(c.bodyRaw || "") + "</textarea></div>" +
        jiraAttachBar("jira-cedit-ta", key) +
        '<div class="row-gap" style="margin-top:14px"><div class="spacer"></div>' +
        '<button class="btn primary" data-act="jira-cedit-save" data-key="' + esc(key) + '" data-cid="' + esc(cid) + '">' + ic("check", "ico-sm") + "Save</button></div>";
    } });
  }
  function saveJiraCommentEdit(btn) {
    var key = btn.getAttribute("data-key"), cid = btn.getAttribute("data-cid");
    var ta = document.getElementById("jira-cedit-ta"); var val = ta ? ta.value.trim() : "";
    if (!val) { toast("Comment cannot be empty", "ok"); return; }
    closeModal();
    window.CONSOLE.post("/jira-comment-edit", { key: key, comment_id: cid, text: val }).then(function (r) {
      if (r && r.ok) { var j = jiraByKey(key); if (j) { j._jiraLoaded = false; ensureJira(j); } toast("Comment updated"); }
      else toast("Update failed" + (r && r.error ? ": " + r.error : ""));
    }, function () { toast("Update failed"); });
  }

  /* Testing Session picker: the signed-in member's last sessions from the cloud admin (via the bot,
     action "cloud_sessions"). Ticking one writes its "ID: / Application:" block into the Session Info
     box, so the rest of the form and the saved record are exactly what a manual paste produces. */
  /* Session lists come from the cloud admin through the bot. One request per user per hour: the answer
     is kept here (and on the bot), so reopening a form costs nothing; the Refresh button asks again. */
  var SESS_TTL = 3600000, _sessCache = {};
  function sessCached(key) { var c = _sessCache[key]; return c && Date.now() - c.at < SESS_TTL ? c : null; }
  function sessAge(key) { var c = _sessCache[key]; return c ? timeText(new Date(c.at).toISOString()) : ""; }
  /* Launcher of a session's game (Game List "Platform"), so GTA V on Steam / Epic / Xbox can be told apart. */
  var LAUNCHER_NAMES = { steam: "Steam", epic: "Epic", "epic games": "Epic", xbox: "Xbox", gog: "GOG", ubisoft: "Ubisoft", "ubisoft connect": "Ubisoft", ea: "EA app", "ea app": "EA app", origin: "EA app", "battle.net": "Battle.net", battlenet: "Battle.net", rockstar: "Rockstar", microsoft: "Microsoft Store" };
  function launcherName(x) {
    var p = String((x && x.launcher) || "").trim(); if (!p) return "";
    return LAUNCHER_NAMES[p.toLowerCase()] || (p.charAt(0).toUpperCase() + p.slice(1));
  }
  function launcherChip(x) {
    var n = launcherName(x); if (!n) return "";
    var tail = "(" + n.toLowerCase() + ")", t = String(x.application || "").trim().toLowerCase();
    if (t.slice(-tail.length) === tail) return "";   // title already says it, e.g. "Forza Horizon 5 (Xbox)"
    return '<span class="ts-launcher">' + esc(n) + "</span>";
  }
  function sessFetch(key, payload, force, ok, fail) {
    var c = !force && sessCached(key);
    if (c) { ok(c.items); return; }
    if (force) payload.force = true;
    window.CONSOLE.postMsg("/actions", { type: "cloud_sessions", payload: payload }).then(function (res) {
      if (res.status < 200 || res.status >= 300 || !res.data || !res.data.id) { fail(res.data && res.data.error); return; }
      busyInc();
      pollAction(res.data.id, function (a) {
        if (a.status !== "done") { fail(a.error); return; }
        var items = (a.result && a.result.sessions) || [];
        _sessCache[key] = { at: Date.now(), items: items };
        ok(items);
      }, 0);
    }, function () { fail("Could not reach the server"); });
  }
  function sessRefreshBtn(act, key) {
    return ' <button type="button" class="btn sm ghost" data-act="' + act + '" title="Ask the cloud admin again' + (sessAge(key) ? " (loaded " + esc(sessAge(key)) + ")" : "") + '" style="margin-left:6px">' + ic("refresh", "ico-sm") + "Refresh</button>";
  }
  var _ts = { state: "idle", items: [], error: "", at: 0 };
  function tsBlock(x) {
    return "ID: " + x.session_id + "\nApplication: " + (x.application || "Unknown") +
      (x.application_id != null && !/^Application #/.test(x.application || "") ? " [ID: " + x.application_id + "]" : "");
  }
  function tsPicked(x) { return String(state.modalValues.session || "").indexOf("ID: " + x.session_id) >= 0; }
  function tsRerender() {
    if (!state.modal || state.modal._key !== "testing") return;
    syncModalValues(); renderModal();
  }
  function tsLoad(force) {
    if (_ts.state === "loading") return;
    var c = !force && sessCached("me");
    if (c) { _ts.items = c.items; _ts.state = "ready"; tsRerender(); return; }
    _ts.state = "loading"; _ts.error = "";
    tsRerender();
    sessFetch("me", { mine: true }, !!force, function (items) { _ts.items = items; _ts.state = "ready"; tsRerender(); },
      function (msg) { _ts.state = "error"; _ts.error = msg || "Could not load your sessions"; tsRerender(); });
  }
  function tsPick(btn) {
    var x = _ts.items[+btn.getAttribute("data-i")]; if (!x) return;
    syncModalValues();
    var cur = String(state.modalValues.session || ""), block = tsBlock(x);
    if (tsPicked(x)) {
      // Drop this session's block (from its "ID:" line to the next blank line), keep everything else.
      var blocks = cur.split(/\n\s*\n/).filter(function (b) { return b.indexOf("ID: " + x.session_id) < 0; });
      cur = blocks.join("\n\n").trim();
    } else {
      cur = (cur.trim() ? cur.trim() + "\n\n" : "") + block;
    }
    state.modalValues.session = cur;
    renderModal();
  }
  function tsDuration(sec) {
    sec = +sec || 0; if (!sec) return "";
    var m = Math.round(sec / 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min";
  }
  function tsIntro() {
    var inner;
    if (_ts.state === "loading") inner = '<div class="f-hint">Loading your last sessions...</div>';
    else if (_ts.state === "error") inner = '<div class="f-hint">' + esc(_ts.error) + '</div><button type="button" class="btn sm" data-act="ts-load">Try again</button>';
    else if (_ts.state === "ready" && !_ts.items.length) inner = '<div class="f-hint">No sessions in the last 30 days.</div>';
    else if (_ts.state === "ready") inner = '<div class="ts-list">' + _ts.items.map(function (x, i) {
      var on = tsPicked(x), bits = [x.playground, timeText(x.started_at || x.created_at), tsDuration(x.length)].filter(Boolean);
      return '<button type="button" class="ts-row' + (on ? " on" : "") + '" data-act="ts-pick" data-i="' + i + '" aria-pressed="' + (on ? "true" : "false") + '">' +
        '<span class="ts-check">' + (on ? ic("check", "ico-sm") : "") + "</span>" +
        '<span class="ts-main"><span class="ts-title"><b class="truncate">' + esc(x.application || "Unknown") + "</b>" + launcherChip(x) + "</span>" +
        '<span class="ts-sub truncate">' + esc(bits.join(" | ")) + "</span></span></button>";
    }).join("") + "</div>";
    else inner = '<button type="button" class="btn sm" data-act="ts-load">Load my last sessions</button>';
    return '<div class="field"><label>My recent sessions <span class="opt">(tick to add)</span>' + (_ts.state === "ready" ? sessRefreshBtn("ts-load", "me") : "") + "</label>" + inner + "</div>";
  }
  function modalTesting() {
    setTimeout(function () { tsLoad(false); }, 0);
    return { _key: "testing", title: "Add Testing Session", submit: "Submit", close: "Close", intro: tsIntro,
      onSubmit: function (v) {
        // Save to the shared testing_sessions store in the Slack schema (one doc per pasted
        // session). NO Slack post - like the Slack flow, the only side effect is the DB write; the
        // 08:00 daily report picks these up. (Removed the old "report" action that spammed the
        // Slack reports channel with a "Testing session - <name>" card per submission.)
        window.CONSOLE.postMsg("/testing", { session: v.session, ticket_url: v.ticket_url, environment: v.environment, issue: v.issue, result: v.result, tags: v.testing_tags || [] }).then(function (res) {
          if (res.status >= 200 && res.status < 300) {
            var n = (res.data && res.data.count) || 0;
            toast(n > 1 ? (n + " testing sessions saved") : "Testing session saved");
          } else {
            // Surface the server's own reason instead of a generic "Save failed".
            toast((res.data && res.data.error) || (res.status === 400 ? "Check the session format: each needs an ID: line and an Application: line" : "Save failed"), "error");
          }
        }, function () { toast("Save failed (network error)", "error"); });
      },
      fields: [
        { id: "session", label: "Session Info", type: "textarea", required: true,
          placeholder: "ID: 03d7005e-a318-4eb6-9230-3a060fc10bb1\nApplication: Crimson Desert\n\nID: 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d\nApplication: Other Game",
          hint: 'Each session is two lines (ID: and Application:). Separate multiple sessions with a blank line. Prefixes must be exact: "ID:" and "Application:"' },
        { id: "ticket_url", label: "Ticket URL", type: "url", placeholder: "Enter ticket URL" },
        { id: "environment", label: "Environment", type: "select", required: true, placeholder: "Environment", options: ["Prod", "Testing"] },
        { id: "issue", label: "Issue", type: "select", required: true, placeholder: "Issue", options: ["Yes", "No"], controls: true },
        { id: "result", label: "Result", type: "text", placeholder: "Result", showWhen: { field: "issue", value: "Yes" } },
        { id: "testing_tags", label: "Issue tags", type: "multiselect", placeholder: "Issue Tags", options: D.testingTags, showWhen: { field: "issue", value: "Yes" } }
      ] };
  }
  /* Edit a saved testing session: the same form as Add Testing Session, prefilled (the Slack Edit button
     runs the same server function, services/testing_sessions.py). */
  function openEditTesting(id) {
    var s = ((_myAct.data && _myAct.data.testing) || []).filter(function (x) { return x.id === id; })[0];
    if (!s) { toast("This session is no longer in the list"); return; }
    var spec = modalTesting();
    spec.title = "Edit Testing Session"; spec.submit = "Save"; spec._key = "testing-edit"; delete spec.intro;
    spec.initial = { session: "ID: " + s.session_id + "\nApplication: " + s.game, ticket_url: s.ticket_url || "",
      environment: s.environment || "", issue: s.issue || "", result: s.result || "", testing_tags: (s.tags || []).slice() };
    spec.fields[0].hint = "One session: the ID: line and the Application: line.";
    spec.onSubmit = function (v) {
      window.CONSOLE.postMsg("/testing/" + encodeURIComponent(id), { session: v.session, ticket_url: v.ticket_url, environment: v.environment,
        issue: v.issue, result: v.issue === "Yes" ? v.result : "", tags: v.issue === "Yes" ? (v.testing_tags || []) : [] }, "PATCH").then(function (res) {
        if (res.status === 200) { toast("Testing session updated"); _myAct.data = null; }
        else toast((res.data && res.data.error) || "Update failed", "error");
      }, function () { toast("Update failed (network error)", "error"); });
    };
    showModal(spec);
  }
  /* Add / Edit User ID for a social profile. Takes the ID itself, or an email that is looked up once
     through the cloud admin; only the ID is saved, the address is never stored. */
  function modalAddEmail() {
    return { title: "Add User ID", submit: "Save", close: "Cancel",
      onSubmit: function (v) {
        var raw = String(v.user_ref || "").trim(), url = String(v.profile_url || "").trim();
        if (/^\d{1,12}$/.test(raw)) { saveUserId(url, raw); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) { toast("Enter a User ID (digits) or the user's email", "error"); return; }
        toast("Looking up the User ID...");
        enqueueAction("cloud_user_lookup", { email: raw.toLowerCase() }, function (a) {
          var uid = a.status === "done" && a.result && a.result.user_id ? String(a.result.user_id) : "";
          if (!uid) { toast(a.error ? "User ID not found: " + a.error : "No account with this email", "error"); return; }
          saveUserId(url, uid);
        });
      },
      fields: [
        { id: "user_ref", label: "User ID or email", type: "text", required: true, placeholder: "9444330 or user@example.com", hint: "An email is only used to find the User ID. It is not saved." },
        { id: "profile_url", label: "Profile URL", type: "text", required: true, placeholder: "discord.com/users/... | reddit.com/user/... | facebook.com/..." }
      ] };
  }
  function modalIssue() {
    return { title: "Send custom issue", submit: "Submit", close: "Cancel",
      onSubmit: function (v) {
        window.CONSOLE.post("/custom-issue", {
            issue_url: v.issue_url, user_id: String(v.user_id || "").replace(/\D/g, ""), facebook_name: v.facebook_name,
            tags: v.tags || [], ticket_url: v.ticket_url, platform: v.platform
          }).then(function () { toast("Issue submitted"); },
             function (s) { toast(s === 400 ? "Issue URL and at least one tag are required" : "Submit failed"); });
      },
      fields: [
        { id: "issue_url", label: "Issue URL", type: "url", required: true, placeholder: "Enter issue URL" },
        { id: "user_id", label: "User ID", type: "text", placeholder: "9444330" },
        { id: "facebook_name", label: "Facebook Name (only for Facebook platform)", type: "text", placeholder: "e.g. Vitor Santos" },
        { id: "tags", label: "Tags", type: "multiselect", required: true, placeholder: "Select tags", options: D.issueTags },
        { id: "ticket_url", label: "Ticket URL", type: "url", placeholder: "Enter ticket URL" },
        { id: "platform", label: "Platform", type: "select", required: true, placeholder: "Select platform", options: ["Facebook", "Discord", "Telegram", "Reddit"] }
      ] };
  }
  /* ---------- My Activity (Quick Actions) ----------
     The signed-in user's own tags + testing sessions, bucketed into their current shift, previous
     shift and this week (Mon-Sun). Fetched once from /my-activity (last 8 days, covers all three
     windows) and cached briefly; the same cache feeds the Send Report modal so it shows the current
     shift's work in full. */
  var _myAct = { data: null, at: 0, loading: false };
  function loadMyActivity(force, cb) {
    cb = cb || function () {};
    if (!force && _myAct.data && (Date.now() - _myAct.at < 45000)) return cb(_myAct.data);
    if (_myAct.loading) return;                      // a fetch is already in flight; its cb re-renders
    _myAct.loading = true;
    window.CONSOLE.get("/my-activity").then(function (d) {
      _myAct.loading = false;
      _myAct.data = { tags: (d && d.tags) || [], testing: (d && d.testing) || [] };
      _myAct.at = Date.now();
      cb(_myAct.data);
    }, function () { _myAct.loading = false; cb(_myAct.data || { tags: [], testing: [] }); });
  }
  /* Recent on-shift windows [{start,end} ms], most-recent first, derived the same relative-to-now
     way as shiftWindowStart (no timezone math). Only windows that have already started are returned;
     an in-progress shift's end is clamped to now. */
  function recentShiftWindows() {
    var u = state.user; if (!u) return [];
    var sched = (u.schedule && typeof u.schedule === "object") ? u.schedule : defaultSchedule();
    var kp = _kyivParts(new Date()); if (!kp) return [];
    var todayIdx = (new Date(Date.UTC(+kp.year, +kp.month - 1, +kp.day)).getUTCDay() + 6) % 7;
    var nowMin = (+kp.hour) * 60 + (+kp.minute), now = Date.now(), out = [];
    for (var back = 0; back <= 8; back++) {
      var s = sched[_SCHED_ORDER[((todayIdx - back) % 7 + 7) % 7]];
      if (!s || !s.on) continue;
      var st = _tmin(_hhmm(s.start)), en = _tmin(_hhmm(s.end)), overnight = en <= st;
      var startTs = now - (back * 1440 + (nowMin - st)) * 60000;
      if (startTs > now) continue;                   // shift hasn't started yet today
      var endTs = now - (back * 1440 + (nowMin - (overnight ? en + 1440 : en))) * 60000;
      out.push({ start: startTs, end: Math.min(endTs, now) });
    }
    out.sort(function (a, b) { return b.start - a.start; });
    return out;
  }
  /* [start,end] ms for one of the three My Activity windows. */
  function myActWindow(which) {
    var wins = recentShiftWindows();
    if (which === "current") return wins[0] || null;
    if (which === "prev") return wins[1] || null;
    var kp = _kyivParts(new Date()); if (!kp) return null;   // week: since the most recent Monday 00:00 Kyiv
    var todayIdx = (new Date(Date.UTC(+kp.year, +kp.month - 1, +kp.day)).getUTCDay() + 6) % 7;
    var nowMin = (+kp.hour) * 60 + (+kp.minute);
    return { start: Date.now() - (todayIdx * 1440 + nowMin) * 60000, end: Date.now() };
  }
  /* Bucket the cached activity into a window; {tags:[...], testing:{total,problems,problematic,ok}}. */
  function myActBucket(win) {
    var data = _myAct.data || { tags: [], testing: [] };
    function inWin(iso) {
      if (!win) return false;
      var d = _utcDate(iso); if (!d) return false;
      var t = d.getTime(); return t >= win.start && t <= win.end;
    }
    var tags = data.tags.filter(function (x) { return inWin(x.at); });
    var ts = data.testing.filter(function (x) { return inWin(x.at); });
    var problematic = ts.filter(function (x) { return x.issue === "Yes"; });
    return { tags: tags, testing: { total: ts.length, problems: problematic.length, problematic: problematic, ok: ts.length - problematic.length, all: ts } };
  }
  var _MA_WHERE = { reddit_post: "Reddit post", reddit_modmail: "Reddit ModMail", discord_ticket: "Discord ticket",
                    discord_mention: "Discord mention", facebook_post: "Facebook", telegram: "Telegram" };
  function _prettyWhere(w) {
    w = w || "";
    if (_MA_WHERE[w]) return _MA_WHERE[w];
    return w ? w.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : "-";
  }
  /* Render one window's tags + testing breakdown (used by the modal AND the Send Report intro). */
  function myActSummaryHtml(win, editable) {
    var b = myActBucket(win);
    var tagHtml = b.tags.length
      ? b.tags.map(function (t) {
          var where = _prettyWhere(t.where);
          var loc = t.url
            ? '<a class="ma-link" href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(where) + "</a>"
            : '<span class="muted">' + esc(where) + "</span>";
          return '<div class="ma-tag-row"><span class="chip soft">' + esc(t.tag) + "</span>" +
            '<span class="ma-where">' + loc + "</span>" +
            '<span class="ma-ago">' + esc(timeText(t.at)) + "</span></div>";
        }).join("")
      : '<div class="ctx-empty">No tags added in this window.</div>';
    var ts = b.testing;
    var probHtml = ts.problematic.map(function (s) {
      return '<div class="ma-prob"><div class="ma-prob-top"><span class="mono truncate">' + esc(s.game || s.session_id) + "</span>" +
        '<span class="chip accent" style="padding:1px 8px">Issue</span></div>' +
        (s.result ? '<div class="ma-prob-body">' + esc(s.result) + "</div>" : "") +
        ((s.tags && s.tags.length) ? '<div class="row-gap" style="margin-top:5px">' + s.tags.map(function (tg) { return '<span class="chip soft">' + esc(tg) + "</span>"; }).join("") + "</div>" : "") +
        "</div>";
    }).join("");
    var testHtml = '<div class="ma-test-stat">' +
      '<span class="ma-stat"><b>' + ts.total + "</b> session" + (ts.total === 1 ? "" : "s") + "</span>" +
      '<span class="ma-stat"><b>' + ts.problems + "</b> with issue</span>" +
      '<span class="ma-stat"><b>' + ts.ok + "</b> clean</span></div>" + probHtml +
      (editable && ts.all.length ? '<div class="ma-list" style="margin-top:8px">' + ts.all.map(function (s) {
        return '<div class="ma-tag-row"><span class="mono truncate">' + esc(s.game || "") + "</span>" +
          '<span class="muted mono truncate" style="font-size:11px">' + esc(String(s.session_id || "").slice(0, 8)) + "</span>" +
          '<button class="btn sm ghost" data-act="testing-edit" data-id="' + esc(s.id || "") + '">Edit</button></div>';
      }).join("") + "</div>" : "");
    return '<div class="ma-sec"><div class="ma-sec-h">' + ic("tag", "ico-sm") + "Tags added <span class='muted'>(" + b.tags.length + ")</span></div>" +
      '<div class="ma-list">' + tagHtml + "</div></div>" +
      '<div class="ma-sec"><div class="ma-sec-h">' + ic("gamepad", "ico-sm") + "Testing sessions</div>" + testHtml + "</div>";
  }
  var _MA_TABS = [["current", "Current shift"], ["prev", "Previous shift"], ["week", "This week"]];
  function myActBodyHtml() {
    if (!_myAct.data) return '<div class="ctx-empty" style="padding:26px">Loading your activity…</div>';
    var tab = state._myActTab || "current";
    var tabsHtml = _MA_TABS.map(function (kv) {
      return '<button class="ma-tab' + (tab === kv[0] ? " on" : "") + '" data-act="myact-tab" data-tab="' + kv[0] + '">' + kv[1] + "</button>";
    }).join("");
    var win = myActWindow(tab);
    var range = win
      ? (fmtKyivShort(new Date(win.start)) + " - " + (win.end >= Date.now() - 60000 ? "now" : fmtKyivShort(new Date(win.end))))
      : (tab === "prev" ? "no previous shift found" : "no shift found");
    return '<div class="ma-tabs">' + tabsHtml + "</div>" +
      '<div class="ma-range">' + esc(range) + "</div>" +
      '<div class="ma-scroll">' + myActSummaryHtml(win, true) + "</div>";
  }
  function modalMyActivity() {
    state._myActTab = "current";
    loadMyActivity(true, function () { if (state.modal && state.modal._key === "my-activity") renderModal(); });
    return { _key: "my-activity", title: "My Activity", close: "Close", custom: myActBodyHtml };
  }
  /* Send Report intro: the current shift's My Activity (tags + testing, full, scrollable) above the
     generic shift-activity feed, so the operator can transcribe it into the report fields. */
  function reportIntroHtml() {
    var maHtml = (!_myAct.data)
      ? '<div class="ctx-empty">Loading your shift activity…</div>'
      : myActSummaryHtml(myActWindow("current"));
    return '<div class="shift-activity"><div class="sa-head">' + ic("bolt", "ico-sm") +
      "Your current shift <span class='muted'>(for the report below)</span></div>" +
      '<div class="ma-scroll ma-in-report">' + maHtml + "</div></div>" + shiftActivityHtml();
  }
  /* A read-only summary of what the signed-in user did during their current shift (from the shared
     activity feed, scoped to the shift window). Shown atop the daily report so they can see and
     transcribe everything - posts answered, tickets linked/created, ModMail replies, tags, transfers. */
  function shiftActivityHtml() {
    var sws = shiftWindowStart(), me = myName();
    var acts = (D.activity || []).filter(function (a) {
      if ((a.user || "") !== me) return false;
      if (!sws) return true;
      var d = _utcDate(a.at); return !d || d.getTime() >= sws;
    });
    var since = sws ? fmtKyivShort(new Date(sws)) : "start";
    var rows = acts.length
      ? acts.slice(0, 80).map(function (a) {
          return '<div class="sa-row"><span class="sa-act">' + esc(a.action) + "</span>" +
            (a.target ? '<span class="sa-tgt truncate">' + esc(a.target) + "</span>" : "") +
            '<span class="sa-ago">' + esc(a.ago || "") + "</span></div>";
        }).join("")
      : '<div class="ctx-empty">No recorded activity this shift yet.</div>';
    return '<div class="shift-activity"><div class="sa-head">' + ic("bolt", "ico-sm") +
      "Your shift activity <span class='muted'>(" + acts.length + " since " + esc(since) + ")</span></div>" +
      '<div class="sa-list">' + rows + "</div></div>";
  }
  function modalReport() {
    loadMyActivity(false, function () {
      if (state.modal && state.modal.title === "Community Report") {
        // Prefill today's testing-session count from the loaded shift activity so it isn't 0/blank.
        if (state.modalValues && !state.modalValues.testing_count) {
          var _b = myActBucket(myActWindow("current"));
          if (_b && _b.testing) state.modalValues.testing_count = String(_b.testing.total);
        }
        renderModal();
      }
    });
    var _init = {};
    if (_myAct.data) {   // already cached -> prefill synchronously 
      var _b0 = myActBucket(myActWindow("current"));
      if (_b0 && _b0.testing) _init.testing_count = String(_b0.testing.total);
    }
    return { title: "Community Report", submit: "Submit", close: "Close",
      intro: reportIntroHtml, initial: _init,
      onSubmit: function (v) { pushReport("daily", [
        ["Issues summary", v.issues_summary], ["Sent posts to TG", v.tg_posts], ["Testing sessions count", v.testing_count],
        ["Testing sessions summary", v.testing_summary], ["Crypto Activity", v.crypto || "-"], ["Day Summary", v.day_summary]
      ]); },
      fields: [
        { id: "issues_summary", label: "Issues summary", type: "text", required: true, placeholder: "Issues summary" },
        { id: "tg_posts", label: "Sent posts to TG", type: "number", required: true },
        { id: "testing_count", label: "Testing sessions count", type: "text", required: true, placeholder: "Testing sessions count" },
        { id: "testing_summary", label: "Testing sessions summary", type: "text", required: true, placeholder: "Testing sessions summary" },
        { id: "crypto", label: "Crypto Activity", type: "text", placeholder: "Crypto Activity" },
        { id: "day_summary", label: "Day Summary", type: "text", required: true, placeholder: "Day Summary" }
      ] };
  }
  function modalWeekly() {
    return { title: "Weekly Report", submit: "Submit", close: "Cancel",
      onSubmit: function (v) { pushReport("weekly", [
        ["Important/Interesting Technical Problems", v.tech], ["Massive Non-Technical Requests", v.nontech || "-"],
        ["Created Jira Tickets", v.jira || "-"], ["Cryptoactivity", v.crypto || "-"], ["Other", v.other || "-"]
      ]); },
      fields: [
        { id: "tech", label: "Important/Interesting Technical Problems", type: "textarea", required: true, placeholder: "Describe the problems" },
        { id: "nontech", label: "Massive Non-Technical Requests", type: "textarea", placeholder: "Describe the requests" },
        { id: "jira", label: "Created Jira Tickets", type: "textarea", placeholder: "List created Jira tickets" },
        { id: "crypto", label: "Cryptoactivity", type: "textarea", required: true, placeholder: "Describe crypto activity" },
        { id: "other", label: "Other", type: "textarea", placeholder: "Anything else" }
      ] };
  }
  /* Reports: the bot saves the report (console Reports) and posts it to Slack - the same function as the
     Slack report forms (services/team_forms.py). */
  function pushReport(type, fields) {
    enqueueAction("report", { type: type, fields: fields }, function (res) {
      var r = res.result || {};
      if (r.id) {
        D.reports.unshift({ id: r.id, type: type, date: new Date().toISOString().slice(0, 10), fields: fields,
          author: (state.user && state.user.name) || "", author_email: (state.user && state.user.email) || "",
          created_at: new Date().toISOString() });
        render();
      }
      toast(res.status === "done" ? "Report sent to Slack" : "Report not sent: " + (res.error || "unknown error"));
    });
    toast(type === "weekly" ? "Weekly report submitted" : "Report submitted");
  }
  function openAddMaintenance(ctxType, ref) {
    // Entity is picked from the CURRENTLY ACTIVE maintenances (from /maintenances), split by type,
    // so the subscription matches a real maintenance and its end-notice can fire.
    var games = (D.maintenances || []).filter(function (m) { return m.type === "game"; }).map(function (m) { return m.entity; });
    var servers = (D.maintenances || []).filter(function (m) { return m.type === "server"; }).map(function (m) { return m.entity; });
    var brazil = (D.maintenances || []).filter(function (m) { return m.type === "brazil"; }).map(function (m) { return m.entity; });   // Brazil-only maintenances, separate from regular
    var LANGS = { English: "en", Russian: "ru", Ukrainian: "ua" };   // codes must match the bot templates
    showModal({ title: "Add Maintenance", submit: "Add maintenance", close: "Cancel", modeless: true,
      onSubmit: function (v) {
        var entity = ((v.mtype === "server" ? v.entity_server : v.mtype === "brazil" ? v.entity_brazil : v.entity_game) || "").trim();
        if (!entity) { toast("Select an active maintenance"); return; }
        var payload = { entity: entity, mtype: v.mtype || "game", language: LANGS[v.language] || "en" };
        if (ctxType === "convo") { payload.target_type = "reddit"; payload.convo_id = ref; }
        else { payload.target_type = "discord"; payload.ticket_id = ref; }
        function addLocalSub() {
          D.maintenanceSubs.push({ entity: entity, type: payload.mtype, language: payload.language,
            target_type: payload.target_type, convo_id: payload.convo_id || null });
        }
        toast("Adding maintenance...");
        enqueueAction("maintenance_notify", payload, function (r) {
          if (r.status === "done") { addLocalSub(); render(); }
          toast(r.status === "done" ? "Subscribed: the user will be told automatically when it ends" : "Failed: " + (r.error || "unknown"));
        });
      },
      fields: [
        { id: "mtype", label: "Type", type: "select", required: true, placeholder: "Type", options: ["game", "server", "brazil"], controls: true },
        { id: "entity_game", label: "Active game maintenance", type: "select", required: true,
          placeholder: games.length ? "Select a game" : "No active game maintenances", options: games,
          showWhen: { field: "mtype", value: "game" } },
        { id: "entity_server", label: "Active server maintenance", type: "select", required: true,
          placeholder: servers.length ? "Select a server" : "No active server maintenances", options: servers,
          showWhen: { field: "mtype", value: "server" } },
        { id: "entity_brazil", label: "Active Brazil maintenance", type: "select", required: true,
          placeholder: brazil.length ? "Select a Brazil maintenance" : "No active Brazil maintenances", options: brazil,
          showWhen: { field: "mtype", value: "brazil" } },
        { id: "language", label: "Language", type: "select", required: true, placeholder: "Language", options: ["English", "Russian", "Ukrainian"] }
      ] });
  }
  function openDiscordStatus(ticketKey) {
    var t = ticketByKey(ticketKey); if (!t) return;
    var STATUS = { "In progress": "in_progress", "Close ticket": "closed" };
    showModal({ title: "Change status - #" + t.ticket_number, submit: "Apply", close: "Cancel",
      onSubmit: function (v) {
        var status = STATUS[v.status];
        if (!status) { toast("Pick a status"); return; }
        toast(status === "closed" ? "Scheduling close..." : "Updating status...");
        enqueueAction("discord_status", { ticket_id: tid(t), status: status }, function (r) {
          if (r.status === "done") {
            if (status === "in_progress") { t.status = "in_progress"; render(); toast("Marked In progress"); }
            else { render(); toast("Close scheduled (in ~1h; cancels if the user replies)"); }
          } else toast("Failed: " + (r.error || "unknown"));
        });
      },
      fields: [
        { id: "status", label: "New status", type: "select", required: true, placeholder: "Select status",
          options: ["In progress", "Close ticket"],
          hint: "Close schedules the bot's standard close (~1h; cancels if the user replies)." }
      ] });
  }
  function openDiscordPostpone(ticketKey) {
    var t = ticketByKey(ticketKey); if (!t) return;
    var DUR = { "30 minutes": "30m", "2 hours": "2h", "1 day": "1d", "1 week": "1w" };
    showModal({ title: "Postpone - #" + t.ticket_number, submit: "Postpone", close: "Cancel", modeless: true,
      onSubmit: function (v) {
        var duration = DUR[v.duration];
        if (!duration) { toast("Pick a duration"); return; }
        var reason = (v.reason || "").trim();
        toast("Postponing...");
        enqueueAction("discord_postpone", { ticket_id: tid(t), duration: duration, reason: reason }, function (r) {
          toast(r.status === "done" ? "Ticket postponed" : "Failed: " + (r.error || "unknown"));
        });
      },
      fields: [
        { id: "duration", label: "Postpone for", type: "select", required: true, placeholder: "Duration",
          options: ["30 minutes", "2 hours", "1 day", "1 week"] },
        { id: "reason", label: "Reason", type: "text", placeholder: "Optional reason" }
      ] });
  }
  /* Apply a Discord status change from the unified status dropdown. Postpone is handled
     via its own modal (openDiscordPostpone) so it can be confirmed/cancelled. */
  /* Console-side Discord status override (item S4): for the "soft" statuses (new/waiting_user/
     needs_review) the bot has no equivalent, so we persist a display-only override. "" clears it. */
  /* Persist a manual ModMail / Discord status and keep state._overrides (re-applied on every refresh)
     in step, so a list refresh before the convo-status poll does not drop the status for a moment. */
  function postConvoStatus(id, v) {
    var ov = state._overrides || (state._overrides = {}), at = state._overridesAt || (state._overridesAt = {});
    if (v) { ov[id] = v; at[id] = new Date().toISOString(); } else { delete ov[id]; delete at[id]; }
    return window.CONSOLE.post("/convo-status", { convo_id: id, status: v });
  }
  function setDiscordOverride(t, v) {
    if (!t) return;
    t.override_status = v;
    t._override_at = new Date().toISOString();   // ack marker so an explicit "Waiting on user" sticks 
    postConvoStatus(tid(t), v).then(function () {}, function () {});
    logActivity("set Discord status to " + mmStatusLabel(deriveDiscordStatus(t)), "#" + t.ticket_number + " " + t.user_name);
    render(); toast("Status: " + mmStatusLabel(deriveDiscordStatus(t)));
  }
  /* Done is a console status that ALSO closes the Discord ticket (the bot's standard scheduled
     close). Reflect it immediately via the override, persist it, then enqueue the bot close. */
  function doneDiscord(t) {
    if (!t) return;
    t.override_status = "done";
    t._override_at = new Date().toISOString();   // ack marker so a later user reply reopens Done -> Needs review
    postConvoStatus(tid(t), "done").then(function () {}, function () {});
    render();
    enqueueAction("discord_status", { ticket_id: tid(t), status: "closed" }, function (r) {
      toast(r.status === "done" ? "Marked Done; Discord close scheduled (~1h, cancels if the user replies)"
        : "Marked Done (Discord close failed: " + (r.error || "unknown") + ")");
    });
  }
  function openAddEmail(redditUser, existingEmail, profileUrl) {
    // Add / Edit Email, modeless so the chat stays readable while you copy an email/session out of it
    // (item W5). When an email is already on file we prefill it and relabel the modal "Edit Email".
    // profileUrl (when given) sets the binding target directly - Discord ModMail passes a discord.com
    // profile URL so the email is bound to the Discord user (discord_user_id), not guessed as Reddit.
    var spec = modalAddEmail();
    spec.modeless = true;
    spec.initial = {};
    if (profileUrl) spec.initial.profile_url = profileUrl;
    else if (redditUser) spec.initial.profile_url = "https://www.reddit.com/user/" + redditUser;
    if (existingEmail) { spec.initial.user_ref = existingEmail; spec.title = "Edit User ID"; }
    showModal(spec);
  }
  /* Copy arbitrary text to the clipboard, with a fallback for non-secure contexts. */
  function copyText(text, okMsg) {
    if (!text) return;
    var done = function () { toast(okMsg || "Copied"); }, fail = function () { toast("Copy failed"); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, fail); return; }
    } catch (e) {}
    try {   // fallback for non-secure contexts where the Clipboard API is unavailable
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta); done();
    } catch (e2) { fail(); }
  }
  /* ---------- Add Jira Ticket (item W4): pick an existing team ticket OR create one with the
     chat's communication link auto-filled. Works for Reddit ModMail, Discord, and Reddit Posts. */
  /* The console chat a Jira ticket was created from / linked to, as a route ("" if none is known):
     a Discord ticket or Reddit convo/post linked in the console first, then its Communication Link. */
  /* Open the console chat a Jira ticket was created from. Jira itself only opens via "Open in Jira". */
  function openJiraChat(key) {
    var j = (D.jira || []).filter(function (x) { return x.issue_key === key; })[0] ||
            (D.urgReview || []).filter(function (x) { return x.key === key; }).map(function (u) { return { issue_key: u.key, communication_link: u.communication_link }; })[0] ||
            { issue_key: key };
    var local = chatForJira(j);
    if (local) { setTimeout(function () { location.replace(local); }, 0); return; }
    var back = function (msg) { toast(msg); setTimeout(function () { if (history.length > 1) history.back(); else location.replace("#/inbox"); }, 0); };
    window.CONSOLE.get("/jira-chat?key=" + encodeURIComponent(key) + "&link=" + encodeURIComponent(j.communication_link || "")).then(function (d) {
      if (d && d.go) location.replace(d.go); else back("No console chat is linked to " + key + ". Use Open in Jira.");
    }, function () { back("Could not find the chat for " + key); });
  }
  function chatForJira(j) {
    var key = j && j.issue_key; if (!key) return "";
    var t = (D.discordTickets || []).filter(function (x) { return (x.jira_keys || []).indexOf(key) >= 0 || x.jira_key === key; })[0];
    if (t) return "#/discord/" + tid(t);
    var mn = D.modNotes || {}, users = Object.keys(mn);
    for (var i = 0; i < users.length; i++) { var cid = (mn[users[i]].jira_convos || {})[key]; if (cid) return "#/modmail/" + cid; }
    var pj = D.postJira || {}, pids = Object.keys(pj);
    for (var k = 0; k < pids.length; k++) if ((pj[pids[k]] || []).indexOf(key) >= 0) return "#/posts/" + pids[k];
    var link = String(j.communication_link || ""), m;
    if ((m = /discord(?:app)?\.com\/channels\/\d+\/(\d+)/.exec(link))) {
      var byCh = (D.discordTickets || []).filter(function (x) { return String(x.channel_id) === m[1]; })[0];
      if (byCh) return "#/discord/" + tid(byCh);
    }
    if ((m = /mod\.reddit\.com\/mail\/(?:[a-z]+\/)?([a-z0-9]+)/i.exec(link))) return "#/modmail/" + m[1];
    if ((m = /reddit\.com\/r\/[^\/]+\/comments\/([a-z0-9]+)/i.exec(link))) return "#/posts/" + m[1];
    return "";
  }
  function commLinkFor(anchor) {
    if (!anchor) return "";
    if (anchor.type === "convo") return "https://mod.reddit.com/mail/all/" + anchor.ref;
    if (anchor.type === "ticket") {
      var t = ticketByKey(anchor.ref);
      return (t && state.discordGuildId && t.channel_id) ? "https://discord.com/channels/" + state.discordGuildId + "/" + t.channel_id : "";
    }
    if (anchor.type === "post") {
      var p = (D.redditPosts || []).filter(function (x) { return x.id === anchor.ref; })[0];
      return (p && p.url) || "";
    }
    return "";
  }
  /* ---------- Jira Ticket + Urgent Request forms (1:1 with the Slack modals) ----------
     These mirror views/ticket_views.py exactly (topics, fields, selects, file inputs). On submit the
     console builds the SAME `values` shape as a Slack view + base64 files, enqueues a create_so_ticket
     / create_urgent action, and the bot worker runs handlers/ticket_create.py -> identical tickets.
     KEEP IN SYNC with views/ticket_views.py + handlers/ticket_create.py. */
  var SESSION_PLACEHOLDER = "ID: 4a6a8afd-...\nApplication: Game name [ID: 682]\nPlayground: Krakow\n\nDevice: Desktop\nClient: BoosteroidWindowsClient v.1.11.23";
  var SESSION_HINT = 'Prefixes: "ID:", "Application:", "Playground:" ("Device:"/"Client:" optional). Paste multiple sessions back to back.';
  var URG_SESSION_PLACEHOLDER = "User ID: 7436618\n\nID: 4a6a8afd-...\nApplication: Cyberpunk 2077 (Steam) [ID: 682]\nPlayground: Ploiesti";
  var L1_TAGS = ["native_desktop", "native_android", "webclient", "web_tv", "game", "launcher", "subscription", "stream", "web_backend", "tbd"];
  var JIRA_TOPICS = ["Poor quality/lags", "Game issue", "Launcher issue", "Desktop application issue", "TV application issue", "Saves issue", "DLC request", "Local saves/config support request", "Gamepad issue", "Subscription issue", "Account issue", "Site issue", "Other"];
  function tfTi(b, a, l, ph, opt) { return { block: b, action: a, label: l, type: "text", ph: ph || "", required: !opt }; }
  function tfMl(b, a, l, ph, opt) { return { block: b, action: a, label: l, type: "textarea", ph: ph || "", required: !opt }; }
  function tfSel(b, a, l, o, opt) { return { block: b, action: a, label: l, type: "select", options: o, required: !opt }; }
  function tfFi(b, a, l) { return { block: b, action: a, label: l, type: "file", required: false }; }
  function tfSession(opt) { return { block: "app_id_playground_block", action: "app_id_playground_input", label: "Session data", type: "textarea", ph: SESSION_PLACEHOLDER, hint: SESSION_HINT, required: !opt }; }
  function tfCommon(optSession, nameLabel) {
    return [tfTi("ticket_name_block", "ticket_name_input", nameLabel || "Ticket Name"),
      tfTi("email_block", "email_input", "User ID", "9444330"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfSession(optSession)];
  }
  function topicFields(topic) {
    var YND = ["Yes", "No", "-"], YN = ["Yes", "No"];
    if (topic === "Poor quality/lags") return [
      tfTi("ticket_name_block", "ticket_name_input", "Ticket Name"),
      tfTi("email_block", "email_input", "User ID", "9444330"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfSession(),
      tfSel("connection_block", "connection_input", "Connection type", ["Ethernet", "Wi-Fi 5 GHz", "Wi-Fi 2.4 GHz"]),
      tfSel("multiple_games_block", "multiple_games_input", "Issue is present in multiple games", YND),
      tfSel("other_devices_block", "other_devices_input", "Issue appears on other devices/networks", YN),
      tfSel("issue_origin_block", "issue_origin_input", "Where is the issue appears", ["Browser", "Application", "Both application and browser", "-"]),
      tfSel("third_party_block", "third_party_input", "Is there an additional load on the network while streaming", YND),
      tfFi("speedtest_block", "speedtest_input", "Speedtest"),
      tfFi("mtr_block", "mtr_input", "MTR"),
      tfFi("mtu_block", "mtu_input", "MTU"),
      tfFi("screenshots_block", "screenshots_input", "Screenshot/video of the problem"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")];
    if (topic === "Game issue") return [
      tfTi("ticket_name_block", "ticket_name_input", "Problem summary (will be added to ticket name)"),
      tfTi("email_block", "email_input", "User ID", "9444330"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfSession(),
      tfSel("issue_origin_block", "issue_origin_input", "Where is the issue appears", ["Browser", "Application", "Both application and browser", "-"]),
      tfFi("media_block", "media_input", "Screenshot/video of the problem"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")];
    if (topic === "Launcher issue") return tfCommon(false, "Problem summary (will be added to ticket name)").concat([
      tfSel("launcher_block", "launcher_input", "Launcher", ["Steam", "Epic", "Xbox", "EA", "Battle.net", "Ubisoft", "Rockstar", "Other"]),
      tfFi("media_block", "media_input", "Screenshot/video of the problem"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")]);
    if (topic === "Desktop application issue") return tfCommon(true, "Problem summary (will be added to ticket name)").concat([
      tfSel("application_block", "application_input", "Application", ["Windows app", "macOS app", "Linux app"]),
      tfFi("media_block", "media_input", "Screenshot/video of the problem"),
      tfFi("log_block", "log_input", "Logs"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")]);
    if (topic === "TV application issue") return tfCommon(true, "Problem summary (will be added to ticket name)").concat([
      tfSel("application_block", "application_input", "Application", ["Android TV", "Samsung TV", "LG TV", "Philips TV", "Hisense TV", "Fire TV"]),
      tfFi("media_block", "media_input", "Screenshot/video of the problem"),
      tfFi("tv_os_block", "tv_os_input", "TV OS version screenshot"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")]);
    if (topic === "Saves issue") return tfCommon(false, "Problem summary (will be added to ticket name)").concat([
      tfSel("saves_block", "saves_input", "Saves type", ["Local", "Cloud"]),
      tfSel("multiple_games_block", "multiple_games_input", "Issue is present in multiple games", YND),
      tfSel("account_type_block", "account_type_input", "What type of an account user has", ["Own account", "Shared account"]),
      tfFi("steam_remote_block", "steam_remote_input", "Screenshot of Steam Remote Storage (if Steam game)"),
      tfFi("screenshots_block", "screenshots_input", "Screenshot/video of the problem"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")]);
    if (topic === "DLC request") return tfCommon(true, "Game Name (will be added to ticket name)").concat([
      tfTi("dlc_name_block", "dlc_name_input", "DLC name/link"),
      tfFi("dlc_block", "dlc_input", "DLCs screenshot"),
      tfMl("description_block", "description_input", "Description")]);
    if (topic === "Local saves/config support request") return [
      tfTi("email_block", "email_input", "User ID", "9444330"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfSession(),
      tfSel("local_request_type_block", "local_request_type_input", "Local request type", ["Config", "Local saves", "Local saves & config"]),
      tfMl("description_block", "description_input", "Description")];
    if (topic === "Gamepad issue") return tfCommon().concat([
      tfTi("gamepad_model_block", "gamepad_model_input", "Gamepad model"),
      tfSel("gamepad_connection_block", "gamepad_connection_input", "Connection type", ["Cable", "Bluetooth"]),
      tfSel("multiple_games_block", "multiple_games_input", "Issue is present in multiple games", YND),
      tfSel("issue_origin_block", "issue_origin_input", "Where is the issue appears", ["Browser", "Application", "Both application and browser", "-"]),
      tfFi("media_block", "media_input", "Screenshot/video of the issue"),
      tfFi("gamepad_tester_block", "gamepad_tester_input", "Screenshot/video of the Gamepad Tester site"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")]);
    if (topic === "Subscription issue") return [
      tfTi("ticket_name_block", "ticket_name_input", "Ticket Name"),
      tfTi("email_block", "email_input", "User ID", "9444330"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfTi("uniq_id_block", "uniq_id_input", "Uniq ID", "User unique ID"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")];
    if (topic === "Account issue") return [
      tfTi("ticket_name_block", "ticket_name_input", "Ticket Name"),
      tfTi("email_block", "email_input", "User ID", "9444330"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")];
    if (topic === "Site issue") return [
      tfTi("ticket_name_block", "ticket_name_input", "Ticket Name"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true),
      tfFi("media_block", "media_input", "Screenshot/video of the problem"),
      tfFi("console_block", "console_input", "Screenshot of browser console"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")];
    if (topic === "Other") return tfCommon(true).concat([
      tfFi("media_block", "media_input", "Files"),
      tfMl("steps_block", "steps_input", "Steps already taken", "", true),
      tfMl("description_block", "description_input", "Description")]);
    return tfCommon().concat([tfMl("steps_block", "steps_input", "Steps already taken", "", true), tfMl("description_block", "description_input", "Description")]);
  }
  function ticketFieldHtml(f, prefill) {
    var did = "tf_" + f.block + "_" + f.action;
    var req = f.required ? "" : ' <span class="muted" style="font-weight:400">(optional)</span>';
    var attrs = ' id="' + did + '" data-tf-block="' + f.block + '" data-tf-action="' + f.action + '" data-tf-type="' + f.type + '"';
    var pv = (prefill && prefill[f.block]) || "";
    var open = '<label class="field"><span>' + esc(f.label) + req + "</span>";
    var hint = f.hint ? '<div class="f-hint">' + esc(f.hint) + "</div>" : "";
    if (f.type === "textarea") return open + '<textarea class="f-input"' + attrs + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : "") + ">" + esc(pv) + "</textarea>" + hint + "</label>";
    if (f.type === "select") return open + '<select class="f-input"' + attrs + '><option value="">Select...</option>' + f.options.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + "</option>"; }).join("") + "</select></label>";
    if (f.type === "file") return open + '<input type="file" multiple accept="image/*,video/*"' + attrs + "></label>";
    return open + '<input class="f-input" type="text"' + attrs + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : "") + ' value="' + esc(pv) + '"></label>';
  }
  function l1TagsHtml() {
    return '<label class="field"><span>L1 Tags</span><div class="l1-tags" style="display:flex;flex-wrap:wrap;gap:8px 14px">' +
      L1_TAGS.map(function (t) { return '<label style="display:flex;align-items:center;gap:5px;font-weight:400"><input type="checkbox" data-l1="' + esc(t) + '"> ' + esc(t) + "</label>"; }).join("") + "</div></label>";
  }
  function ticketFormBody(fields, prefill, extra) {
    return '<div class="tform">' + fields.map(function (f) { return ticketFieldHtml(f, prefill); }).join("") + (extra || "") + "</div>";
  }
  // Read the open ticket form into a Slack-shaped `values` dict + collect File objects per block.
  function collectTicketValues(host) {
    var values = {};
    Array.prototype.forEach.call(host.querySelectorAll("[data-tf-block]"), function (el) {
      var b = el.getAttribute("data-tf-block"), a = el.getAttribute("data-tf-action"), t = el.getAttribute("data-tf-type");
      if (t === "file") return;
      values[b] = values[b] || {};
      if (t === "select") { if (el.value) values[b][a] = { selected_option: { value: el.value } }; }
      else { if ((el.value || "").trim()) values[b][a] = { value: el.value }; }
    });
    var l1 = Array.prototype.filter.call(host.querySelectorAll("[data-l1]"), function (c) { return c.checked; }).map(function (c) { return { value: c.getAttribute("data-l1") }; });
    if (l1.length) values["l1_tags_block"] = { l1_tags_input: { selected_options: l1 } };
    return values;
  }
  function readFileB64(file) {
    return new Promise(function (res) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ""); var i = s.indexOf(","); res({ name: file.name, mimetype: file.type || "application/octet-stream", b64: i >= 0 ? s.slice(i + 1) : s }); };
      r.onerror = function () { res(null); };
      r.readAsDataURL(file);
    });
  }
  function collectTicketFiles(host) {   // -> Promise of { block_id: [ {name,mimetype,b64} ] }
    var proms = [], map = {};
    Array.prototype.forEach.call(host.querySelectorAll('[data-tf-type="file"]'), function (el) {
      var b = el.getAttribute("data-tf-block");
      Array.prototype.forEach.call(el.files || [], function (f) {
        proms.push(readFileB64(f).then(function (o) { if (o) (map[b] = map[b] || []).push(o); }));
      });
    });
    return Promise.all(proms).then(function () { return map; });
  }
  function enqueueTicketAction(type, payload, label) {
    window.CONSOLE.post("/actions", { type: type, payload: payload }).then(function (a) {
      if (a && a.id) pollTicketAction(a.id, label); else ticketSubmitEnd(false, "Could not enqueue " + label);
    }, function (s) { ticketSubmitEnd(false, s === 413 ? "Files too large - create the ticket, then attach them" : "Could not enqueue " + label); });
  }
  /* While a ticket is being created the form shows it (button locked + a line of text) so nobody is
     left staring at an unchanged modal or submits twice. Closing the form doesn't lose the result:
     it still arrives as a long toast. Success closes the form; failure keeps it with the input intact. */
  var TICKET_CREATE_BTNS = '[data-act="urg-create"],[data-act="so-ticket-create"]';
  function ticketSubmitStart(host) {
    if (state._ticketBusy) { toast("The previous ticket is still being created"); return false; }
    state._ticketBusy = true; state._ticketModal = state.modal;
    var b = host.querySelector(TICKET_CREATE_BTNS);
    if (b) {
      b.disabled = true; b.textContent = "Creating...";
      var _foot = b.closest(".modal-foot");
      (_foot || b).insertAdjacentHTML(_foot ? "beforebegin" : "afterend", '<div class="f-hint" data-ticket-progress style="margin:8px 16px">Creating the ticket in Jira. This can take a few minutes. You can close this window, the result will appear on screen.</div>');
    }
    return true;
  }
  function ticketSubmitEnd(ok, msg) {
    var same = !!state.modal && state.modal === state._ticketModal;
    state._ticketBusy = false; state._ticketModal = null;
    if (ok) { if (same) closeModal(); toast(msg, "sticky"); return; }
    var host = same && modalHost();
    if (host) {
      var b = host.querySelector(TICKET_CREATE_BTNS), p = host.querySelector("[data-ticket-progress]");
      if (b) { b.disabled = false; b.textContent = "Create"; }
      if (p) p.remove();
    }
    toast(msg, "error");
  }
  function pollTicketAction(id, label, tries) {
    tries = tries || 0;
    function again() {
      if (tries > 200) { ticketSubmitEnd(false, label + " is taking too long. Check Jira before trying again"); return; }   // ~5 min
      setTimeout(function () { pollTicketAction(id, label, tries + 1); }, 1500);
    }
    window.CONSOLE.get("/actions/" + id).then(function (a) {
      if (a && a.status === "done") {
        var keys = a.result && a.result.keys, key = a.result && a.result.key;
        // Sessions of different games become one URG ticket per game.
        if (keys && keys.length > 1) { ticketSubmitEnd(true, label + ": one ticket per game: " + keys.join(", ")); return; }
        ticketSubmitEnd(true, key ? (label + " created: " + key) : (label + " created")); return;
      }
      if (a && a.status === "error") { ticketSubmitEnd(false, label + " failed: " + (a.error || "")); return; }
      again();
    }, again);   // a failed status check isn't a failed ticket: keep watching
  }
  function requiredMissing(host, fields) {
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (!f.required || f.type === "file") continue;
      var el = host.querySelector("#tf_" + f.block + "_" + f.action);
      if (el && !(el.value || "").trim()) return f.label;
    }
    return null;
  }
  // Step 1: topic picker. Step 2: the topic's fields + L1 tags.
  function openJiraTicket(anchor) {
    var sel = '<label class="field"><span>Ticket topic</span><select class="f-input" id="jira-topic-sel"><option value="">Select topic</option>' +
      JIRA_TOPICS.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + "</option>"; }).join("") + "</select></label>";
    state._ticketAnchor = anchor || null;
    showModal({ title: "Create Jira Ticket", close: "Cancel", modeless: true, custom: function () { return '<div class="tform">' + sel + '<button class="btn primary" data-act="jira-topic-next" style="margin-top:6px">Next</button></div>'; } });
  }
  function openJiraTicketForm(topic) {
    var fields = topicFields(topic);
    state._ticketTopic = topic; state._ticketFields = fields;
    var comm = commLinkFor(state._ticketAnchor); var prefill = comm ? { comm_link_block: comm } : {};
    var uid = anchorUserId(state._ticketAnchor);
    var hasSession = fields.some(function (f) { return f.block === "app_id_playground_block"; });
    if (uid && fields.some(function (f) { return f.block === "email_block"; })) prefill.email_block = uid;   // the User ID field
    _us = { uid: hasSession ? uid : "", pending: hasSession ? uid : "", state: "idle", items: [], error: "", box: "tf_app_id_playground_block_app_id_playground_input", header: false };
    showModal({ title: (TOPIC_TITLES2[topic] || topic), close: "Cancel", modeless: true,
      footExtra: '<button class="btn primary" data-act="so-ticket-create">Create</button>',
      custom: function () { return '<div id="urg-sessions">' + usHtml() + "</div>" + ticketFormBody(fields, prefill, l1TagsHtml()); } });
    if (hasSession) {
      usBind("#tf_email_block_email_input");
      // the sessions picker sits right under the User ID field it belongs to
      var _uf = q("#tf_email_block_email_input", modalHost()), _ps = q("#urg-sessions", modalHost());
      var _ff = _uf && _uf.closest(".field"); if (_ff && _ps) _ff.parentNode.insertBefore(_ps, _ff.nextSibling);
    }
    if (_us.uid) usLoad();   // known from the chat: load right away
  }
  var TOPIC_TITLES2 = { "Desktop application issue": "Desktop App Issue", "Local saves/config support request": "Local Request" };
  function submitSoTicket() {
    var host = modalHost(); if (!host) return;
    var fields = state._ticketFields || [], topic = state._ticketTopic;
    var miss = requiredMissing(host, fields); if (miss) { toast("Required: " + miss); return; }
    if (!host.querySelector("[data-l1]:checked")) { toast("Select at least one L1 tag"); return; }
    if (!ticketSubmitStart(host)) return;
    var values = collectTicketValues(host);
    collectTicketFiles(host).then(function (filesByBlock) {
      enqueueTicketAction("create_so_ticket", { topic: topic, values: values, files_by_block: filesByBlock, user_ref: anchorUserRef(state._ticketAnchor) }, "Jira ticket");
    }, function () { ticketSubmitEnd(false, "Could not read the attached files"); });
  }
  function urgFields() {
    return [
      { block: "session_block", action: "session_input", label: "Session info", type: "textarea", ph: URG_SESSION_PLACEHOLDER, hint: "Optional User ID on top (an email is replaced with the User ID). Paste one session, or several for multiple playgrounds.", required: true },
      tfSel("update_type_block", "update_type_input", "Update type", ["Update in launcher", "Update in game", "Version mismatch"]),
      tfMl("description_block", "description_input", "Description", "", true),
      tfFi("screenshot_block", "screenshot_input", "Screenshot"),
      tfTi("comm_link_block", "comm_link_input", "Communication Link", "https://discord.com/channels/...", true)
    ];
  }
  /* The Boosteroid User ID of the person behind a chat, when the directory (or a lookup made this
     session) knows it: Reddit convo / post -> by username, Discord ticket -> by Discord ID or the email
     typed into the ticket form. "" when unknown. */
  function anchorUserId(anchor) {
    if (!anchor) return "";
    var u = null, email = "";
    if (anchor.type === "convo") { var c = convoById(anchor.ref); u = c ? userByReddit(c.participant) : null; }
    else if (anchor.type === "post") { var p = (D.redditPosts || []).filter(function (x) { return x.id === anchor.ref; })[0]; u = p ? userByReddit(p.author) : null; }
    else if (anchor.type === "ticket") {
      var t = ticketByKey(anchor.ref);
      if (t) { email = (t.metadata && t.metadata.email_or_session) || ""; u = userByDiscordId(t.user_id) || userByEmail(email); }
    }
    if (u && u.user_ids && u.user_ids.length) return String(u.user_ids[0]);
    var em = String((u && u.emails && u.emails[0]) || email || "").toLowerCase();
    return (em && _uidByEmail[em]) || "";
  }
  /* Urgent Request: the user's last sessions (bot action "cloud_sessions"). Ticking one or several
     writes them into the Session info box in the same text format a pasted session has, under a
     "User ID:" line, so the ticket is built by the unchanged parser. The picker is patched in place:
     re-rendering the whole form would wipe what the operator already typed. */
  var _us = { uid: "", state: "idle", items: [], error: "", box: "tf_session_block_session_input", header: true };
  function usBlock(x) {
    return "ID: " + x.session_id + "\nApplication: " + (x.application || "Unknown") +
      (x.application_id != null && !/^Application #/.test(x.application || "") ? " [ID: " + x.application_id + "]" : "") +
      (x.playground ? "\nPlayground: " + x.playground : "");
  }
  function usBox() { return q("#" + _us.box, modalHost()); }
  function usPicked(x) { var b = usBox(); return !!b && b.value.indexOf("ID: " + x.session_id) >= 0; }
  function usHtml() {
    if (!_us.mine && _us.state === "idle") {
      var p = _us.pending || "";
      return p.length >= 4 ? '<div class="field us-get"><button type="button" class="btn sm" data-act="us-get">' + ic("search", "ico-sm") + "Get Sessions</button>" +
        '<span class="f-hint">Last sessions of User ID ' + esc(p) + "</span></div>" : "";
    }
    if (!_us.uid) return "";
    var inner;
    if (_us.state === "loading") inner = '<div class="f-hint">Loading the last sessions...</div>';
    else if (_us.state === "error") inner = '<div class="f-hint">' + esc(_us.error) + '</div><button type="button" class="btn sm" data-act="us-load">Try again</button>';
    else if (_us.state === "ready" && !_us.items.length) inner = '<div class="f-hint">No sessions in the last 30 days.</div>';
    else if (_us.state === "ready") inner = '<div class="ts-list">' + _us.items.map(function (x, i) {
      var on = usPicked(x), bits = [x.playground, timeText(x.started_at || x.created_at), tsDuration(x.length)].filter(Boolean);
      return '<button type="button" class="ts-row' + (on ? " on" : "") + '" data-act="us-pick" data-i="' + i + '" aria-pressed="' + (on ? "true" : "false") + '">' +
        '<span class="ts-check">' + (on ? ic("check", "ico-sm") : "") + "</span>" +
        '<span class="ts-main"><span class="ts-title"><b class="truncate">' + esc(x.application || "Unknown") + "</b>" + launcherChip(x) + "</span>" +
        '<span class="ts-sub truncate">' + esc(bits.join(" | ")) + "</span></span></button>";
    }).join("") + "</div>";
    else inner = "";
    if (_us.mine) return '<div class="field"><span>My last sessions <span class="muted" style="font-weight:400">(tick to add)</span>' + (_us.state === "ready" ? sessRefreshBtn("us-refresh", "me") : "") + "</span>" + inner + "</div>";
    return '<div class="field"><span>Last sessions of User ID ' + esc(_us.uid) + ' <span class="muted" style="font-weight:400">(tick to add)</span>' + (_us.state === "ready" ? sessRefreshBtn("us-refresh", "u:" + _us.uid) : "") + "</span>" + inner + "</div>";
  }
  function usPaint() { var el = q("#urg-sessions", modalHost()); if (el) el.innerHTML = usHtml(); }
  /* The User ID field a form types into: changing it only offers "Get Sessions" (no request yet). */
  function usBind(sel) {
    var inp = q(sel, modalHost()); if (!inp) return;
    _us.pending = String(inp.value || "").replace(/\D/g, "");
    inp.addEventListener("input", function () {
      var v = String(inp.value || "").replace(/\D/g, "");
      if (v === _us.pending) return;
      _us.pending = v;
      if (_us.mine) return;
      if (v !== _us.uid) { _us.uid = ""; _us.state = "idle"; _us.items = []; }
      usPaint();
    });
  }
  function usGet() {
    if (!_us.pending || _us.pending.length < 4) return;
    _us.uid = _us.pending; _us.state = "idle"; usLoad();
  }
  function usLoad(force) {
    if (!_us.uid || _us.state === "loading") return;
    var uid = _us.uid, key = _us.mine ? "me" : "u:" + uid;
    var c = !force && sessCached(key);
    if (c) { _us.items = c.items.slice(0, 5); _us.state = "ready"; usPaint(); return; }
    _us.state = "loading"; _us.error = ""; usPaint();
    // "me": the server takes the User ID from the signed-in member's own profile (shared with Add Testing Session).
    sessFetch(key, _us.mine ? { mine: true } : { user_id: +uid, limit: 5 }, !!force, function (items) {
      if (_us.uid !== uid) return;                     // another chat's form was opened meanwhile
      _us.items = items.slice(0, 5); _us.state = "ready"; usPaint();
    }, function (msg) { if (_us.uid !== uid) return; _us.state = "error"; _us.error = msg || "Could not load the sessions"; usPaint(); });
  }
  function usPick(btn) {
    var x = _us.items[+btn.getAttribute("data-i")], box = usBox(); if (!x || !box) return;
    var cur = box.value;
    if (usPicked(x)) {
      cur = cur.split(/\n\s*\n/).filter(function (b) { return b.indexOf("ID: " + x.session_id) < 0; }).join("\n\n").trim();
    } else {
      if (_us.header && !/User ID\s*:/i.test(cur)) cur = "User ID: " + _us.uid + (cur.trim() ? "\n\n" + cur.trim() : "");
      cur = (cur.trim() ? cur.trim() + "\n\n" : "") + usBlock(x);
    }
    box.value = cur;
    usPaint();
  }
  /* Whose chat a ticket is created from, so the bot can tie the resolved User ID to that account. */
  function anchorUserRef(anchor) {
    if (!anchor) return null;
    if (anchor.type === "convo") { var c = convoById(anchor.ref); return c && c.participant && c.participant !== "[deleted]" ? { reddit_username: c.participant } : null; }
    if (anchor.type === "post") { var p = (D.redditPosts || []).filter(function (x) { return x.id === anchor.ref; })[0]; return p && p.author && p.author !== "[deleted]" ? { reddit_username: p.author } : null; }
    if (anchor.type === "ticket") { var t = ticketByKey(anchor.ref); return t && t.user_id ? { discord_user_id: String(t.user_id) } : null; }
    return null;
  }
  function openCreateUrgent(anchor) {
    state._urgAnchor = anchor || null;
    var fields = urgFields(); state._urgFields = fields;
    var comm = commLinkFor(anchor); var prefill = comm ? { comm_link_block: comm } : {};
    state._urgUs = null;
    var _auid = anchorUserId(anchor);
    _us = { uid: _auid, pending: _auid, state: "idle", items: [], error: "", box: "tf_session_block_session_input", header: true };
    showModal({ title: "Urgent Request", close: "Cancel", modeless: true,
      footExtra: '<button class="btn primary" data-act="urg-create">Create</button>',   // in the window footer, next to Cancel - no scrolling to it
      custom: function () {
        return '<div class="field"><span>Ticket type</span><input type="hidden" id="urg-type" value="Update" data-tf-block="urg_type_block" data-tf-action="urg_type_input" data-tf-type="select">' +
          '<div class="urg-seg" role="radiogroup"><button type="button" class="on" data-urg-type="Update" role="radio" aria-checked="true">Update</button>' +
          '<button type="button" data-urg-type="Verification" role="radio" aria-checked="false"' + (URG_VERIFICATION_ON ? "" : " disabled") + '>Verification' + (URG_VERIFICATION_ON ? "" : ' <small>soon</small>') + "</button></div></div>" +
          (isAdmin() ? '<label class="field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer;margin-top:-6px"><input type="checkbox" id="urg-ver-switch"' + (URG_VERIFICATION_ON ? " checked" : "") + '> <span class="muted">Verification tickets enabled for everyone (admin)</span></label>' : "") +
          '<label class="field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="urg-own" data-act="urg-own"> <b>My Own Ticket</b></label>' +
          '<div class="f-hint" style="margin:-4px 0 10px">Your own session: the ticket goes under your User ID, the session is added to Testing Sessions, and it closes by itself when resolved. You get the result.</div>' +
          '<label class="field" id="urg-uid-f"><span>User ID</span><input class="f-input" id="urg-uid" inputmode="numeric" placeholder="9444330" value="' + esc(_auid) + '"></label>' +
          '<div id="urg-sessions">' + usHtml() + "</div>" + ticketFormBody(fields, prefill, "");
      } });
    Array.prototype.forEach.call(modalHost().querySelectorAll("[data-urg-type]"), function (b) {
      b.addEventListener("click", function () { if (!b.disabled) urgSetType(b.getAttribute("data-urg-type")); });
    });
    var sw = q("#urg-ver-switch", modalHost());
    if (sw) sw.addEventListener("change", function () {
      var on = sw.checked; sw.disabled = true;
      window.CONSOLE.post("/admin/urg-settings", { verification: on }).then(function (d) {
        sw.disabled = false; URG_VERIFICATION_ON = !!d.verification; urgTypePaint();
        toast("Verification tickets " + (URG_VERIFICATION_ON ? "enabled" : "disabled"));
      }, function () { sw.disabled = false; sw.checked = !on; toast("Could not change the setting"); });
    });
    window.CONSOLE.get("/urg-settings").then(function (d) { URG_VERIFICATION_ON = !!(d && d.verification); urgTypePaint(); }, function () {});
    usBind("#urg-uid");
    if (_us.uid) usLoad();   // known from the chat: load right away
  }
  /* Update / Verification (Jira customfield_10610). Verification needs the same game + playground
     sessions but has no "Update type". One admin switch (console_config urg_verification) turns it on
     for the console and the bot together. */
  var URG_VERIFICATION_ON = false;
  function urgTypePaint() {
    var host = modalHost(), s = q("#urg-type", host), sw = q("#urg-ver-switch", host);
    if (sw) sw.checked = URG_VERIFICATION_ON;
    if (!s) return;
    var o = q('[data-urg-type="Verification"]', host);
    if (o) { o.disabled = !URG_VERIFICATION_ON; o.innerHTML = "Verification" + (URG_VERIFICATION_ON ? "" : " <small>soon</small>"); }
    if (!URG_VERIFICATION_ON && s.value === "Verification") urgSetType("Update");
  }
  function urgSetType(t) {
    var host = modalHost(), s = q("#urg-type", host); if (!s) return;
    s.value = t;
    Array.prototype.forEach.call(host.querySelectorAll("[data-urg-type]"), function (b) {
      var on = b.getAttribute("data-urg-type") === t;
      b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false");
    });
    urgTypeChanged();
  }
  function urgIsVerification(host) { var s = q("#urg-type", host); return !!s && s.value === "Verification"; }
  function urgTypeChanged() {
    var host = modalHost(), ut = q("#tf_update_type_block_update_type_input", host);
    var wrap = ut && ut.closest(".field");
    if (wrap) wrap.style.display = urgIsVerification(host) ? "none" : "";
  }
  /* "My Own Ticket": swap the picker to the member's own last 5 sessions (and back to the chat user's). */
  function urgOwnToggle(on) {
    var box = usBox();
    if (box) {   // the picked sessions belong to the other person: start the session box clean
      var keep = box.value.split(/\n\s*\n/).filter(function (b) {
        return !(_us.items || []).some(function (x) { return b.indexOf("ID: " + x.session_id) >= 0; }) && !/^\s*user\s*id\s*:/i.test(b);
      });
      box.value = keep.join("\n\n").trim();
    }
    var _uf = q("#urg-uid-f", modalHost()); if (_uf) _uf.style.display = on ? "none" : "";   // own ticket: your own User ID
    if (on) { state._urgUs = _us; _us = { uid: "me", mine: true, state: "idle", items: [], error: "", box: "tf_session_block_session_input", header: false }; }
    else { _us = state._urgUs || { uid: anchorUserId(state._urgAnchor), state: "idle", items: [], error: "", box: "tf_session_block_session_input", header: true }; _us.state = _us.state === "loading" ? "idle" : _us.state; }
    usPaint();
    if (_us.mine && _us.state !== "ready") usLoad();   // your own sessions; another User ID waits for Get Sessions
  }
  function submitUrg() {
    var host = modalHost(); if (!host) return;
    var fields = state._urgFields || [];
    if (urgIsVerification(host)) fields = fields.filter(function (f) { return f.block !== "update_type_block"; });
    // the User ID typed above the picker goes on top of Session info (same format as a picked session)
    var _uidIn = q("#urg-uid", host), _sb = q("#tf_session_block_session_input", host);
    var _uidV = _uidIn ? String(_uidIn.value || "").replace(/\D/g, "") : "";
    if (_uidV && _sb && !(q("#urg-own", host) || {}).checked && !/User ID\s*:/i.test(_sb.value)) _sb.value = "User ID: " + _uidV + (_sb.value.trim() ? "\n\n" + _sb.value.trim() : "");
    var miss = requiredMissing(host, fields); if (miss) { toast("Required: " + miss); return; }
    if (!ticketSubmitStart(host)) return;
    var values = collectTicketValues(host);
    collectTicketFiles(host).then(function (map) {
      var files = []; Object.keys(map).forEach(function (k) { files = files.concat(map[k]); });   // URG: one flat file list
      var own = !!(host.querySelector("#urg-own") || {}).checked;
      enqueueTicketAction("create_urgent", { values: values, files: files, own_ticket: own, user_ref: own ? null : anchorUserRef(state._urgAnchor) }, own ? "Own urgent request" : "Urgent request");
    }, function () { ticketSubmitEnd(false, "Could not read the attached files"); });
  }
  /* Full console URL of a chat, e.g. https://cmtconsole.xyz/console/#/discord/<id> ("" if unknown). */
  function consoleChatLink(anchor) {
    var route = anchor ? handoffRoute({ context_type: anchor.type, ref: anchor.ref }) : "";
    return route ? location.origin + location.pathname + route : "";
  }
  /* Is `key` already linked to this chat in the console? (Same records linkJiraToChat writes.) */
  function anchorHasJira(anchor, key) {
    if (!anchor || !key) return false;
    if (anchor.type === "convo") {
      var c = convoById(anchor.ref), mn = c ? D.modNotes[c.participant] : null;
      return !!(mn && mn.jira_convos && mn.jira_convos[key] === anchor.ref);
    }
    if (anchor.type === "ticket") {
      var t = ticketByKey(anchor.ref);
      return !!t && ((t.jira_keys || []).indexOf(key) >= 0 || t.jira_key === key);
    }
    if (anchor.type === "post") {
      var p = (D.redditPosts || []).filter(function (x) { return x.id === anchor.ref; })[0];
      return ((p && p.jira_keys) || []).indexOf(key) >= 0 || ((D.postJira || {})[anchor.ref] || []).indexOf(key) >= 0;
    }
    return false;
  }
  function linkJiraToChat(anchor, key) {
    if (!anchor || !key) return;
    if (anchor.type === "convo") {
      var c = convoById(anchor.ref); var ru = c ? c.participant : "";
      var mn = D.modNotes[ru] || (D.modNotes[ru] = { jira_convos: {}, highlighted_convos: [] });
      mn.jira_convos = mn.jira_convos || {}; mn.highlighted_convos = mn.highlighted_convos || [];
      mn.jira_convos[key] = anchor.ref;
      {
        window.CONSOLE.post("/reddit-jira-link", { reddit_user: ru, issue_key: key, convo_id: anchor.ref }).then(function () {
          if (mn.highlighted_convos.indexOf(anchor.ref) < 0) {
            enqueueAction("reddit_highlight", { convo_id: anchor.ref, reddit_user: ru, highlight: true }, function (r) {
              if (r.status === "done" && mn.highlighted_convos.indexOf(anchor.ref) < 0) { mn.highlighted_convos.push(anchor.ref); render(); }
            });
          }
        }, function () { toast("Could not link Jira ticket"); });
      }
    } else if (anchor.type === "ticket") {
      var t = ticketByKey(anchor.ref);
      if (t) { t.jira_keys = t.jira_keys || []; if (t.jira_keys.indexOf(key) < 0) t.jira_keys.push(key); t.jira_key = t.jira_keys[0]; }
      window.CONSOLE.post("/discord-jira-link", { ticket_id: (t && t._id) || anchor.ref, issue_key: key }).then(function () {}, function () { toast("Could not link Jira ticket"); });
    } else if (anchor.type === "user") {
      D.userJira = D.userJira || {};
      var ul = D.userJira[anchor.ref] || (D.userJira[anchor.ref] = []);
      if (ul.indexOf(key) < 0) ul.push(key);
      window.CONSOLE.post("/jira-user-link", { user_id: anchor.ref, issue_key: key, label: anchor.label || "" }).then(function () {}, function () { toast("Could not link Jira ticket"); });
    } else if (anchor.type === "post") {
      var p = (D.redditPosts || []).filter(function (x) { return x.id === anchor.ref; })[0];
      if (p) { p.jira_keys = p.jira_keys || []; if (p.jira_keys.indexOf(key) < 0) p.jira_keys.push(key); }
      D.postJira = D.postJira || {}; var _pj = D.postJira[anchor.ref] || (D.postJira[anchor.ref] = []);   // re-applied on every posts refresh
      if (_pj.indexOf(key) < 0) _pj.push(key);
      window.CONSOLE.post("/post-jira-link", { post_id: anchor.ref, issue_key: key }).then(function () {}, function () { toast("Could not link Jira ticket"); });
    }
    logActivity("linked Jira " + key, anchor.type + " " + anchor.ref);
    closeModal(); render(); toast("Linked " + key);
  }
  /* Link an EXISTING Jira ticket to this chat - no ticket creation here (use "Create Ticket" for that).
     Link either by picking from the console's team tickets, or by typing a key / pasting a Jira link. */
  /* Jira title index search for the Link modal: cached per query, debounced, repaints the open modal when
     the answer lands. Returns the cached list, [] (nothing / too short) or null (still loading). */
  var _jsugCache = {}, _jsugTimer = null;
  function jiraSuggest(ql) {
    ql = String(ql || "").trim().toLowerCase();
    if (ql.length < 2) return [];
    if (_jsugCache.hasOwnProperty(ql)) return _jsugCache[ql];
    clearTimeout(_jsugTimer);
    _jsugTimer = setTimeout(function () {
      window.CONSOLE.get("/jira-suggest?q=" + encodeURIComponent(ql)).then(function (d) {
        _jsugCache[ql] = (d && Array.isArray(d.items)) ? d.items : [];
      }, function () { _jsugCache[ql] = []; }).then(function () {
        var si = document.getElementById("modal-search-input"), box = document.getElementById("modal-results");
        if (si && box && state.modal && state.modal.search && (si.value || "").trim().toLowerCase() === ql) box.innerHTML = state.modal.search.run(ql);
        ltPaintSug();
      });
    }, 200);
    return null;
  }
  function openAddJira(anchor) {
    state._jiraAnchor = anchor;
    showModal({ title: "Link Jira Ticket", close: "Close", modeless: true,
      search: { placeholder: "Type the problem or a ticket number (SO-1234), or paste a Jira link...", run: function (ql) {
        // Manual link: if the query contains a Jira key (raw or inside a URL), offer to link it directly.
        var manual = "", m = /([A-Za-z][A-Za-z0-9]+-\d+)/.exec(ql || "");
        if (m) {
          var mkey = m[1].toUpperCase();
          manual = '<div class="act-row" data-act="jira-pick" data-key="' + esc(mkey) + '" style="cursor:pointer;border:1px dashed var(--border-strong)">' +
            '<div class="ar-main"><div class="row-gap">' + jkeyChip(mkey) + '<span class="truncate">Link this ticket</span></div></div>' +
            '<span class="st">manual</span></div>';
        }
        var list = (D.jira || []).filter(function (j) {
          if (jiraCategory(j.status) === "done") return false;   // finished tickets aren't linkable
          if (isUrgKey(j.issue_key)) return false;              // urgent requests have their own flow (Create Urgent)
          return !ql || (j.issue_key + " " + (j.summary || "")).toLowerCase().indexOf(ql) >= 0;
        }).slice(0, 60);
        var shown = {}; if (m) shown[m[1].toUpperCase()] = 1;
        var rows = list.map(function (j) {
          shown[j.issue_key] = 1;
          return '<div class="act-row" data-act="jira-pick" data-key="' + esc(j.issue_key) + '" style="cursor:pointer">' +
            '<div class="ar-main"><div class="row-gap">' + jkeyChip(j.issue_key) + '<span class="truncate">' + esc(j.summary || "") + "</span></div></div></div>";
        }).join("");
        // Matches from the Jira title index (mostly tickets still in Backlog), fetched while typing.
        var sug = jiraSuggest(ql), sugRows = "";
        if (sug && sug.length) {
          sugRows = sug.filter(function (s) { return !shown[s.key] && !isUrgKey(s.key); }).map(function (s) {
            return '<div class="act-row jsug-row" data-act="jira-pick" data-key="' + esc(s.key) + '" data-title="' + esc(s.summary) + '" style="cursor:pointer">' +
              '<div class="ar-main"><div class="row-gap">' + jkeyChip(s.key) + (s.status ? '<span class="chip soft">' + esc(s.status) + "</span>" : "") + "</div>" +
              '<div class="jsug-title">' + esc(s.summary || "(no title yet)") + "</div></div></div>";
          }).join("");
          if (sugRows) sugRows = '<div class="jsug-h">In Jira' + (m ? "" : " Backlog") + "</div>" + sugRows;
        } else if (sug === null && (ql || "").length >= 2) {
          sugRows = '<div class="jsug-h">Searching Jira...</div>';
        }
        if (!rows && !manual && !sugRows) rows = '<div class="ctx-empty">No matching tickets. Type a ticket key (e.g. SO-1234) or paste a Jira link to link it.</div>';
        return manual + sugRows + rows;
      } } });
  }
  /* Link Ticket form (Quick Actions, and the step after picking a ticket in a chat). Posts one comment to
     the ticket in the team's usual format, nothing else:
         User ID: 8840985

         ID: 01a0ad2a-...
         Application: How to Fish [ID: 3104]
         Playground: Omaha
         <optional text>

         <chat link>
     The chat (Reddit ModMail / Discord / post) is also linked in the console when the link is one we know,
     and the User ID is kept for the L1 "Update the user" cards. */
  var _lt = null;
  function anchorFromLink(link) {
    link = String(link || "");
    var m = /discord(?:app)?\.com\/channels\/\d+\/(\d+)/.exec(link);
    if (m) { var t = ticketByKey(m[1]); return t ? { type: "ticket", ref: tid(t) } : null; }
    m = /mod\.reddit\.com\/mail\/[a-z]+\/([a-z0-9]+)/i.exec(link);
    if (m && convoById(m[1])) return { type: "convo", ref: m[1] };
    var p = (D.redditPosts || []).filter(function (x) { return x.url && link.indexOf(x.url) === 0; })[0];
    return p ? { type: "post", ref: p.id } : null;
  }
  function ltKeyHtml() {
    if (_lt.key) return '<div class="field"><span>Ticket</span><div class="row-gap" style="gap:8px;align-items:flex-start">' + jkeyChip(_lt.key) +
      '<span class="jsug-title" style="flex:1;min-width:0">' + esc(_lt.title || "") + "</span>" +
      (_lt.fixedKey ? "" : '<button type="button" class="btn xs ghost" data-act="lt-key-clear">Change</button>') + "</div></div>";
    return '<label class="field"><span>Ticket</span><input class="f-input" id="lt-key" placeholder="Type the problem or a ticket number (SO-1234), or paste a Jira link" autocomplete="off"></label>' +
      '<div id="lt-sug" class="lt-sug"></div>';
  }
  function ltSugRows(ql) {
    ql = String(ql || "").trim().toLowerCase();
    if (!ql) return "";
    var out = [], shown = {}, m = /([A-Za-z][A-Za-z0-9]+-\d+)/.exec(ql);
    if (m && !isUrgKey(m[1].toUpperCase())) { shown[m[1].toUpperCase()] = 1; out.push([m[1].toUpperCase(), ""]); }
    (D.jira || []).forEach(function (j) {
      if (out.length > 8 || shown[j.issue_key] || isUrgKey(j.issue_key) || jiraCategory(j.status) === "done") return;
      if ((j.issue_key + " " + (j.summary || "")).toLowerCase().indexOf(ql) < 0) return;
      shown[j.issue_key] = 1; out.push([j.issue_key, j.summary || ""]);
    });
    var sug = jiraSuggest(ql);
    (sug || []).forEach(function (s) { if (out.length < 12 && !shown[s.key] && !isUrgKey(s.key)) { shown[s.key] = 1; out.push([s.key, s.summary || ""]); } });
    if (!out.length) return sug === null ? '<div class="jsug-h">Searching Jira...</div>' : '<div class="ctx-empty">No matching tickets.</div>';
    return out.map(function (r) {
      return '<div class="act-row" data-act="lt-key-pick" data-key="' + esc(r[0]) + '" data-title="' + esc(r[1]) + '" style="cursor:pointer"><div class="ar-main">' +
        '<div class="row-gap">' + jkeyChip(r[0]) + "</div>" + (r[1] ? '<div class="jsug-title">' + esc(r[1]) + "</div>" : "") + "</div></div>";
    }).join("");
  }
  function ltPaintSug() {
    var inp = q("#lt-key", modalHost()), box = q("#lt-sug", modalHost());
    if (inp && box) box.innerHTML = ltSugRows(inp.value);
  }
  function ltSetKey(key, title) {
    _lt.key = key; _lt.title = title;
    var el = q("#lt-key-wrap", modalHost()); if (!el) return;
    el.innerHTML = ltKeyHtml();
    var inp = q("#lt-key", modalHost());
    if (inp) { inp.addEventListener("input", ltPaintSug); inp.focus(); }
  }
  function openLinkForm(o) {
    var anchor = o.anchor && o.anchor.type !== "user" ? o.anchor : null;
    _lt = { anchor: anchor, key: o.key || "", title: o.title || "", fixedKey: !!o.key };
    var uid = anchorUserId(anchor);
    _us = { uid: uid, state: "idle", items: [], error: "", box: "lt-session", header: true };
    showModal({ title: "Link Ticket", close: "Cancel", modeless: true,
      footExtra: '<button class="btn primary" data-act="lt-submit">Link</button>',
      custom: function () {
        return '<div class="tform"><div id="lt-key-wrap">' + ltKeyHtml() + "</div>" +
          (anchor ? "" : '<label class="field"><span>Chat link</span><input class="f-input" id="lt-link" placeholder="https://discord.com/channels/... or https://mod.reddit.com/mail/..."></label>') +
          '<label class="field"><span>User ID</span><input class="f-input" id="lt-uid" inputmode="numeric" placeholder="9444330" value="' + esc(uid) + '"></label>' +
          '<div id="urg-sessions">' + usHtml() + "</div>" +
          '<label class="field"><span>Session info</span><textarea class="f-input" id="lt-session" rows="5" placeholder="' + esc(SESSION_PLACEHOLDER) + '"></textarea></label>' +
          '<label class="field"><span>Text <span class="muted" style="font-weight:400">(optional)</span></span><textarea class="f-input" id="lt-text" rows="3"></textarea></label></div>';
      } });
    var host = modalHost();
    var ki = q("#lt-key", host); if (ki) { ki.addEventListener("input", ltPaintSug); ki.focus(); }
    usBind("#lt-uid");
    if (_us.uid) usLoad();   // known from the chat: load right away
  }
  function ltSubmit() {
    var host = modalHost(); if (!host || !_lt) return;
    var key = _lt.key;
    if (!key) { var ki = q("#lt-key", host), mk = ki && /([A-Za-z][A-Za-z0-9]+-\d+)/.exec(ki.value || ""); key = mk ? mk[1].toUpperCase() : ""; }
    if (!key) { toast("Pick a ticket"); return; }
    if (isUrgKey(key)) { toast("Urgent requests are not linked here"); return; }
    // The comment always carries a link to the chat: the social network's own link when we can build it,
    // otherwise the console link (no Discord guild id loaded, a Discord forum post...). The L1 follow-ups
    // and the auto-link read both kinds.
    var link = _lt.anchor ? (commLinkFor(_lt.anchor) || consoleChatLink(_lt.anchor)) : ((q("#lt-link", host) || {}).value || "").trim();
    if (_lt.anchor && !link) { toast("Could not build a link to this chat", "error"); return; }
    if (!_lt.anchor && !/^https?:\/\//i.test(link)) { toast("Required: Chat link"); return; }
    var uid = ((q("#lt-uid", host) || {}).value || "").replace(/\D/g, "");
    var sess = ((q("#lt-session", host) || {}).value || "").trim();
    var text = ((q("#lt-text", host) || {}).value || "").trim();
    if (!uid && !sess) { toast("Required: User ID or Session info"); return; }
    var head = sess;
    if (uid && !/User ID\s*:/i.test(sess)) head = "User ID: " + uid + (sess ? "\n\n" + sess : "");
    var body = head + (text ? "\n" + text : "") + (link ? "\n\n" + link : "");
    var anchor = _lt.anchor || anchorFromLink(link), title = _lt.title;
    // What the server looks for in the ticket's existing comments (no free text: it must not cause a
    // false match) and whether this ticket is already linked to this chat.
    var route = anchor ? handoffRoute({ context_type: anchor.type, ref: anchor.ref }) : "";
    var refs = [head, link, route].filter(Boolean).join("\n");
    var linked = anchorHasJira(anchor, key);
    function done(res) {
      if (uid) { D.userJira = D.userJira || {}; var ul = D.userJira[uid] || (D.userJira[uid] = []); if (ul.indexOf(key) < 0) ul.push(key);
        window.CONSOLE.post("/jira-user-link", { user_id: uid, issue_key: key }).then(function () {}, function () {}); }
      if (anchor) linkJiraToChat(anchor, key); else { closeModal(); render(); }
      if (res && res.skipped) {
        toast("Linked " + key + ". No new Jira comment: one already mentions " + (res.mention || "this user"));
        logActivity("linked Jira " + key + " (comment already there)", link);
        return;
      }
      toast("Linked " + key + (title ? DOT + title : ""));
      logActivity("linked Jira " + key, link);
    }
    var btn = q('[data-act="lt-submit"]', host); if (btn) { btn.disabled = true; btn.textContent = "Linking..."; }
    window.CONSOLE.postMsg("/jira-link-comment", { issue_key: key, body: body, refs: refs, linked: linked }).then(function (res) {
      if (res.status >= 200 && res.status < 300) { done(res.data || {}); return; }
      if (btn) { btn.disabled = false; btn.textContent = "Link"; }
      toast((res.data && res.data.error) || "Could not post to Jira, try again", "error");
    }, function () { if (btn) { btn.disabled = false; btn.textContent = "Link"; } toast("Could not post to Jira, try again", "error"); });
  }
  /* Search User ID: find a person by their social name (or by the ID itself) and get the Boosteroid
     User ID. Records that still hold only a legacy email offer a one-click lookup instead of the address. */
  function modalSearchEmail() {
    // Bindings made a moment ago (another operator, the Facebook extension) count too: reload the directory.
    window.CONSOLE.get("/users-emails").then(function (recs) {
      if (!Array.isArray(recs)) return;
      D._emailRecs = recs.slice(); D.users = buildUsers(recs);
      var si = document.getElementById("modal-search-input"), box = document.getElementById("modal-results");
      if (si && box && state.modal && state.modal.search) box.innerHTML = state.modal.search.run((si.value || "").toLowerCase());
    }, function () {});
    return { title: "Search User ID", close: "Close",
      search: { placeholder: "Reddit / Discord / Facebook name, or a User ID...", run: function (ql) {
        var rows = D.users.filter(function (u) {
          return !ql || [].concat(u.reddits || [], u.discord_names || [], u.discord_ids || [], u.facebooks || [], u.user_ids || [], u.emails || [])
            .some(function (x) { return x && String(x).toLowerCase().indexOf(ql) >= 0; });
        }).slice(0, 80);
        if (!rows.length) return '<div class="ctx-empty">No matches.</div>';
        return rows.map(function (u) {
          var parts = [];
          (u.reddits || []).forEach(function (r) { parts.push("Reddit u/" + esc(r)); });
          (u.discord_names.length ? u.discord_names : u.discord_ids).forEach(function (d) { parts.push("Discord " + esc(d)); });
          (u.facebooks || []).forEach(function (f) { parts.push("Facebook " + esc(f)); });
          var uid = (u.user_ids || [])[0] || "", em = (u.emails || [])[0] || "";
          var sub = uid ? "User ID " + esc(uid) : (em ? "User ID not looked up yet" : "No User ID on file");
          var btn = uid
            ? '<button class="btn sm ghost" data-act="copy-uid" data-uid="' + esc(uid) + '">' + ic("copy", "ico-sm") + "Copy</button>" +
              '<a class="btn sm ghost" href="' + esc(adminSessionsUrl(uid)) + '" target="_blank" rel="noopener">' + ic("external", "ico-sm") + "Admin</a>"
            : (em && /@/.test(em) ? '<button class="btn sm ghost" data-act="find-uid" data-email="' + esc(em) + '">' + ic("user", "ico-sm") + "Find</button>" : "");
          return '<div class="act-row"><div class="ar-main"><div class="truncate">' + (parts.join(DOT) || "Unknown") + "</div>" +
            '<div class="ar-sub mono">' + sub + "</div></div>" + btn +
            '<button class="btn sm ghost" data-go="#/user/' + esc(u.id) + '">' + ic("user", "ico-sm") + "360</button></div>";
        }).join("");
      } } };
  }
  function modalSearchTickets() {
    return { title: "Search Discord Tickets", close: "Close",
      search: { placeholder: "username, username#1234, or numeric user ID", run: function (ql) {
        var rows = D.discordTickets.filter(function (t) {
          return !ql || (String(t.user_name) + " " + String(t.user_id)).toLowerCase().indexOf(ql) >= 0;
        });
        if (!rows.length) return '<div class="ctx-empty">No matches.</div>';
        return rows.map(function (t) {
          return '<div class="act-row"><div class="ar-main"><div class="truncate">#' + t.ticket_number + DOT + esc(t.user_name) + "</div>" +
            '<div class="ar-sub">' + esc(t.metadata.description) + "</div></div>" +
            '<button class="btn sm ghost" data-go="#/discord/' + tid(t) + '">' + ic("external", "ico-sm") + "Open</button></div>";
        }).join("");
      } } };
  }
  function openReportView(id) {
    var r = D.reports.filter(function (x) { return x.id === id; })[0]; if (!r) return;
    showModal({ title: (r.type === "weekly" ? "Weekly Report" : "Community Report") + DOT + r.author + DOT + r.date, close: "Close",
      custom: function () {
        return r.fields.map(function (f) {
          return '<div class="field"><label>' + esc(f[0]) + '</label><div class="read-val">' + esc(f[1] || "-") + "</div></div>";
        }).join("");
      } });
  }

  /* Where the modal engine renders: the centered blocking box, or the floating modeless popover
     (item W5). A modeless popover has NO backdrop, so the chat behind it stays clickable. */
  function modalHost() { return q(state.modeless ? "#popover" : "#modal-box"); }
  function showModal(spec) {
    if (!spec) return;
    closeModal();                    // never stack a modal + popover
    state.modal = spec;
    state.modeless = !!spec.modeless;
    q("#modal-box").classList.toggle("modal-wide", !!spec.wide && !spec.modeless);
    state.modalValues = spec.initial ? JSON.parse(JSON.stringify(spec.initial)) : {};
    state.modalQuery = "";
    renderModal();
    if (state.modeless) {
      var pop = q("#popover"); pop.classList.add("open");
      // Default anchor: upper area of the detail pane; keep any prior dragged position.
      if (!pop.style.top) { pop.style.top = "90px"; pop.style.right = "36px"; pop.style.left = "auto"; }
    } else {
      q("#modal-overlay").classList.add("open");
    }
    if (!spec.search) {
      var first = q(".f-input", modalHost());
      if (first) setTimeout(function () { first.focus(); }, 20);
    }
  }
  function openModal(key) { showModal(MODALS[key] && MODALS[key]()); }
  function closeModal() {
    state.modal = null;
    state.modeless = false;
    q("#modal-overlay").classList.remove("open");
    q("#modal-box").innerHTML = "";
    var pop = q("#popover"); if (pop) { pop.classList.remove("open"); pop.innerHTML = ""; }
  }
  /* User-initiated close (X / Cancel / backdrop / Esc). A modal may define beforeClose() to guard
     against losing unsaved work; returning false keeps it open. A programmatic closeModal() (e.g.
     right after a successful save) bypasses the guard on purpose. */
  function attemptCloseModal() {
    var m = state.modal;
    if (m && typeof m.beforeClose === "function" && m.beforeClose() === false) return;
    closeModal();
  }
  /* Drag the modeless popover by its header (item W5). */
  var _popDrag = null;
  document.addEventListener("mousedown", function (e) {
    var head = e.target.closest && e.target.closest('[data-drag="popover"]');
    if (!head || (e.target.closest && e.target.closest("[data-act]"))) return;   // header, not the close button
    var pop = q("#popover"); if (!pop || !pop.classList.contains("open")) return;
    var rect = pop.getBoundingClientRect();
    _popDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    pop.style.left = rect.left + "px"; pop.style.top = rect.top + "px"; pop.style.right = "auto";
    e.preventDefault();
  });
  document.addEventListener("mousemove", function (e) {
    if (!_popDrag) return;
    var pop = q("#popover"); if (!pop) return;
    pop.style.left = Math.max(4, Math.min(window.innerWidth - 80, e.clientX - _popDrag.dx)) + "px";
    pop.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - _popDrag.dy)) + "px";
  });
  document.addEventListener("mouseup", function () { _popDrag = null; });
  function visibleFields() {
    return (state.modal.fields || []).filter(function (f) {
      if (!f.showWhen) return true;
      return (state.modalValues[f.showWhen.field] || "") === f.showWhen.value;
    });
  }
  function fieldHtml(f) {
    var v = state.modalValues[f.id];
    var mark = f.required ? '<span class="req">*</span>' : ' <span class="opt">(optional)</span>';
    var ctrl;
    if (f.type === "textarea") {
      ctrl = '<textarea class="f-input" data-field="' + f.id + '" placeholder="' + esc(f.placeholder || "") + '">' + esc(v || "") + "</textarea>";
    } else if (f.type === "select") {
      ctrl = '<select class="f-input mini-select" data-field="' + f.id + '"' + (f.controls ? " data-modal-controls" : "") + ">" +
        '<option value="">' + esc(f.placeholder || "Select...") + "</option>" +
        f.options.map(function (o) { return '<option value="' + esc(o) + '"' + (v === o ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select>";
    } else if (f.type === "multiselect") {
      var sel = v || [];
      // Options may be plain strings, or {value,label} objects for a friendlier chip label.
      ctrl = '<div class="ms" data-field="' + f.id + '">' + f.options.map(function (o) {
        var val = (o && typeof o === "object") ? o.value : o;
        var lbl = (o && typeof o === "object") ? (o.label || o.value) : o;
        return '<button type="button" class="ms-chip' + (sel.indexOf(val) >= 0 ? " on" : "") + '" data-act="ms-toggle" data-field="' + f.id + '" data-val="' + esc(val) + '">' + esc(lbl) + "</button>";
      }).join("") + "</div>";
    } else {
      var itype = f.type === "number" ? "number" : (f.type === "email" ? "email" : (f.type === "url" ? "url" : (f.type === "password" ? "password" : (f.type === "datetime" ? "datetime-local" : "text"))));
      ctrl = '<input class="f-input" type="' + itype + '" data-field="' + f.id + '" placeholder="' + esc(f.placeholder || "") + '" value="' + esc(v || "") + '">';
    }
    return '<div class="field"><label>' + esc(f.label) + mark + "</label>" + ctrl +
      (f.hint ? '<div class="f-hint">' + esc(f.hint) + "</div>" : "") + "</div>";
  }
  /* The box that really scrolls a chat: the .thread itself on desktop, but on a phone the thread grows
     and the whole screen (.view) scrolls - setting .thread.scrollTop there did nothing, so chats opened
     at the TOP. Walks up to the first scrollable ancestor. */
  function threadScroller(th) {
    var el = th;
    while (el && el !== document.body) {
      var oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return th;
  }
  /* Open / send / back-to-chat: show the latest messages. Images that finish loading afterwards grow the
     thread, so it re-pins once each loads (only while the reader is still at the bottom). */
  function scrollThreadToEnd() {
    var th = q(".thread"); if (!th) return;
    var sc = threadScroller(th); sc.scrollTop = sc.scrollHeight;
    Array.prototype.forEach.call(th.querySelectorAll("img"), function (img) {
      if (img.complete) return;
      img.addEventListener("load", function () {
        var s = threadScroller(th);
        if (s.scrollHeight - s.scrollTop - s.clientHeight < img.offsetHeight + 120) s.scrollTop = s.scrollHeight;
      }, { once: true });
    });
  }
  function renderModal() {
    var m = state.modal; if (!m) return;
    var body;
    if (m.search) {
      body = '<div class="modal-search">' + ic("search", "ico-sm") +
        '<input id="modal-search-input" placeholder="' + esc(m.search.placeholder || "Search...") + '" value="' + esc(state.modalQuery || "") + '"></div>' +
        '<div class="modal-results act-list" id="modal-results">' + m.search.run((state.modalQuery || "").toLowerCase()) + "</div>";
    } else if (m.custom) {
      body = m.custom();
    } else {
      var intro = (typeof m.intro === "function") ? m.intro() : (m.intro || "");   // read-only block above the fields
      body = intro + visibleFields().map(fieldHtml).join("");
    }
    // Re-rendering the SAME modal (a checkbox, an arrow, a filter) keeps where it was scrolled to:
    // remember every scrolled box (by its class list + position among those) and restore it after.
    var _host = modalHost(), _scr = [];
    if (state._modalScrollFor === m) {
      Array.prototype.forEach.call(_host.querySelectorAll("*"), function (el) {
        if (el.scrollTop > 0 && typeof el.className === "string" && el.className) {
          var same = _host.querySelectorAll("." + el.className.trim().split(/\s+/).join("."));
          _scr.push([el.className, Array.prototype.indexOf.call(same, el), el.scrollTop]);
        }
      });
    }
    state._modalScrollFor = m;
    modalHost().innerHTML =
      '<div class="modal-head"' + (state.modeless ? ' data-drag="popover"' : "") + '><h2 class="serif truncate">' + esc(m.title) + "</h2>" +
      '<button class="icon-btn" title="Close" data-act="modal-close">' + ic("x") + "</button></div>" +
      '<div class="modal-body">' + body + "</div>" +
      '<div class="modal-foot">' +
      '<button class="btn ghost" data-act="modal-close">' + esc(m.close || "Cancel") + "</button>" +
      (m.submit ? '<button class="btn primary" data-act="modal-submit">' + esc(m.submit) + "</button>" : "") +
      (m.footExtra || "") +
      "</div>";
    _scr.forEach(function (s) {
      var el = _host.querySelectorAll("." + s[0].trim().split(/\s+/).join("."))[s[1]];
      if (el) el.scrollTop = s[2];
    });
    if (m.search) {
      var si = q("#modal-search-input");
      if (si) setTimeout(function () { si.focus(); }, 10);
    }
  }
  function syncModalValues() {
    if (!state.modal || !state.modal.fields) return;
    Array.prototype.forEach.call(modalHost().querySelectorAll("input.f-input, textarea.f-input, select.f-input"), function (el) {
      state.modalValues[el.getAttribute("data-field")] = el.value;
    });
  }
  function msToggle(btn) {
    var id = btn.getAttribute("data-field"), val = btn.getAttribute("data-val");
    var arr = state.modalValues[id] || (state.modalValues[id] = []);
    var i = arr.indexOf(val);
    if (i >= 0) { arr.splice(i, 1); btn.classList.remove("on"); }
    else { arr.push(val); btn.classList.add("on"); }  /* toggle in place - no full re-render */
  }
  function submitModal() {
    var m = state.modal; if (!m) return;
    syncModalValues();
    var missing = visibleFields().filter(function (f) {
      if (!f.required) return false;
      var v = state.modalValues[f.id];
      return f.type === "multiselect" ? !(v && v.length) : !(v && String(v).trim());
    });
    if (missing.length) { toast("Required: " + missing[0].label); return; }
    var onSubmit = m.onSubmit, values = state.modalValues;
    closeModal();
    if (onSubmit) onSubmit(values);
  }

  /* ---------- Admin panel ---------- */
  // One permission per console section (must mirror ALL_PERMS in console_auth.py and the NAV `perm` keys).
  // {value,label} so the Rights editor shows a readable name for each section.
  var PERMS = [
    { value: "reddit",    label: "Reddit ModMail" },
    { value: "posts",     label: "Reddit Posts" },
    { value: "reddit_comments", label: "Reddit Comments" },
    { value: "discord",   label: "Discord" },
    { value: "facebook",  label: "Facebook" },
    { value: "telegram",  label: "Telegram" },
    { value: "jira",      label: "Jira" },
    { value: "known",     label: "Known Issues" },
    { value: "gamecards", label: "Game Cards" },
    { value: "maintenance", label: "Maintenance" },
    { value: "wishlist",  label: "Wishlist" },
    { value: "actions",   label: "Quick Actions" },
    { value: "schedule",  label: "Schedule" },
    { value: "admin",     label: "Admin (full access)" }
  ];
  var PERM_VALUES = PERMS.map(function (p) { return p.value; });
  // A new member gets every section except Admin by default (mirrors DEFAULT_PERMS on the backend).
  var DEFAULT_PERMS = PERM_VALUES.filter(function (p) { return p !== "admin"; });
  var TPL_CATS = ["General", "Technical", "Posts", "ModMail"];

  /* Admin-only settings are fetched when the Admin page is open (not in every operator's start-up burst,
     where non-admins only got 403s). While the page stays open they are re-read at most once a minute. */
  var ADMIN_DATA_TTL = 60000;
  function ensureAdminData() {
    if (!isAdmin()) return;
    if (state._adminDataAt && Date.now() - state._adminDataAt < ADMIN_DATA_TTL) return;
    state._adminDataAt = Date.now();
    var C = window.CONSOLE, obj = function (d) { return d && typeof d === "object" && !Array.isArray(d); };
    Promise.all([
      C.get("/forums-config").then(function (d) { if (obj(d)) D.forumConfig = d; }, function () {}),
      C.get("/reminders-config").then(function (d) { if (obj(d)) D.remindersConfig = d; }, function () {}),
      C.get("/known-issues-config").then(function (d) { if (obj(d)) D.knownConfig = d; }, function () {}),
      C.get("/known-issues-suggestions").then(function (list) {
        if (Array.isArray(list)) D.knownSuggestions = list.map(function (s) { s.id = s.id || s._id; return s; });
      }, function () {}),
      C.get("/schedule-config").then(function (d) { if (obj(d)) D.scheduleConfig = d; }, function () {}),
      C.get("/maintenance-sheet-config").then(function (d) { if (obj(d)) D.maintSheetConfig = d; }, function () {}),
      C.get("/ignored-reddit").then(function (d) { if (d && Array.isArray(d.users)) D.ignoredReddit = d.users; }, function () {}),
      C.get("/moderators-discord").then(function (d) { if (d && Array.isArray(d.users)) D.moderatorsDiscord = d.users; }, function () {}),
      C.get("/image-whitelist-discord").then(function (d) { if (d && Array.isArray(d.users)) D.imageWhitelistDiscord = d.users; }, function () {}),
      C.get("/reddit-flag-alert").then(function (d) { if (obj(d)) D.redditFlagAlert = d; }, function () {})
    ]).then(function () { if (parseHash().view === "admin") renderFresh(); });
  }
  function viewAdmin() {
    ensureAdminData();
    /* Users */
    var userRows = D.team.map(function (m) {
      return '<div class="act-row" style="flex-direction:column;align-items:stretch;gap:8px">' +
        '<div class="ar-main">' +
        '<div class="row-gap"><span class="lq-av sm">' + esc(m.initials) + "</span>" +
        '<span class="truncate"><b>' + esc(m.name) + "</b>" + (m.role === "admin" ? ' <span class="chip soft" style="padding:0 7px">admin</span>' : "") + "</span></div>" +
        '<div class="ar-sub mono truncate">' + esc(m.email) + "</div>" +
        '<div class="ar-sub truncate" style="margin-top:2px">' + ic("clock", "ico-sm") + " " + esc(m.hours) + "</div>" +
        '<div class="ar-sub truncate" style="margin-top:2px">' + ic("user", "ico-sm") + " " +
          "alias " + esc(m.alias || "-") + (m.display_name && m.display_name !== m.name ? DOT + "shown as " + esc(m.display_name) : "") + "</div>" +
        '<div class="ar-sub truncate" style="margin-top:2px">' + ic("link", "ico-sm") + " " + esc(identitySummary(m)) + "</div>" +
        "</div>" +
        '<div class="row-gap" style="gap:6px;flex-wrap:wrap">' +
        '<button class="btn sm ghost" data-act="admin-identity" data-id="' + esc(m.id) + '" title="Identity + linked accounts">' + ic("link", "ico-sm") + "Identity</button>" +
        '<button class="btn sm ghost" data-act="admin-hours" data-id="' + esc(m.id) + '" title="Working hours + Testing window">' + ic("clock", "ico-sm") + "Hours</button>" +
        '<button class="btn sm ghost" data-act="admin-leave" data-id="' + esc(m.id) + '" title="Vacation / sick allowance">' + ic("calendar", "ico-sm") + "Leave</button>" +
        '<button class="btn sm ghost" data-act="admin-perms" data-id="' + esc(m.id) + '" title="Rights">' + ic("shield", "ico-sm") + "Rights</button>" +
        '<button class="btn sm ghost" data-act="admin-user-pw" data-id="' + esc(m.id) + '" title="Set password">' + ic("shield", "ico-sm") + "Password</button>" +
        (!m.has_password ? '<button class="btn sm ghost" data-act="admin-user-invite" data-id="' + esc(m.id) + '" title="Show / reset the first-run invite code to share">' + ic("shield", "ico-sm") + "Invite code</button>" : "") +
        '<button class="btn sm ghost" data-act="admin-user-del" data-id="' + esc(m.id) + '" data-name="' + esc(m.name) + '" title="Delete user">' + ic("x", "ico-sm") + "Delete</button>" +
        "</div></div>";
    }).join("");
    var users = panel("user", "Users", D.team.length,
      '<div class="section-note" style="margin-bottom:10px">Create accounts, set working hours, edit rights.</div>' +
      '<div class="act-list">' + userRows + "</div>" +
      '<button class="btn primary" data-act="modal" data-modal="create-user" style="margin-top:12px">' + ic("plus", "ico-sm") + "Create user</button>");

    /* Activity monitor */
    var actRows = D.activity.map(function (a) {
      return actRow("<b>" + esc(a.user) + "</b> " + esc(a.action), esc(a.target), a.ago);
    }).join("") || '<div class="ctx-empty">No activity.</div>';
    // Capped height with its own scroll so a long history doesn't stretch the whole Admin page.
    var activity = panel("bolt", "Activity monitor", D.activity.length || null,
      '<div class="act-list act-scroll" data-keep-scroll="admin-activity">' + actRows + "</div>");

    /* Templates */
    // Compact list (item W8): category + title only; full body shows in the Edit modal.
    var tplRows = D.templates.map(function (t) {
      return '<div class="act-row"><div class="ar-main">' +
        '<div class="row-gap"><span class="chip soft" style="padding:1px 8px">' + esc(t.category) + '</span><b class="truncate">' + esc(t.title) + "</b></div></div>" +
        '<div class="row-gap" style="flex:none">' +
        '<button class="btn sm ghost" data-act="admin-tpl" data-id="' + esc(t.id) + '">' + ic("notes", "ico-sm") + "Edit</button>" +
        '<button class="btn sm ghost iconly" data-act="admin-tpl-del" data-id="' + esc(t.id) + '" title="Delete">' + ic("x", "ico-sm") + "</button></div></div>";
    }).join("") || '<div class="ctx-empty">No templates.</div>';
    var templates = panel("notes", "Reply templates", D.templates.length,
      '<div class="section-note" style="margin-bottom:10px">Any user can insert these into a conversation (insert flow coming next).</div>' +
      '<div class="act-list">' + tplRows + "</div>" +
      '<button class="btn primary" data-act="modal" data-modal="create-tpl" style="margin-top:12px">' + ic("plus", "ico-sm") + "Add template</button>");

    /* Variables & links */
    var varRows = D.variables.map(function (v) {
      return '<div class="var-row"><label>' + esc(v.label) + "</label>" +
        '<div class="row-gap"><input class="f-input" data-var-id="' + esc(v.id) + '" value="' + esc(v.value) + '">' +
        '<button class="btn sm" data-act="var-save" data-id="' + esc(v.id) + '">' + ic("check", "ico-sm") + "Save</button></div></div>";
    }).join("");
    var variables = panel("link", "Variables & links", null, '<div class="stack" style="gap:14px">' + varRows + "</div>");

    /* Reddit ignored accounts (identity): "clean" accounts NOT tied to a team member
       (Reddit bots we don't own). Team moderators are NOT listed here - they are derived
       automatically from each member's linked accounts in their profile Identity (reddit_username /
       discord_name), so there is nothing else to maintain by hand. This list only mutes the bot's
       Slack alerts; the console still shows every comment. */
    var ignoredReddit = panel("posts", "Reddit - ignored accounts", (D.ignoredReddit || []).length || null,
      '<div class="section-note" style="margin-bottom:8px">Reddit accounts the bot skips for Slack alerts (bots like AutoModerator). Your team\'s moderators (Reddit + Discord) are picked up automatically from each person\'s profile Identity - no separate moderator list to maintain.</div>' +
      '<textarea class="f-input" data-list-key="ignored-reddit" style="min-height:88px" placeholder="One username per line">' + esc((D.ignoredReddit || []).join("\n")) + "</textarea>" +
      '<button class="btn primary" data-act="list-save" data-key="ignored-reddit" style="margin-top:10px">' + ic("check", "ico-sm") + "Save</button>");

    /* Discord notification recipients + Identity authority . */
    var discordRecipients = panel("discord", "Discord recipients", (D.moderatorsDiscord || []).length || null,
      '<div class="section-note" style="margin-bottom:8px">Extra Discord accounts (name or id, one per line) that should get moderator-mention notifications in addition to the team profiles - use this for custom recipients not tied to a person.</div>' +
      '<textarea class="f-input" data-list-key="moderators-discord" style="min-height:76px" placeholder="One Discord name or id per line">' + esc((D.moderatorsDiscord || []).join("\n")) + "</textarea>" +
      '<button class="btn primary" data-act="list-save" data-key="moderators-discord" style="margin-top:10px">' + ic("check", "ico-sm") + "Save recipients</button>");

    /* Permanent whitelist for the Discord image ratelimit (the image-spam alert never fires for these). */
    var imageWhitelist = panel("shield", "Discord - image ratelimit whitelist", (D.imageWhitelistDiscord || []).length || null,
      '<div class="section-note" style="margin-bottom:8px">Discord accounts (name or id, one per line) that are never subject to the image ratelimit. Team moderators are always exempt. Users added from the Telegram alert button expire after 30 days; this list is permanent. Changes apply within a minute.</div>' +
      '<textarea class="f-input" data-list-key="image-whitelist-discord" style="min-height:76px" placeholder="One Discord name or id per line">' + esc((D.imageWhitelistDiscord || []).join("\n")) + "</textarea>" +
      '<button class="btn primary" data-act="list-save" data-key="image-whitelist-discord" style="margin-top:10px">' + ic("check", "ico-sm") + "Save whitelist</button>");

    /* History cleanup */
    var history = panel("clock", "History cleanup", null,
      '<div class="section-note" style="margin-bottom:10px">Move every current Reddit ModMail conversation, Post, Telegram message, Discord Mention and Forum post into the History view (a big imported backlog is cleared at once). Items with no activity for 5+ days are already there automatically; new activity brings an item back. Discord tickets and Jira are not affected.</div>' +
      '<button class="btn primary" data-act="history-all">' + ic("clock", "ico-sm") + "Move all Reddit to History</button>");

    /* Reports overview (all users) */
    var allRep = D.reports.map(function (r) {
      return '<div class="act-row" data-act="report-view" data-id="' + esc(r.id) + '" style="cursor:pointer"><div class="ar-main">' +
        '<div class="row-gap"><span class="chip soft" style="padding:1px 8px">' + (r.type === "weekly" ? "Weekly" : "Daily") + "</span><b>" + esc(r.author) + "</b>" +
        '<span class="truncate muted">' + esc((r.fields[0] && r.fields[0][1]) || "") + "</span></div></div>" +
        '<span class="ar-meta">' + esc(r.date) + "</span></div>";
    }).join("") || '<div class="ctx-empty">No reports.</div>';
    var reports = panel("book", "Reports (all users)", D.reports.length, '<div class="act-list">' + allRep + "</div>");

    /* Bot worker + actions queue (audit log) */
    if (!state.botActions.loaded && !state.botActions.loading) loadBotActions();
    var qItems = state.botActions.items || [];
    var qRows = qItems.length ? qItems.map(function (act) {
      var when = act.finished_at || act.created_at;
      var main = '<span class="st ' + statusClass(act.status) + '" style="font-size:11px">' + esc(act.status) + "</span> <b>" + esc(act.type) + "</b>" +
        (act.error ? ' <span class="muted">' + esc(act.error) + "</span>" : "");
      return actRow(main, esc(act.requested_by || ""), timeText(when));
    }).join("") : '<div class="ctx-empty">' + (state.botActions.loading ? "Loading..." : "No actions yet.") + "</div>";
    var bot = panel("wrench", "Bot worker & queue", qItems.length || null,
      '<div class="action-btns">' +
      '<button class="btn" data-act="bot-ping">' + ic("check", "ico-sm") + "Ping bot worker</button>" +
      '<button class="btn ghost" data-act="bot-actions-refresh">' + ic("refresh", "ico-sm") + "Refresh</button>" +
      "</div>" +
      '<div class="act-list" style="margin-top:12px">' + qRows + "</div>" +
      '<div class="section-note" style="margin-top:10px">Every console action (Discord replies, pings, ...) is a row here with its status - a live audit log. Done rows auto-clean after 30 days, errors after 90.</div>');

    // the Admin page is split into sections (tabs) instead of one long pile of panels.
    // Every panel is still here, each in exactly one section; only the active section is rendered.
    var ADMIN_TABS = [
      { key: "team",       label: "Team",         panels: function () { return users + adminLeavePanel() + activity; } },
      { key: "known",      label: "Known Issues", panels: function () { return adminKnownSuggestionsPanel() + adminKnownPanel(); } },
      { key: "sheets",     label: "Sheets",       panels: function () { return adminSchedulePanel() + adminGameCardsPanel() + adminGameTestingPanel() + adminMaintSheetPanel(); } },
      { key: "reddit",     label: "Reddit",       panels: function () { return ignoredReddit + adminRedditFlagPanel() + history; } },
      { key: "discord",    label: "Discord",      panels: function () { return adminForumsPanel() + discordRecipients + imageWhitelist; } },
      { key: "automation", label: "Automation",   panels: function () { return adminRemindersPanel() + bot; } },
      { key: "content",    label: "Content",      panels: function () { return templates + variables; } },
      { key: "data",       label: "Data",         panels: function () { return adminDbPanel(); } },
      { key: "reports",    label: "Reports",      panels: function () { return reports; } }
    ];
    if (!state.adminTab) { try { state.adminTab = localStorage.getItem("cmt-admin-tab") || "team"; } catch (e) { state.adminTab = "team"; } }
    var _hTab = parseHash().id;   // #/admin/known (links from notifications) opens that tab
    if (_hTab && ADMIN_TABS.some(function (t) { return t.key === _hTab; })) state.adminTab = _hTab;
    var curAdmin = ADMIN_TABS.filter(function (t) { return t.key === state.adminTab; })[0] || ADMIN_TABS[0];
    var adminTabs = '<div class="subtabs admin-tabs" role="tablist" aria-label="Admin sections">' + ADMIN_TABS.map(function (t) {
      var on = t.key === curAdmin.key;
      return '<button class="stab' + (on ? " active" : "") + '" role="tab" aria-selected="' + (on ? "true" : "false") + '" data-act="admin-tab" data-key="' + t.key + '">' + esc(t.label) + "</button>";
    }).join("") + "</div>";
    return '<div class="page admin-page"><div class="page-head"><div><h1>Admin</h1></div></div>' + adminTabs +
      '<div class="actions-grid admin-grid admin-sec-' + curAdmin.key + '">' + curAdmin.panels() + "</div></div>";
  }

  function modalCreateUser() {
    return { title: "Create user", submit: "Create", close: "Cancel",
      onSubmit: function (v) {
        var name = v.name || "New User";
        window.CONSOLE.post("/users", { name: name, email: v.email, role: v.role || "member", title: v.title, hours: v.hours }).then(function (u) {
            if (u && u.id) { D.team.push(u); render(); showInviteCode(u.email, u.invite); }
            else toast("Create failed" + (u && u.error ? ": " + u.error : ""));
          }, function (s) { toast(s === 409 ? "A user with that email already exists" : "Create failed"); });
      },
      fields: [
        { id: "name", label: "Full name", type: "text", required: true, placeholder: "e.g. Sam T." },
        { id: "email", label: "Email", type: "email", required: true, placeholder: "sam.t@boosteroid.com" },
        { id: "title", label: "Title", type: "text", placeholder: "Community Team" },
        { id: "role", label: "Role", type: "select", required: true, placeholder: "Role", options: ["member", "admin"] },
        { id: "hours", label: "Working hours", type: "text", placeholder: "Mon-Fri 09:00-18:00 (Europe/Kiev)" }
      ] };
  }
  function modalCreateTpl() {
    return { title: "Add template", submit: "Add", close: "Cancel",
      onSubmit: function (v) {
        window.CONSOLE.post("/templates", { title: v.title, category: v.category || "General", body: v.body }).then(function (t) {
            if (t && t.id) { D.templates.push(t); render(); toast("Template added"); } else toast("Failed");
          }, function () { toast("Failed"); });
      },
      fields: [
        { id: "title", label: "Title", type: "text", required: true, placeholder: "Short name" },
        { id: "category", label: "Category", type: "select", required: true, placeholder: "Category", options: TPL_CATS },
        { id: "body", label: "Message", type: "textarea", required: true, placeholder: "Template text..." }
      ] };
  }
  /* Short summary of a member's linked social accounts, for the admin card. */
  function identitySummary(m) {
    var parts = [];
    if (m.slack_id) parts.push("Slack");
    if (m.telegram_id) parts.push("TG");
    if (m.jira_account_id) parts.push("Jira");
    if (m.discord_id || m.discord_name) parts.push("Discord");
    if (m.reddit_username) parts.push("Reddit u/" + m.reddit_username);
    return parts.length ? parts.join(", ") : "no linked accounts yet";
  }
  /* Admin editor for a member's identity: the unifying alias + display name + one id per
     platform. The bot and console resolve "who did what" through these links. (items 2, 3) */
  function allScheduleMembers() {
    var set = {}, out = [];
    ((D.schedule && D.schedule.months) || []).forEach(function (mo) {
      (mo.members || []).forEach(function (mm) { if (!schHidden(mm) && !set[mm]) { set[mm] = 1; out.push(mm); } });
    });
    return out;
  }
  function openIdentity(id) {
    var m = memberById(id); if (!m) return;
    var memberOpts = allScheduleMembers();
    if (m.schedule_member && memberOpts.indexOf(m.schedule_member) < 0) memberOpts.push(m.schedule_member);
    showModal({ title: "Identity - " + m.name, submit: "Save", close: "Cancel",
      initial: { alias: m.alias || "", name: m.name || "", schedule_member: m.schedule_member || "",
        slack_id: m.slack_id || "", telegram_id: m.telegram_id || "", jira_account_id: m.jira_account_id || "",
        discord_id: m.discord_id || "", discord_name: m.discord_name || "", reddit_username: m.reddit_username || "",
        cloud_user_id: m.cloud_user_id || "" },
      onSubmit: function (v) {
        // Edit the account's Full Name (created at sign-up); keep display_name in sync with it so the
        // name shown across all socials is just the Full Name (no separate display-name concept).
        var payload = { name: v.name, display_name: v.name, alias: v.alias, schedule_member: v.schedule_member,
          slack_id: v.slack_id,
          telegram_id: v.telegram_id, jira_account_id: v.jira_account_id, discord_id: v.discord_id,
          discord_name: v.discord_name, reddit_username: v.reddit_username,
          cloud_user_id: String(v.cloud_user_id || "").replace(/\D/g, "") };
        window.CONSOLE.patch("/users/" + encodeURIComponent(id), payload).then(function (u) {
            if (u && u.id) { updateTeamMember(u); render(); toast("Identity saved"); } else toast("Save failed");
          }, function () { toast("Save failed"); });
      },
      fields: [
        { id: "name", label: "Full name (shown across all socials)", type: "text", required: true, placeholder: "e.g. Oleg Teleshko" },
        { id: "alias", label: "Alias (unifying key)", type: "text", required: true, placeholder: "e.g. o.teleshko", hint: "Matches the .env alias; links Slack/Telegram/Jira." },
        { id: "schedule_member", label: "Calendar member (schedule binding)", type: "select", options: memberOpts, placeholder: "— not bound —", hint: "Which schedule column is this person, so their calendar Vacation/Sick applies to them." },
        { id: "slack_id", label: "Slack user ID", type: "text", placeholder: "U08ABC123" },
        { id: "telegram_id", label: "Telegram ID", type: "text", placeholder: "749211636" },
        { id: "cloud_user_id", label: "Boosteroid User ID", type: "text", placeholder: "9444330", hint: "This member's own account ID from the cloud admin. Used to list their sessions in Add Testing Session." },
        { id: "jira_account_id", label: "Jira account ID", type: "text", placeholder: "712020:b8865bb0-b2fa-46d5-8f01-0e09215248a1", hint: "Full Atlassian accountId (prefix:uuid). From the .env JIRA_OUR_USER_IDS entry, take the first two parts only - the third part (alias) goes in the Alias field above." },
        { id: "discord_id", label: "Discord user ID", type: "text", placeholder: "233117845" },
        { id: "discord_name", label: "Discord moderator name", type: "text", placeholder: "[Mod] Viktor" },
        { id: "reddit_username", label: "Reddit username", type: "text", placeholder: "Viktor_Boosteroid", hint: "Auto-excluded from Slack alerts; the console still shows their comments." }
      ] });
  }
  /* Working hours as a per-day schedule (item X3): each day can be on/off with its own start/end,
     and an overnight shift (end <= start, e.g. 22:00 to 06:00) is supported + flagged "+1 day". */
  var HOURS_DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
  function _hhmm(v) { return /^\d{1,2}:\d{2}$/.test(String(v || "")) ? (String(v).length === 4 ? "0" + v : v) : "09:00"; }
  function _tmin(v) { var p = String(v).split(":"); return (+p[0]) * 60 + (+p[1]); }
  function defaultSchedule() { var s = {}; HOURS_DAYS.forEach(function (d, i) { s[d[0]] = { on: i < 5, start: "09:00", end: "18:00", test_start: "", test_end: "" }; }); return s; }
  function _hhmmOrBlank(v) { return /^\d{1,2}:\d{2}$/.test(String(v || "")) ? (String(v).length === 4 ? "0" + v : String(v)) : ""; }
  /* Custom 24-hour time field (native <input type=time> follows the browser's UI language, which shows
     AM/PM for many users regardless of the OS/page locale). A plain text field is always 24h. It accepts
     "1000"/"10:00"/"9:5" and normalises to "HH:MM" on blur; blank stays blank. */
  function normalizeTime24(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    var digits = s.replace(/\D/g, ""); if (!digits) return "";
    var h, mn;
    if (s.indexOf(":") >= 0) { var p = s.split(":"); h = parseInt(p[0] || "0", 10); mn = parseInt(p[1] || "0", 10); }
    else if (digits.length <= 2) { h = parseInt(digits, 10); mn = 0; }
    else { h = parseInt(digits.slice(0, digits.length - 2), 10); mn = parseInt(digits.slice(-2), 10); }
    if (isNaN(h)) h = 0; if (isNaN(mn)) mn = 0;
    h = Math.min(23, Math.max(0, h)); mn = Math.min(59, Math.max(0, mn));
    return ("0" + h).slice(-2) + ":" + ("0" + mn).slice(-2);
  }
  function timeInput24(cls, value, extra) {
    return '<input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" class="time24 ' + cls + '" value="' + esc(value || "") + '"' + (extra || "") + ">";
  }
  function scheduleSummary(sched) {
    var segs = [], cur = null;
    HOURS_DAYS.forEach(function (d) {
      var s = sched[d[0]] || { on: false, start: "09:00", end: "18:00" };
      var key = s.on ? (s.start + "|" + s.end) : "off";
      if (cur && cur.key === key) { cur.endDay = d[1]; }
      else { cur = { key: key, on: s.on, start: s.start, end: s.end, startDay: d[1], endDay: d[1] }; segs.push(cur); }
    });
    var parts = segs.filter(function (g) { return g.on; }).map(function (g) {
      var days = g.startDay === g.endDay ? g.startDay : (g.startDay + "-" + g.endDay);
      var over = _tmin(g.end) <= _tmin(g.start) ? " +1d" : "";
      return days + " " + g.start + "-" + g.end + over;
    });
    return parts.length ? parts.join(", ") : "Days off / no hours set";
  }
  function readSchedule(host) {
    var out = {};
    Array.prototype.forEach.call((host || document).querySelectorAll(".sched-row"), function (row) {
      var ts = row.querySelector(".sched-tstart"), te = row.querySelector(".sched-tend");
      out[row.getAttribute("data-day")] = {
        on: row.querySelector(".sched-on").checked,
        start: normalizeTime24(row.querySelector(".sched-start").value) || "09:00",
        end: normalizeTime24(row.querySelector(".sched-end").value) || "18:00",
        // Testing sub-window (optional): blank means no testing block that day.
        test_start: ts ? normalizeTime24(ts.value) : "",
        test_end: te ? normalizeTime24(te.value) : ""
      };
    });
    return out;
  }
  function openHours(id) {
    var m = memberById(id); if (!m) return;
    var sched = (m.schedule && typeof m.schedule === "object") ? m.schedule : defaultSchedule();
    showModal({ title: "Working hours - " + m.name, submit: "Save", close: "Cancel",
      initial: { schedule: sched },   // survives closeModal (submitModal closes before onSubmit runs)
      custom: function () {
        return '<div class="sched">' + HOURS_DAYS.map(function (d) {
          var s = sched[d[0]] || { on: false, start: "09:00", end: "18:00", test_start: "", test_end: "" };
          var over = s.on && _tmin(_hhmm(s.end)) <= _tmin(_hhmm(s.start));
          return '<div class="sched-row" data-day="' + d[0] + '">' +
            '<div class="sched-main">' +
            '<label class="sched-day"><input type="checkbox" class="sched-on"' + (s.on ? " checked" : "") + "><span>" + d[1] + "</span></label>" +
            timeInput24("sched-start", _hhmm(s.start)) +
            '<span class="sched-dash">to</span>' +
            timeInput24("sched-end", _hhmm(s.end)) +
            '<span class="sched-next"' + (over ? "" : " hidden") + ' title="Shift crosses midnight">+1 day</span>' +
            "</div>" +
            '<div class="sched-test" title="Testing window inside the shift - no notifications; shown as Testing in Team">' +
            '<span class="sched-tl">' + ic("gamepad", "ico-sm") + "Testing</span>" +
            timeInput24("sched-tstart", _hhmmOrBlank(s.test_start)) +
            '<span class="sched-dash">to</span>' +
            timeInput24("sched-tend", _hhmmOrBlank(s.test_end)) +
            "</div>" +
            "</div>";
        }).join("") + "</div>" +
        '<div class="f-hint">All times Europe/Kyiv. Uncheck a day for a day off. Overnight shifts (end before start, e.g. 22:00 to 06:00) are marked +1 day. <b>Testing</b> is a block inside the shift (usually 4-5h) when the person is not on the console - notifications are muted and Team shows "Testing"; leave it blank if there is none. The rest of the shift is Duty.</div>';
      },
      onSubmit: function (v) {
        // The modal DOM is already closed here, so read the schedule kept in modalValues (seeded from
        // `initial` and updated on every edit by schedRowToggle).
        var out = (v && v.schedule) || sched;
        var human = scheduleSummary(out);
        window.CONSOLE.patch("/users/" + encodeURIComponent(id), { schedule: out, hours: human }).then(function (u) {
            if (u && u.id) { updateTeamMember(u); render(); toast("Working hours updated"); } else toast("Update failed");
          }, function () { toast("Update failed"); });
      } });
  }
  /* Live "+1 day" badge toggle as the operator edits a schedule row (no re-render, keeps focus),
     and keep the full schedule in modalValues so onSubmit has it after the modal closes. */
  function schedRowToggle(row) {
    if (!row) return;
    var on = row.querySelector(".sched-on").checked;
    var over = on && _tmin(_hhmm(row.querySelector(".sched-start").value)) >= _tmin(_hhmm(row.querySelector(".sched-end").value));
    var badge = row.querySelector(".sched-next");
    if (badge) badge.hidden = !over;
    var host = row.closest("#modal-box, #popover");
    if (host && state.modalValues) state.modalValues.schedule = readSchedule(host);
  }
  function openPerms(id) {
    var m = memberById(id); if (!m) return;
    showModal({ title: "Rights - " + m.name, submit: "Save", close: "Cancel", initial: { perms: (m.permissions || []).slice() },
      onSubmit: function (v) {
        var perms = (v.perms || []).slice();
        window.CONSOLE.patch("/users/" + encodeURIComponent(id), { permissions: perms }).then(function (u) {
            if (u && u.id) { updateTeamMember(u); render(); toast("Rights updated"); } else toast("Update failed");
          }, function () { toast("Update failed"); });
      },
      fields: [ { id: "perms", label: "Permissions", type: "multiselect", required: true, options: PERMS } ] });
  }
  /* Admin: a member's vacation/sick allowance + usage. Blank totals fall back to the global default
     (Admin -> Leave policy). "Used" is auto-incremented on approval; edit here to correct or reset. */
  function openLeaveAdmin(id) {
    var m = memberById(id); if (!m) return;
    var lv = m.leave || {}, cfg = D.leaveConfig || {};
    showModal({ title: "Leave - " + m.name, submit: "Save", close: "Cancel",
      initial: { vac_total: lv.vac_total || "", vac_used: lv.vac_used || 0, sick_total: lv.sick_total || "",
        sick_used: lv.sick_used || 0, renew: lv.renew || "", renew_note: lv.renew_note || "" },
      onSubmit: function (v) {
        var payload = { leave: { vac_total: +v.vac_total || 0, vac_used: +v.vac_used || 0,
          sick_total: +v.sick_total || 0, sick_used: +v.sick_used || 0,
          renew: (v.renew || "").trim(), renew_note: (v.renew_note || "").trim() } };
        window.CONSOLE.patch("/users/" + encodeURIComponent(id), payload).then(function (u) {
            if (u && u.id) { updateTeamMember(u); render(); toast("Leave allowance saved"); } else toast("Save failed");
          }, function () { toast("Save failed"); });
      },
      fields: [
        { id: "vac_total", label: "Vacation days / year", type: "number", placeholder: String(cfg.vac_total || 0), hint: "Blank = the global default (" + (cfg.vac_total || 0) + ")." },
        { id: "vac_used", label: "Vacation days used", type: "number" },
        { id: "sick_total", label: "Sick days / year", type: "number", placeholder: String(cfg.sick_total || 0), hint: "Blank = the global default (" + (cfg.sick_total || 0) + ")." },
        { id: "sick_used", label: "Sick days used", type: "number" },
        { id: "renew", label: "Renews on", type: "text", placeholder: "e.g. 01.01.2026" },
        { id: "renew_note", label: "Renewal note", type: "text", placeholder: "how this person's days reset" }
      ] });
  }
  function openTemplateEdit(id) {
    var t = D.templates.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    showModal({ title: "Edit template", submit: "Save", close: "Cancel", initial: { title: t.title, category: t.category, body: t.body },
      onSubmit: function (v) {
        window.CONSOLE.patch("/templates/" + encodeURIComponent(id), { title: v.title, category: v.category, body: v.body }).then(function (u) {
            if (u && u.id) { t.title = u.title; t.category = u.category; t.body = u.body; render(); toast("Template saved"); } else toast("Failed");
          }, function () { toast("Failed"); });
      },
      fields: [
        { id: "title", label: "Title", type: "text", required: true },
        { id: "category", label: "Category", type: "select", required: true, options: TPL_CATS },
        { id: "body", label: "Message", type: "textarea", required: true }
      ] });
  }
  function deleteTemplate(id) {
    window.CONSOLE.del("/templates/" + encodeURIComponent(id)).then(function (r) {
        if (r && r.ok) { D.templates = D.templates.filter(function (x) { return x.id !== id; }); render(); toast("Template deleted"); } else toast("Delete failed");
      }, function () { toast("Delete failed"); });
  }
  function varSave(btn) {
    var id = btn.getAttribute("data-id"), inp = q('[data-var-id="' + id + '"]');
    var v = D.variables.filter(function (x) { return x.id === id; })[0];
    if (!(v && inp)) return;
    v.value = inp.value;
    window.CONSOLE.put("/variables", { variables: D.variables }).then(function () { toast("Saved"); }, function () { toast("Save failed"); });
  }
  function openUserPassword(id) {
    var m = memberById(id); if (!m) return;
    showModal({ title: "Set password - " + m.name, submit: "Set password", close: "Cancel",
      onSubmit: function (v) {
        var pw = v.password || "";
        if (pw.length < 8) { toast("Password must be at least 8 characters"); return; }
        window.CONSOLE.post("/users/" + encodeURIComponent(id) + "/password", { password: pw }).then(function (r) {
            if (r && r.ok) toast("Password set for " + m.name); else toast("Failed" + (r && r.error ? ": " + r.error : ""));
          }, function () { toast("Failed to set password"); });
      },
      fields: [ { id: "password", label: "New password", type: "password", required: true, placeholder: "At least 6 characters", hint: "The user can change it themselves after signing in." } ] });
  }
  function deleteUser(id, name) {
    if (!window.confirm("Delete user " + (name || "") + "? They lose access to the console.")) return;
    window.CONSOLE.del("/users/" + encodeURIComponent(id)).then(function (r) {
        if (r && r.ok) { D.team = D.team.filter(function (m) { return m.id !== id; }); render(); toast("User deleted"); }
        else toast("Delete failed" + (r && r.error ? ": " + r.error : ""));
      }, function () { toast("Delete failed (can't remove the last admin or yourself)"); });
  }
  /* Save a shared list. key = "ignored-reddit" | "moderators-discord" | "image-whitelist-discord". */
  function saveExclusionList(key) {
    var ta = q('[data-list-key="' + key + '"]');
    var items = (ta ? ta.value : "").split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var target = { "ignored-reddit": "ignoredReddit", "image-whitelist-discord": "imageWhitelistDiscord" }[key] || "moderatorsDiscord";
    window.CONSOLE.put("/" + key, { users: items }).then(function (r) {
        if (r && r.ok) { D[target] = r.users; render(); toast("Saved"); } else toast("Save failed");
      }, function () { toast("Save failed"); });
  }
  /* Show a freshly-created / regenerated first-run invite code so the admin can copy + share it. The
     new user needs this code (plus their email) on the "set your password" screen. */
  function showInviteCode(email, code) {
    if (!code) { toast("User created - use the Invite code button to get their code"); return; }
    showModal({ title: "Invite code", close: "Done", custom: function () {
      return '<div class="f-hint" style="line-height:1.5;margin-bottom:12px">Share this one-time code with <b>' + esc(email) + '</b>. They enter it (with their email) on the first-run "set your password" screen. It stops working once they set a password.</div>' +
        '<div class="field"><label>Invite code</label><input class="f-input" id="invite-code-val" readonly value="' + esc(code) + '" style="font-family:var(--font-mono);font-size:15px"></div>' +
        '<button class="btn primary" data-act="copy-invite" style="width:100%;justify-content:center;margin-top:6px">' + ic("link", "ico-sm") + "Copy code</button>";
    } });
    setTimeout(function () { var i = q("#invite-code-val"); if (i) { i.focus(); i.select(); } }, 30);
  }
  function adminGetInvite(id) {
    window.CONSOLE.post("/users/" + id + "/invite", {}).then(function (r) {
      if (r && r.ok) { var m = memberById(id); if (m) m.has_password = false; showInviteCode(r.email || (m && m.email) || "", r.invite); }
      else toast(r && r.error ? r.error : "Could not create invite code");
    }, function (s) { toast(s === 409 ? "This user already set a password" : "Could not create invite code"); });
  }
  /* Admin "move everything to History": sets a cutoff = now, so every current Reddit
     ModMail convo + Post drops into History; anything with newer activity later comes back. Does
     not touch Discord or Jira. */
  function moveAllToHistory() {
    if (!window.confirm("Move ALL current Reddit ModMail conversations, Posts, Telegram messages, Discord Mentions and Forum posts into History?\nNew activity will bring an item back automatically. Discord tickets and Jira are not affected.")) return;
    var now = Date.now();
    function applyLocal() { state.historyCutoff = now; render(); toast("Everything moved to History"); }
    window.CONSOLE.post("/history-cutoff", {}).then(function (r) {
        state.historyCutoff = (r && r.cutoff) ? (_utcDate(r.cutoff) || {getTime:function(){return now;}}).getTime() : now;
        render(); toast("Everything moved to History");
      }, function () { toast("Failed"); });
  }

  /* ---------- templates: insert into a composer ---------- */
  function openTemplatePicker() {
    // Two tabs: saved reply Templates, and the prepared "canned" answers from Known Issues.
    showModal({ title: "Insert template", close: "Close",
      search: { placeholder: "Search by title, category, or text...", run: function (ql) {
        var tab = state.tplTab || "templates";
        var tabs = '<div class="filters" style="margin-bottom:10px">' +
          [["templates", "Templates"], ["known", "Known Issues"]].map(function (t) {
            return '<button class="filter' + (tab === t[0] ? " active" : "") + '" data-act="tpl-tab" data-tab="' + t[0] + '">' + t[1] + "</button>";
          }).join("") + "</div>";
        return tabs + (tab === "known" ? knownCannedRows(ql) : templateRows(ql));
      } } });
  }
  function templateRows(ql) {
    var rows = D.templates.filter(function (t) {
      return !ql || (t.title + " " + t.category + " " + t.body).toLowerCase().indexOf(ql) >= 0;
    });
    if (!rows.length) return '<div class="ctx-empty">No templates.</div>';
    return rows.map(function (t) {
      return '<div class="act-row"><div class="ar-main">' +
        '<div class="row-gap"><span class="chip soft" style="padding:1px 8px">' + esc(t.category) + '</span><b class="truncate">' + esc(t.title) + "</b></div>" +
        '<div class="ar-sub">' + esc(t.body) + "</div></div>" +
        '<button class="btn sm primary" data-act="tpl-insert" data-id="' + esc(t.id) + '">' + ic("plus", "ico-sm") + "Insert</button></div>";
    }).join("");
  }
  /* Known Issues canned answers as insertable templates: every Known Issue row that has a
     prepared "canned" reply becomes a pick, labelled by its category + problem. */
  function knownCannedRows(ql) {
    var out = [];
    Object.keys(D.knownIssues || {}).forEach(function (cat) {
      var rows = (D.knownIssues[cat] && D.knownIssues[cat].rows) || [];
      rows.forEach(function (r) {
        var canned = (r.canned || "").trim();
        if (!canned) return;
        var title = (r.entity ? r.entity + " - " : "") + (r.problem || "(issue)");
        if (ql && (title + " " + canned + " " + cat).toLowerCase().indexOf(ql) < 0) return;
        out.push('<div class="act-row"><div class="ar-main">' +
          '<div class="row-gap"><span class="chip soft" style="padding:1px 8px">' + esc(cat) + '</span><b class="truncate">' + esc(title) + "</b></div>" +
          '<div class="ar-sub">' + esc(canned) + "</div></div>" +
          '<button class="btn sm primary" data-act="tpl-insert-text" data-text="' + esc(canned) + '">' + ic("plus", "ico-sm") + "Insert</button></div>");
      });
    });
    if (!out.length) return '<div class="ctx-empty">No canned answers in Known Issues' + (ql ? " match your search." : ".") + "</div>";
    return out.join("");
  }
  function insertTemplate(id) {
    var t = D.templates.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    insertTemplateText(t.body, "Template inserted");
  }
  function insertTemplateText(text, msg) {
    if (!text) return;
    closeModal();
    var ta = q("[data-composer]");
    if (ta) { var cur = (ta.value || "").trim(); ta.value = cur ? (cur + "\n\n" + text) : text; ta.focus(); toast(msg || "Inserted"); return; }
    // No visible composer: the picker replaced a modeless popover (the Telegram reply). Re-open it
    // with the preserved draft + the inserted template so nothing is lost (QA finding).
    if (state._tplTgId) {
      var draft = (state._tplDraft || "").trim();
      openTgReply(state._tplTgId, draft ? (draft + "\n\n" + text) : text);
      state._tplTgId = null; state._tplDraft = "";
      toast(msg || "Inserted");
      return;
    }
    toast("Open a chat to insert the template");
  }

  /* ---------- shift handoff notes ---------- */
  function seenHandoffIds() {
    if (!state.user) return [];
    try { return JSON.parse(localStorage.getItem("cmt-ho-seen-" + state.user.id) || "[]"); } catch (e) { return []; }
  }
  function markHandoffSeen(ids) {
    if (!state.user) return;
    try { localStorage.setItem("cmt-ho-seen-" + state.user.id, JSON.stringify(seenHandoffIds().concat(ids))); } catch (e) {}
  }
  function pendingHandoffs(user) {
    var seen = seenHandoffIds();
    return (D.handoffs || []).filter(function (h) {
      var forMe = (h.toId === user.id) || !h.toId;               /* addressed to me, or "next shift" */
      var notMine = h.from !== user.name;                        /* don't show your own note back */
      return forMe && notMine && seen.indexOf(h.id) < 0 && !h.done;
    });
  }
  function showHandoffPopup() {
    if (!state.user) return;
    var pend = pendingHandoffs(state.user);
    if (!pend.length) return;
    markHandoffSeen(pend.map(function (h) { return h.id; }));    /* seen persists across reloads */
    showModal({ title: pend.length > 1 ? "Handoff notes (" + pend.length + ")" : "Handoff note", close: "Got it",
      custom: function () {
        return pend.map(function (h) {
          var where = h.refLabel || h.context_type;
          return '<div class="field"><label>' + ic("reply", "ico-sm") + "From " + esc(h.from) + DOT + "for " + esc(h.to) + DOT + esc(h.ago) + (where ? DOT + esc(where) : "") +
            '</label><div class="read-val">' + esc(h.text) + "</div></div>";
        }).join("");
      } });
  }
  function mapActivity(a) {
    return { user: a.user || "someone", action: a.action || "", target: a.target || "", at: a.at || "", ago: timeText(a.at) };
  }
  /* Per-message translator (item W10). Cache is keyed by the original text (translation is
     deterministic) so it survives re-renders. After each render, add a Translate button to every
     message bubble and re-attach any cached RU translation. */
  /* Dispatch desk (v2.9x): presentation-only pass over freshly rendered chat markup.
     Queue: day separators + short relative time (full text kept in the title) + status as row tooltip.
     Thread: day separators + consecutive messages from the same author grouped (meta hidden, kept in title).
     Deterministic and idempotent, so the soft re-render can run it on the new markup before comparing. */
  var DESK_MON = /\b(\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))\b/;
  function deskDay(t) {
    var m = DESK_MON.exec(t || "");
    if (m) return m[1];
    return /(^|\s)\d{1,2}:\d{2}\b/.test(t || "") ? "Today" : null;
  }
  function deskEnhance(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll(".pane.list"), function (list) {
      if (list.querySelector(".q-day")) return;
      var rows = list.querySelectorAll(":scope > .row");
      var days = Array.prototype.map.call(rows, function (row) {
        var t = row.querySelector(".rtime"); return t ? deskDay(t.textContent) : null;
      });
      var dated = days.length && days.every(function (d) { return d; });
      var last = null;
      Array.prototype.forEach.call(rows, function (row, i) {
        var t = row.querySelector(".rtime");
        if (dated && days[i] !== last) {
          var sep = document.createElement("div"); sep.className = "q-day"; sep.textContent = days[i];
          row.parentNode.insertBefore(sep, row); last = days[i];
        }
        if (t) {
          var full = t.textContent, parts = full.split(DOT);
          if (parts.length > 1) { t.title = full; t.textContent = parts[parts.length - 1].replace(/\s*ago$/, "").trim(); }
        }
        var st = row.querySelector(".rmeta .st");
        if (st && !row.getAttribute("title")) row.setAttribute("title", st.textContent);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll(".thread"), function (th) {
      if (th.querySelector(".msg-day")) return;
      var lastDay = null, lastKey = null;
      Array.prototype.forEach.call(th.querySelectorAll(":scope > .msg"), function (m) {
        var meta = m.querySelector(":scope > .meta");
        var txt = meta ? meta.textContent : "";
        var day = meta ? deskDay(txt) : null;
        if (day && day !== lastDay) {
          var sep = document.createElement("div"); sep.className = "msg-day"; sep.textContent = day;
          th.insertBefore(sep, m); lastDay = day; lastKey = null;
        }
        var key = meta ? m.className + "|" + txt.split(DOT)[0] : null;
        if (key && key === lastKey) { m.classList.add("cont"); m.setAttribute("title", txt); }
        lastKey = key;
      });
    });
  }
  /* Broken chat images: the old inline onerror handlers were blocked by the CSP (script-src 'self'),
     so the fallback never ran. One capturing listener does the same job without inline script. */
  document.addEventListener("error", function (ev) {
    var img = ev.target;
    if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-imgfail")) return;
    var mode = img.getAttribute("data-imgfail"); img.removeAttribute("data-imgfail");
    if (mode === "drop") { var w = img.closest(".msg-imgs"); if (w) w.remove(); return; }
    var sp = document.createElement("span"); sp.className = "faint"; sp.textContent = "\uD83D\uDDBC image (open)";
    img.replaceWith(sp);
  }, true);
  function enhanceTranslate() {
    var root = q("#view-root"); if (!root) return;
    state.translations = state.translations || {};
    Array.prototype.forEach.call(root.querySelectorAll(".thread .msg"), function (msg) {
      var bub = msg.querySelector(".bubble"); if (!bub) return;
      var text = (bub.textContent || "").trim();
      if (!text) return;                       // image-only / empty bubble
      var tr = state.translations[text];
      if (tr != null) {
        var d = document.createElement("div"); d.className = "bubble tr"; d.textContent = tr; msg.appendChild(d);
      }
      var btn = document.createElement("button");
      btn.className = "tr-btn"; btn.setAttribute("data-act", "translate");
      btn.textContent = (tr != null ? "Hide RU" : "Translate");
      msg.appendChild(btn);
    });
  }
  function translateMsg(btn) {
    var msg = btn.closest(".msg"); var bub = msg && msg.querySelector(".bubble"); if (!bub) return;
    var text = (bub.textContent || "").trim(); if (!text) return;   // cache key (same as enhanceTranslate)
    var src = (bub.innerText || text).trim();                       // what we send: keeps the line breaks of formatted posts
    state.translations = state.translations || {};
    if (state.translations[text] != null) { delete state.translations[text]; render(); return; }  // toggle hide
    btn.textContent = "...";
    window.CONSOLE.post("/translate", { text: src }).then(function (d) {
      if (d && d.same) { btn.textContent = "Translate"; toast(d.names_only ? "Only names here, nothing to translate" : "Already in Russian"); return; }
      if (d && d.text) { state.translations[text] = d.text; render(); }
      else { btn.textContent = "Translate"; toast(d && d.error ? d.error : "Translation failed"); }
    }, function () { btn.textContent = "Translate"; toast("Translation failed"); });
  }
  /* Translate whatever the operator typed in the composer to English, in place. Sending stays
     manual - this only rewrites the textarea so they can review/edit before hitting send. Keeps the
     textarea focused during the request so auto-refresh stays paused and can't wipe the draft. */
  function translateComposer(btn) {
    // The composer lives in a detail pane (ModMail/Discord) OR in a movable popover (Telegram reply,
    // item W5). Scope to whichever contains the button so Translate works in both places.
    var scope = btn.closest("#popover") || btn.closest(".pane.detail") || document;
    var ta = scope.querySelector("[data-composer]");
    if (!ta) return;
    var text = (ta.value || "").trim();
    if (!text) { ta.focus(); return; }
    ta.focus();
    var lbl = btn.innerHTML; btn.innerHTML = "..."; btn.disabled = true;
    window.CONSOLE.post("/translate", { text: text, target_lang: "EN" }).then(function (d) {
      btn.innerHTML = lbl; btn.disabled = false;
      if (d && d.same) { ta.focus(); toast(d.names_only ? "Only names here, nothing to translate" : "Already in English"); return; }
      if (d && d.text) { ta.value = d.text; ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} }
      else toast(d && d.error ? d.error : "Translation failed");
    }, function () { btn.innerHTML = lbl; btn.disabled = false; toast("Translation failed"); });
  }
  /* Record a team action into the shared Activity feed (item W9): optimistic locally + persist. */
  function logActivity(action, target) {
    var rec = { user: myName(), action: action, target: target || "", ago: "now" };
    D.activity = D.activity || [];
    D.activity.unshift(rec);
    if (D.activity.length > 100) D.activity.length = 100;
    window.CONSOLE.post("/activity", { action: action, target: target || "" }).then(function () {}, function () {});
  }
  function handoffPeople() { return (D.roster && D.roster.length) ? D.roster : (D.team || []); }
  function mapHandoff(h) {
    var m = handoffPeople().filter(function (x) { return x.id === h.target; })[0];
    return { id: h.id, from: h.from, to: m ? m.name : "Next shift (anyone)", toId: m ? m.id : null,
      ago: timeText(h.created_at) || "now", ts: h.created_at, text: h.text,
      done: !!h.done, doneBy: h.done_by || "",
      context_type: h.context_type || "", ref: h.ref || "", refLabel: h.refLabel || "" };
  }
  /* In-console route for a handoff's origin chat, so a handoff clearly links to WHERE it was left. */
  function handoffRoute(h) {
    var t = h.context_type, r = h.ref;
    if (!t || !r) return "";
    if (t === "convo") return "#/modmail/" + r;
    if (t === "post") return "#/posts/" + r;
    if (t === "ticket") return "#/discord/" + r;
    if (t === "forum") return "#/discord/forum/" + r;
    if (t === "mention") return "#/discord/mentions/" + r;
    if (t === "jira") return "#/jirachat/" + r;
    return "";
  }
  /* Handoffs addressed to me (or to "next shift") that I haven't completed yet - drives the persistent
     Inbox surface (they stay until Marked done, server-side, not just dismissed on the start popup). */
  function myHandoffs() {
    if (!state.user) return [];
    return (D.handoffs || []).filter(function (h) {
      var forMe = (h.toId === state.user.id) || !h.toId;   // to me specifically, or "next shift (anyone)"
      return forMe && h.from !== state.user.name && !h.done;
    });
  }
  function handoffCard(h) {
    var route = handoffRoute(h);
    var where = h.refLabel || (h.context_type ? h.context_type : "General shift note");
    var whereChip = route
      ? '<a class="chip soft" style="padding:1px 8px;text-decoration:none" data-go="' + esc(route) + '">' + ic("reply", "ico-sm") + esc(where) + "</a>"
      : '<span class="chip soft" style="padding:1px 8px">' + ic("reply", "ico-sm") + esc(where) + "</span>";
    return '<div class="feed-card ho-card"><div class="fc-main">' +
      '<div class="td-top"><span class="chip soft" style="padding:1px 8px">' + ic("user", "ico-sm") + "From " + esc(h.from) + "</span>" +
      whereChip + '<span class="rtime" style="margin-left:auto" title="' + esc(fmtDT(h.ts)) + '">' + esc(h.ago) + "</span></div>" +
      '<div class="fc-sub" style="margin-top:8px">' + esc(h.text) + "</div>" +
      '<div class="td-actions">' +
      '<button class="btn sm primary" data-act="handoff-done" data-id="' + esc(h.id) + '">' + ic("check", "ico-sm") + "Mark done</button>" +
      (route ? '<button class="btn sm ghost" data-go="' + esc(route) + '">' + ic("external", "ico-sm") + "Open where it was left</button>" : "") +
      "</div></div></div>";
  }
  function markHandoffDone(id) {
    var h = (D.handoffs || []).filter(function (x) { return x.id === id; })[0]; if (!h) return;
    function applyLocal() { h.done = true; h.doneBy = myName(); logActivity("marked a handoff done", h.refLabel || h.context_type || ""); render(); toast("Handoff marked done"); }
    window.CONSOLE.post("/handoffs/" + encodeURIComponent(id) + "/done", { done: true }).then(applyLocal, function () { toast("Could not update"); });
  }
  function openHandoffCreate(ctxType, ref, refLabel) {
    var opts = ["Next shift (anyone)"].concat(handoffPeople().filter(function (m) { return !state.user || m.id !== state.user.id; }).map(function (m) { return m.name; }));
    showModal({ title: "Leave a handoff note" + (refLabel ? " - " + refLabel : ""), submit: "Leave note", close: "Cancel",
      onSubmit: function (v) {
        var toName = v.to || "Next shift (anyone)", toId = null;
        if (toName !== "Next shift (anyone)") { var m = handoffPeople().filter(function (x) { return x.name === toName; })[0]; toId = m ? m.id : null; }
        window.CONSOLE.post("/handoffs", { target: toId || "anyone", text: v.text, context_type: ctxType || "", ref: ref || "", label: refLabel || "" }).then(function (h) {
            if (h && h.id) { D.handoffs.unshift(mapHandoff(h)); render(); toast("Handoff note left"); } else toast("Failed");
          }, function () { toast("Failed"); });
      },
      fields: [
        { id: "to", label: "For", type: "select", required: true, placeholder: "Who", options: opts },
        { id: "text", label: "Note", type: "textarea", required: true, placeholder: "What the next person should know..." }
      ] });
  }

  /* ---------- User 360 ---------- */
  function userActivity(u) {
    var rs = (u.reddits || []).map(function (x) { return String(x).toLowerCase(); });
    var ds = (u.discord_ids || []).map(String);
    var fbs = (u.facebooks || []).map(function (x) { return String(x).toLowerCase(); });
    function inR(n) { return n && rs.indexOf(String(n).toLowerCase()) >= 0; }
    return {
      convos: (D.redditModmail || []).filter(function (c) { return inR(c.participant); }),
      posts: (D.redditPosts || []).filter(function (p) { return inR(p.author); }),
      comments: (D.redditComments || []).filter(function (c) { return inR(c.author); }),
      tickets: (D.discordTickets || []).filter(function (t) { return ds.indexOf(String(t.user_id)) >= 0; }),
      mentions: (D.discordMentions || []).filter(function (m) { return ds.indexOf(String(m.user_id || m.author_id || "")) >= 0; }),
      facebook: (D.channelContacts || []).filter(function (c) { return fbs.indexOf(String(c.name || c.author || "").toLowerCase()) >= 0; })
    };
  }
  /* Profile 360 Discord history: only ACTIVE tickets are loaded up front, so fetch every ticket of this
     Discord user (closed included) once and add them to the list (marked _hist so refreshes keep them). */
  var _userTicketsFetched = {};
  function ensureUserTickets(ids) {
    (ids || []).forEach(function (did) {
      did = String(did || ""); if (!/^\d+$/.test(did) || _userTicketsFetched[did]) return;
      _userTicketsFetched[did] = "loading";
      window.CONSOLE.get("/discord-tickets?user_id=" + encodeURIComponent(did) + "&limit=500").then(function (list) {
        _userTicketsFetched[did] = "done";
        if (!Array.isArray(list)) { render(); return; }
        var seen = {}; D.discordTickets.forEach(function (t) { seen[tid(t)] = true; });
        var _add = list.map(mapDiscordTicket).filter(function (t) { return !seen[tid(t)]; });
        _add.forEach(function (t) { t._hist = true; D.discordTickets.push(t); }); overlayTickets(_add);
        render();
      }, function () { _userTicketsFetched[did] = "failed"; render(); });
    });
  }
  function viewUser(id) {
    var u = userById(id);
    if (!u) return emptyState("user", "User not found", "");
    ensureUserTickets(u.discord_ids);
    var dispName = u.reddit ? "u/" + u.reddit : (u.discord_name || u.facebook || u.email || "Unknown user");
    function chips(arr, color, pre) { return (arr || []).map(function (x) { return '<span class="chip"><i class="sdot" style="background:var(' + color + ')"></i>' + pre + esc(x) + "</span>"; }).join(""); }
    var idChips = chips(u.reddits, "--src-reddit", "u/") + chips(u.discord_names.length ? u.discord_names : u.discord_ids, "--src-discord", "") + chips(u.facebooks, "--src-facebook", "");
    (u.emails || []).forEach(function (e) { idChips += '<span class="chip soft mono">' + esc(e) + "</span>"; });
    if (u.session) idChips += '<span class="chip soft mono truncate" style="max-width:220px">' + esc(u.session) + "</span>";
    var act = userActivity(u), notes = notesFor("user", u.id);
    /* A column shows its first few entries; "Show all" expands it (long mention lists made the page
       endless on a phone). Each list also scrolls inside itself on desktop. Empty columns collapse. */
    state.uExpand = state.uExpand || {};
    function col(icon, title, items, key, extraHtml) {
      if (typeof items === "string") items = items ? [items] : [];
      var n = items.length, open = !!state.uExpand[key], LIM = 5;
      var shown = open ? items : items.slice(0, LIM);
      var more = n > LIM ? '<button class="btn sm ghost u-more" data-act="u-expand" data-key="' + key + '">' + (open ? "Show less" : "Show all " + n) + "</button>" : "";
      return '<div class="u-col' + (n || extraHtml ? "" : " u-col-empty") + '"><h3>' + ic(icon, "ico-sm") + title + (n ? '<span class="u-count">' + n + "</span>" : "") +
        '</h3><div class="ctx-list">' + (extraHtml || "") + (shown.join("") || (extraHtml ? "" : '<div class="ctx-empty">-</div>')) + "</div>" + more + "</div>";
    }
    function item(go, title, sub, when) {
      return '<div class="ctx-item" data-go="' + esc(go) + '"><div class="ci-top"><span class="truncate">' + esc(title) + '</span><span class="rtime">' + esc(when || "") + "</span></div>" +
        (sub ? '<div class="muted truncate" style="font-size:12px;margin-top:3px">' + esc(previewText(sub)) + "</div>" : "") + "</div>";
    }
    var convosH = act.convos.map(function (c) { return item("#/modmail/" + c.id, c.subject, c.preview, c.ago); });
    var postsH = act.posts.map(function (p) { return item("#/posts/" + p.id, p.title, p.body, p.ago); })
      .concat(act.comments.map(function (c) { return item("#/reddit-comments", "Comment", c.body, timeText(c.created)); }));
    var tks = act.tickets.slice().sort(function (a, b) { var ta = _utcDate(a.created_at || a.ts), tb = _utcDate(b.created_at || b.ts); return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0); });
    var loadingT = (u.discord_ids || []).some(function (d) { return _userTicketsFetched[String(d)] === "loading"; });
    var ticketsH = tks.map(function (t) {
      var st = deriveDiscordStatus(t);
      return item("#/discord/" + tid(t), "#" + t.ticket_number + DOT + (t.metadata && t.metadata.description || "") + (st === "done" ? DOT + "Closed" : ""), t.last_message, t.ago);
    });
    var mentionsH = act.mentions.map(function (m) { return item(m.id ? "#/discord/mentions/" + m.id : "#/discord/mentions", m.channel_name ? "#" + m.channel_name : "Mention", m.content || m.text, m.ago); });
    var fbH = act.facebook.map(function (c) { return item("#/channels", c.name || c.author || "Facebook", c.note || c.text, ""); });
    var notesH = notes.map(function (n) { return '<div class="note" style="box-shadow:none"><div class="ntext" style="font-size:13px">' + esc(n.text) + '</div><div class="nfoot">' + esc(n.author) + DOT + esc(n.ago) + "</div></div>"; });
    var cols = col("mail", "Reddit ModMail", convosH, "mm") + col("posts", "Reddit posts and comments", postsH, "posts") +
      col("discord", "Discord tickets", ticketsH, "tickets", loadingT ? '<div class="ctx-empty">Loading ticket history...</div>' : "") +
      (mentionsH.length ? col("hash", "Discord mentions", mentionsH, "mentions") : "") +
      (u.facebooks && u.facebooks.length ? col("facebook", "Facebook", fbH, "fb") : "") + col("notes", "Notes", notesH, "notes");
    return '<div class="page"><div class="u360">' +
      '<div class="u-hero"><div class="u-av">' + esc(initials(u.reddit || u.discord_name || u.facebook || u.email)) + '</div><div style="min-width:0"><h1>' + esc(dispName) + '</h1><div class="u-id">' + idChips + "</div></div><div class=\"spacer\"></div>" +
      '<button class="btn ghost iconly" title="Close" data-go="#/inbox">' + ic("x", "ico-sm") + "</button></div>" +
      '<div class="u-cols">' + cols + "</div></div></div>";
  }

  /* ---------- command palette ---------- */
  /* Global search index (item S2): each item carries a `search` blob with everything you can match
     on - participant/author/user, email, subject/title/description, message body, Jira reporter. */
  function cmdkAll() {
    var items = [];
    NAV.forEach(function (n) { items.push({ cat: "Navigate", icon: n.icon, title: "Open " + n.label, go: n.go, search: "open " + n.label }); });
    items.push({ cat: "Navigate", icon: "sun", title: "Change design", act: "theme", search: "change design theme dark black glassy light toggle" });
    D.redditModmail.forEach(function (c) {
      var u = userByReddit(c.participant);
      var lastBody = (c.messages && c.messages.length) ? c.messages[c.messages.length - 1].body : (c.preview || "");
      items.push({ cat: "Reddit ModMail", icon: "mail", title: c.subject, sub: "u/" + c.participant, go: "#/modmail/" + c.id,
        search: c.subject + " u/" + c.participant + " " + (u && ((u.user_ids || []).join(" ") + " " + (u.email || "")) || "") + " " + lastBody });
    });
    D.discordTickets.forEach(function (t) {
      var u = userByDiscordId(t.user_id);
      items.push({ cat: "Discord ModMail", icon: "discord", title: "#" + t.ticket_number + DOT + t.user_name, sub: t.metadata.description, go: "#/discord/" + tid(t),
        search: "#" + t.ticket_number + " " + t.user_name + " " + (t.metadata.description || "") + " " + (t.metadata.email_or_session || "") + " " + (u && ((u.user_ids || []).join(" ") + " " + (u.email || "")) || "") });
    });
    D.jira.forEach(function (j) { items.push({ cat: "Jira", icon: "jira", title: j.issue_key + DOT + j.summary, sub: "Open in Jira", go: "#/jira/" + j.issue_key,
      search: j.issue_key + " " + (j.summary || "") + " " + (j.status || "") + " " + (j.reporter || "") }); });
    D.users.forEach(function (u) { items.push({ cat: "Users", icon: "user", title: u.reddit ? "u/" + u.reddit : (u.discord_name || u.facebook || "user"), sub: (u.user_ids && u.user_ids[0]) ? "User ID " + u.user_ids[0] : "", go: "#/user/" + u.id,
      search: (u.reddits || []).join(" ") + " " + (u.discord_names || []).join(" ") + " " + (u.discord_ids || []).join(" ") + " " + (u.facebooks || []).join(" ") + " " + (u.user_ids || []).join(" ") + " " + (u.email || "") }); });
    D.redditPosts.forEach(function (p) { items.push({ cat: "Reddit Posts", icon: "posts", title: p.title, sub: p.subreddit + DOT + "u/" + p.author, go: "#/posts/" + p.id,
      search: p.title + " " + p.subreddit + " u/" + p.author + " " + (p.body || (p.thread && p.thread[0] && p.thread[0].body) || "") }); });
    return items;
  }
  function cmdkFilter() {
    var ql = state.cmdk.query.toLowerCase(), all = cmdkAll();
    if (!ql) return all;
    // Match every whitespace-separated term (AND) against the item's search blob.
    var terms = ql.split(/\s+/).filter(Boolean);
    return all.filter(function (i) {
      var hay = (i.search || (i.title + " " + (i.sub || "") + " " + i.cat)).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }
  function renderCmdk() {
    var items = cmdkFilter(); state.cmdk.items = items;
    if (state.cmdk.sel >= items.length) state.cmdk.sel = Math.max(0, items.length - 1);
    var listEl = q("#cmdk-list");
    if (!items.length) { listEl.innerHTML = '<div class="cmdk-empty">Nothing found</div>'; return; }
    var html = "", lastCat = null;
    items.forEach(function (it, i) {
      if (it.cat !== lastCat) { html += '<div class="cmdk-group">' + esc(it.cat) + "</div>"; lastCat = it.cat; }
      html += '<div class="cmdk-item' + (i === state.cmdk.sel ? " sel" : "") + '" data-cmdk-i="' + i + '">' + ic(it.icon, "ico-sm") +
        '<div class="ci-main"><div class="truncate">' + esc(it.title) + "</div>" + (it.sub ? '<div class="ci-sub truncate">' + esc(it.sub) + "</div>" : "") + "</div>" +
        (it.go ? '<span class="k">&#8629;</span>' : "") + "</div>";
    });
    listEl.innerHTML = html;
    var sel = q(".cmdk-item.sel", listEl); if (sel) sel.scrollIntoView({ block: "nearest" });
  }
  function openCmdk() {
    state.cmdk.open = true; state.cmdk.query = ""; state.cmdk.sel = 0;
    q("#cmdk-overlay").classList.add("open");
    var inp = q("#cmdk-input"); inp.value = ""; renderCmdk();
    setTimeout(function () { inp.focus(); }, 20);
  }
  function closeCmdk() { state.cmdk.open = false; q("#cmdk-overlay").classList.remove("open"); }
  function activateCmdk(i) {
    var it = state.cmdk.items[i]; if (!it) return;
    closeCmdk();
    if (it.act === "theme") openThemePicker();
    else if (it.go) location.hash = it.go;
  }

  /* ---------- theme + toast ---------- */
  /* The designs in the "Change design" window. Black is the Dark design on pure black: the page keeps
     data-theme="dark" (same layout, nothing can shift) and only adds data-variant="black". */
  var THEMES = [
    { id: "dark",   name: "Dark",   desc: "The standard dark look: grey surfaces, amber accents, solid panels." },
    { id: "black",  name: "Black",  desc: "Pure black, no grey: black panels with thin lines, amber accents." },
    { id: "glassy", name: "Glassy", desc: "Frosted glass panels on a drifting colourful backdrop." },
    { id: "light",  name: "Light",  desc: "White panels on a soft grey page, amber accents." },
  ];
  function themeOk(t) { return THEMES.some(function (x) { return x.id === t; }); }
  function applyTheme() {
    if (!themeOk(state.theme)) state.theme = "dark";
    var root = document.documentElement;
    root.setAttribute("data-theme", state.theme === "black" ? "dark" : state.theme);
    if (state.theme === "black") root.setAttribute("data-variant", "black"); else root.removeAttribute("data-variant");
    var b = q("#theme-btn"); if (b) b.innerHTML = ic(state.theme === "light" ? "sun" : "moon");
  }
  function setTheme(t) {
    if (!themeOk(t)) return;
    state.theme = t;
    try { localStorage.setItem("cmt-theme", t); } catch (e) {}
    applyTheme();
  }
  function openThemePicker() {
    showModal({
      title: "Change design", wide: true, submit: "Save", initial: { theme: state.theme },
      custom: function () {
        var cur = state.modalValues.theme;
        return '<div class="tp-grid">' + THEMES.map(function (t) {
          return '<button type="button" class="tp-card' + (t.id === cur ? " on" : "") + '" data-act="theme-pick" data-theme-id="' + t.id + '" aria-pressed="' + (t.id === cur) + '">' +
            '<span class="tp-name"><span class="tp-radio"></span>' + esc(t.name) + (t.id === state.theme ? ' <span class="faint" style="font-weight:400;font-size:12px">(current)</span>' : "") + "</span>" +
            '<span class="tp-prev tp-' + t.id + '" aria-hidden="true"><span class="tp-side"><i></i><i class="on"></i><i></i><i></i><i></i></span>' +
            '<span class="tp-main"><span class="tp-top"><b></b><span></span></span><span class="tp-cardm">' +
            [1, 2, 3, 4, 5].map(function (n) { return '<span class="tp-row"><i></i><em></em>' + (n % 2 ? "<s></s>" : "") + "</span>"; }).join("") +
            "</span></span></span>" +
            '<span class="tp-desc">' + esc(t.desc) + "</span></button>";
        }).join("") + "</div>";
      },
      onSubmit: function (v) { setTheme(v.theme); },
    });
  }
  var toastTimer, toastTick;
  var TOAST_ERR_RE = /fail|error|couldn'?t|can'?t|cannot|unable|invalid|denied|rejected/i;
  /* Transient status message at the bottom of the page. Errors (auto-detected from the text, or an
     explicit type "error") are prominent (red), persist ~15s, and show a live countdown + an X to
     dismiss early. Success/info stay brief and quiet. Pass "ok" to force the quiet style. */
  function toast(msg, type) {
    var sticky = type === "sticky";   // an important success: same long, closable toast as an error
    var isErr = !sticky && (type === "error" || (type !== "ok" && type !== "success" && TOAST_ERR_RE.test(String(msg || ""))));
    var t = q("#toast"); if (!t) return;
    clearTimeout(toastTimer); clearInterval(toastTick);
    var longT = isErr || sticky;
    var dur = longT ? 15000 : 1800;
    t.className = "toast" + (longT ? " error" : "") + (sticky ? " sticky" : "");
    t.setAttribute("aria-live", isErr ? "assertive" : "polite");
    if (longT) {
      var secs = Math.round(dur / 1000);
      t.innerHTML = '<span class="toast-msg"></span><span class="toast-count" aria-hidden="true">' + secs + 's</span>' +
        '<button class="toast-close" type="button" aria-label="Dismiss">&times;</button><span class="toast-timer"></span>';
      t.querySelector(".toast-msg").textContent = msg;
      var bar = t.querySelector(".toast-timer"), countEl = t.querySelector(".toast-count");
      t.querySelector(".toast-close").onclick = function () { clearTimeout(toastTimer); clearInterval(toastTick); t.classList.remove("show"); };
      t.classList.add("show");
      requestAnimationFrame(function () { if (bar) { bar.style.transition = "transform " + dur + "ms linear"; bar.style.transform = "scaleX(0)"; } });
      var left = secs;
      toastTick = setInterval(function () { left -= 1; if (countEl) countEl.textContent = Math.max(0, left) + "s"; if (left <= 0) clearInterval(toastTick); }, 1000);
    } else {
      t.textContent = msg;
      t.classList.add("show");
    }
    toastTimer = setTimeout(function () { t.classList.remove("show"); clearInterval(toastTick); }, dur);
  }

  /* ---------- interactive actions ---------- */
  function addNoteFrom(btn) {
    var wrap = btn.closest(".note-add"), inp = wrap && wrap.querySelector("[data-note-input]");
    var val = inp && inp.value.trim(); if (!val) { if (inp) inp.focus(); return; }
    var ctxType = btn.getAttribute("data-ctx-type") || "general";
    var ref = btn.getAttribute("data-ctx-ref") || "";
    var label = btn.getAttribute("data-ctx-label") || "General";
    window.CONSOLE.post("/notes", { context_type: ctxType, ref: ref, text: val, label: label }).then(function (n) {
        D.notes.unshift(mapNote(n)); render(); toast("Note added");
      }, function () { toast("Could not add note"); });
  }
  /* Edit / delete a team note (item X2). */
  function openNoteEdit(id) {
    var n = D.notes.filter(function (x) { return String(x.id) === String(id); })[0]; if (!n) return;
    showModal({ title: "Edit note", submit: "Save", close: "Cancel", initial: { text: n.text },
      onSubmit: function (v) {
        var val = (v.text || "").trim(); if (!val) { toast("Note can't be empty", "ok"); return; }
        n.text = val;
        window.CONSOLE.patch("/notes/" + encodeURIComponent(id), { text: val }).then(function () {}, function () { toast("Save failed"); });
        render(); toast("Note updated");
      },
      fields: [ { id: "text", label: "Note", type: "textarea", required: true, placeholder: "Note text" } ] });
  }
  function deleteNote(id) {
    D.notes = D.notes.filter(function (x) { return String(x.id) !== String(id); });
    window.CONSOLE.del("/notes/" + encodeURIComponent(id)).then(function () {}, function () {});
    render(); toast("Note deleted");
  }
  /* ---------- Send safety window --------------------------------------
     Every customer-facing send (Reddit note/reply, Reddit post community/personal,
     Discord note/user) is held for SEND_WINDOW_MS. The message shows immediately as
     "pending" with Edit + Undo; only when the timer elapses is the real send dispatched.
     Undo cancels it entirely; Edit cancels it and puts the text back in the composer. */
  var SEND_WINDOW_MS = 60000;
  function myName() { return (state.user && (state.user.display_name || state.user.name)) || D.me.name || "You"; }
  function pendingById(id) { return state.pendingSends.filter(function (p) { return p.id === id; })[0]; }
  function removePending(id) {
    var p = pendingById(id); if (p && p.timer) clearTimeout(p.timer);
    state.pendingSends = state.pendingSends.filter(function (x) { return x.id !== id; });
    savePending();
  }
  function startPendingTicker() {
    if (state.pendingTicker) return;
    state.pendingTicker = setInterval(function () {
      if (!state.pendingSends.length) { clearInterval(state.pendingTicker); state.pendingTicker = null; return; }
      state.pendingSends.forEach(function (p) {
        var el = document.querySelector('[data-cd="' + p.id + '"]');
        if (el) el.textContent = Math.max(0, Math.ceil((p.sendAt - Date.now()) / 1000)) + "s";
      });
    }, 1000);
  }
  /* spec: { refType:"convo"|"post"|"ticket", ref, author, body, run } - run() performs the
     real send (live enqueue or demo) plus the optimistic thread update. */
  function queueSend(spec) {
    if (spec.immediate) {   // mods-only / internal notes send right away - no 60s undo window
      try { spec.run(); } catch (e) { toast("Send failed"); }
      return;
    }
    var id = "ps" + Date.now() + Math.random().toString(36).slice(2, 6);
    var p = { id: id, refType: spec.refType, ref: String(spec.ref), author: spec.author,
              body: spec.body, sendAt: Date.now() + SEND_WINDOW_MS, run: spec.run };
    p.timer = setTimeout(function () { firePending(id); }, SEND_WINDOW_MS);
    p.kind = spec.kind || "";
    state.pendingSends.push(p);
    savePending();
    startPendingTicker();
    render();
    scrollThreadToEnd();
    toast("Sending in 60s - Undo or Edit below");
  }
  function savePending() {
    try {
      localStorage.setItem("cmt-pending-sends", JSON.stringify(state.pendingSends.map(function (p) {
        return { id: p.id, refType: p.refType, ref: p.ref, author: p.author, body: p.body, sendAt: p.sendAt, kind: p.kind };
      })));
    } catch (e) {}
  }
  /* After a reload: re-queue replies that were still in their 60s window (overdue ones go out now). */
  function restorePending() {
    var list = [];
    try { list = JSON.parse(localStorage.getItem("cmt-pending-sends") || "[]") || []; } catch (e) {}
    try { localStorage.removeItem("cmt-pending-sends"); } catch (e) {}
    list.forEach(function (sp) {
      if (Date.now() - sp.sendAt > 10 * 60 * 1000) return;   // too old to send blindly
      var run = function () {
        if (sp.refType === "convo") enqueueAction("reddit_reply", { convo_id: sp.ref, text: sp.body, kind: sp.kind === "internal" ? "note" : "user" },
          function (r) { if (r.status === "done") toast("Reply sent to user"); else sendFailed("convo", sp.ref, sp.body, r.error); },
          function () { sendFailed("convo", sp.ref, sp.body, "could not reach the server"); });
        else if (sp.refType === "ticket") { var t = ticketByKey(sp.ref);
          if (t && t._id) enqueueAction("discord_reply", { ticket_id: t._id, text: sp.body, kind: sp.kind || "user" },
            function (r) { if (r.status === "done") toast("Sent to user"); else sendFailed("ticket", sp.ref, sp.body, r.error); },
            function () { sendFailed("ticket", sp.ref, sp.body, "could not reach the server"); });
          else sendFailed("ticket", sp.ref, sp.body, "ticket not found after reload"); }
      };
      var p = { id: sp.id, refType: sp.refType, ref: sp.ref, author: sp.author, body: sp.body, sendAt: Math.max(sp.sendAt, Date.now() + 3000), run: run, kind: sp.kind };
      p.timer = setTimeout(function () { firePending(p.id); }, p.sendAt - Date.now());
      state.pendingSends.push(p);
    });
    if (state.pendingSends.length) { startPendingTicker(); savePending(); }
  }
  function firePending(id) {
    var p = pendingById(id); if (!p) return;
    removePending(id);
    try { p.run(); } catch (e) { toast("Send failed"); }
  }
  function cancelPending(id) {
    if (!pendingById(id)) return;
    removePending(id); render(); toast("Send cancelled");
  }
  function editPending(id) {
    var p = pendingById(id); if (!p) return;
    var body = p.body; removePending(id); render();
    var ta = q("[data-composer]"); if (ta) { ta.value = body; ta.focus(); }
    toast("Editing - press send again to restart the 60s window");
  }
  /* Pending bubbles for a given thread, appended after the real messages. */
  function renderPending(refType, ref) {
    var list = state.pendingSends.filter(function (p) { return p.refType === refType && String(p.ref) === String(ref); });
    if (!list.length) return "";
    return list.map(function (p) {
      var s = Math.max(0, Math.ceil((p.sendAt - Date.now()) / 1000));
      return '<div class="msg out pending" style="opacity:.85"><div class="meta">' + esc(p.author) + DOT +
        'sending in <span data-cd="' + p.id + '">' + s + 's</span>' + DOT +
        '<a href="#" data-act="send-now" data-pid="' + p.id + '">Send now</a> ' + DOT + ' ' +
        '<a href="#" data-act="send-edit" data-pid="' + p.id + '">Edit</a> ' + DOT + ' ' +
        '<a href="#" data-act="send-undo" data-pid="' + p.id + '">Undo</a></div>' +
        '<div class="bubble" style="border:1px dashed var(--border)">' + esc(p.body) + "</div></div>";
    }).join("");
  }
  function sendFrom(btn) {
    var pane = btn.closest(".pane.detail"), ta = pane && pane.querySelector("[data-composer]");
    var val = ta && ta.value.trim(); if (!val) { if (ta) ta.focus(); toast("Type a message first"); return; }
    var kind = btn.getAttribute("data-kind") || "user";
    var convo = convoById(btn.getAttribute("data-convo"));
    if (!convo) { toast("This conversation is still loading - try again in a second"); return; }
    if (state.drafts) state.drafts[state._threadKey] = "";
    ta.value = "";
    queueSend({ refType: "convo", ref: convo.id, kind: kind, author: myName(), body: val, immediate: kind === "internal", run: function () {
      logActivity(kind === "internal" ? "left a mods-only note" : "replied on Reddit ModMail", "u/" + convo.participant);
      function applyLocal() {
        convo.messages.push({ id: "m" + Date.now(), author: myName(), is_internal: kind === "internal", ago: "now", body: val, _local: true, _localAt: Date.now() });
        if (kind === "user") {
          // Our public reply: the derived status is now "Waiting on user". Mark it so the LIST row
          // stays correct across refresh/reload before the bot snapshot catches up (item W3).
          convo.unread = false;
          convo.mod_replied = true;
          if (!convo.last_author || convo.last_author === convo.participant) convo.last_author = myName();
          D.convoReplied = D.convoReplied || {}; D.convoReplied[convo.id] = 1; holdLocal("replied", convo.id, 1);
        }
      }
      applyLocal(); render();
        scrollThreadToEnd();
        if (kind === "user") window.CONSOLE.post("/convo-replied", { convo_id: convo.id }).then(function () {}, function () {});
        enqueueAction("reddit_reply", { convo_id: convo.id, text: val, kind: kind === "internal" ? "note" : "user" }, function (r) {
          if (r.status === "done") { toast(kind === "internal" ? "Mods-only note posted" : "Reply sent to user"); return; }
          sendFailed("convo", convo.id, val, r.error);
        }, function () { sendFailed("convo", convo.id, val, "could not reach the server"); });
    } });
  }
  function toggleHighlight(btn) {
    var convo = convoById(btn.getAttribute("data-convo"));
    var user = btn.getAttribute("data-user") || "";
    if (!convo) return;
    var mn = D.modNotes[user] || (D.modNotes[user] = { jira_convos: {}, highlighted_convos: [] });
    if (!mn.highlighted_convos) mn.highlighted_convos = [];
    var want = mn.highlighted_convos.indexOf(convo.id) < 0;   // toggle
    function applyLocal() {
      var i = mn.highlighted_convos.indexOf(convo.id);
      if (want && i < 0) mn.highlighted_convos.push(convo.id);
      else if (!want && i >= 0) mn.highlighted_convos.splice(i, 1);
    }
    toast(want ? "Highlighting on Reddit..." : "Removing highlight...");
      enqueueAction("reddit_highlight", { convo_id: convo.id, reddit_user: user, highlight: want }, function (r) {
        if (r.status === "done") { applyLocal(); render(); toast(want ? "Highlighted on Reddit" : "Highlight removed"); }
        else toast("Highlight failed: " + (r.error || "unknown"));
      });
  }
  function archiveConvo(btn) {
    var convo = convoById(btn.getAttribute("data-convo"));
    if (!convo) return;
    toast("Archiving on Reddit...");
      enqueueAction("reddit_archive", { convo_id: convo.id }, function (r) {
        if (r.status === "done") {
          convo.site_status = "resolved"; convo._archived = true;
          convo.override_status = "done"; convo._override_at = new Date().toISOString();
          postConvoStatus(convo.id, "done").then(function () {}, function () {});
          render(); toast("Archived on Reddit");
        }
        else toast("Archive failed: " + (r.error || "unknown"));
      });
  }
  /* Ignore / un-ignore a Reddit post. Ignored = intentionally left unanswered;
     it counts as closed and drops out of the No-reply queue. Persisted site-side. */
  function togglePostIgnore(btn) {
    var post = D.redditPosts.filter(function (p) { return p.id === btn.getAttribute("data-post"); })[0];
    if (!post) return;
    var want = !post.ignored;
    function commit(reason) {
      function applyLocal() {
        var ig = state._ignored || (state._ignored = []), at = ig.indexOf(post.id);
        if (want && at < 0) ig.push(post.id); else if (!want && at >= 0) ig.splice(at, 1);
        var meta = state._ignoreMeta || (state._ignoreMeta = {});
        if (want) meta[post.id] = { reason: reason || "", by: myName() }; else delete meta[post.id];
        post.ignored = want; if (want) { post.ignore_reason = reason; post.ignored_by = myName(); } else { post.ignore_reason = ""; post.ignored_by = ""; } logActivity(want ? "ignored a Reddit post" : "un-ignored a Reddit post", (post.title || post.subreddit) + (reason ? " - " + reason : "")); render(); toast(want ? "Post ignored" : "Post un-ignored"); }
      window.CONSOLE.post("/post-flags", { post_id: post.id, ignored: want, reason: reason || "" }).then(applyLocal,
          function () { toast("Could not update"); });
    }
    if (want) {
      // Ignoring a post requires a reason so the team keeps a record of why it was skipped.
      showModal({
        title: "Ignore post", submit: "Ignore", close: "Cancel",
        fields: [{ id: "reason", label: "Reason", type: "textarea", required: true, placeholder: "Why is this post being ignored?" }],
        onSubmit: function (v) {
          var reason = (v.reason || "").trim();
          if (!reason) { toast("A reason is required to ignore"); return; }
          commit(reason);
        }
      });
      return;
    }
    commit("");
  }
  function toggleTgIgnore(btn) {
    var m = (D.telegramMessages || []).filter(function (x) { return x.id === btn.getAttribute("data-id"); })[0];
    if (!m) return;
    var want = !m.ignored;
    function applyLocal() { m.ignored = want; holdLocal("tgign", m.id, want); logActivity(want ? "ignored a Telegram message" : "un-ignored a Telegram message", "@" + (m.username || m.user || "")); render(); toast(want ? "Telegram message ignored" : "Un-ignored"); }
    window.CONSOLE.post("/telegram-status", { id: m.id, status: want ? "ignored" : "new" }).then(applyLocal,
        function () { toast("Could not update"); });
  }
  /* Bulk-ignore the selected Telegram messages (multi-select via the per-card checkbox). */
  function bulkTgIgnore() {
    var sel = state.tgSel || {};
    var msgs = (D.telegramMessages || []).filter(function (m) { return sel[m.id] && !m.ignored; });
    if (!msgs.length) { state.tgSel = {}; render(); return; }
    var done = 0, fail = 0, total = msgs.length;
    function finish() {
      if (done + fail < total) return;
      state.tgSel = {}; logActivity("ignored " + done + " Telegram messages", ""); render();
      toast(done + " ignored" + (fail ? ", " + fail + " failed" : ""));
    }
    msgs.forEach(function (m) {
      window.CONSOLE.post("/telegram-status", { id: m.id, status: "ignored" }).then(
        function () { m.ignored = true; holdLocal("tgign", m.id, true); done++; finish(); },
        function () { fail++; finish(); });
    });
  }
  function dsendFrom(btn) {
    var pane = btn.closest(".pane.detail"), ta = pane && pane.querySelector("[data-composer]");
    var val = ta && ta.value.trim(); if (!val) { if (ta) ta.focus(); toast("Type a message first"); return; }
    var kind = btn.getAttribute("data-kind") || "user";
    var t = ticketByKey(btn.getAttribute("data-ticket"));
    if (!t) { toast("This ticket is still loading - try again in a second"); return; }
    if (state.drafts) state.drafts[state._threadKey] = "";
    ta.value = "";
    queueSend({ refType: "ticket", ref: tid(t), kind: kind, author: myName(), body: val, immediate: kind === "note", run: function () {
      logActivity(kind === "note" ? "left a Discord internal note" : "replied on Discord", "#" + t.ticket_number + " " + t.user_name);
      function applyLocal() {
        t.messages_history = t.messages_history || [];
        t.messages_history.push({ author_name: myName(), content: val, timestamp: "now", is_user: false, note: kind === "note", _local: true, _localAt: Date.now() });
        t.messages_count = (t.messages_count || 0) + 1;
      }
      if (t._id) {
        applyLocal(); render();
        scrollThreadToEnd();
        enqueueAction("discord_reply", { ticket_id: t._id, text: val, kind: kind }, function (r) {
          if (r.status === "done") { toast(kind === "note" ? "Internal note posted" : "Sent to user"); return; }
          sendFailed("ticket", tid(t), val, r.error);
        }, function () { sendFailed("ticket", tid(t), val, "could not reach the server"); });
        return;
      }
      // A ticket without a server id cannot be sent to: never pretend it went out.
      sendFailed("ticket", tid(t), val, "this ticket is not saved on the server yet, reload the page");
    } });
  }

  /* ---------- tags (context panel) + Actions hub ---------- */
  function tagsArrFor(type, ref) {
    var key = "tags", obj = type === "convo" ? convoById(ref)
            : type === "ticket" ? ticketByKey(ref)
            : type === "post" ? D.redditPosts.filter(function (p) { return p.id === ref; })[0]
            : type === "mention" ? (D.discordMentions || []).filter(function (x) { return x.id === ref; })[0]
            : type === "telegram" ? (D.telegramMessages || []).filter(function (x) { return x.id === ref; })[0]
            : null;
    if (type === "forum") { obj = (D.discordForum || []).filter(function (x) { return x.id === ref; })[0]; key = "consoleTags"; }   // keep console tags apart from native Discord forum tags
    if (!obj) return null;
    if (!obj[key]) obj[key] = [];
    return obj[key];
  }
  function addTagFrom(btn) {
    var wrap = btn.closest(".note-add"), inp = wrap && wrap.querySelector("[data-tag-input]");
    var val = inp && inp.value.trim(); if (!val) { if (inp) inp.focus(); return; }
    var _tl = D.issueTags || [];   // restrict tags to our list (item: only our tags can be added)
    if (_tl.length) {
      var _canon = _tl.filter(function (t) { return String(t).toLowerCase() === val.toLowerCase(); })[0];
      if (!_canon) { toast("Pick a tag from the list"); if (inp) inp.focus(); return; }
      val = _canon;
    }
    var type = btn.getAttribute("data-tag-type"), ref = btn.getAttribute("data-tag-ref");
    var arr = tagsArrFor(type, ref); if (!arr) return;
    function done() { render(); if (state.modal) renderModal(); }   // also refresh the tag-editor popover if open
    if (arr.indexOf(val) >= 0) { done(); return; }
    window.CONSOLE.post("/tags", { context_type: type, ref: ref, tag: val }).then(function () {
        _tagsLocal(type, ref, val, true); arr.push(val); logActivity("added tag '" + val + "'", type + " " + ref); done(); toast("Tag added");
      }, function () { toast("Could not add tag"); });
  }
  /* Fresh ticket objects pulled in outside the refresh (closed archive page, archive search, Profile 360
     history) get the same overlays as the main list: manual status + tags. */
  function overlayTickets(list) {
    var ov = state._overrides || {}, at = state._overridesAt || {};
    (list || []).forEach(function (t) { var k = tid(t); if (ov[k]) { t.override_status = ov[k]; t._override_at = at[k] || ""; } });
    if (state._tags) applyTags(state._tags);
  }
  /* Keep state._tags (re-applied to every rebuilt list on refresh) in step with a local tag change. */
  function _tagsLocal(type, ref, tag, add) {
    var l = state._tags || (state._tags = []);
    state._tags = l.filter(function (d) { return !(d.context_type === type && d.ref === ref && d.tag === tag); });
    if (add) state._tags.push({ context_type: type, ref: ref, tag: tag });
  }
  function delTagFrom(btn) {
    var type = btn.getAttribute("data-tag-type"), ref = btn.getAttribute("data-tag-ref"), tag = btn.getAttribute("data-tag");
    var arr = tagsArrFor(type, ref); if (!arr) return;
    function removeLocal() { var i = arr.indexOf(tag); if (i >= 0) arr.splice(i, 1); render(); if (state.modal) renderModal(); }
    window.CONSOLE.del("/tags?context_type=" + encodeURIComponent(type) + "&ref=" + encodeURIComponent(ref) + "&tag=" + encodeURIComponent(tag))
        .then(function () { _tagsLocal(type, ref, tag, false); removeLocal(); toast("Tag removed"); }, function () { toast("Could not remove tag"); });
  }

  /* ---------- events ---------- */
  document.addEventListener("click", function (e) {
    var ci = e.target.closest(".cmdk-item"); if (ci) { activateCmdk(+ci.getAttribute("data-cmdk-i")); return; }
    if (e.target.id === "cmdk-overlay") { closeCmdk(); return; }
    // A hard modal does not close on a backdrop click (too easy to lose work by mis-clicking) - only
    // the X / Cancel button or Esc closes it. The modeless popover has no backdrop anyway.
    var act = e.target.closest("[data-act]");
    if (act) {
      var a = act.getAttribute("data-act");
      if (a === "theme") { openThemePicker(); return; }
      if (a === "theme-pick") { state.modalValues.theme = act.getAttribute("data-theme-id"); renderModal(); return; }
      if (a === "refresh") { manualRefresh(); return; }
      if (a === "feedback-open") { toggleFeedback(); return; }
      if (a === "feedback-cat") { fbPickCat(act); return; }
      if (a === "feedback-all") { closeFeedback(); return; }
      if (a === "feedback-close") { closeFeedback(); return; }
      if (a === "feedback-submit") { submitFeedback(); return; }
      if (a === "shot-unstage") { var _sk = act.getAttribute("data-stage"); shotStage(_sk).splice(parseInt(act.getAttribute("data-i"), 10), 1); redrawShotPicker(_sk); return; }
      if (a === "ki-shot-del") { kiShotDelete(act.getAttribute("data-id")); return; }
      if (a === "ksug-shot-del") {
        var _sg = act.getAttribute("data-sug"), _sh = act.getAttribute("data-id");
        window.CONSOLE.del("/known-issues-suggestions/" + encodeURIComponent(_sg) + "/shots/" + encodeURIComponent(_sh)).then(function () {
          var _s = (D.knownSuggestions || []).filter(function (x) { return x.id === _sg; })[0];
          if (_s) _s.shots = (_s.shots || []).filter(function (x) { return x.id !== _sh; });
          syncModalValues(); renderModal(); render(); toast("Screenshot removed", "ok");
        }, function () { toast("Remove failed"); });
        return;
      }
      if (a === "cmdk") { openCmdk(); return; }
      if (a === "toast") { toast(act.getAttribute("data-msg") || "Demo"); return; }
      if (a === "filter") { state[act.getAttribute("data-group")] = act.getAttribute("data-val"); if (!leaveMobileDetail()) render(); return; }
      if (a === "history-toggle") { var hk = act.getAttribute("data-key"); state[hk] = !state[hk]; if (!leaveMobileDetail()) render(); return; }
      if (a === "inbox-tab") { state.inboxTab = act.getAttribute("data-tab"); render(); return; }
      if (a === "known-tab") { state.knownTab = act.getAttribute("data-tab"); state.knownSel = null; state.knownQuery = ""; render(); return; }
      if (a === "mnt-tab") { state.mntTab = act.getAttribute("data-tab"); render(); return; }
      if (a === "mnt-end") { confirmEndMaintenance(act.getAttribute("data-entity"), act.getAttribute("data-type")); return; }
      if (a === "mnt-add-brazil") { addBrazilMaintenance(); return; }
      if (a === "mnt-edit-brazil") { var _be = act.getAttribute("data-entity"); addBrazilMaintenance((D.maintenances || []).filter(function (x) { return x.type === "brazil" && x.entity === _be; })[0] || { entity: _be }); return; }
      if (a === "known-open") { openKnownDetail(act.getAttribute("data-cat"), act.getAttribute("data-key")); return; }
      if (a === "known-add") { openAddKnownIssue(act.getAttribute("data-cat")); return; }
      if (a === "known-sync") { toast("Syncing from the sheet…"); enqueueAction("known_issues_sync", {}, function (r) { if (r && r.status === "done") { toast("Synced"); refreshKnown(); } else toast("Sync failed" + (r && r.error ? ": " + r.error : "")); }); return; }
      if (a === "known-sug-approve") { approveKnownSuggestion(act.getAttribute("data-id")); return; }
      if (a === "known-sug-reject") { if (state.modal) closeModal(); rejectKnownSuggestion(act.getAttribute("data-id")); return; }
      if (a === "known-sug-review") { openKnownSuggestionReview(act.getAttribute("data-id")); return; }
      if (a === "known-sug-save") { saveKnownSuggestion(act.getAttribute("data-id")); return; }
      if (a === "sch-view") { state.scheduleView = act.getAttribute("data-val") === "month" ? "month" : "week"; render(); return; }
      if (a === "sch-week") {
        var _wd = act.getAttribute("data-dir");
        if (_wd === "0") { state.scheduleWeekStart = null; }
        else { var _ws = currentWeekStart(); _ws.setDate(_ws.getDate() + (_wd === "1" ? 7 : -7)); state.scheduleWeekStart = _ws.getTime(); }
        render(); return;
      }
      if (a === "leave-req") { openLeaveRequest(act.getAttribute("data-type") === "sick" ? "sick" : "vacation"); return; }
      if (a === "my-leave") { openMyLeave(); return; }
      if (a === "leave-submit") { submitLeave(act.getAttribute("data-type") === "sick" ? "sick" : "vacation"); return; }
      if (a === "leave-decide") { decideLeave(act.getAttribute("data-id"), act.getAttribute("data-decision")); return; }
      if (a === "copy-leave") { var _lid = act.getAttribute("data-id"); var _lr = (D.leaveAll || []).concat(D.leaveRequests || []).filter(function (x) { return String(x.id) === String(_lid); })[0]; if (_lr) copyText(leaveEmailTemplate(_lr), "Email template copied"); return; }
      if (a === "sch-day") { openScheduleDay(act.getAttribute("data-month"), act.getAttribute("data-date")); return; }
      if (a === "sch-cell") { openScheduleCell(act.getAttribute("data-month"), act.getAttribute("data-date"), act.getAttribute("data-member"), act.getAttribute("data-mindex"), act.getAttribute("data-value")); return; }
      if (a === "sch-set") { if (state._schCell) scheduleSetCell(state._schCell, act.getAttribute("data-val")); return; }
      if (a === "sch-set-input") { var _sci = q("#sch-input"); if (state._schCell) scheduleSetCell(state._schCell, _sci ? _sci.value.trim() : ""); return; }
      if (a === "sch-new-month") { openCreateMonth(); return; }
      if (a === "sch-sync") { toast("Syncing schedule…"); enqueueAction("schedule_sync", {}, function (r) { if (r && r.status === "done") { toast("Synced"); refreshSchedule(); } else toast("Sync failed" + (r && r.error ? ": " + r.error : "")); }); return; }
      if (a === "sched-config-save") { var _su = ((document.querySelector("[data-sched-url]") || {}).value || "").trim(); var _scfg = { webapp_url: _su }; D.scheduleConfig = _scfg; window.CONSOLE.post("/schedule-config", _scfg).then(function () { toast("Schedule config saved"); }, function () { toast("Save failed"); }); return; }
      if (a === "gc-add-game") { openAddGame(); return; }
      if (a === "gca-mode") { syncModalValues(); state.modalValues.mode = act.getAttribute("data-mode"); renderModal(); return; }
      if (a === "gcs-repick") { var _rs = gcSug(act.getAttribute("data-src")); _rs.status = "pick"; gcRerender(); return; }
      if (a === "gc-new-week") { openCreateWeek(); return; }
      if (a === "gc-toggle") { var _gw = currentGcWeek(); if (_gw) { var _gk = _gw.week + "||" + act.getAttribute("data-row"); state.gcOpen = state.gcOpen || {}; state.gcOpen[_gk] = !state.gcOpen[_gk]; render(); } return; }
      if (a === "gc-copyrow") { gcCopyRow(act.getAttribute("data-row")); return; }
      if (a === "gc-delete") {
        var _gcw = currentGcWeek(); if (!_gcw) return;
        var _gcrow = act.getAttribute("data-row"), _gctitle = act.getAttribute("data-title") || "this card";
        if (!window.confirm('Delete "' + _gctitle + '" from ' + _gcw.week + "?\nThis removes the row from the sheet (other cards shift up).")) return;
        toast("Deleting card…");
        enqueueAction("game_cards_delete", { week: _gcw.week, row_index: parseInt(_gcrow, 10) }, function (r) {
          if (r && r.status === "done") { toast("Card deleted"); refreshGameCards(); }
          else toast("Delete failed" + (r && r.error ? ": " + r.error : ""), "error");
        });
        return;
      }
      if (a === "gc-copy") { copyText(act.getAttribute("data-text"), "Copied"); return; }
      if (a === "rl-f") { var _rs = rlState(); _rs[act.getAttribute("data-group")] = act.getAttribute("data-val"); render(); return; }
      if (a === "rl-person") { var _rp = rlState(), _rv = act.getAttribute("data-val"); _rp.author = _rp.author === _rv ? "" : _rv; render(); return; }
      if (a === "rl-expand") { act.classList.toggle("open"); return; }
      if (a === "rl-csv") { rlCsv(); return; }
      if (a === "gt-sync") { toast("Reading the testing sheet…"); enqueueAction("game_testing_sync", {}, function (r) { if (r && r.status === "done") { toast("Synced", "ok"); refreshGameTesting(true); } else toast("Sync failed" + (r && r.error ? ": " + r.error : "")); }); return; }
      if (a === "gt-plat") { state.gtPlat = act.getAttribute("data-val"); render(); return; }
      if (a === "gt-config-save") { var _tu = ((document.querySelector("[data-gt-url]") || {}).value || "").trim(); var _tcfg = { webapp_url: _tu }; D.gameTestingConfig = _tcfg; window.CONSOLE.post("/game-testing-config", _tcfg).then(function () { toast("Game-testing config saved"); }, function () { toast("Save failed"); }); return; }
      if (a === "gc-sync") { toast("Syncing game cards…"); enqueueAction("game_cards_sync", {}, function (r) { if (r && r.status === "done") { toast("Synced"); refreshGameCards(); } else toast("Sync failed" + (r && r.error ? ": " + r.error : "")); }); return; }
      if (a === "gc-config-save") { var _gu = ((document.querySelector("[data-gc-url]") || {}).value || "").trim(); var _gcfg = { webapp_url: _gu }; D.gameCardsConfig = _gcfg; window.CONSOLE.post("/game-cards-config", _gcfg).then(function () { toast("Game-cards config saved"); }, function () { toast("Save failed"); }); return; }
      if (a === "maint-sheet-config-save") { var _mu = ((document.querySelector("[data-maint-url]") || {}).value || "").trim(); var _mcfg = { webapp_url: _mu }; D.maintSheetConfig = _mcfg; window.CONSOLE.post("/maintenance-sheet-config", _mcfg).then(function () { toast("Maintenance sheet config saved"); }, function () { toast("Save failed"); }); return; }
      if (a === "reddit-flag-save") {
        var _rf = function (k) { return document.querySelector('[data-rfa="' + k + '"]'); };
        var _rcfg = { enabled: !!(_rf("enabled") || {}).checked,
          alert_minutes: +((_rf("alert_minutes") || {}).value) || 10,
          min_errors: +((_rf("min_errors") || {}).value) || 5,
          realert_hours: +((_rf("realert_hours") || {}).value) || 3,
          tag: ((_rf("tag") || {}).value || "").trim() };
        window.CONSOLE.post("/reddit-flag-alert", _rcfg).then(function (r) { D.redditFlagAlert = r || _rcfg; render(); toast("Reddit alert settings saved"); }, function () { toast("Save failed"); });
        return;
      }
      if (a === "leave-config-save") { var _lvt = Math.max(0, +((document.querySelector("[data-leave-vac]") || {}).value) || 0); var _lst = Math.max(0, +((document.querySelector("[data-leave-sick]") || {}).value) || 0); var _lcfg = { vac_total: _lvt, sick_total: _lst }; D.leaveConfig = _lcfg; window.CONSOLE.post("/leave-config", _lcfg).then(function () { toast("Leave policy saved"); }, function () { toast("Save failed"); }); return; }
      if (a === "copy-canned") { var _kb = act.closest(".ki-canned"); var _bb = _kb && _kb.querySelector(".ki-canned-body"); copyText(_bb ? (_bb.innerText || _bb.textContent || "") : "", "Canned message copied"); return; }
      if (a === "history-all") { moveAllToHistory(); return; }
      if (a === "load-closed") { loadClosed(); return; }
      if (a === "discord-tab") { state.discordTab = act.getAttribute("data-tab"); if (parseHash().id) location.hash = "#/discord"; else render(); return; }
      if (a === "mention-status") {
        var _mid = act.getAttribute("data-id"), _mval = act.getAttribute("data-val");
        (D.discordMentions || []).forEach(function (o) { if (o.id === _mid) o.status = (o.status === _mval ? "new" : _mval); });
        var _mn = (D.discordMentions || []).filter(function (o) { return o.id === _mid; })[0];
        if (_mn) window.CONSOLE.post("/mention-status", { id: _mid, status: _mn.status }).then(function () {}, function () {});
        if (_mn) logActivity("marked Discord mention " + _mn.status, "#" + (_mn.channel_name || ""));
        render(); toast(_mval === "ignored" ? "Marked Ignored" : "Marked Replied"); return;
      }
      if (a === "forum-status") {
        var _fid = act.getAttribute("data-id"), _fval = act.getAttribute("data-val");
        D.forumStatus = D.forumStatus || {};
        var _fnext = (D.forumStatus[_fid] === _fval) ? "new" : _fval;   // toggle off -> back into the To-Do
        if (_fnext === "new") delete D.forumStatus[_fid]; else D.forumStatus[_fid] = _fnext;
        window.CONSOLE.post("/forum-status", { id: _fid, status: _fnext }).then(function () {}, function () {});
        var _ff = (D.discordForum || []).filter(function (o) { return o.id === _fid; })[0];
        if (_ff) logActivity("marked Discord forum " + _fnext, _ff.title || "");
        render(); toast(_fnext === "new" ? "Back to To-Do" : (_fval === "ignored" ? "Marked Ignored" : "Marked Replied")); return;
      }
      if (a === "tg-reply") { openTgReply(act.getAttribute("data-id")); return; }
      if (a === "tg-ignore") { toggleTgIgnore(act); return; }
      if (a === "tg-select") {
        var _tid = act.getAttribute("data-id"); state.tgSel = state.tgSel || {};
        var _on = !state.tgSel[_tid], _ord = state._tgOrder || [];
        if (e.shiftKey && state._tgLast && _ord.indexOf(state._tgLast) >= 0 && _ord.indexOf(_tid) >= 0) {   // range
          var _a = _ord.indexOf(state._tgLast), _b = _ord.indexOf(_tid), _lo = Math.min(_a, _b), _hi = Math.max(_a, _b);
          for (var _i = _lo; _i <= _hi; _i++) { if (_on) state.tgSel[_ord[_i]] = true; else delete state.tgSel[_ord[_i]]; }
        } else if (_on) state.tgSel[_tid] = true; else delete state.tgSel[_tid];
        state._tgLast = _tid; render(); return;
      }
      if (a === "tg-select-all") {
        var _all = state._tgOrder || []; state.tgSel = state.tgSel || {};
        var _every = _all.length && _all.every(function (x) { return state.tgSel[x]; });
        _all.forEach(function (x) { if (_every) delete state.tgSel[x]; else state.tgSel[x] = true; });
        render(); return;
      }
      if (a === "tg-open") { state.tgOpen = act.getAttribute("data-id"); render(); return; }
      if (a === "tg-clear-sel") { state.tgSel = {}; render(); return; }
      if (a === "tg-bulk-ignore") { bulkTgIgnore(); return; }
      if (a === "add-suggestion") { var _smid = act.getAttribute("data-id"); var _sm = (D.telegramMessages || []).filter(function (x) { return x.id === _smid; })[0]; openAddSuggestion(_sm ? _sm.text : "", _smid); return; }
      if (a === "add-gaming-proposal") { openAddSuggestion(""); return; }
      if (a === "act-create-urgent") { openCreateUrgent(null); return; }
      if (a === "act-create-ticket") { openJiraTicket(null); return; }
      if (a === "proposal-add") { openProposalForChat({ type: act.getAttribute("data-anchor-type"), ref: act.getAttribute("data-anchor-ref") }); return; }
      if (a === "add-proposal") { openAddProposal(""); return; }
      if (a === "tg-send") {
        var _tta = q("[data-composer]"), _ttxt = _tta ? _tta.value.trim() : "";
        if (!_ttxt) { toast("Write a reply first"); return; }
        var _tm = (D.telegramMessages || []).filter(function (x) { return x.id === act.getAttribute("data-id"); })[0];
        if (_tm) { _tm.answered = true; _tm.reply = _ttxt; _tm._local = true; }
        enqueueAction("telegram_reply", { id: act.getAttribute("data-id"), text: _ttxt }, function () {});
        logActivity("replied on Telegram", _tm ? "@" + (_tm.username || "") : "");
        closeModal(); render(); toast("Reply sent as the group"); return;
      }
      if (a === "dbmig-preview") { dbMigRun(+act.getAttribute("data-id"), false); return; }
      if (a === "dbmig-apply") { dbMigRun(+act.getAttribute("data-id"), true); return; }
      if (a === "dbmig-report") { dbReport(); return; }
      if (a === "convo-delete") {
        var _dc = act.getAttribute("data-convo");
        if (!window.confirm("Delete this conversation from the console?\n\nOnly the console copy is removed; Reddit is not touched.")) return;
        D.redditModmail = D.redditModmail.filter(function (c) { return c.id !== _dc; });
        location.hash = "#/modmail";
        render();
        window.CONSOLE.del("/reddit-modmail/" + encodeURIComponent(_dc)).then(function () { toast("Deleted from the console"); }, function () { toast("Delete failed"); });
        return;
      }
      if (a === "fb-translate") {
        var _tid = act.getAttribute("data-id"), _tp = fbPostById(_tid);
        state.fbTr = state.fbTr || {};
        if (state.fbTr[_tid]) { delete state.fbTr[_tid]; render(); return; }
        if (!_tp || !_tp.text) return;
        act.textContent = "...";
        window.CONSOLE.post("/translate", { text: _tp.text }).then(function (d) {
          if (d && d.same) { act.textContent = "Translate"; toast(d.names_only ? "Only names here, nothing to translate" : "Already in Russian"); return; }
          if (d && d.text) { state.fbTr[_tid] = d.text; render(); }
          else { act.textContent = "Translate"; toast(d && d.error ? d.error : "Translation failed"); }
        }, function () { act.textContent = "Translate"; toast("Translation failed"); });
        return;
      }
      if (a === "fb-tab") { state.fbTab = act.getAttribute("data-tab"); render(); return; }
      if (a === "fb-filter") { state.fbFilter = act.getAttribute("data-f"); render(); return; }
      if (a === "fb-status") { fbPatch(act.getAttribute("data-id"), { status: act.getAttribute("data-st") }); renderRail(); setActiveNav("channels"); return; }
      if (a === "fb-untag") {
        var _fp = fbPostById(act.getAttribute("data-id")), _tg = act.getAttribute("data-tag");
        if (_fp) fbPatch(_fp.id, { tags: (_fp.tags || []).filter(function (t) { return t !== _tg; }) });
        return;
      }
      if (a === "fb-tag") {
        var _tid2 = act.getAttribute("data-id"), _tpo = fbPostById(_tid2);
        if (!_tpo) return;
        // The same tag list as everywhere else in the console (Admin > Issue tags).
        showModal({ title: "Tags", submit: "Save", close: "Cancel",
          initial: { tags: (_tpo.tags || []).slice() },
          fields: [{ id: "tags", label: "Tags", type: "multiselect", placeholder: "Select tags", options: D.issueTags || [] }],
          onSubmit: function (v) { fbPatch(_tid2, { tags: (v.tags || []).slice() }); } });
        return;
      }
      if (a === "fb-bind") {
        var _fid = act.getAttribute("data-id"), _fpo = fbPostById(_fid), _isTag = false;
        showModal({ title: _isTag ? "Add tag" : "Bind author to User ID", submit: "Save", close: "Cancel",
          initial: { v: _isTag ? "" : ((_fpo && _fpo.user_id) || "") },
          fields: [{ id: "v", label: _isTag ? "Tag" : "User ID or email (applies to all posts by " + ((_fpo && _fpo.author) || "this author") + ")", type: "text", required: !_isTag }],
          onSubmit: function (v) {
            var val = (v.v || "").trim();
            if (!_fpo) return closeModal();
            if (_isTag) { if (val && (_fpo.tags || []).indexOf(val) < 0) fbPatch(_fid, { tags: (_fpo.tags || []).concat([val]) }); }
            else fbPatch(_fid, { user_id: val });
            closeModal();
          } });
        return;
      }
      if (a === "fbdm-seen") {
        var _did = act.getAttribute("data-id");
        (D.fbDms || []).forEach(function (d) { if (d.id === _did) d.status = "seen"; });
        render(); renderRail(); setActiveNav("channels");
        window.CONSOLE.patch("/fb-dms/" + encodeURIComponent(_did), { status: "seen" }).then(function () {}, function () {});
        return;
      }
      if (a === "wl-tab") { state.wlTab = act.getAttribute("data-tab") || ""; render(); return; }
      if (a === "wl-sort") { state.wlSort = act.getAttribute("data-sort") || "total"; render(); return; }
      if (a === "wl-week") { var _wk = act.getAttribute("data-week"); state.wlWeekOpen = state.wlWeekOpen === _wk ? "-" : _wk; render(); return; }
      if (a === "wl-toggle") {
        if (e.target.closest("a")) return;
        state.wlOpen = state.wlOpen || {}; var _wkey = act.getAttribute("data-key");
        state.wlOpen[_wkey] = !state.wlOpen[_wkey];
        if (state.wlOpen[_wkey] && !(state.wlReq || {})[_wkey]) loadWishlistRequests(_wkey);
        render(); return;
      }
      if (a === "wl-status") { openWishlistStatus(act.getAttribute("data-key"), act.getAttribute("data-status")); return; }
      if (a === "bans-tab") { state.bansTab = act.getAttribute("data-tab") || ""; render(); return; }
      if (a === "ban-toggle") { state.banOpen = state.banOpen || {}; var _bid = act.getAttribute("data-id"); state.banOpen[_bid] = !state.banOpen[_bid]; render(); return; }
      if (a === "copy-text") { copyText(act.getAttribute("data-text"), "Copied"); return; }
      if (a === "events-cat") { state.eventsCat = act.getAttribute("data-cat") || ""; render(); return; }
      if (a === "add-maintenance") { openAddMaintenance(act.getAttribute("data-ctx-type"), act.getAttribute("data-ctx-ref")); return; }
      if (a === "list-save") { saveExclusionList(act.getAttribute("data-key")); return; }
      if (a === "reminders-save") {
        var _rc = {};
        Array.prototype.forEach.call(document.querySelectorAll("[data-rem]"), function (el) {
          _rc[el.getAttribute("data-rem")] = el.type === "checkbox" ? el.checked : (el.type === "number" ? (+el.value || 0) : el.value);
        });
        D.remindersConfig = _rc;
        window.CONSOLE.post("/reminders-config", _rc).then(function () { toast("Reminders saved"); }, function () { toast("Save failed"); });
        return;
      }
      if (a === "forums-save") {
        var _fc = {};
        Array.prototype.forEach.call(document.querySelectorAll("[data-forum-cat]"), function (el) { _fc[el.getAttribute("data-forum-cat")] = el.value.trim(); });
        D.forumConfig = _fc;
        window.CONSOLE.post("/forums-config", _fc).then(function () { toast("Forums saved"); }, function () { toast("Save failed"); });
        return;
      }
      if (a === "known-config-save") {
        var _kurl = ((document.querySelector("[data-known-url]") || {}).value || "").trim();
        var _kcfg = { webapp_url: _kurl, tg_chats: ((document.querySelector("[data-known-tg]") || {}).value || "").trim() };
        D.knownConfig = _kcfg;
        window.CONSOLE.post("/known-issues-config", _kcfg).then(function () { toast("Known-issues config saved"); }, function () { toast("Save failed"); });
        return;
      }
      if (a === "game-list-config-save") {
        var _glurl = ((document.querySelector("[data-game-list-url]") || {}).value || "").trim();
        var _glcfg = { webapp_url: _glurl };
        D.gameListConfig = _glcfg;
        window.CONSOLE.post("/game-list-config", _glcfg).then(function () { toast("Game List config saved"); }, function () { toast("Save failed"); });
        return;
      }
      if (a === "game-list-sync") { toast("Syncing the Game List…"); enqueueAction("game_list_sync", {}, function (r) { if (r && r.status === "done") { toast("Game List synced"); window.CONSOLE.get("/game-list").then(function (d) { if (d && d.by_title) { D.gameList = d.by_title; render(); } }, function () {}); } else toast("Sync failed" + (r && r.error ? ": " + r.error : "")); }); return; }
      if (a === "jira-sync") { jiraSync(false); return; }
      if (a === "jira-status") { openJiraStatus(act.getAttribute("data-key")); return; }
      if (a === "jira-do-transition") { doJiraTransition(act); return; }
      if (a === "jira-comment") { postJiraComment(act); return; }
      if (a === "jira-edit") { openJiraEdit(act.getAttribute("data-key")); return; }
      if (a === "jira-edit-save") { saveJiraEdit(act); return; }
      if (a === "jira-fields") { openJiraFields(act.getAttribute("data-key")); return; }
      if (a === "jira-comment-edit") { openJiraCommentEdit(act.getAttribute("data-key"), act.getAttribute("data-cid")); return; }
      if (a === "jira-cedit-save") { saveJiraCommentEdit(act); return; }
      if (a === "jira-attach-trigger") { var _fi = document.getElementById(act.getAttribute("data-for")); if (_fi) _fi.click(); return; }
      if (a === "gc-pick") { state.gcSel = act.getAttribute("data-row"); render(); return; }
      if (a === "ds-filters") { state.dsFiltersOpen = !state.dsFiltersOpen; render(); return; }
      if (a === "ctx-add-open") {   // side panel: show the tag/note input only when asked (demo layout)
        state.ctxAdd = act.getAttribute("data-key"); render();
        var sel = state.ctxAdd.indexOf("tag|") === 0 ? "[data-tag-input]" : "[data-note-input]";
        setTimeout(function () { var inp = q(sel); if (inp) inp.focus(); }, 0);
        return;
      }
      if (a === "note-add") { addNoteFrom(act); state.ctxAdd = ""; return; }
      if (a === "note-edit") { openNoteEdit(act.getAttribute("data-id")); return; }
      if (a === "note-del") { deleteNote(act.getAttribute("data-id")); return; }
      if (a === "send") { sendFrom(act); return; }
      if (a === "dsend") { dsendFrom(act); return; }
      if (a === "send-now") { e.preventDefault(); firePending(act.getAttribute("data-pid")); return; }
      if (a === "send-undo") { e.preventDefault(); cancelPending(act.getAttribute("data-pid")); return; }
      if (a === "send-edit") { e.preventDefault(); editPending(act.getAttribute("data-pid")); return; }
      if (a === "tag-add") { addTagFrom(act); return; }
      if (a === "tag-del") { delTagFrom(act); return; }
      if (a === "tag-ignore") { setTagIgnore(act.getAttribute("data-tag-type"), act.getAttribute("data-tag-ref"), true); return; }
      if (a === "tag-unignore") { setTagIgnore(act.getAttribute("data-tag-type"), act.getAttribute("data-tag-ref"), false); return; }
      if (a === "tag-open") { openTagEditor(act.getAttribute("data-tag-type"), act.getAttribute("data-tag-ref")); return; }
      if (a === "add-email") { openAddEmail(act.getAttribute("data-user"), act.getAttribute("data-uid") || "", act.getAttribute("data-profile")); return; }
      if (a === "jira-add") { openAddJira({ type: act.getAttribute("data-anchor-type"), ref: act.getAttribute("data-anchor-ref") }); return; }
      if (a === "jira-pick") {
        var _jk = act.getAttribute("data-key"), _jt = act.getAttribute("data-title") || "";
        if (!_jt) { var _jj = (D.jira || []).filter(function (j) { return j.issue_key === _jk; })[0]; _jt = _jj ? _jj.summary || "" : ""; }
        closeModal();
        openLinkForm({ anchor: state._jiraAnchor, key: _jk, title: _jt });
        return;
      }
      if (a === "act-link-ticket") { openLinkForm({}); return; }
      if (a === "lt-key-pick") { ltSetKey(act.getAttribute("data-key"), act.getAttribute("data-title") || ""); return; }
      if (a === "lt-key-clear") { ltSetKey("", ""); return; }
      if (a === "lt-submit") { ltSubmit(); return; }
      if (a === "create-urgent") { openCreateUrgent({ type: act.getAttribute("data-anchor-type"), ref: act.getAttribute("data-anchor-ref") }); return; }
      if (a === "jira-new") { openJiraTicket({ type: act.getAttribute("data-anchor-type"), ref: act.getAttribute("data-anchor-ref") }); return; }
      if (a === "jira-topic-next") { var _jt = q("#jira-topic-sel") ? q("#jira-topic-sel").value : ""; if (!_jt) { toast("Select a topic"); return; } openJiraTicketForm(_jt); return; }
      if (a === "so-ticket-create") { submitSoTicket(); return; }
      if (a === "urg-create") { submitUrg(); return; }
      if (a === "td-so-forward") { todoSoForward(act.getAttribute("data-key"), act.getAttribute("data-since")); return; }
      if (a === "td-so-closed") { todoJiraClose(act.getAttribute("data-key"), act.getAttribute("data-since")); return; }
      if (a === "td-l1-done") { l1Done(act.getAttribute("data-id")); return; }
      if (a === "td-urg-transfer") { urgTransferOne(act.getAttribute("data-key"), act.getAttribute("data-rid") || "", act.getAttribute("data-since")); return; }   // URG: Done, no comment
      if (a === "td-dismiss") { todoDismiss(act.getAttribute("data-key"), act.getAttribute("data-since")); return; }
      if (a === "highlight") { toggleHighlight(act); return; }
      if (a === "archive") { archiveConvo(act); return; }
      if (a === "translate") { translateMsg(act); return; }
      if (a === "tr-compose") { translateComposer(act); return; }
      if (a === "rail-toggle") { document.body.classList.toggle("rail-open"); return; }   // phone: open/close section drawer
      if (a === "rail-close") { document.body.classList.remove("rail-open"); return; }
      if (a === "admin-tab") {
        state.adminTab = act.getAttribute("data-key");
        try { localStorage.setItem("cmt-admin-tab", state.adminTab); } catch (e) {}
        render(); var _pg = q(".page"); if (_pg) _pg.scrollTop = 0;
        return;
      }
      if (a === "ctx-tab") {
        var _ck = act.getAttribute("data-key"), _cp = act.closest(".pane.context");
        state.ctxTab = _ck;
        try { localStorage.setItem("cmt-ctx-tab", _ck); } catch (e) {}
        if (_cp) {
          _cp.setAttribute("data-ctx-tab", _ck);
          var _tbs = _cp.querySelectorAll(".ctx-tab");
          for (var _ti = 0; _ti < _tbs.length; _ti++) {
            var _on = _tbs[_ti].getAttribute("data-key") === _ck;
            _tbs[_ti].classList.toggle("on", _on);
            _tbs[_ti].setAttribute("aria-selected", _on ? "true" : "false");
          }
        }
        return;
      }
      if (a === "customize-ctx" || a === "customize-nav") { openLayoutCustom(a === "customize-ctx" ? "ctx" : "nav"); return; }
      if (a === "lay-toggle") {
        var _lk = act.getAttribute("data-kind"), _lp = layoutPrefs()[_lk], _key = act.getAttribute("data-key");
        if (_lp.hidden[_key]) delete _lp.hidden[_key]; else _lp.hidden[_key] = true;
        layoutChanged(); return;
      }
      if (a === "lay-move") {
        var _mk = act.getAttribute("data-kind"), _keys = _mk === "ctx"
          ? orderedKeys(CTX_SECTIONS.map(function (c) { return c.key; }), layoutPrefs().ctx.order)
          : navItemsFor().map(function (n) { return n.view; });
        var _i = _keys.indexOf(act.getAttribute("data-key")), _j = _i + (+act.getAttribute("data-dir"));
        if (_i >= 0 && _j >= 0 && _j < _keys.length) { var _t = _keys[_i]; _keys[_i] = _keys[_j]; _keys[_j] = _t; }
        layoutPrefs()[_mk].order = _keys; layoutChanged(); return;
      }
      if (a === "lay-reset") { layoutPrefs()[act.getAttribute("data-kind")] = { order: [], hidden: {} }; layoutChanged(); return; }
      if (a === "rail-collapse") { var _rc = q(".app").classList.toggle("rail-collapsed"); try { localStorage.setItem("cmt-rail-collapsed", _rc ? "1" : "0"); } catch (e) {} return; }   // desktop: collapse/expand rail
      if (a === "mobile-back") { location.hash = mobileRoute().back; return; }   // phone: chat -> its list (Forum post -> Forum)
      if (a === "m-info") {
        // Laptop / half-screen widths: the context panel is a slide-over, the button opens and closes it.
        if (!state.isMobile) { document.body.classList.toggle("ctx-open"); return; }
        // Phone: the same topbar button reads "Chat" on the details screen, so it toggles back to the chat.
        document.body.classList.toggle("m-ctx"); applyMobileChrome(); if (!document.body.classList.contains("m-ctx")) scrollThreadToEnd(); return; }
      if (a === "m-ctx-back") { document.body.classList.remove("m-ctx"); applyMobileChrome(); return; }   // phone: details -> chat
      if (a === "post-ignore") { togglePostIgnore(act); return; }
      if (a === "dstatus") { openDiscordStatus(act.getAttribute("data-ticket")); return; }
      if (a === "modal") { openModal(act.getAttribute("data-modal")); return; }
      if (a === "rss-toggle") { state.rssOpen = !state.rssOpen; act.classList.toggle("open", state.rssOpen); return; }   // phone: banner is 2 lines until tapped
      if (a === "modal-close") { attemptCloseModal(); return; }
      if (a === "modal-submit") { submitModal(); return; }
      if (a === "ms-toggle") { msToggle(act); return; }
      if (a === "find-uid") { findUserId(act.getAttribute("data-email"), profileUrlFor(act.getAttribute("data-user"), act.getAttribute("data-profile"))); return; }
      if (a === "copy-uid") { copyText(act.getAttribute("data-uid"), "User ID copied"); return; }
      if (a === "us-load") { usLoad(); return; }
      if (a === "us-get") { usGet(); return; }
      if (a === "us-refresh") { usLoad(true); return; }
      if (a === "us-pick") { usPick(act); return; }
      if (a === "ts-load") { tsLoad(true); return; }
      if (a === "ts-pick") { tsPick(act); return; }
      if (a === "report-view") { openReportView(act.getAttribute("data-id")); return; }
      if (a === "account") { openAccount(); return; }
      if (a === "notifications") { openNotifications(); return; }
      if (a === "notify-go") { var _nu = act.getAttribute("data-open"); if (_nu) { if (act.getAttribute("data-internal")) { if (state.modal) closeModal(); location.hash = _nu; } else window.open(_nu, "_blank", "noopener"); } return; }
      if (a === "notify-open") { openNotifySettings(); return; }
      if (a === "notify-master") { state.notifyPrefs.enabled = !state.notifyPrefs.enabled; refreshNotifyBody(); return; }
      if (a === "notify-type") { var _t = act.getAttribute("data-type"); state.notifyPrefs.types = state.notifyPrefs.types || {}; state.notifyPrefs.types[_t] = (state.notifyPrefs.types[_t] === false); refreshNotifyBody(); return; }
      if (a === "notify-chan") { var _c = act.getAttribute("data-chan"); state.notifyPrefs.channels = state.notifyPrefs.channels || {}; state.notifyPrefs.channels[_c] = !state.notifyPrefs.channels[_c]; refreshNotifyBody(); return; }
      if (a === "notify-wh") { state.notifyPrefs.use_working_hours = !state.notifyPrefs.use_working_hours; refreshNotifyBody(); return; }
      if (a === "notify-day") { refreshNotifyBody(); return; }
      if (a === "notify-save") { saveNotifyPrefs(); return; }
      if (a === "notify-test") { notifyTest(); return; }
      if (a === "notify-tg") { notifyConnectTelegram(); return; }
      if (a === "notify-tg-unlink") { notifyUnlinkTelegram(); return; }
      if (a === "notify-push") { notifyEnablePush(); return; }
      if (a === "notify-push-off") { notifyDisablePush(); return; }
      if (a === "acct-password") { openChangePassword(); return; }
      if (a === "testing-edit") { openEditTesting(act.getAttribute("data-id")); return; }
      if (a === "login") { attemptLogin(); return; }
      if (a === "setpw") { submitSetPassword(act.getAttribute("data-email")); return; }
      if (a === "login-back") { renderLogin(); return; }
      if (a === "ds-archive") {
        state.discordArchive = !state.discordArchive; state.discordStatus = "all";
        if (/^#\/discord\/[^\/]+$/.test(location.hash) && !/^#\/discord\/(forum|mentions)/.test(location.hash)) location.hash = "#/discord"; else render();
        return;
      }
      if (a === "u-expand") { var _uk = act.getAttribute("data-key"); state.uExpand = state.uExpand || {}; state.uExpand[_uk] = !state.uExpand[_uk]; render(); return; }
      if (a === "admin-identity") { openIdentity(act.getAttribute("data-id")); return; }
      if (a === "admin-hours") { openHours(act.getAttribute("data-id")); return; }
      if (a === "admin-perms") { openPerms(act.getAttribute("data-id")); return; }
      if (a === "admin-leave") { openLeaveAdmin(act.getAttribute("data-id")); return; }
      if (a === "admin-user-del") { deleteUser(act.getAttribute("data-id"), act.getAttribute("data-name")); return; }
      if (a === "admin-user-pw") { openUserPassword(act.getAttribute("data-id")); return; }
      if (a === "admin-user-invite") { adminGetInvite(act.getAttribute("data-id")); return; }
      if (a === "bot-actions-refresh") { state.botActions.loaded = false; loadBotActions(); return; }
      if (a === "bot-ping") { toast("Pinging bot worker..."); enqueueAction("ping", {}, function (r) { toast(r.status === "done" ? "Bot worker OK (pong)" : "Worker error: " + (r.error || "")); }); return; }
      if (a === "admin-tpl") { openTemplateEdit(act.getAttribute("data-id")); return; }
      if (a === "admin-tpl-del") { deleteTemplate(act.getAttribute("data-id")); return; }
      if (a === "var-save") { varSave(act); return; }
      if (a === "tpl-pick") { var _c = q("[data-composer]"); state._tplDraft = _c ? _c.value : ""; state._tplTgId = act.closest("#popover") ? (state._tgReplyId || null) : null; openTemplatePicker(); return; }
      if (a === "tpl-insert") { insertTemplate(act.getAttribute("data-id")); return; }
      if (a === "tpl-insert-text") { insertTemplateText(act.getAttribute("data-text")); return; }
      if (a === "tpl-tab") { state.tplTab = act.getAttribute("data-tab"); var _tr = q("#modal-results"); if (_tr && state.modal && state.modal.search) _tr.innerHTML = state.modal.search.run((state.modalQuery || "").toLowerCase()); return; }
      if (a === "copy-invite") { var iv = q("#invite-code-val"); if (iv) { iv.select(); try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Select and copy the code"); } } return; }
      if (a === "handoff-new") { openHandoffCreate(); return; }
      if (a === "myact-tab") { state._myActTab = act.getAttribute("data-tab"); renderModal(); return; }
      if (a === "handoff-done") { markHandoffDone(act.getAttribute("data-id")); return; }
      if (a === "feedback-edit") { state.fbEdit = act.getAttribute("data-id"); render(); var _fe = q('[data-fb-edit="' + state.fbEdit + '"]'); if (_fe) _fe.focus(); return; }
      if (a === "feedback-edit-cancel") { state.fbEdit = null; render(); return; }
      if (a === "feedback-reply-edit") { state.fbReplyEdit = act.getAttribute("data-id"); render(); var _rt = q('[data-fb-reply="' + state.fbReplyEdit + '"]'); if (_rt) { _rt.focus(); _rt.setSelectionRange(_rt.value.length, _rt.value.length); } return; }
      if (a === "feedback-reply-cancel") { state.fbReplyEdit = null; render(); return; }
      if (a === "feedback-edit-save") { var _eid = act.getAttribute("data-id"); var _et = q('[data-fb-edit="' + _eid + '"]'); saveFeedbackEdit(_eid, _et ? _et.value.trim() : ""); return; }
      if (a === "feedback-reply") { var _fid = act.getAttribute("data-id"); var _ri = q('[data-fb-reply="' + _fid + '"]'); setFeedbackReply(_fid, _ri ? _ri.value.trim() : ""); return; }
      if (a === "handoff-chat") { openHandoffCreate(act.getAttribute("data-ctx-type"), act.getAttribute("data-ctx-ref"), act.getAttribute("data-ctx-label")); return; }
      if (a === "contact-new") { openContactCreate(); return; }
      if (a === "fb-group") { openFacebookGroup(); return; }
      if (a === "contact-edit") { openContactEdit(act.getAttribute("data-id")); return; }
      if (a === "contact-del") { deleteContact(act.getAttribute("data-id")); return; }
    }
    var go = e.target.closest("[data-go]");
    if (go && e.target.closest("a[href]") && go.contains(e.target.closest("a[href]"))) return;   // inner link wins
    if (go && /^#\/jira\//.test(go.getAttribute("data-go") || "")) {   // ticket chips open the ticket in Jira
      window.open(jiraUrl(go.getAttribute("data-go").slice(7)), "_blank", "noopener"); return;
    }
    if (go) { var href = go.getAttribute("data-go"); if (href && href !== "#") { if (state.modal) closeModal(); clearSearch(); location.hash = href; } }
  });
  /* Opening any item clears an active global search so the destination renders normally (V5). */
  function clearSearch() {
    if (!state.q) return;
    state.q = "";
    var si = q("#search-input"); if (si) si.value = "";
  }

  document.addEventListener("change", function (e) {
    var sst = e.target.closest("input[data-shot-stage]");   // screenshot picker inside a form (staged until save)
    if (sst) { stageShots(sst.getAttribute("data-shot-stage"), sst.files); sst.value = ""; return; }
    var kis = e.target.closest("input[data-ki-shot]");      // admin: screenshot onto an existing known issue
    if (kis) { kiShotsPicked(kis); return; }
    var fbs0 = e.target.closest("input[data-fb-shot]");     // feedback author: add a screenshot later
    if (fbs0) { fbShotPicked(fbs0); return; }
    var gcs = e.target.closest("[data-gcs]");   // Game Cards "New this week" panel controls
    if (gcs) { gcSugChange(gcs); return; }
    var jf = e.target.closest("input[data-act='jira-file']");
    if (jf) { jiraFileChosen(jf); return; }
    var uo = e.target.closest("input[data-act='urg-own']");   // Create Urgent: "My Own Ticket"
    if (uo) { urgOwnToggle(uo.checked); return; }
    var aof = e.target.closest("[data-act='acct-offduty']");   // account: ignore off-duty views toggle
    if (aof) { setOffdutyReads(aof.checked); return; }
    // 24h time fields: normalise "1000"/"9:5" -> "HH:MM" on blur so the display matches what's saved.
    var t24 = e.target.closest(".time24");
    if (t24) { t24.value = normalizeTime24(t24.value); }   // fall through: a .sched-row time also refreshes the row
    var sr = e.target.closest(".sched-row");   // working-hours picker (item X3)
    if (sr) { schedRowToggle(sr); return; }
    var lvc = e.target.closest("[data-act='leave-calc']");   // leave request date picker -> live working-day count
    if (lvc) { updateLeavePreview(state._leaveType || "vacation"); return; }
    var fbs = e.target.closest("select[data-act='feedback-status']");   // admin sets feedback status (item Y)
    if (fbs) { setFeedbackStatus(fbs.getAttribute("data-id"), fbs.value); return; }
    var scm = e.target.closest("select[data-act='sch-month-sel']");     // schedule month picker
    if (scm) { state.scheduleMonth = scm.value; render(); return; }
    var rla = e.target.closest("select[data-act='rl-author']");
    if (rla) { rlState().author = rla.value; render(); return; }
    var rld = e.target.closest("[data-rl-date]");
    if (rld) { rlState()[rld.getAttribute("data-rl-date")] = rld.value; render(); return; }
    var rlq = e.target.closest("[data-rl-q]");
    if (rlq) { rlState().q = rlq.value; render(); return; }
    var gtw = e.target.closest("select[data-act='gt-week-sel']");       // game-testing week picker
    if (gtw) { state.gtWeek = gtw.value; render(); return; }
    var gts = e.target.closest("[data-act='gt-set']");            // game-testing answer
    if (gts) { gtSet(gts); return; }
    var gcw = e.target.closest("select[data-act='gc-week-sel']");       // game-cards week picker
    if (gcw) { state.gcWeek = gcw.value; render(); return; }
    var gcf = e.target.closest("[data-gc-field]");                      // inline-editable game-card field
    if (gcf) { gcSaveField(gcf); return; }
    var mc = e.target.closest("select[data-modal-controls]");
    if (mc) { syncModalValues(); renderModal(); return; }
    var dsel = e.target.closest("select[data-act='dstatus-select']");
    if (dsel) {
      var dt = ticketByKey(dsel.getAttribute("data-ref"));
      if (!dt) return;
      var dv = dsel.value === "__auto__" ? "" : dsel.value;
      // Console-only statuses, with two exceptions that also drive Discord:
      if (dv === "postponed") { openDiscordPostpone(tid(dt)); return; }   // -> bot postpone (modal confirms)
      if (dv === "done") { doneDiscord(dt); return; }                    // -> reflect done + bot closes the ticket
      setDiscordOverride(dt, dv);   // new / in_progress / waiting_user / needs_review, or "" = auto (from flow)
      return;
    }
    var sel = e.target.closest("select[data-act='mstatus']");
    if (sel) {
      var c = convoById(sel.getAttribute("data-ref"));
      if (c) {
        var v = sel.value === "__auto__" ? "" : sel.value;   // any status, or "" = auto (from flow)
        c.override_status = v;
        c._override_at = new Date().toISOString();   // ack marker so an explicit "Waiting on user" sticks 
        if (v === "done" && c.id) {              // Done -> archive on Reddit
          enqueueAction("reddit_archive", { convo_id: c.id }, function (r) {
            if (r.status === "done") { c._archived = true; render(); toast("Archived on Reddit"); }
            else {   // not archived on Reddit -> don't keep showing Done
              c.override_status = ""; c._override_at = "";
              postConvoStatus(c.id, "").then(function () {}, function () {});
              render(); toast("Archive failed: " + (r.error || ""));
            }
          });
        } else if (v === "done") { c._archived = true; }
        postConvoStatus(c.id, v).then(function () {}, function () {});
        logActivity("set Reddit ModMail status to " + mmStatusLabel(deriveRedditStatus(c)), "u/" + c.participant);
        render(); toast("Status: " + mmStatusLabel(deriveRedditStatus(c)));
      }
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "modal-search-input") {
      state.modalQuery = e.target.value;
      var res = q("#modal-results");
      if (res && state.modal && state.modal.search) res.innerHTML = state.modal.search.run(state.modalQuery.toLowerCase());
    }
  });

  document.addEventListener("keydown", function (e) {
    if (q("#auth-gate").classList.contains("show")) {
      if (e.key === "Enter") { var sp = q("#auth-gate [data-act='setpw']"); if (sp) submitSetPassword(sp.getAttribute("data-email")); else attemptLogin(); }
      return;
    }
    if (state.modal) { if (e.key === "Escape") attemptCloseModal(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); state.cmdk.open ? closeCmdk() : openCmdk(); return; }
    if (!state.cmdk.open) return;
    if (e.key === "Escape") closeCmdk();
    else if (e.key === "ArrowDown") { e.preventDefault(); state.cmdk.sel = Math.min(state.cmdk.items.length - 1, state.cmdk.sel + 1); renderCmdk(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); state.cmdk.sel = Math.max(0, state.cmdk.sel - 1); renderCmdk(); }
    else if (e.key === "Enter") { e.preventDefault(); activateCmdk(state.cmdk.sel); }
  });

  /* ---------- auth (login gate + session) ---------- */
  function memberById(id) { return D.team.filter(function (m) { return m.id === id; })[0]; }
  function updateTeamMember(u) {   /* replace a team member in place after a live update */
    for (var i = 0; i < D.team.length; i++) { if (D.team[i].id === u.id) { D.team[i] = u; break; } }
    if (state.user && state.user.id === u.id) { state.user = u; applyUser(); }
  }
  function isAdmin() { return !!(state.user && state.user.role === "admin"); }
  // Admins implicitly hold every permission (their stored list may predate a newly-added section);
  // everyone else is checked against their granted list. Never throws on a missing/blank list.
  function can(perm) {
    if (!state.user) return false;
    if (state.user.role === "admin") return true;
    return (state.user.permissions || []).indexOf(perm) >= 0;
  }
  // Whether the signed-in user may see/reach a NAV item (admin-only gate + per-section permission).
  function canSee(n) { return n && (!n.adminOnly || isAdmin()) && (!n.perm || can(n.perm)); }


  function applyUser() {
    if (!state.user) return;
    D.me = { name: state.user.name, initials: state.user.initials, role: state.user.title };
    var av = q("#avatar-btn");
    if (av) { av.textContent = state.user.initials; av.title = state.user.name + " - " + state.user.title; }
  }
  function completeLogin(user) {   /* live mode: user comes from the API */
    state.user = user;
    applyUser();
    q("#auth-gate").classList.remove("show");
    if (!location.hash || location.hash === "#" || location.hash === "#/") location.hash = "#/inbox";
    state.hydrating = true;                    /* show the loader, not the mock, until data lands */
    render();
    hydrateLive();                             /* pull real Mongo data after sign-in; it fires the handoff popup when done */
    setTimeout(function () { if (state.hydrating) { state.hydrating = false; render(); } }, 8000);
    toast("Signed in as " + (user.name || user.email || "user"));
  }
  function signOut() {
    window.CONSOLE.logout().then(function () { state.user = null; renderLogin(); });
  }
  var SSO_ERRORS = {
    no_account: "Your Google account has no console access yet. Ask an admin to add your work email.",
    domain: "Use your company Google account.",
    expired: "The sign-in took too long. Try again.",
    cancelled: "Google sign-in was cancelled.",
    not_configured: "Google sign-in is not set up on this server.",
    failed: "Google sign-in failed. Try again."
  };
  function ssoErrorFromUrl() {   /* ?sso_error=<code> from the Google callback; shown once, then removed */
    var m = /[?&]sso_error=([a-z_]+)/.exec(location.search || "");
    if (!m) return "";
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    return SSO_ERRORS[m[1]] || SSO_ERRORS.failed;
  }
  function renderLogin() {
    var ssoErr = ssoErrorFromUrl();
    function paint(cfg) {
      var google = !!(cfg && cfg.google), password = !cfg || cfg.password !== false;
      q("#auth-gate").innerHTML =
        '<div class="login-card">' +
        '<div class="login-brand serif">CMT Console</div>' +
        '<div class="login-sub muted">Sign in to continue</div>' +
        '<div class="login-form">' +
        (google ? '<a class="btn primary" href="/api/console/sso/google/start" style="justify-content:center">' + ic("shield", "ico-sm") + "Sign in with Google</a>" : "") +
        (google && password ? '<div class="login-or muted">or with a password</div>' : "") +
        (password ?
          '<label class="field"><span>Email</span><input class="f-input" id="login-email" type="email" placeholder=""></label>' +
          '<label class="field"><span>Password</span><input class="f-input" id="login-pass" type="password" placeholder="Password"></label>' +
          '<button class="btn ' + (google ? "ghost" : "primary") + '" data-act="login" style="justify-content:center">' + ic("shield", "ico-sm") + "Sign in</button>" : "") +
        '<div class="login-err" id="login-err">' + esc(ssoErr) + "</div>" +
        "</div></div>";
      q("#auth-gate").classList.add("show");
      var em = q("#login-email"); if (em && !google) setTimeout(function () { em.focus(); }, 30);
    }
    paint(null);
    fetch("/api/console/sso/config", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) { if (cfg && !state.user) paint(cfg); }, function () {});
  }
  function renderSetPassword(email) {   /* live mode: bootstrap admin / new user setting first password */
    q("#auth-gate").innerHTML =
      '<div class="login-card">' +
      '<div class="login-brand serif">CMT Console</div>' +
      '<div class="login-sub muted">First sign-in - set a password for <span class="mono">' + esc(email) + "</span></div>" +
      '<div class="login-form">' +
      '<label class="field"><span>Invite code</span><input class="f-input" id="setpw-invite" type="text" autocomplete="off" placeholder="The code an admin gave you"></label>' +
      '<label class="field"><span>New password</span><input class="f-input" id="setpw-1" type="password" placeholder="At least 8 characters"></label>' +
      '<label class="field"><span>Confirm password</span><input class="f-input" id="setpw-2" type="password" placeholder="Repeat password"></label>' +
      '<button class="btn primary" data-act="setpw" data-email="' + esc(email) + '" style="justify-content:center">' + ic("shield", "ico-sm") + "Set password and sign in</button>" +
      '<div class="login-err" id="login-err"></div>' +
      '<button class="btn ghost" data-act="login-back" style="justify-content:center">Back</button>' +
      "</div></div>";
    q("#auth-gate").classList.add("show");
    var p = q("#setpw-1"); if (p) setTimeout(function () { p.focus(); }, 30);
  }
  function attemptLogin() {
    var err = q("#login-err");
    var email = ((q("#login-email") && q("#login-email").value) || "").trim();
    var pass = (q("#login-pass") && q("#login-pass").value) || "";
    if (window.CONSOLE && window.CONSOLE.mode === "live") {
      if (!email) { if (err) err.textContent = "Enter your email"; return; }
      window.CONSOLE.login(email, pass).then(function (res) {
        if (res.status === 200 && res.data && res.data.needsPassword) { renderSetPassword(res.data.email || email); return; }
        if (res.status === 200) { completeLogin(res.data); return; }
        if (err) err.textContent = (res.data && res.data.error) || "Sign-in failed";
      }, function () { if (err) err.textContent = "Network error"; });
      return;
    }
  }
  function submitSetPassword(email) {
    var err = q("#login-err");
    var invite = ((q("#setpw-invite") && q("#setpw-invite").value) || "").trim();
    var p1 = (q("#setpw-1") && q("#setpw-1").value) || "", p2 = (q("#setpw-2") && q("#setpw-2").value) || "";
    if (!invite) { if (err) err.textContent = "Enter the invite code an admin gave you"; return; }
    if (p1.length < 8) { if (err) err.textContent = "Password must be at least 8 characters"; return; }
    if (p1 !== p2) { if (err) err.textContent = "Passwords do not match"; return; }
    if (!(window.CONSOLE && window.CONSOLE.mode === "live")) return;
    window.CONSOLE.setPassword(email, p1, invite).then(function (res) {
      if (res.status === 200) { completeLogin(res.data); return; }
      if (err) err.textContent = (res.data && res.data.error) || "Could not set password";
    }, function () { if (err) err.textContent = "Network error"; });
  }
  function openAccount() {
    var u = state.user; if (!u) return;
    showModal({ title: "Account", submit: "Sign out", close: "Close",
      onSubmit: function () { signOut(); },
      custom: function () {
        var rows = [["Name", u.name], ["Email", u.email], ["Role", u.role], ["Title", u.title], ["Working hours", u.hours]];
        var body = rows.map(function (r) { return '<div class="field"><label>' + esc(r[0]) + '</label><div class="read-val">' + esc(r[1]) + "</div></div>"; }).join("");
        // Identity + linked accounts (read-only; an admin edits these in Admin > Users > Identity).
        var idRows = [["Full name", u.display_name || u.name], ["Alias", u.alias || ""],
          ["Slack ID", u.slack_id || ""], ["Telegram ID", u.telegram_id || ""],
          ["Jira account ID", u.jira_account_id || ""], ["Discord", u.discord_name || u.discord_id || ""]]
          .filter(function (r) { return r[1]; });
        if (idRows.length) {
          body += '<div class="field"><label>Identity (linked accounts)</label><div class="read-val" style="line-height:1.7">' +
            idRows.map(function (r) { return "<b>" + esc(r[0]) + ":</b> " + esc(r[1]); }).join("<br>") + "</div></div>";
        }
        // Self-service preference: don't let an off-duty peek mark chats read for the whole team.
        body += '<div class="field"><label>Read tracking</label>' +
          '<label class="acc-toggle"><input type="checkbox" data-act="acct-offduty"' + (u.ignore_offduty_reads === false ? "" : " checked") + "><span>Ignore my views when I'm off duty</span></label>" +
          '<div class="f-hint">Read status for chats is shared across the whole team. With this on, opening a chat outside your Duty hours won’t mark it read for whoever is actually on shift. On by default.</div></div>';
        // (Per-user Reddit connect was removed: the separate console/bot servers can't share the
        // single OAuth redirect URI. Replies happen on Reddit directly via "Open post on Reddit".)
        body += '<button class="btn" data-act="handoff-new">' + ic("reply", "ico-sm") + "Leave a handoff note</button>";
        body += '<button class="btn" data-act="acct-password">' + ic("shield", "ico-sm") + "Change password</button>";
        if (u.role === "admin") body += '<button class="btn" data-go="#/admin">' + ic("shield", "ico-sm") + "Open Admin panel</button>";
        return body;
      } });
  }
  function openChangePassword() {
    showModal({ title: "Change password", submit: "Change password", close: "Cancel",
      fields: [
        { id: "current", label: "Current password", type: "password", required: true },
        { id: "next", label: "New password", type: "password", required: true, placeholder: "At least 8 characters" },
        { id: "again", label: "New password again", type: "password", required: true } ],
      onSubmit: function (v) {
        if (v.next !== v.again) { toast("The new passwords do not match"); return; }
        window.CONSOLE.postMsg("/change-password", { current: v.current, new: v.next }).then(function (res) {
          if (res.status === 200) toast("Password changed");
          else toast((res.data && res.data.error) || "Could not change the password");
        }, function () { toast("Could not change the password"); });
      } });
  }
  function setOffdutyReads(ignore) {
    ignore = !!ignore;
    if (state.user) state.user.ignore_offduty_reads = ignore;
    {
      window.CONSOLE.patch("/account-prefs", { ignore_offduty_reads: ignore }).then(function (u) {
        if (u && u.id) { state.user = u; updateTeamMember(u); applyUser(); }
        toast(ignore ? "Off-duty views won’t count as read" : "Off-duty views will count as read");
      }, function () { toast("Couldn’t save the setting"); });
    }
  }
  /* (Per-user Reddit connect / disconnect UI was removed - the separate console and bot servers can't
     share the single OAuth redirect URI. The backend routes stay dormant for a future revisit.) */

  /* ---------- Notification settings (per-user; item: notification system) ---------- */
  var NOTIFY_TYPE_LABELS = {
    reddit_post: "New Reddit post",
    reddit_modmail: "New Reddit ModMail",
    reddit_modmail_msg: "New message in a ModMail",
    discord_ticket: "New Discord ticket",
    discord_msg: "New message in a Discord ticket",
    discord_forum: "New Discord forum post",
    discord_mod_mention: "Moderator mentioned (Discord)",
    jira_cm: "Jira handoff to CM",
    jira_urg_review: "Urgent request in Review",
    jira_l1: "Ticket in L1 In Progress (users to update)"
  };
  /* Admin-only notification types (shown only to admins, default off): new in-app feedback and new
     vacation/sick leave requests. */
  var NOTIFY_ADMIN_LABELS = {
    feedback_new: "New feedback (review / bug)",
    leave_request: "Vacation / sick leave request",
    ki_suggest: "Known issue suggested (console or public page)"
  };
  var NOTIFY_DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]];
  function defaultNotifyPrefs() {
    var sched = {}; NOTIFY_DAYS.forEach(function (d) { sched[d[0]] = { on: d[0] !== "0" && d[0] !== "6", start: "09:00", end: "18:00" }; });
    var types = {}; Object.keys(NOTIFY_TYPE_LABELS).forEach(function (t) { types[t] = true; });
    return { enabled: false, use_working_hours: true, types: types, channels: { telegram: false, slack: false, webpush: false },
      schedule: sched, telegram_linked: false, slack_linked: false, webpush_devices: 0 };
  }
  function openNotifySettings() {
    window.CONSOLE.get("/notify-prefs").then(function (p) { state.notifyPrefs = p || defaultNotifyPrefs(); renderNotifyModal(); },
      function () { toast("Could not load notification settings"); });
  }
  /* ---------- Notification center (the bell): a log of the notifications that should have arrived ---------- */
  function loadNotifyFeed() {
    window.CONSOLE.get("/notify-feed").then(function (d) { state.notifyFeed = d || { items: [], unread: 0 }; refreshBellPip(); }, function () {});
  }
  function refreshBellPip() {
    var p = document.querySelector("#bell-btn .pip");
    if (p) p.style.display = (state.notifyFeed && state.notifyFeed.unread > 0) ? "" : "none";
  }
  function openNotifications() {
    window.CONSOLE.get("/notify-feed").then(function (d) {
      state.notifyFeed = d || { items: [], unread: 0 };
      renderNotifyCenter();
      // Opening the center marks everything read (clears the bell dot).
      window.CONSOLE.post("/notify-feed/seen", {}).then(function () { if (state.notifyFeed) state.notifyFeed.unread = 0; refreshBellPip(); }, function () {});
    }, function () { state.notifyFeed = { items: [], unread: 0 }; renderNotifyCenter(); });
  }
  function renderNotifyCenter() {
    showModal({ title: "Notifications", close: "Close", custom: function () { return notifyCenterBody(state.notifyFeed); } });
  }
  function notifyCenterBody(f) {
    f = f || { items: [], unread: 0 };
    var head = '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">' +
      '<button class="btn sm" data-act="notify-open">Notification settings</button></div>';
    if (!f.items || !f.items.length) return head + emptyState("bell", "No notifications", "Events you are subscribed to will show up here.");
    var rows = f.items.map(function (n) {
      var title = esc(n.title || NOTIFY_TYPE_LABELS[n.type] || n.type);
      var body = n.body ? '<div class="muted" style="font-size:13px;margin-top:2px;overflow-wrap:anywhere">' + esc(n.body) + "</div>" : "";
      var target = n.route || n.url;   // prefer the in-console route over the social-network URL
      var open = target ? ' data-act="notify-go" data-open="' + esc(target) + '"' + (n.route ? ' data-internal="1"' : "") + ' style="cursor:pointer"' : "";
      return '<div class="fb-item"' + open + '>' +
        '<div style="font-weight:600' + (n.unread ? "" : ";opacity:.7") + '">' + title + "</div>" + body +
        '<div class="nfoot" style="margin-top:4px">' + esc(timeText(n.created_at)) + "</div></div>";
    }).join("");
    return head + '<div class="stack" style="gap:10px">' + rows + "</div>";
  }
  /* Payload-shaped fingerprint of the prefs (only the fields Save actually persists) so we can tell
     whether the modal has unsaved changes without noise from server-only fields. */
  function notifyPrefsSig(p) {
    p = p || {};
    return JSON.stringify({ enabled: !!p.enabled, use_working_hours: !!p.use_working_hours,
      types: p.types || {}, channels: p.channels || {}, schedule: p.schedule || {} });
  }
  function renderNotifyModal() {
    showModal({ title: "Notification settings", close: "Close",
      custom: function () { return notifyModalBody(state.notifyPrefs); },
      // Guard against closing with unsaved changes: warn unless the prefs match the opening snapshot.
      beforeClose: function () {
        captureNotifySchedule();   // fold any custom-hours edits into state before comparing
        if (notifyPrefsSig(state.notifyPrefs) === state._notifyBaseline) return true;
        return window.confirm("You have unsaved notification settings. Close without saving?");
      } });
    captureNotifySchedule();                                    // normalize the freshly-rendered inputs
    state._notifyBaseline = notifyPrefsSig(state.notifyPrefs);  // ...then snapshot as the clean baseline
  }
  function nRow(label, control) { return '<div class="nrow"><span class="ntitle">' + label + '</span><span class="nctl">' + control + "</span></div>"; }
  function nToggle(on, act, extra) { return '<button class="ntoggle' + (on ? " on" : "") + '" data-act="' + act + '"' + (extra || "") + '><span></span></button>'; }
  function notifyModalBody(p) {
    p = p || defaultNotifyPrefs();
    var html = nRow("<b>Enable notifications</b>", nToggle(p.enabled, "notify-master"));
    html += '<div class="nsub">What to notify me about</div>';
    Object.keys(NOTIFY_TYPE_LABELS).forEach(function (t) {
      html += nRow(esc(NOTIFY_TYPE_LABELS[t]), nToggle((p.types || {})[t] !== false, "notify-type", ' data-type="' + t + '"'));
    });
    if (isAdmin()) {   // admin-only alerts (default off): feedback + leave requests
      p.types = p.types || {};
      html += '<div class="nsub">Admin alerts</div>' +
        '<div class="muted" style="font-size:12px;line-height:1.5;margin-bottom:6px">Always delivered, also outside your working hours, during Testing and on leave.</div>';
      Object.keys(NOTIFY_ADMIN_LABELS).forEach(function (t) {
        if (typeof p.types[t] === "undefined") p.types[t] = false;
        html += nRow(esc(NOTIFY_ADMIN_LABELS[t]), nToggle(p.types[t] === true, "notify-type", ' data-type="' + t + '"'));
      });
    }
    html += '<div class="nsub">Channels</div>';
    var tg = (p.telegram_linked ? '<span class="nok">Connected</span> <button class="btn sm ghost" data-act="notify-tg-unlink" title="Stop Telegram DMs and unlink this chat">Disconnect</button>' : '<button class="btn sm ghost" data-act="notify-tg">' + ic("external", "ico-sm") + "Connect</button>");
    html += nRow("Telegram DM", tg + " " + nToggle((p.channels || {}).telegram, "notify-chan", ' data-chan="telegram"'));
    var sl = (p.slack_linked ? '<span class="nok">Linked</span>' : '<span class="muted" style="font-size:11px">Set Slack ID in Identity</span>');
    html += nRow("Slack DM", sl + " " + nToggle((p.channels || {}).slack, "notify-chan", ' data-chan="slack"'));
    var wp = (p.webpush_devices ? '<span class="nok">' + p.webpush_devices + " device(s)</span> " +
      '<button class="btn sm ghost" data-act="notify-push-off" title="Remove push from all your devices">Turn off</button> ' : "") +
      '<button class="btn sm ghost" data-act="notify-push">' + ic("bell", "ico-sm") + "Enable here</button>";
    html += nRow("Browser / Mobile push", wp + " " + nToggle((p.channels || {}).webpush, "notify-chan", ' data-chan="webpush"'));
    html += '<div class="nsub">When to receive them</div>';
    html += nRow("Follow my working hours", nToggle(p.use_working_hours, "notify-wh"));
    if (!p.use_working_hours) {
      html += '<div class="nsched">';
      NOTIFY_DAYS.forEach(function (d) {
        var s = (p.schedule || {})[d[0]] || { on: false, start: "09:00", end: "18:00" };
        html += '<div class="nsched-row"><label class="nday"><input type="checkbox" data-act="notify-day" data-day="' + d[0] + '"' + (s.on ? " checked" : "") + "> " + d[1] + "</label>" +
          timeInput24("f-input", s.start || "09:00", ' data-nday="' + d[0] + '" data-edge="start"' + (s.on ? "" : " disabled")) +
          '<span class="ndash">-</span>' + timeInput24("f-input", s.end || "18:00", ' data-nday="' + d[0] + '" data-edge="end"' + (s.on ? "" : " disabled")) + "</div>";
      });
      html += "</div>";
    } else {
      html += '<div class="muted" style="font-size:12px;line-height:1.5">Notifications arrive only during your working hours (from your profile). Turn this off for a custom per-day schedule.</div>';
    }
    html += '<div class="row-gap" style="margin-top:16px;gap:8px;flex-wrap:wrap">' +
      '<button class="btn primary" data-act="notify-save">' + ic("check", "ico-sm") + "Save</button>" +
      '<button class="btn" data-act="notify-test">' + ic("send", "ico-sm") + "Send test</button></div>" +
      '<div class="muted" style="font-size:11px;margin-top:10px;line-height:1.5">Web push works in Chrome/Edge/Firefox on desktop and Android. On iPhone, first add the console to your home screen (Share &rarr; Add to Home Screen), then enable push from the installed app.</div>';
    return html;
  }
  /* Read the custom-schedule inputs from the open modal into state (so edits survive re-render + save,
     since submit-style close would empty the DOM first). Safe no-op when the custom rows aren't shown. */
  function captureNotifySchedule() {
    var host = modalHost(); if (!host) return;
    var rows = host.querySelectorAll(".nsched-row"); if (!rows.length) return;
    state.notifyPrefs.schedule = state.notifyPrefs.schedule || {};
    Array.prototype.forEach.call(rows, function (row) {
      var cb = row.querySelector('input[type="checkbox"]');
      var times = row.querySelectorAll("input[data-nday]");
      if (!cb) return;
      state.notifyPrefs.schedule[cb.getAttribute("data-day")] = {
        on: cb.checked,
        start: (times[0] ? normalizeTime24(times[0].value) : "") || "09:00",
        end: (times[1] ? normalizeTime24(times[1].value) : "") || "18:00" };
    });
  }
  function refreshNotifyBody() {
    captureNotifySchedule();
    var mb = q(".modal-body", modalHost()); if (mb) mb.innerHTML = notifyModalBody(state.notifyPrefs);
  }
  function saveNotifyPrefs() {
    captureNotifySchedule();
    var p = state.notifyPrefs;
    var payload = { enabled: !!p.enabled, use_working_hours: !!p.use_working_hours, types: p.types || {}, channels: p.channels || {}, schedule: p.schedule || {} };
    window.CONSOLE.put("/notify-prefs", payload).then(function (np) { state.notifyPrefs = np; closeModal(); toast("Notification settings saved"); },
      function () { toast("Save failed"); });
  }
  function notifyTest() {
    window.CONSOLE.post("/notify-test", {}).then(function () { toast("Test sent to your enabled channels"); }, function () { toast("Could not send test"); });
  }
  function notifyConnectTelegram() {
    window.CONSOLE.get("/notify-telegram-link").then(function (d) {
      if (d && d.url) { try { window.open(d.url, "_blank", "noopener"); } catch (e) {} toast("Approve in Telegram, then reopen these settings"); }
      else toast(d && d.error ? d.error : "Telegram not configured on the server");
    }, function (s) { toast(s === 503 ? "Telegram bot not configured on the server" : "Could not start Telegram connect"); });
  }
  function notifyUnlinkTelegram() {
    if (!window.confirm("Disconnect Telegram? Notifications will stop going to this Telegram chat.")) return;
    window.CONSOLE.post("/notify-telegram-unlink", {}).then(function () {
      if (state.notifyPrefs) { state.notifyPrefs.telegram_linked = false; (state.notifyPrefs.channels = state.notifyPrefs.channels || {}).telegram = false; }
      refreshNotifyBody(); toast("Telegram disconnected");
    }, function () { toast("Could not disconnect Telegram"); });
  }
  function notifyDisablePush() {
    if (!window.confirm("Turn off push notifications on all your devices?")) return;
    var done = function () {
      window.CONSOLE.post("/notify-push-unsubscribe", {}).then(function (r) {
        if (state.notifyPrefs) { state.notifyPrefs.webpush_devices = (r && r.devices) || 0; (state.notifyPrefs.channels = state.notifyPrefs.channels || {}).webpush = false; }
        refreshNotifyBody(); toast("Push turned off");
      }, function () { toast("Could not turn push off"); });
    };
    // Also drop this browser's own subscription so it stops receiving pushes right away.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then(function (reg) {
        reg.pushManager.getSubscription().then(function (sub) { if (sub) sub.unsubscribe().then(done, done); else done(); }, done);
      }, done);
    } else done();
  }
  function urlBase64ToUint8Array(b64) {
    var pad = "=".repeat((4 - b64.length % 4) % 4);
    var s = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(s), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function notifyEnablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { toast("This browser does not support push"); return; }
    window.CONSOLE.get("/notify-vapid").then(function (d) {
      var key = d && d.publicKey;
      if (!key) { toast("Push not configured on the server (VAPID key missing)"); return; }
      Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") { toast("Notification permission denied"); return; }
        navigator.serviceWorker.ready.then(function (reg) {
          reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }).then(function (sub) {
            window.CONSOLE.post("/notify-push-subscribe", { subscription: sub.toJSON() }).then(function (r) {
              if (r && r.ok) {
                if (state.notifyPrefs) { state.notifyPrefs.webpush_devices = r.devices; (state.notifyPrefs.channels = state.notifyPrefs.channels || {}).webpush = true; }
                refreshNotifyBody(); toast("Push enabled on this device");
              } else toast("Could not save subscription");
            }, function () { toast("Could not save subscription"); });
          }, function () { toast("Push subscription failed (permission or browser)"); });
        });
      });
    }, function () { toast("Push not configured"); });
  }
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    var ok = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!ok) return;   // service workers require https (localhost is allowed)
    try { navigator.serviceWorker.register("sw.js").then(function () {}, function () {}); } catch (e) {}
  }

  /* ---------- init ---------- */
  function paintShell(showGate) {
    // Restore the desktop rail collapsed/expanded preference.
    // With no saved choice, a narrow window (laptop, half screen) starts with the rail collapsed.
    try {
      var _rc0 = localStorage.getItem("cmt-rail-collapsed");
      if (_rc0 === "1" || (_rc0 === null && window.innerWidth > 760 && window.innerWidth <= 1180)) q(".app").classList.add("rail-collapsed");
    } catch (e) {}
    renderRail();
    if (!location.hash) location.hash = "#/inbox";
    render();
    // Live: the handoff popup waits until hydrateLive has loaded real /handoffs (see hydrateLive);
    // showing it here would run against empty data. Mock mode has its handoffs up front.
    if (showGate) renderLogin(); else {}
  }
  /* The server could not be reached: say so and try again (there is no demo data to fall back to). */
  function bootOffline() {
    document.body.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;' +
      'text-align:center"><div><div style="font-size:18px;font-weight:600;margin-bottom:8px">' +
      'Cannot reach the console server</div><div style="opacity:.75">Retrying in 15 seconds...</div></div></div>';
    setTimeout(function () { location.reload(); }, 15000);
  }

  /* After the Reddit OAuth callback we land back on /console/?reddit=<flag>. Toast the outcome
     and strip the query so a reload does not repeat it. The updated /me (with reddit_connected)
     is already reflected in state.user from the probe above. */
  function bootAuth() {
    if (!window.CONSOLE) { bootOffline(); return; }
    window.CONSOLE.probe().then(function (user) {
      if (window.CONSOLE.mode === "live") {
        state.user = user || null;             /* real server session (2-day cookie) */
        if (user) applyUser();
        state.hydrating = !!user;              /* show the loader (not the mock) until first hydrate lands */
        paintShell(!user);
        if (user) {
          hydrateLive();                       /* swap mock -> real Mongo data */
          // Safety net: never leave the loader stuck if a fetch hangs past 8s - show whatever arrived.
          setTimeout(function () { if (state.hydrating) { state.hydrating = false; render(); } }, 8000);
        }
      } else {
        bootOffline();
      }
    }, function () { bootOffline(); });
  }
  /* Drag a pane divider to resize the list (left) / context (right) pane; persist on release. */
  document.addEventListener("mousedown", function (e) {
    var h = e.target.closest(".col-resizer"); if (!h) return;
    e.preventDefault();
    var side = h.getAttribute("data-resize");
    var split = q(".split.three"); if (!split) return;
    var rect = split.getBoundingClientRect();
    h.classList.add("dragging"); document.body.style.userSelect = "none";
    var lastVal = null;
    function onMove(ev) {
      // Generous, window-relative caps (keep a usable middle pane); effectively "no fixed limit".
      var maxList = Math.round(window.innerWidth * 0.6);
      var maxCtx = Math.round(window.innerWidth * 0.7);
      if (side === "left") {
        lastVal = Math.max(200, Math.min(maxList, Math.round(ev.clientX - rect.left)));
        document.documentElement.style.setProperty("--list-w", lastVal + "px");
      } else {
        lastVal = Math.max(220, Math.min(maxCtx, Math.round(rect.right - ev.clientX)));
        document.documentElement.style.setProperty("--ctx-w", lastVal + "px");
      }
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      h.classList.remove("dragging"); document.body.style.userSelect = "";
      if (lastVal != null) {   // save the exact dragged value for THIS side (robust across reloads)
        try { localStorage.setItem(side === "left" ? "cmt-list-w" : "cmt-ctx-w", String(lastVal)); } catch (e2) {}
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  function init() {
    try {
      state.theme = localStorage.getItem("cmt-theme") ||
        (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    } catch (e) { state.theme = "light"; }
    applyTheme();
    applyPaneWidths();
    try { state.drafts = JSON.parse(sessionStorage.getItem("cmt-drafts") || "{}") || {}; sessionStorage.removeItem("cmt-drafts"); } catch (e) { state.drafts = {}; }
    registerServiceWorker();   // PWA + Web Push (no-op off https/localhost)
    state.isMobile = isMobileView();
    // Re-render when crossing the phone/desktop breakpoint (rotate, resize) so the layout switches.
    window.addEventListener("resize", function () {
      var m = isMobileView();
      if (m !== state.isMobile) { state.isMobile = m; render(); }
    });
    window.addEventListener("hashchange", function () { render(); if (parseHash().view === "inbox") loadTodoData(true); });
    q("#cmdk-input").addEventListener("input", function (e) { state.cmdk.query = e.target.value; state.cmdk.sel = 0; renderCmdk(); });
    q("#search-input").addEventListener("input", function (e) { state.q = e.target.value; render(); });
    // Known Issues in-section search: filters tiles in place (no re-render) so the caret stays put.
    document.addEventListener("input", function (e) { if (e.target && e.target.id === "known-search") filterKnownList(e.target.value); });
    bootAuth();   /* decides live vs mock, then paints */
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
