# Flect catalog

The apps you can install on [Flect](https://flect.cloud) in one step. Each one
is a **template**: a `flect.toml` with a `[catalog]` table, no scope and no
resource ids (Flect RFC-0021). Installing
one creates the resources it needs, asks for its settings, generates its
secrets and deploys it; afterwards it is an ordinary Flect app.

The platform reads this repository: every few hours Flect reindexes `main`,
checks every template and publishes the ones that pass to the dashboard's
catalog and to `flect install`.

## Add an app

Open a pull request with **one** of:

1. **A template here**, for an app whose own repo has no Flect file:
   `apps/<id>/flect.toml` (and, if you like, `apps/<id>/README.md`), plus an
   entry in `flect-catalog.toml`:

   ```toml
   [[apps]]
   id     = "my-app"
   source = "./apps/my-app"
   ```

2. **A pointer to your own repo**, where `flect.toml` lives next to your code,
   pinned to a tag or a commit (never a branch):

   ```toml
   [[apps]]
   id     = "notes-api"
   source = "github:acme/notes-api@v2.3.0"          # or …@v2.3.0#deploy/flect for a sub-directory
   ```

## What a template looks like

```toml
[app]
name = "papyra"

[catalog]
title    = "Papyra"
tagline  = "Self-hosted notes, in Markdown files you own."
category = "app"                      # starter | app | data | worker
license  = "GPL-3.0"
source   = "https://github.com/lyfie-org/papyra"

[inputs.TZ]                           # asked at install
description = "Time zone for dates in notes"
default     = "UTC"

[services.web]
image    = "lyfie/papyra:v1.1.1"      # pinned: latest, main, dev are refused
port     = 8080
public   = true
health   = "/health"

[services.web.vars]
TZ = "{inputs.TZ}"                    # also {app.url} and {app.name}
```

Resources are declared by binding, without an id (`[[databases]] binding =
"DB"`), and created at install. A secret the app needs is declared once
(`[secrets.KEY] generate = "hex:32"`, or without `generate` to ask for it) and
listed by the service that gets it. See `apps/` for complete examples: nginx,
papyra, n8n.

## The rules CI checks

- `[catalog]` has `title`, `tagline` and `category`.
- No `scope`, no `domain`, no resource `id`: the installer chooses those.
- Every image is pinned to a version or a digest.
- Placeholders are only `{inputs.X}`, `{app.url}` and `{app.name}`, and every
  input they name exists.
- The schema is closed: no host paths, no fixed ports, no field Flect does not
  define. A template can do nothing an app's own `flect.toml` cannot.
- `volumes` (`"/data"` or `{ path, size, owner }`, RFC-0022) are kept on the
  node the app runs on and not backed up yet; the check warns.

The rules live in [`checker/`](checker/); a pull request is checked with
`main`'s copy of them. Run the same check locally:

```bash
cd checker && npm ci && npm run check -- .. --fetch
```
