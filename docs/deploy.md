# 🪽 Quick Deploying Guide

> **Important:** You should know at least a little bit of Docker, databases, and Node.js before you deploy an instance of the TwextHub API.

## 📕 Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [⚠️ Prerequisites](#-prerequisites)
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

The first user account to sign up is automatically promoted to an administrator. Don't expose the API to the public Internet without creating your first user account. Do so with either [the Twext CLI](https://github.com/twextjs/twext) or an instance of the TwextHub UI.

## ➕ Deploy with Docker Compose

You can run a prebuilt image of the TwextHub API at `ghcr.io/twextjs/twexthub-api`. Although, that image only supports environment variables, **not** `config.yaml`.

1. Copy the required files to a directory of your choice:

   ```bash
   cp compose.example.yml <YOUR_DIRECTORY>/compose.yaml
   cp config.yaml <YOUR_DIRECTORY>/config.yaml
   ```

2. Modify `config.yaml` to your deployment's needs.
3. Deploy:

   ```bash
   docker compose up -d
   ```

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
