# Sending events: SDKs and the HTTP API

NsMetry counts web pages with its `<script>` tracker and app screens and
events with an SDK. Both end at the same public endpoint, described in
[api.md](api.md#ingest-public). This page covers:

- [`nsmetry` for JavaScript](#javascript) — browsers, Node, Bun, Deno, React Native, Electron, Workers;
- [`nsmetry` for NSH](#nsh) — Native Shell apps on iOS, Android, macOS, Windows, Linux and the web;
- [the raw HTTP API](#any-other-language), with batching clients in Swift and Kotlin;
- [the budget](#budget): how many requests a fleet of apps costs on Cloudflare's free plan.

First register the app as a site in the dashboard. A site is a domain
(`example.com`) or a bare name (`disktree`). An app and its website can share one
site or have one each; one each keeps app screens and web pages apart.

## JavaScript

```sh
npm install nsmetry
```

```ts
import { createNsMetry } from 'nsmetry';

const nsmetry = createNsMetry({
  endpoint: 'https://stats.example.com',
  site: 'disktree',
  appVersion: '2.3.1',
  persistUserId: true,
});

nsmetry.screen('/scan');
nsmetry.track('scan_finished', { files: 18234, seconds: 12 });
```

| Method | |
| --- | --- |
| `track(name, props?)` | A custom event, on the current screen |
| `screen(path, props?)` | A screen or page view |
| `identify(userId)` | Use this anonymous id from now on (`null`: back to the generated one) |
| `flush()` | Send now; resolves when done, never rejects |
| `shutdown()` | Flush, then stop |
| `setEnabled(enabled)` | Opt out (drops the queue) or back in |

It queues events and sends them as one `POST /api/events/batch` 5 minutes after
the first one queued (`flushInterval`, default 300 000 ms), as soon as 50 are
waiting (`maxBatch`), and when the page is
hidden (with `sendBeacon`) or the process is about to exit. Failures are retried
with exponential backoff; the queue holds at most 1000 events (`maxQueue`),
dropping the oldest. Nothing it does throws into the host app. Platform notes —
React Native's `AppState`, Workers' `waitUntil` — are in
[sdk/js/README.md](../sdk/js/README.md).

## NSH

```sh
nsh add nsmetry
```

```ts
// analytics.ts
import { createNsMetry } from "nsmetry";
export const nsmetry = createNsMetry({ endpoint: "https://stats.example.com", site: "omasend", persistUserId: true });
```

```tsx
// App.tsx, in the root component
useNsMetry(nsmetry);                                                         // flush on background / quit
useScreenTracking(nsmetry, navStackPath(nav, (route) => `/${route.name}`)); // screen views
```

The same methods as the JavaScript package (the queue code is shared). On top:
the anonymous id lives in NSH `Storage`, `appVersion` defaults to `nsh.json`'s
`"version"`, and the `ua` field names the OS and device class
(`NsMetry-NSH/0.1.0 (Android 35; Mobile)`). See
[sdk/nsh/README.md](../sdk/nsh/README.md).

## Any other language

One request:

```http
POST /api/events/batch HTTP/1.1
Host: stats.example.com
Content-Type: text/plain;charset=UTF-8

{
  "site": "disktree",
  "events": [
    { "name": "screen_view", "url": "/scan", "ts": 1795694400,
      "user_id": "9f0c…", "app_version": "2.3.1", "ua": "Disktree/2.3.1 (macOS 15.1)" },
    { "name": "scan_finished", "url": "/scan", "ts": 1795694412,
      "user_id": "9f0c…", "app_version": "2.3.1", "ua": "Disktree/2.3.1 (macOS 15.1)",
      "props": { "files": 18234, "seconds": 12 } }
  ]
}
```

Rules worth knowing:

- **≤ 50 events per request.** `204` means stored. `400` (malformed) and `404`
  (unknown site) will fail again: drop the batch. Retry `429`, `5xx` and network
  errors with backoff. Keep request bodies small (well under 32 KB).
- **`name`**: `screen_view` (or `pageview`) is a view of `url`; anything else is a custom event.
- **`url`**: a path (`/settings`) is enough for an app. Leave ids out of it.
- **`ts`**: unix seconds, honoured when it falls in the current UTC day; older events are stored at receive time.
- **`user_id`**: a random id you generate once per install and keep. It enables
  active users and retention, and is hashed per site before it is stored. Never
  send an email or account id.
- **`props`**: flat, ≤ 10 keys, string/number/boolean values, strings ≤ 100 characters.
- **`ua`**: always set it from a native app. The server reads the OS
  (`iOS`, `Android`, `macOS`, `Windows NT`, `Linux`) and device class (`iPhone`/
  `Mobile`, `iPad`/`Tablet`, otherwise desktop) from it. Without it, the HTTP
  client's own User-Agent is used, and `okhttp/…` — Android's default — is dropped
  as a bot. Don't put words such as `bot`, `monitor`, `preview` or `scanner` in it
  for the same reason.
- The content type does not matter (the body is parsed as JSON); `text/plain`
  spares browsers a CORS preflight request.

### Swift (URLSession)

```swift
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Queues events and sends them in batches of up to 50. Call `flush()` when the
/// app moves to the background (scenePhase / didEnterBackgroundNotification).
actor NsMetry {
    static let shared = NsMetry(endpoint: URL(string: "https://stats.example.com/api/events/batch")!, site: "omamail")

    private let endpoint: URL
    private let site: String
    private var queue: [[String: Any]] = []
    private var timer: Task<Void, Never>?
    private var backoff: UInt64 = 2
    private var flushing = false // the actor is reentrant across awaits: one flush at a time

    private let userId: String = {
        if let id = UserDefaults.standard.string(forKey: "nsmetry.uid") { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "nsmetry.uid")
        return id
    }()
    private let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    private let ua: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let os = "\(v.majorVersion).\(v.minorVersion)"
        #if os(iOS)
        return UIDevice.current.userInterfaceIdiom == .pad ? "Omamail (iPad; iOS \(os); Tablet)" : "Omamail (iPhone; iOS \(os); Mobile)"
        #else
        return "Omamail (macOS \(os))"
        #endif
    }()

    init(endpoint: URL, site: String) { self.endpoint = endpoint; self.site = site }

    func screen(_ path: String) { enqueue(name: "screen_view", url: path, props: nil) }
    func track(_ name: String, url: String = "/", props: [String: Any]? = nil) { enqueue(name: name, url: url, props: props) }

    private func enqueue(name: String, url: String, props: [String: Any]?) {
        var event: [String: Any] = ["name": name, "url": url, "ts": Int(Date().timeIntervalSince1970),
                                    "user_id": userId, "app_version": appVersion, "ua": ua]
        if let props { event["props"] = props }
        queue.append(event)
        if queue.count > 1000 { queue.removeFirst(queue.count - 1000) } // bounded while offline
        if queue.count >= 50 { Task { await flush() } }
        else if timer == nil { timer = Task { try? await Task.sleep(nanoseconds: 300_000_000_000); timer = nil; await flush() } }
    }

    func flush() async {
        guard !flushing else { return }
        flushing = true
        defer { flushing = false }
        while !queue.isEmpty {
            let batch = Array(queue.prefix(50))
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("text/plain;charset=UTF-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["site": site, "events": batch])
            let status = (try? await URLSession.shared.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode } ?? 0
            if status == 0 || status == 429 || status >= 500 {          // keep and retry later
                let wait = backoff; backoff = min(backoff * 2, 300)
                timer = Task { try? await Task.sleep(nanoseconds: wait * 1_000_000_000); timer = nil; await flush() }
                return
            }
            backoff = 2
            queue.removeFirst(batch.count)                               // sent, or refused for good (400/404)
        }
    }
}

// await NsMetry.shared.screen("/inbox")
// await NsMetry.shared.track("send", props: ["attachments": 2])
```

### Kotlin (OkHttp)

```kotlin
import android.content.Context
import android.os.Build
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Queues events and sends them in batches of up to 50. Call flush() from onStop / ProcessLifecycleOwner. */
class NsMetry(context: Context, private val site: String, private val endpoint: String = "https://stats.example.com/api/events/batch") {
    private val client = OkHttpClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private val queue = ArrayDeque<JSONObject>()
    private var timer: Job? = null
    private var backoffMs = 2_000L
    private val flushing = java.util.concurrent.atomic.AtomicBoolean(false) // one flush at a time

    private val prefs = context.getSharedPreferences("nsmetry", Context.MODE_PRIVATE)
    private val userId = prefs.getString("uid", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("uid", it).apply() }
    private val appVersion = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    // OkHttp's own User-Agent ("okhttp/4.x") is filtered as a bot: describe the device instead.
    private val ua = run {
        val tablet = context.resources.configuration.smallestScreenWidthDp >= 600
        "Spotish/$appVersion (Android ${Build.VERSION.SDK_INT}; ${if (tablet) "Tablet" else "Mobile"})"
    }

    fun screen(path: String) = enqueue("screen_view", path, null)
    fun track(name: String, url: String = "/", props: Map<String, Any>? = null) = enqueue(name, url, props)

    private fun enqueue(name: String, url: String, props: Map<String, Any>?) {
        val event = JSONObject()
            .put("name", name).put("url", url).put("ts", System.currentTimeMillis() / 1000)
            .put("user_id", userId).put("app_version", appVersion).put("ua", ua)
        if (props != null) event.put("props", JSONObject(props))
        synchronized(lock) {
            queue.addLast(event)
            while (queue.size > 1000) queue.removeFirst()          // bounded while offline
            if (queue.size >= 50) scope.launch { flush() }
            else if (timer == null) timer = scope.launch { delay(300_000); synchronized(lock) { timer = null }; flush() }
        }
    }

    suspend fun flush(): Unit = withContext(Dispatchers.IO) {
        if (!flushing.compareAndSet(false, true)) return@withContext
        try { drain() } finally { flushing.set(false) }
    }

    private fun drain() {
        while (true) {
            val batch = synchronized(lock) { queue.take(50) }
            if (batch.isEmpty()) return
            val body = JSONObject().put("site", site).put("events", JSONArray(batch)).toString()
            val request = Request.Builder().url(endpoint)
                .post(body.toRequestBody("text/plain; charset=utf-8".toMediaType())).build()
            val status = try { client.newCall(request).execute().use { it.code } } catch (e: java.io.IOException) { 0 }
            if (status == 0 || status == 429 || status >= 500) {      // keep and retry later
                val wait = backoffMs; backoffMs = minOf(backoffMs * 2, 300_000)
                synchronized(lock) { timer?.cancel(); timer = scope.launch { delay(wait); synchronized(lock) { timer = null }; flush() } }
                return
            }
            backoffMs = 2_000
            synchronized(lock) { repeat(batch.size) { queue.removeFirst() } } // sent, or refused for good
        }
    }
}
```

Both are sketches to copy and adapt, not published packages: the SDKs above
are the maintained clients.

## Budget

The instance runs on Cloudflare's free plan, which allows per day **100,000
Worker requests**, **100,000 D1 rows written** and 5,000,000 rows read, for
everything: ingest, the dashboard, the apps and agents reading it.

**Requests are the limit that binds.** An SDK spends one request per flush, and
flushes only while it has something to send:

| Client | Requests per day |
| --- | --- |
| A running app, actively used | 1 per 5 minutes of use (one per `flushInterval`, or per 50 events if sooner), plus 1 per trip to the background |
| An idle or closed app | 0 |
| A web page view with the `<script>` tracker | 1 |
| A dashboard visit | ~5–15 |

Rule of thumb: **requests/day ≈ Σ (active minutes ÷ 5 + sessions) over all
installs + web page views + ~1,000 for dashboards**. For example:

- 300 desktop users of Disktree, 20 active minutes each, 3 sessions: 300 × 7 ≈ **2,100**
- 1,000 phone users of Omasend, 5 minutes each, 4 sessions: 1,000 × 5 ≈ **5,000**
- 20,000 web page views across the apps' websites: **20,000**

That is ~28,000 of 100,000. test/budget.test.ts drives the real SDK queue
(sdk/js/src/core.ts) on a virtual clock for every simulated user, so the
fleet it measures pays exactly these flushes. A fleet that grows past the
budget can raise `flushInterval` further before anything else; a lower one
costs requests in proportion (30 s makes a 5-minute session cost ten).

**Rows written** are the second limit. A batch is stored raw as one row per
install it carries (src/ingest.ts), so batching saves writes as well as
requests: a single `/api/event` costs one raw row per event, an SDK flush one
raw row for up to 50. The rollups then add rows by *variety*, not volume — one
per distinct path, event name, property value, country and so on per site per
day (see the README, "How it stays free"). Track what you will read — a
screen, a finished export, an error — not every tap, and keep paths and
property values few and repetitive: each distinct combination is a row.

If the instance runs out anyway, Cloudflare answers the rest of the day's
requests with an error; the SDKs keep the events queued (up to 1000 per
install) and send them later, stamped with the time they arrive.
