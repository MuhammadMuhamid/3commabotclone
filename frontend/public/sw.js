self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || "Signal Bot order executed", {
    body: data.body || "A Binance order was executed.",
    tag: data.tag || "signal-bot-execution",
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if ("focus" in client) { client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  }));
});
