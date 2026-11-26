/* ============================================================
   CMT Console - thin API client for /api/console/*. Loaded before
   app.js. mode is "live" once the server answered; "offline" when it
   could not be reached (app.js then shows a retry screen - there is no
   demo data).
   ============================================================ */
(function () {
  "use strict";
  var BASE = "/api/console";

  function req(path, method, body) {
    var opts = { method: method || "GET", credentials: "same-origin", headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(BASE + path, opts).then(function (r) {
      // A 401 on anything but the sign-in calls means the session is gone: tell the app once.
      if (r.status === 401 && !/^\/(me|login|set-password)$/.test(path)) {
        try { window.dispatchEvent(new Event("console:unauthorized")); } catch (e) {}
      }
      return r;
    });
  }
  function json(r) { return r.json().then(function (d) { return d; }, function () { return {}; }); }

  window.CONSOLE = {
    base: BASE,
    mode: "unknown",            // "live" | "offline" | "unknown"

    /* Reach the server and return the current user (or null when signed out). */
    probe: function () {
      var self = this;
      if (location.protocol !== "http:" && location.protocol !== "https:") {
        self.mode = "offline";
        return Promise.resolve(null);
      }
      // Only a real 401/403 means signed out. A 5xx or a network blip gets a few retries first, so a
      // slow moment on the server doesn't look like a logout on page load.
      function later(n) {
        return new Promise(function (ok) { setTimeout(ok, 1500); }).then(function () { return attempt(n + 1); });
      }
      function attempt(n) {
        return req("/me", "GET").then(function (r) {
          self.mode = "live";
          if (r.status === 200) return json(r);   // signed in
          if (r.status === 401 || r.status === 403 || n >= 4) return null;   // live but signed out
          return later(n);
        }, function () {
          if (n < 2) return later(n);
          self.mode = "offline";                  // API unreachable -> retry screen
          return null;
        });
      }
      return attempt(0);
    },

    login: function (email, password) {
      return req("/login", "POST", { email: email, password: password })
        .then(function (r) { return json(r).then(function (d) { return { status: r.status, data: d }; }); });
    },
    setPassword: function (email, password, invite) {
      return req("/set-password", "POST", { email: email, password: password, invite: invite || "" })
        .then(function (r) { return json(r).then(function (d) { return { status: r.status, data: d }; }); });
    },
    logout: function () {
      return req("/logout", "POST").then(function () {}, function () {});
    },

    /* ETag of the last response per path (the live lists' version, used to seed the /poll map). */
    etags: {},
    /* Read helper: resolves to parsed JSON on 2xx, rejects with the status otherwise. */
    get: function (path) {
      var self = this;
      return req(path, "GET").then(function (r) {
        var et = r.headers.get("ETag");
        if (et) self.etags[path] = et.replace(/^W\//, "").replace(/"/g, "");
        if (r.status >= 200 && r.status < 300) return json(r);
        return Promise.reject(r.status);
      });
    },
    /* Write helpers (notes/tags etc.). Resolve parsed JSON on 2xx, reject the
       status otherwise so callers can toast an error and keep local state. */
    post: function (path, body) {
      return req(path, "POST", body).then(function (r) {
        if (r.status >= 200 && r.status < 300) return json(r);
        return Promise.reject(r.status);
      });
    },
    /* Like post(), but resolves with {status, data} even on 4xx/5xx so callers can surface the
       server's specific error (data.error) instead of a generic message. Rejects only on a real
       network failure. */
    postMsg: function (path, body, method) {   // method: "POST" (default) or e.g. "PATCH"
      return req(path, method || "POST", body).then(function (r) {
        return json(r).then(function (d) { return { status: r.status, data: d }; });
      });
    },
    del: function (path) {
      return req(path, "DELETE").then(function (r) {
        if (r.status >= 200 && r.status < 300) return json(r);
        return Promise.reject(r.status);
      });
    },
    patch: function (path, body) {
      return req(path, "PATCH", body).then(function (r) {
        if (r.status >= 200 && r.status < 300) return json(r);
        return Promise.reject(r.status);
      });
    },
    put: function (path, body) {
      return req(path, "PUT", body).then(function (r) {
        if (r.status >= 200 && r.status < 300) return json(r);
        return Promise.reject(r.status);
      });
    },
    /* Multipart upload (attachments). Pass a FormData; the browser sets the
       boundary Content-Type itself, so we must NOT set it here. */
    upload: function (path, formData) {
      return fetch(BASE + path, { method: "POST", credentials: "same-origin", body: formData })
        .then(function (r) {
          if (r.status >= 200 && r.status < 300) return json(r);
          return Promise.reject(r.status);
        });
    }
  };
})();
