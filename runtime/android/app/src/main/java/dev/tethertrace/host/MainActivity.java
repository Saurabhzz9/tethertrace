package dev.tethertrace.host;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * The Android runtime for .tapp packages.
 *
 * It opens one package (handed over by tethertrace, or bundled in this APK's assets), checks every
 * file against the manifest, and shows the package in a WebView under an origin of its own. Files
 * are served straight from the verified archive. Requests to anywhere else are refused unless the
 * manifest asked for the network and listed that origin. Device features go through one bridge
 * object, and each call is checked against the manifest's permissions here, on the native side.
 */
public class MainActivity extends Activity {
    static final String RUNTIME_VERSION = "0.1.0";
    static final String BUNDLED = "app.tapp";

    private ZipFile zip;
    private JSONObject manifest;
    private JSONObject files;
    private Set<String> permissions = new HashSet<>();
    private Set<String> network = new HashSet<>();
    private String id;
    private String originHost;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            open(locate());
        } catch (Exception e) {
            refuse(e.getMessage() == null ? e.toString() : e.getMessage());
            return;
        }
        show();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            if (zip != null) zip.close();
        } catch (Exception ignored) {
        }
    }

    /** The package to run: the one named in the launch intent, else the one bundled in this APK. */
    private File locate() throws Exception {
        String named = getIntent().getStringExtra("tapp");
        if (named != null) {
            File f = new File(getFilesDir(), named).getCanonicalFile();
            if (!f.getPath().startsWith(getFilesDir().getCanonicalPath() + File.separator)) throw new Exception("The package path leaves this app's folder");
            if (!f.isFile()) throw new Exception("No package at " + named);
            return f;
        }
        File out = new File(getCacheDir(), BUNDLED);
        try (InputStream in = getAssets().open(BUNDLED); FileOutputStream o = new FileOutputStream(out)) {
            copy(in, o);
        } catch (java.io.FileNotFoundException e) {
            throw new Exception("No package to run. Start one with: tethertrace run app.tapp --platform android");
        }
        return out;
    }

    /** Read the manifest and check every file. Throws with a reason a person can read. */
    private void open(File file) throws Exception {
        zip = new ZipFile(file);
        ZipEntry me = zip.getEntry("tapp.json");
        if (me == null) throw new Exception("Not a .tapp package (no tapp.json)");
        manifest = new JSONObject(new String(read(zip.getInputStream(me)), StandardCharsets.UTF_8));
        if (manifest.optInt("tapp") != 1) throw new Exception("Package format " + manifest.opt("tapp") + " is not supported by this runtime");
        id = manifest.getString("id");
        if (!id.matches("^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$")) throw new Exception("The package id is not valid");
        JSONObject rt = manifest.getJSONObject("runtime");
        if (!"web".equals(rt.optString("kind")) || rt.optInt("api") > 1) throw new Exception("This package needs a newer runtime");
        files = manifest.getJSONObject("files");
        String entry = manifest.getString("entry");
        if (!files.has(entry)) throw new Exception("The entry file is not in the package");

        JSONArray p = manifest.getJSONArray("permissions");
        for (int i = 0; i < p.length(); i++) permissions.add(p.getString(i));
        JSONArray n = manifest.getJSONArray("network");
        for (int i = 0; i < n.length(); i++) network.add(n.getString(i).toLowerCase());

        // Nothing unlisted may be inside, and every listed file must match its SHA-256.
        Enumeration<? extends ZipEntry> all = zip.entries();
        while (all.hasMoreElements()) {
            String name = all.nextElement().getName();
            if (name.equals("tapp.json") || name.equals("tapp.sig")) continue;
            if (!files.has(name)) throw new Exception("\"" + name + "\" is in the package but not in its manifest");
        }
        Iterator<String> names = files.keys();
        while (names.hasNext()) {
            String name = names.next();
            if (name.startsWith("/") || name.contains("..") || name.contains("\\") || name.contains(":")) throw new Exception("\"" + name + "\" is not an allowed file path");
            ZipEntry e = zip.getEntry(name);
            if (e == null) throw new Exception("\"" + name + "\" is missing from the package");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = zip.getInputStream(e)) {
                byte[] buf = new byte[65536];
                for (int r; (r = in.read(buf)) > 0; ) md.update(buf, 0, r);
            }
            if (!hex(md.digest()).equals(files.getJSONObject(name).getString("sha256"))) throw new Exception("\"" + name + "\" does not match the manifest. The package was changed after it was packed.");
        }
        // Each package gets its own origin, so one package cannot read another's storage.
        originHost = hex(MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8))).substring(0, 20) + ".tapp.invalid";
    }

    private void show() {
        setTitle(manifest.optString("name", id));
        WebView web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Host(), "__tappHost");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The page may move around inside its own package, never out of it.
                return !originHost.equals(request.getUrl().getHost());
            }
        });
        setContentView(web);
        web.loadUrl("https://" + originHost + "/" + manifest.optString("entry"));
    }

    private void refuse(String why) {
        TextView t = new TextView(this);
        t.setText("This package was not started.\n\n" + why);
        t.setTextSize(16);
        t.setTextColor(Color.BLACK);
        t.setBackgroundColor(Color.WHITE);
        t.setGravity(Gravity.CENTER);
        t.setPadding(48, 48, 48, 48);
        setContentView(t);
    }

    // ------------------------------------------------------------ serving

    private WebResourceResponse serve(WebResourceRequest request) {
        String host = request.getUrl().getHost();
        if (!originHost.equals(host)) {
            String origin = (request.getUrl().getScheme() + "://" + request.getUrl().getAuthority()).toLowerCase();
            if (permissions.contains("network") && network.contains(origin)) return null; // allowed: let the WebView fetch it
            return plain(403, "Forbidden", "This package may not contact " + origin);
        }
        String path = request.getUrl().getPath();
        if (path == null || path.equals("/")) path = "/" + manifest.optString("entry");
        path = path.substring(1);
        try {
            if (path.equals("__tapp/boot.js")) return bytes("text/javascript", ("window.__tappBoot=" + boot() + ";").getBytes(StandardCharsets.UTF_8), false);
            if (path.equals("__tapp/bridge.js")) return bytes("text/javascript", read(getAssets().open("bridge.js")), false);
            if (!files.has(path)) return plain(404, "Not Found", path + " is not in this package");
            byte[] data = read(zip.getInputStream(zip.getEntry(path)));
            String mime = mime(path);
            if (mime.equals("text/html")) data = inject(data);
            return bytes(mime, data, mime.equals("text/html"));
        } catch (Exception e) {
            return plain(500, "Error", String.valueOf(e.getMessage()));
        }
    }

    private String boot() throws Exception {
        JSONObject b = new JSONObject();
        b.put("id", id).put("name", manifest.optString("name")).put("version", manifest.optString("version"));
        b.put("platform", "android").put("runtime", RUNTIME_VERSION).put("permissions", manifest.getJSONArray("permissions"));
        return b.toString();
    }

    /** Put the runtime's two scripts in front of the page's own. */
    private byte[] inject(byte[] html) {
        String s = new String(html, StandardCharsets.UTF_8);
        String tags = "<script src=\"/__tapp/boot.js\"></script><script src=\"/__tapp/bridge.js\"></script>";
        int head = s.toLowerCase().indexOf("<head");
        int at = head < 0 ? -1 : s.indexOf('>', head);
        s = at < 0 ? tags + s : s.substring(0, at + 1) + tags + s.substring(at + 1);
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private String csp() {
        StringBuilder connect = new StringBuilder("'self'");
        if (permissions.contains("network")) for (String o : network) connect.append(' ').append(o);
        return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src " + connect + "; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
    }

    private WebResourceResponse bytes(String mime, byte[] data, boolean html) {
        Map<String, String> h = new HashMap<>();
        h.put("X-Content-Type-Options", "nosniff");
        h.put("Cache-Control", "no-store");
        if (html) h.put("Content-Security-Policy", csp());
        boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
        return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", h, new ByteArrayInputStream(data));
    }

    private WebResourceResponse plain(int status, String reason, String body) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, new HashMap<String, String>(), new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    // ------------------------------------------------------------ bridge

    /** The native half of window.tapp. Every method checks the manifest before it does anything. */
    class Host {
        @JavascriptInterface
        public String call(String method, String argsJson) {
            try {
                JSONObject a = new JSONObject(argsJson == null ? "{}" : argsJson);
                switch (method) {
                    case "storage.get": {
                        need("storage");
                        String v = prefs().getString(a.getString("key"), null);
                        return ok(v == null ? JSONObject.NULL : v);
                    }
                    case "storage.set":
                        need("storage");
                        prefs().edit().putString(a.getString("key"), a.getString("value")).apply();
                        return ok(true);
                    case "storage.remove":
                        need("storage");
                        prefs().edit().remove(a.getString("key")).apply();
                        return ok(true);
                    case "vibrate": {
                        need("vibrate");
                        Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                        if (v == null || !v.hasVibrator()) return error("unavailable", "This device cannot vibrate");
                        long ms = Math.max(1, Math.min(a.optLong("ms", 50), 2000));
                        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                        else v.vibrate(ms);
                        return ok(true);
                    }
                    default:
                        return error("unavailable", method + " is not available on android");
                }
            } catch (SecurityException e) {
                return error("permission_denied", e.getMessage());
            } catch (Exception e) {
                return error("error", String.valueOf(e.getMessage()));
            }
        }

        private void need(String permission) {
            if (!permissions.contains(permission)) throw new SecurityException("This package did not ask for the \"" + permission + "\" permission");
        }

        private SharedPreferences prefs() {
            return getSharedPreferences("tapp_" + id, MODE_PRIVATE);
        }

        private String ok(Object value) throws Exception {
            return new JSONObject().put("ok", true).put("value", value).toString();
        }

        private String error(String code, String message) {
            try {
                return new JSONObject().put("ok", false).put("error", code).put("message", message).toString();
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"error\"}";
            }
        }
    }

    // ------------------------------------------------------------ helpers

    private static void copy(InputStream in, java.io.OutputStream out) throws Exception {
        byte[] buf = new byte[65536];
        for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
    }

    private static byte[] read(InputStream in) throws Exception {
        try (InputStream i = in) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            copy(i, o);
            return o.toByteArray();
        }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static String mime(String path) {
        String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase() : "";
        switch (ext) {
            case "html": case "htm": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": case "map": return "application/json";
            case "wasm": return "application/wasm";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "ico": return "image/x-icon";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            case "mp3": return "audio/mpeg";
            case "wav": return "audio/wav";
            case "ogg": return "audio/ogg";
            case "mp4": return "video/mp4";
            case "webm": return "video/webm";
            case "txt": return "text/plain";
            case "xml": return "text/xml";
            default: return "application/octet-stream";
        }
    }
}
