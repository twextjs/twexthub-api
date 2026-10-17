# 🗄️ Legacy SQL Migrations

These are the numbered SQL migrations the server used to apply itself, kept for
reference only.

## 📕 Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [📦 What Replaced Them](#-what-replaced-them)
- [⬆️ Upgrading An Existing Instance](#-upgrading-an-existing-instance)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## 📦 What Replaced Them

Nothing reads these files any more. Prisma Migrate owns the schema, and
`prisma/migrations/0_baseline` is the whole of what they built, produced by
introspecting a database at their final state. The last of these,
`0029_version_download_metrics.sql`, also exists as the Prisma migration
`prisma/migrations/1_version_download_metrics`, so a database adopted from an
earlier history still gets it.

## ⬆️ Upgrading An Existing Instance

A deployment that already ran every SQL migration through
`0028_version_warnings.sql` is adopted rather than rebuilt: `runMigrations` in
`src/db.js` marks the baseline applied once it sees that set in
`schema_migrations`, lets Prisma Migrate apply anything newer, and refuses to
start on a partial one. See the
[deploy guide](../docs/deploy.md#-upgrading-from-the-sql-migration-releases).
