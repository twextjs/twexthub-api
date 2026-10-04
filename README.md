# 📦 TwextHub API

[![CI](https://github.com/twextjs/twexthub-api/actions/workflows/ci.yml/badge.svg)](https://github.com/twextjs/twexthub-api/actions/workflows/ci.yml) [![CD](https://github.com/twextjs/twexthub-api/actions/workflows/cd.yml/badge.svg)](https://github.com/twextjs/twexthub-api/actions/workflows/cd.yml)

> _Host extensions built with Twext online. API-only._

## 📕 Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [🌟 Highlights](#-highlights)
- [ℹ️ Overview](#-overview)
  - [✍️ Authors](#-authors)
- [🚀 Usage](#-usage)
- [⬇️ Installation](#-installation)
- [💭 Feedback and Contributing](#-feedback-and-contributing)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## 🌟 Highlights

- Publishing sends your Twext project's source; the server compiles it in a sandbox and serves the built extension, so what's reviewed is what runs.
- Accounts, organizations, SemVer versions with dist-tags, and a review queue for a namespace's first publish.
- Runs anywhere Docker does: one container plus PostgreSQL, with a volume for the stored sources and blobs.

## ℹ️ Overview

TwextHub is a registry of custom TurboWarp extensions built with [Twext](https://github.com/twextjs/twext). It tracks registry stats, user accounts, organizations, and extension source code. Powered by PostgreSQL and Node.js, it is easy to deploy on the majority of cloud platforms to bare metal (with Docker).

### ✍️ Authors

> **AI Disclosure:** AI was used in the development of the TwextHub API.

- **Main Developer:** [@kamixfox](https://github.com/kamixfox)

## 🚀 Usage

You can see the official live instance of TwextHub at [twexts.sdisk.us](https://twexts.sdisk.us). We can't reliably explain the API's usage without getting technical. So, if you're planning to deploy a TwextHub API instance, see the [documentation](./docs/index.md).

## ⬇️ Installation

While installation with Node.js exists, you should prefer Docker because it's safer. We will only provide steps for deployment with Docker Compose.

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

## 💭 Feedback and Contributing

Discussions are turned off here, just open an issue if you have a question, or if you find a bug/a new feature to add.

If you want to contribute to this project, feel free! See the [Development Guide.](./docs/development.md)
