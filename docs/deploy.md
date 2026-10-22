# 🪽 Quick Deploying Guide

> **Important:** You should know at least a little bit of Docker, databases, and Node.js before you deploy an instance of the TwextHub API.

## 📕 Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [⚠️ Prerequisites](#-prerequisites)
- [⬆️ Upgrading from the SQL-migration releases](#-upgrading-from-the-sql-migration-releases)
- [➕ Deploy with Docker Compose](#-deploy-with-docker-compose)
- [⚙️ Configuration](#-configuration)
- [ℹ️ The Build Sandbox](#-the-build-sandbox)
- [📊 Data Persistence](#-data-persistence)
- [⏭️ What's Next](#-whats-next)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## ⚠️ Prerequisites

To deploy an instance of the TwextHub API, you will need:

1. Node.js v24 or newer.
2. A reachable PostgreSQL database (v16 recommended).
3. The PostgreSQL database URL set

   > You can either:
   >
   > 1. Set it in your environment variables: `TWEXTHUB_DATABASE_URL`.
   > 2. Or, set it in `config.yaml`: `database.url`.

4. A database role that may create tables, indexes, functions, and triggers. The schema is applied by the instance itself on first boot.
5. The `pg_trgm` extension available to that role. The baseline migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` before the trigram index that uses it, and on a managed PostgreSQL that extension is often restricted to a superuser or a role with `CREATE` on the database. Enable it once as an operator (`CREATE EXTENSION pg_trgm`) if booting with the extension already installed is easier than granting the privilege.

The first user account to sign up is automatically promoted to an administrator. Don't expose the API to the public Internet without creating your first user account. Do so with either [the Twext CLI](https://github.com/twextjs/twext) or an instance of the TwextHub UI.

## ⬆️ Upgrading from the SQL-migration releases

Releases before 2.2 applied their own numbered SQL files and recorded them in `schema_migrations`. The instance now runs Prisma Migrate instead, and adopts such a database rather than rebuilding it.

The rules, all enforced at boot inside one transaction that holds an advisory lock:

- If the database has no migration history at all, the baseline is applied: a fresh install needs nothing from you.
- If `schema_migrations` holds every migration the SQL releases shipped (`0001_init.sql` through `0028_version_warnings.sql`), the baseline is recorded as already applied and the schema is brought up to date by Prisma Migrate — including the per-version download rollup (`0029_version_download_metrics.sql`) that followed those releases. Your existing rows, sequences, and data directory are untouched.
- If it holds some but not all of them, the instance refuses to start and says so. A partial history cannot be adopted: marking the baseline applied would skip whatever the missing files built, and running it would fail against tables that already exist. Finish the upgrade with the release that owns those files first.
- If `_prisma_migrations` exists and `schema_migrations` does not, the database is already on Prisma Migrate and pending migrations are applied.

This is a one-way door. Taking a backup first is not optional — the baseline is a single migration, so there is no partial set of steps to roll back to.

Recovery, if a deployment is interrupted mid-adoption and leaves the baseline recorded without the rest of the history in place:

```bash
DATABASE_URL="$TWEXTHUB_DATABASE_URL" npx prisma migrate resolve --rolled-back 0_baseline --config prisma.config.mjs
```

The `DATABASE_URL` prefix matters: `prisma.config.mjs` reads that variable and falls back to a local default when it is unset, so naming it here keeps the command pointed at the database you configured through `TWEXTHUB_DATABASE_URL` rather than one on the host.

That removes the baseline's row so the next boot records it again. `--applied` does the opposite, marking it applied without running it, which is what the bridge does for a complete legacy history and should not be needed by hand.

## ➕ Deploy with Docker Compose

You can run a prebuilt image of the TwextHub API at `ghcr.io/twextjs/twexthub-api`. Although, that image only supports environment variables, **not** `config.yaml`.

1. Copy the compose file to a directory of your choice:

   ```bash
   cp compose.example.yml <YOUR_DIRECTORY>/compose.yaml
   ```

2. Set `TWEXTHUB_DATABASE_URL` and `TWEXTHUB_PUBLIC_BASE_URL` in it. The image is configured through `TWEXTHUB_*` variables, and the compose file already carries both keys with values to replace.
3. Deploy:

   ```bash
   docker compose up -d
   ```

The container applies the schema and any pending migrations on boot, before it starts serving, so a first deploy needs no manual migrate step. On a database that a previous SQL-migration release built, read the upgrade section above first.

To configure the instance from a file instead, mount one and pass its path as the first argument: `node src/server.js /app/config.yaml` with `/app/config.yaml` bind-mounted from the host. The keys are the ones in the [configuration reference](./configure.md).

## ⚙️ Configuration

The [configuration reference](./configure.md) has every key you can set in the TwextHub API. These keys matter the most in a production deployment:

- `TWEXTHUB_PUBLIC_BASE_URL`: the public URL of the instance.
- `TWEXTHUB_TRUST_PROXY`: set when the API is running behind a reverse proxy. [See Express' trust proxy values](https://expressjs.com/en/guide/behind-proxies/).
- `TWEXTHUB_REQUIRE_HTTPS`: reject HTTP requests.
- `TWEXTHUB_API_ROOT`: the URL prefix all routes are served under (default is the `defaults.apiRoot` in `product.yml`, currently `/v2`).

## ℹ️ The Build Sandbox

Since [Twext](https://github.com/twextjs/twext) sends an archive of your repository when you publish to the TwextHub API, your deployed instance must compile the code itself, so that code owners can check out their code later (and for future features).

When it does, it runs its own instance of Twext to compile the code. But, it does so in a sandboxed environment. That sandbox is:

- **Filesystem:** The sandbox restricts Twext to only allow it to read and write files to its own temporary directory.
- **Memory:** By default, Twext is capped at 192 MB of memory. If memory can't be allocated, the build step will fail.
- **Timeout:** If Twext more than 30 seconds (by default) to compile the extension, it is terminated.
- **No Secrets:** Twext only shares a few environment variables with the host, but all others are not sent.

But, one important thing worth noting is that the environment can't sandbox the network. You are in charge of your own network isolation.

You can substitute the default Twext build tool with your own (called by `node <command> build -o <out>`), with the `TWEXTHUB_COMPILER` environment variable.

## 📊 Data Persistence

Published extension source code is saved to disk, not a database. So, you must mount a persistent Docker volume at `/app/data` (or whatever data directory you have set) to keep the saved data. If you are running your deployed instance on multiple servers, you must find a way to share that persistent storage.

## ⏭️ What's Next

- [Configuration Reference](./configure.md): see every key you can set in the TwextHub API.
