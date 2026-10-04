# ⚙️ Configuration Reference

Every instance of the TwextHub API reads its settings from a YAML file, and most of them can also come from an environment variable that overrides the file. The default file is `config.yaml` in the working directory; the server takes a different path as its first argument (`node src/server.js path/to/config.yaml`), and `node src/migrate.js` takes one as a positional argument or after `--config`.

Settings are applied in three layers:

1. The defaults built into the code.
2. The configuration file, merged over the defaults.
3. Environment variables, which override both.

`database.url` is the only required setting. The server refuses to start without one, from either the file or `TWEXTHUB_DATABASE_URL`.

Here is a configuration that uses every key:

```yaml
port: 3000
dataDir: ./data
apiRoot: /v1
publicBaseUrl: http://localhost:3000
requireHttps: false
trustProxy: false

database:
  url: postgres://postgres:postgres@localhost:5432/twexthub
  maxConnections: 10
  connectTimeoutSeconds: 30
  idleTimeoutSeconds: 60

auth:
  sessionTtlDays: 7
  scrypt: { N: 16384, r: 8, p: 1 }

rateLimits:
  loginAttemptsPerWindow: 5
  loginWindowMinutes: 15
  signupsPerIpPerWindow: 5
  signupWindowMinutes: 15
  publishPerWindow: 30 # null turns this bucket off
  publishWindowMinutes: 60
  downloadsPerIpPerWindow: 240 # null turns this bucket off
  downloadWindowMinutes: 5
  routesPerIpPerWindow: 600
  routeWindowMinutes: 15

pagination:
  defaultLimit: 20
  maxLimit: 50

limits:
  maxBlobBytes: 2097152
  maxAccountBlobBytes: 67108864
  maxSourceBytes: 1048576
  maxProfileImageBytes: 2097152

compiler:
  command: null
  timeoutMs: 30000
  memoryMb: 192
  addressSpaceMb: 1536

logging:
  requests: false

cors:
  allowedOrigins: '*'
```

