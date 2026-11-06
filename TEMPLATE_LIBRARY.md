# Template Library — App Builder 1.8.32

## Catalog snapshot

The catalog snapshot is sourced from `cannoi/app-builder-pi-solohost` main at commit
`3283e1b4f9e6848bf592c8e8c4aefb8809d52b41` and contains 146 distinct IDs:

| Type | Count | Behavior |
|---|---:|---|
| Editable source | 2 | One user starter; one internal sandbox fixture (not offered as a user starter) |
| Docker package | 117 | Metadata/upstream recommendation only |
| Reference | 27 | Research/reference only |

The catalog is metadata, not proof that each upstream project is installable on SoloHost.
No Docker image names, host ports, environment variables, storage paths, or startup commands
are inferred from repository URLs.

## UI

Open **Templates** in the Builder header. Users can:
- Search by application name, category, or tags.
- Filter by category and entry type.
- Describe an idea and receive deterministic ranked matches.
- Inspect license, type, source availability, and upstream project.
- Instantiate an editable source template or choose **Start from Scratch**.

## Safety and current limits

- Only entries with `kind=source`, a real local source directory, and no `internalOnly` flag can be instantiated.
- Source paths must remain inside `templates/`; source directory symlinks are rejected.
- `.git`, `node_modules`, build caches, `.env*`, private keys, and manifest files are not copied.
- Text placeholders `{{APP_NAME}}`, `{{APP_SLUG}}`, `{{APP_SUMMARY}}`, and `{{APP_IDEA}}` are substituted.
- The internal `sandbox-benchmark` source is shown as an internal fixture and cannot be selected as a user app starter.
- The original built-in template remains unchanged; a provenance record is written into the new project.
- After a user selects a source starter, Builder queues the existing `improve` job with the user's requested idea; the normal Improve verification and rollback workflow remains in control.
- Package and reference entries show their upstream links, but one-click deployment/acquisition is not enabled in this release. It must wait for verified upstream image metadata and a valid SoloHost `docker-compose.yml` + `config_options.yml` contract.

## Verification

Focused tests: `node --test tests/templates-library.test.js` (6/6 passed).
Syntax: `node --check src/templates/library.js`, `src/api/routes.js`, and `public/templates.js` passed.
A full `npm test`, Docker build, browser test, and SoloHost installation were not run here.
