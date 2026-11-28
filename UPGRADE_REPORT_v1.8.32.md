# Upgrade Report — App Builder v1.8.32

## Base and upstream reference

- User-provided ZIP: `app-builder-pi-solohost-main (1).zip`, package version 1.8.24.
- Upstream repository inspected: `cannoi/app-builder-pi-solohost`, branch `main`.
- Upstream commit used for the catalog snapshot: `3283e1b4f9e6848bf592c8e8c4aefb8809d52b41`.
- Upstream package version observed: 1.8.31.
- Output package version: 1.8.32.

The uploaded source was retained as the application base. This upgrade ports the Template Library capability and its catalog snapshot; it is not represented as a complete byte-for-byte synchronization of every upstream file from 1.8.31.

## Implemented

1. Added the 146-entry catalog snapshot with 146 unique IDs:
   - 2 source records (one internal-only sandbox fixture)
   - 117 Docker package metadata records
   - 27 reference records
2. Added Template Library UI:
   - Header entry point and modal
   - Search and 15 category filters
   - Source/package/reference separation
   - License, upstream, source availability, and instantiability details
   - Natural-language matching with deterministic score, matched terms, alternatives, and real catalog IDs
   - Start from Scratch path
   - English/Vietnamese UI labels
3. Added API endpoints:
   - `GET /api/templates`
   - `GET /api/templates/categories`
   - `GET /api/templates/catalog-health`
   - `GET /api/templates/:id`
   - `POST /api/templates/match`
   - `POST /api/templates/:id/instantiate`
   - `POST /api/templates/create-from-match`
4. Added safe local source instantiation:
   - Only source records with local folders can be instantiated.
   - Source path containment and symlink checks.
   - Excludes `.git`, dependency/build caches, real `.env`, private keys, and template manifest files.
   - Keeps `.env.example`, `.env.sample`, and `.env.template`.
   - Substitutes standard `APP_*` placeholders.
   - Writes `.builder-template.json` provenance.
   - Never edits the original built-in template.
5. Source selection queues the existing `improve` job with the user's idea. The existing Improve/verification workflow remains responsible for AI changes.
6. Package/reference records are intentionally not deployable in this release. The Builder does not invent image names, ports, env vars, volumes, or startup commands.
7. Added focused tests and documentation.

## Files changed/added

- `package.json`, `package-lock.json`
- `CHANGELOG.md`, `README.md`
- `TEMPLATE_LIBRARY.md`
- `src/templates/library.js`
- `src/api/routes.js`
- `templates/catalog/catalog.json`
- `public/index.html`
- `public/styles.css`
- `public/templates.js`
- `tests/templates-library.test.js`

## Validation

- `node --check` on all JavaScript files under `src`, `public`, and `tests`: PASS.
- HTML parser check for `public/index.html`: PASS.
- `node --test tests/ui.test.js tests/templates-library.test.js`: 26/26 PASS.
- Catalog integrity: 146 entries, 146 unique IDs, type counts 2/117/27: PASS.
- ZIP archive integrity: to be checked after packaging.

## Not verified

- Full `npm test`: not run because dependencies are not installed and offline npm cache did not contain `yaml`; `npm ci --offline` could not complete.
- Browser/Playwright interaction: not run.
- Docker build, container runtime, and SoloHost install: not run.
- One-click Docker package deployment and upstream acquisition: not implemented in this release; package/reference entries remain metadata/recommendations only.

## Compatibility intent

Existing chat, Preview, Publish, AI Provider Hub, Feedback Hub, ZIP import/export, and Upgrade Workshop code paths were not intentionally rewritten.
