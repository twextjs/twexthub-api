# 🧑‍💻 Development Guide

> **Important:** Development is best done on Linux. There is support for Windows, but some tests fail because Windows still uses the outdated CRLF and applies that on every single file you save, so file comparisons will always fail.

The TwextHub API has a somewhat different development process than you're used to. If you make changes, make sure to:

1. Format the code:

   ```bash
   npm run format
   ```

2. Lint the code:

   ```bash
   npm run lint
   ```

3. Before you run tests, run the setup script (requires Docker):

   ```bash
   npm run test:setup
   ```

`npm run check` runs `lint`, `format:check`, and `test` sequentially and is the one to run before you push. It checks formatting without rewriting files; `npm run format` rewrites files.

## 📕 Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [📦 Getting Set Up](#-getting-set-up)
- [🗂️ Project Layout](#-project-layout)
- [🧪 Tests](#-tests)
- [🤖 CI and Releases](#-ci-and-releases)
- [📖 Working on the Docs](#-working-on-the-docs)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## 📦 Getting Set Up

Node.js 24 or newer, Docker for the test database, and a PostgreSQL to run the server against.

```bash
npm install
npm run test:setup
npm test
```

`test:setup` starts a Postgres container (`compose.test.yml`) and creates the `twexthub_test` database in it. Both are one-time steps per machine — the data lives in a named volume, so don't tear the container down between runs; `npm run test:teardown` stops it when you're done.

To run the API itself, point it at a database and start it:

```bash
TWEXTHUB_DATABASE_URL=postgres://postgres:postgres@localhost:5432/twexthub npm run dev
```

`npm run dev` restarts on file changes; `npm start` runs it once. Both read `config.yaml` from the working directory, and the server applies pending migrations on boot, so there's no migrate step to remember. `npm run migrate` applies migrations on its own if you'd rather not start the server.

The first account to sign up on a fresh database becomes the admin, which is worth knowing when your dev database is brand new.

## 🗂️ Project Layout

| Path                                   | What it does                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.js`                        | Entry point: loads the config, migrates the database, boots the app and the background jobs, and shuts them down on a signal.                        |
| `src/app.js`                           | Builds the Express app: the middleware order, the HTTPS and CORS gates, and which routers mount where under the API root.                            |
| `src/config.js`                        | The defaults, the `config.yaml` merge, and the environment variable overrides. See the [configuration reference](./configure.md).                    |
| `src/db.js`                            | The connection pool, the migration runner over `migrations/`, and the boot-time reconciliation of the data directory.                                |
| `src/routes/`                          | One file per resource — sessions, tokens, users, orgs, packages, blobs, discovery, notifications, admin. Each exports a factory that takes `shared`. |
| `src/auth.js`                          | Bearer token authentication, the automation-token scopes, and the admin/owner checks routes call.                                                    |
| `src/password.js`                      | scrypt hashing and verification.                                                                                                                     |
| `src/rate-limit.js`                    | The database-backed rate-limit buckets: login, signup, publish, download.                                                                            |
| `src/http-rate-limit.js`               | The coarse per-IP backstop in front of every route, built on `express-rate-limit`.                                                                   |
| `src/compiler.js`                      | Runs the sandboxed build: the child process, its filesystem/memory/time limits, and the environment allowlist.                                       |
| `src/tarball.js`                       | Packs and extracts the publish tarballs, with entry and byte caps so a hostile archive stays contained.                                              |
| `src/project-manifest.js`              | Derives the registry manifest from a project's `twext.yml` and validates it.                                                                         |
| `src/blobs.js`, `src/sources.js`       | The content-addressed stores under `dataDir` for compiled output and retained sources.                                                               |
| `src/maintenance.js`                   | Blob garbage collection, the daily integrity sweep that re-hashes stored files, and the startup cleanup of stale temp files.                         |
| `src/observability.js`                 | Request counts and timings, the optional per-request JSON log, and the Prometheus endpoint at `/admin/metrics`.                                      |
| `src/metrics.js`                       | The daily download rollup into `extension_daily_downloads`, and the distinct-download hashing.                                                       |
| `src/download-address.js`              | The key that hashes client addresses for those statistics — read from the environment or `dataDir/secrets/`.                                         |
| `src/webhooks.js`                      | Webhook signing, delivery, and retries.                                                                                                              |
| `src/notify.js`, `src/audit.js`        | Notification inserts (they join their caller's transaction) and the append-only audit trail.                                                         |
| `src/server-config.js`                 | The settings an admin may change at runtime, and the check that the config file can hold them.                                                       |
| `src/serialize.js`                     | The JSON shapes clients see, including the absolute URLs built from `publicBaseUrl`.                                                                 |
| `src/pagination.js`                    | Cursor pagination: the cursor encodings and the `limit` parsing.                                                                                     |
| `src/errors.js`                        | `HttpError` and the error handler that turns it into the problem-document body.                                                                      |
| `src/cors.js`                          | The CORS headers, from `cors.allowedOrigins`.                                                                                                        |
| `src/transfer.js`                      | Extension transfers between namespaces: the tables that move and the notifications that go with them.                                                |
| `src/profile.js`, `src/image-sniff.js` | The profile field rules shared by accounts and organizations, and the signature checks on uploaded images.                                           |
| `migrations/`                          | Numbered SQL files, applied in order and recorded in `schema_migrations`.                                                                            |
| `openapi/v1.yml`, `openapi/v2.yml`     | The OpenAPI description of the API surface, one file per major version. `v2.yml` describes the surface this branch serves.                           |
| `test/`, `test-fixtures/`              | The test suite and the Twext projects it publishes end to end.                                                                                       |
| `scripts/test-db.mjs`                  | Creates the test database in the container, idempotently.                                                                                            |
| `product.yml`                          | The name, version, tagline, and defaults (config filename, API root). The version here must match `package.json`; a test enforces it.                |
| `docs/`                                | The documentation in this directory.                                                                                                                 |

`product.yml` deserves a note: `/v2/meta` reports its `name`, `version`, and `tagline`, the server prints its name and version on boot, and `defaults` supplies the config filename and the API root. Bumping the version means touching both it and `package.json`.

## 🧪 Tests

The suite runs on Node's built-in test runner against a real database, one file at a time:

```bash
npm test
```

A single file runs the same way. The whole suite shares one database and every file resets it between tests, which is why `npm test` passes `--test-concurrency=1` — two files at once would truncate each other's rows:

```bash
node --test test/packages.test.js
```

`test/preflight.mjs` runs once before the suite and just checks that the database answers. Without it a missing Postgres would fail every file separately with the same connection error, two hundred times over.

`test/helpers.mjs` is where the shared pieces live: `boot()` builds the app once per file, `makeConfig()` composes test settings over the production defaults, `resetDb()` truncates between tests, and the signup/publish helpers drive the API the way a client would. `test-fixtures/` holds two complete Twext projects, `hello` and `greeter`, whose committed `dist/` output the tests compare byte-for-byte against what the server's sandbox build produces — if a change to the build pipeline alters the compiled bytes, that's where it shows up.

If your database lives somewhere other than the container, point `TWEXTHUB_TEST_DATABASE_URL` at it. The default is `postgres://postgres:postgres@localhost:5432/twexthub_test`.

## 🤖 CI and Releases

CI runs on every push and pull request to `main`, on Node.js 24, in four jobs: `lint`, `format`, `test`, and `test-setup`. `lint` and `format` run in parallel; `test` and `test-setup` wait for both. The `test` job gets its Postgres from a service container; `test-setup` starts the database the way a developer does — `npm run test:setup` — and then runs the same suite, so the documented local path can't rot unnoticed.

Releases are cut by pushing a tag. The CD workflow runs on pushes to `main` and on tags matching `v*`: it re-runs lint, format, and test, then builds and pushes the Docker image to `ghcr.io/twextjs/twexthub-api`. A `v*` tag produces `{{version}}` and `{{major}}.{{minor}}` image tags; a push to `main` produces `latest`.

To cut a release, bump the version in two places, then tag:

1. `version` in `package.json` — what `npm` reports for the checkout.
2. `version` in `product.yml` — the version `/v2/meta` reports and the server prints on boot.

```bash
git tag v2.0.0
git push origin v2.0.0
```

Leaving one behind the other gives an instance that reports a version it isn't — a test fails if they disagree, so CI catches it before the tag exists.

## 📖 Working on the Docs

The documentation is the `docs/` directory, and `docs/index.md` is the index that links to all of it. Pages link to each other with relative paths, so a moved page means fixing its inbound links.

Every page's table of contents is generated:

```bash
npm run doctoc
```

It rewrites the block between the `START doctoc` and `END doctoc` comments. Don't hand-edit those entries; run the command and commit what it produces. The headings in these files carry emoji, and new pages should follow the same convention.
