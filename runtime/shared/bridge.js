// The tapp runtime API, version 1. The same file is served by every runtime; what differs per
// platform is `window.__tappHost`, a small native object, and `window.__tappBoot`, which holds the
// package's identity and the permissions its manifest asked for.
//
// Every call returns a Promise. A call for something the manifest did not ask for is rejected with
// code "permission_denied". Something this platform cannot do is rejected with "unavailable".
(function () {
  "use strict";
  var boot = window.__tappBoot;
  if (!boot || window.tapp) return;
  var host = window.__tappHost;

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }
  function need(permission) {
    if (boot.permissions.indexOf(permission) < 0) throw fail("permission_denied", 'This package did not ask for the "' + permission + '" permission');
  }

  // Without a native host (the desktop preview) the browser itself is the platform.
  var storageKey = function (k) { return "tapp:" + boot.id + ":" + k; };
  var web = {
    "storage.get": function (a) { var v = localStorage.getItem(storageKey(a.key)); return v === null ? null : v; },
    "storage.set": function (a) { localStorage.setItem(storageKey(a.key), String(a.value)); return true; },
    "storage.remove": function (a) { localStorage.removeItem(storageKey(a.key)); return true; },
    vibrate: function (a) {
      if (!navigator.vibrate) throw fail("unavailable", "This device cannot vibrate");
      return navigator.vibrate(a.ms);
    },
  };

  function call(method, permission, args) {
    return new Promise(function (resolve, reject) {
      try {
        if (permission) need(permission);
        if (host) {
          // The native side checks the permission again; this side only fails early.
          var r = JSON.parse(host.call(method, JSON.stringify(args || {})));
          if (r.ok) resolve(r.value === undefined ? null : r.value);
          else reject(fail(r.error || "error", r.message || method + " failed"));
        } else if (web[method]) resolve(web[method](args || {}));
        else reject(fail("unavailable", method + " is not available on " + boot.platform));
      } catch (e) {
        reject(e);
      }
    });
  }

  var info = Object.freeze({ id: boot.id, name: boot.name, version: boot.version, platform: boot.platform, runtime: boot.runtime, permissions: Object.freeze(boot.permissions.slice()) });

  window.tapp = Object.freeze({
    api: 1,
    platform: boot.platform,
    info: function () { return Promise.resolve(info); },
    has: function (permission) { return boot.permissions.indexOf(permission) >= 0; },
    storage: Object.freeze({
      get: function (key) { return call("storage.get", "storage", { key: String(key) }); },
      set: function (key, value) { return call("storage.set", "storage", { key: String(key), value: String(value) }); },
      remove: function (key) { return call("storage.remove", "storage", { key: String(key) }); },
    }),
    vibrate: function (ms) { return call("vibrate", "vibrate", { ms: Math.max(1, Math.min(Number(ms) || 50, 2000)) }); },
  });
})();