## 📕 Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [🔀 How Settings Are Applied](#-how-settings-are-applied)
- [🌐 Server](#-server)
- [🗄️ Database](#-database)
- [🔐 Authentication](#-authentication)
- [🚦 Rate Limits](#-rate-limits)
- [📄 Pagination](#-pagination)
- [📦 Size Limits](#-size-limits)
- [🛠️ The Build Sandbox](#-the-build-sandbox)
- [🌍 CORS and Logging](#-cors-and-logging)
- [🖥️ Editing Settings at Runtime](#-editing-settings-at-runtime)
- [🔑 Other Environment Variables](#-other-environment-variables)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## 🔀 How Settings Are Applied

The configuration file is merged over the defaults one key at a time, so a file only has to set what it wants to change. An explicit `null` in the file means "not set" and falls back to the default — except for `rateLimits.publishPerWindow` and `rateLimits.downloadsPerIpPerWindow`, where `null` is how you switch a bucket off.

Environment variables are read last and win over the file. They are typed by the default they override:

- Booleans accept `true` or `1` and `false` or `0`. Anything else fails startup with an error naming the variable.
- Numbers must be positive integers. A typo like `TWEXTHUB_PORT=3000x` fails startup instead of quietly becoming `3000`.
- The two switchable rate-limit buckets also accept `off` or `null`, which sets them to `null`.
- `cors.allowedOrigins` is a comma-separated list, or `*`.
- `trustProxy` accepts `true`, `false`, a number of hops, or one of Express's keyword values.

Not every key has an environment variable: `database.connectTimeoutSeconds`, `database.idleTimeoutSeconds`, and `auth.scrypt` are file-only.

## 🌐 Server

- `port`: Port the HTTP server listens on. Defaults to `3000`. `TWEXTHUB_PORT`.
- `dataDir`: Directory holding everything the instance stores on disk — compiled blobs, retained project sources, build temporary files, and the generated download-address key. Relative paths resolve against the working directory. Defaults to `./data`. `TWEXTHUB_DATA_DIR`. It has to be persistent storage; see [Data Persistence](./deploy.md#-data-persistence).
- `apiRoot`: URL prefix every route is served under. Leading and trailing slashes are ignored, so `/v1` and `v1` are the same thing; an empty string serves the API at the root. Defaults to `/v1`. `TWEXTHUB_API_ROOT`.
- `publicBaseUrl`: Absolute URL of the instance, used to build download, source, and profile image links in responses. Defaults to `http://localhost:3000`. `TWEXTHUB_PUBLIC_BASE_URL`.
- `requireHttps`: Reject plain HTTP requests with a `403`. Turn it on when the instance is served over TLS. Defaults to `false`. `TWEXTHUB_REQUIRE_HTTPS`.
- `trustProxy`: Handed to Express as its [trust proxy](https://expressjs.com/en/guide/behind-proxies.html) setting. Set it when the API runs behind a reverse proxy, or the rate limits will count the proxy's address instead of each client's. Defaults to `false`. `TWEXTHUB_TRUST_PROXY`.

## 🗄️ Database

- `url`: PostgreSQL connection URL. Required, with no default. `TWEXTHUB_DATABASE_URL`.
- `maxConnections`: Size of the connection pool. Defaults to `10`. `TWEXTHUB_DATABASE_MAX_CONNECTIONS`.
- `connectTimeoutSeconds`: How long to wait for a connection before giving up. Defaults to `30`. File-only.
- `idleTimeoutSeconds`: How long an unused connection is kept before closing. Defaults to `60`. File-only.

Migrations run automatically when the server boots, and `node src/migrate.js` applies them on its own when you would rather not start the server.

## 🔐 Authentication

- `sessionTtlDays`: Lifetime of a sign-in session, in days. It applies to sessions created after the change; existing sessions keep the expiry they were given. Defaults to `7`. `TWEXTHUB_SESSION_TTL_DAYS`.
- `scrypt`: Cost parameters (`N`, `r`, `p`) for password hashing. File-only, and each stored hash records the parameters it was made with, so changing them affects new passwords without invalidating old ones. The defaults (`16384`, `8`, `1`) are a sensible balance; raising `N` makes every sign-in more expensive for the server.

## 🚦 Rate Limits

Limits are counted in fixed windows aligned to the clock — a 15-minute window resets at :00, :15, :30, and :45 — and rejected requests carry a `Retry-After` header saying when the window rolls over.

- `loginAttemptsPerWindow` / `loginWindowMinutes`: Failed sign-ins, counted per namespace per IP and per IP overall. Defaults to `5` attempts per `15` minutes. `TWEXTHUB_LOGIN_ATTEMPTS_PER_WINDOW`, `TWEXTHUB_LOGIN_WINDOW_MINUTES`.
- `signupsPerIpPerWindow` / `signupWindowMinutes`: Sign-up attempts from one IP, counting attempts at both accounts and organizations whether they succeed or not. Defaults to `5` per `15` minutes. `TWEXTHUB_SIGNUPS_PER_IP_PER_WINDOW`, `TWEXTHUB_SIGNUP_WINDOW_MINUTES`.
- `publishPerWindow` / `publishWindowMinutes`: Publishes per account — per account rather than per IP because CI runners often share one. Defaults to `30` per `60` minutes. `TWEXTHUB_PUBLISH_PER_WINDOW`, `TWEXTHUB_PUBLISH_WINDOW_MINUTES`.
- `downloadsPerIpPerWindow` / `downloadWindowMinutes`: Downloads from one IP. Defaults to `240` per `5` minutes. `TWEXTHUB_DOWNLOADS_PER_IP_PER_WINDOW`, `TWEXTHUB_DOWNLOAD_WINDOW_MINUTES`.
- `routesPerIpPerWindow` / `routeWindowMinutes`: A coarse cap on every route, as a backstop for floods the buckets above don't cover. Loopback addresses are exempt. Both must be positive integers — the server won't start without them. Defaults to `600` per `15` minutes. `TWEXTHUB_ROUTES_PER_IP_PER_WINDOW`, `TWEXTHUB_ROUTE_WINDOW_MINUTES`.

The publish and download buckets can be switched off entirely with `null` in the file, or `off` in the environment.

## 📄 Pagination

- `defaultLimit`: Page size when a client doesn't ask for one. Defaults to `20`. `TWEXTHUB_PAGINATION_DEFAULT_LIMIT`.
- `maxLimit`: The largest page size a client may request. Defaults to `50`. `TWEXTHUB_PAGINATION_MAX_LIMIT`.

## 📦 Size Limits

- `maxBlobBytes`: Largest compiled extension the server will store for one version. Defaults to 2 MB. `TWEXTHUB_MAX_BLOB_BYTES`.
- `maxAccountBlobBytes`: Total bytes one account may have stored across its versions and source archives. An admin can raise or lower it for a single account. Defaults to 64 MB. `TWEXTHUB_MAX_ACCOUNT_BLOB_BYTES`.
- `maxSourceBytes`: Largest project tarball a publish may upload. Defaults to 1 MB. `TWEXTHUB_MAX_SOURCE_BYTES`.
- `maxProfileImageBytes`: Largest avatar or banner upload. Defaults to 2 MB. `TWEXTHUB_MAX_PROFILE_IMAGE_BYTES`.

## 🛠️ The Build Sandbox

Every publish is compiled on the server, in a child process with filesystem, memory, and time limits. The [deploy guide](./deploy.md#-the-build-sandbox) describes what the sandbox does; these keys tune it:

- `command`: Path to a Node.js script (`.js`, `.mjs`, or `.cjs`) used instead of the bundled Twext, called as `node <command> build -o <out>`. Defaults to the Twext that ships with the server. `TWEXTHUB_COMPILER`.
- `timeoutMs`: Wall-clock limit for one build; the process is killed when it passes. Defaults to `30000`. `TWEXTHUB_COMPILER_TIMEOUT_MS`.
- `memoryMb`: V8 heap cap for the build, in megabytes. Defaults to `192`. `TWEXTHUB_COMPILER_MEMORY_MB`.
- `addressSpaceMb`: Address-space limit (`ulimit -v`) for the build, in megabytes. Defaults to `1536`. `TWEXTHUB_COMPILER_ADDRESS_SPACE_MB`.

## 🌍 CORS and Logging

- `cors.allowedOrigins`: Origins allowed to call the API from a browser. Either `*`, or a list of origins compared exactly against the `Origin` header. Defaults to `*`. `TWEXTHUB_CORS_ALLOWED_ORIGINS`, as a comma-separated list or `*`.
- `logging.requests`: Write one structured JSON line per request, in addition to the in-memory counters. Defaults to `false`. `TWEXTHUB_LOG_REQUESTS`.

## 🖥️ Editing Settings at Runtime

An admin can read and change a subset of these settings from the running instance through `GET` and `PUT` on `/admin/config` (under the API root), without redeploying. The file is edited in place, so comments and key order survive, and the change is written back to the same file the instance started from.

The endpoint only accepts its own allowlist: the public base URL, session lifetime, page sizes, size limits, compiler limits, request logging, and allowed origins. The database URL, port, API root, and data directory are not editable there — a typo in those is an instance that won't start, and the form would be an easier way to break one than a text editor.

Each setting is either applied immediately or needs a restart, and the response says which. The endpoint returns `409` if the configuration file isn't writable or wouldn't survive a redeploy — inside a container, that means mounting `config.yaml` as a volume rather than baking it into the image.

## 🔑 Other Environment Variables

These aren't part of the configuration file:

- `TWEXTHUB_DOWNLOAD_HASH_KEY`: Key used to hash client addresses for download statistics, so distinct downloads can be counted without storing the addresses. If unset, one is generated into `dataDir/secrets/download-address.key` on first use. Keep it in your secret store if you manage secrets outside the container.
- `TWEXTHUB_METRICS_INTERVAL_MS`: How often the daily download rollup runs, in milliseconds. Defaults to one hour.
- `TWEXTHUB_TEST_DATABASE_URL`: Used only by the test suite; see [Development Guide](./development.md#-tests).
