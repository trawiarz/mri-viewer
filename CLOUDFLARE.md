# Cloudflare copy (branch `claude/mri-viewer-cloudflare-j59a0v`)

This branch holds a second copy of the viewer for Cloudflare Pages. `main` and the GitHub Pages site are unchanged.

- `public/index.html` – the viewer, reading `?s=scan1`, `files/scan1/files.json` and `files/scan1/<path>` (no Google API key).
- `functions/files/[[path]].js` – serves objects from the R2 bucket `mri-viewer` (binding `BUCKET`) at `/files/...`, same origin.
- `functions/api/import.js` + `public/import.html` – one-time copy of the Drive folder into R2 on the first visit
  (file list in the D1 database `mri-viewer`, table `files`). Locks itself once `scan1/files.json` exists.
- `wrangler.toml` – Pages config: output dir `public`, R2 + D1 bindings.

Cloudflare Pages project `mri-viewer`: production branch `claude/mri-viewer-cloudflare-j59a0v`, no build command, output `public`.
Link: https://mri-viewer-7qo.pages.dev/?s=scan1
