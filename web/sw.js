/* CMT Console service worker - Web Push for desktop browsers and installed-PWA mobile.
   Kept intentionally tiny: it only shows incoming push notifications and focuses/opens the
   console when one is clicked. Scope is /console/ (served from there). */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: (event.data && event.data.text()) || "" }; }
  var title = data.title || "CMT Console";
  var options = {
    body: data.body || "",
    icon: "/console/icon-192.png",
    badge: "/console/icon-192.png",
    tag: data.tag || undefined,
    data: { url: data.url || "/console/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/console/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf("/console") >= 0 && "focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
