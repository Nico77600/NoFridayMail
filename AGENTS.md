# Development and publication

## Layout

- `package/` is the product: exactly what an operator needs to deploy and use the add-in (its own `README.md`, `LICENSE`, `THIRD-PARTY-NOTICES.md`, `docs/`, `src/`, `api/`, `deploy/`, `assets/` PNG icons, `manifest.xml`, `webpack.config.js`, `package.json`, `staticwebapp.config.json` and the operator tools in `package/tools/`). Downloads ("Download ZIP", `git archive`) carry `package/` only; the release ZIP root is the content of `package/` plus the root `CHANGELOG.md`.
- The repository root holds what only contributors need: `tests/`, `.github/`, the developer tools in `tools/` (package builder, documentation and image builders, preview, icons, tests runner), the SVG icon sources in `assets/`, the public `README.md`, `CHANGELOG.md`, `SECURITY.md`, `AGENTS.md`, `PROVENANCE.md`, and a development `package.json`.
- Paths in the rest of this file are relative to `package/` (`src/`, `api/`, `deploy/`, `docs/`, `manifest.xml`, `tools/env-config.js`, `tools/Deploy-NoFridayMail.ps1`...), except `tests/`, `.github/`, the developer tools named above and the root documents.
- The four signed PowerShell files (`package/tools/Deploy-NoFridayMail.ps1`, `New-NoFridayMailEnvironment.ps1`, `lib/Deploy-Checks.ps1`, `Test-PackageIntegrity.ps1`) are Authenticode-signed by the owner: never edit them without the owner. Their relative paths (the parent of the script folder, `deploy/`, `package.json`) rely on the layout inside `package/` mirroring a deployed folder.

## Development

- Preserve existing test, packaging, installation, and local deployment procedures.
- Install with `npm ci` in `package/` and `npm ci` at the root. Run `npm test` at the root (the tests use the dependencies installed in `package/`), then in `package/` `npm run build`, `npm run validate` and `npm run validate:env`, before promoting a change; keep them passing. The Pester tests (`tests/*.Tests.ps1`) run from the root with Pester 5 or later.
- Keep private configuration, tokens, tenant data, credentials, customer data and backup files out of commits and release packages (`.gitignore` covers `.env`, certificates and `package/deploy/environments.local/`). `tests/public-safety.test.js` fails when a private identifier (tenant, subscription or application IDs, real `*.azurestaticapps.net` hosts, laboratory user or resource names) or an unknown GUID appears in a tracked or new file; add a placeholder to its allow-list only when it is a published value.
- Lockfiles resolve from the public registry: every `resolved` URL in the tracked `package-lock.json` files (root, `package/`, `package/api/`) starts with `https://registry.npmjs.org/`, and no tracked file names a corporate feed or proxy host (`tests/lockfiles.test.js`, hashed patterns like `tests/public-safety.test.js`). If a corporate npm proxy is configured locally, `npm install` writes its host into the lockfile: before committing, normalise it from the repository root with the script below (it rewrites the `resolved` prefix `https://<host>/.../npm/registry/` to `https://registry.npmjs.org/`; integrity hashes are untouched), then check that `git diff` shows only `resolved` lines.

```js
// node normalize-lockfiles.js  (run from the repository root; any shell)
const fs = require('fs');
const foreign = /"resolved": "https:\/\/(?!registry\.npmjs\.org\/)[^"]*?\/npm\/registry\//g;
for (const f of ['package-lock.json', 'package/package-lock.json', 'package/api/package-lock.json']) {
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(foreign, '"resolved": "https://registry.npmjs.org/'));
}
```

- Commits carry only the repository owner's identity. Do not add co-author trailers for assistants or tools (`Co-Authored-By`, or any co-author or assistant attribution line in commit messages or pull requests).
- Preview public changes and obtain the repository owner's approval before publishing.

## Code conventions

- `src/shared/rules.js` holds pure date logic with no Office dependency, and `src/shared/config.js` holds blocked days, send hour and all localized strings. Add a unit test in `tests/` for every rule change. Operator-facing text, code comments and test titles are English (`tests/english-source.test.js` enforces it); French lives only in the UI strings of `languages.fr`.
- Code reachable from `src/launchevent/` is bundled into one classic `launchevent.js` for the JavaScript-only runtime of classic Outlook on Windows: ES5 only, no `import` at runtime, no DOM, no `localStorage`, no `Intl`. `npm run build` runs `tools/check-bundle.js` to enforce this.
- Read the global `Office` at call time, never at import time, so handlers stay testable under Node.
- Feature-detect Mailbox 1.13 (`delayDeliveryTime`), 1.14 (`cancelLabel`, `commandId`) and 1.15 (`errorMessageMarkdown`) with `Office.context.requirements.isSetSupported`; the manifest minimum stays 1.12.
- Environments live in `deploy/environments/<name>.json` (tracked: `example.json`, `prod.json`) and in `deploy/environments.local/<name>.json` (operator files, git-ignored, never published, looked up first). Schema: `deploy/environment.schema.json`; checks in `tools/env-config.js`. `addinId` is the identity of the add-in: a GUID that is unique per environment (never reuse it) and stable for the whole life of the environment (the same Id means Outlook updates the add-in, a new Id installs a second one). It is generated once by `tools/New-NoFridayMailEnvironment.ps1` (`[guid]::NewGuid()`), never at deployment time, and never changed after users installed the add-in; the deploy script refuses a template or duplicated Id. An environment with `"protected": true` (or named `lab`) is never redeployed without the owner's agreement (`-ConfirmLab`). Rules are injected into the bundle by webpack `DefinePlugin` as `__NFM_RULES__`; `BLOCKED_DAYS` / `WORKING_DAYS` remain optional overrides. Deploy with `tools/Deploy-NoFridayMail.ps1` (supports `-WhatIf`); the deployment token is read at run time and never written to disk or logs.
- Optional `bypass` object in an environment file (justified exceptional send, off when absent) is injected into `__NFM_RULES__` only when present. The justification header contract and the quality check (`validateJustification`) live in `src/shared/bypass.js` and are shared by the task pane and the `OnMessageSend` handler; authorization is server-side (see the Guide). Never let `OnAppointmentSend` bypass. `bypass.mfa` (Entra identity step, receipt from the managed API in `api/`) is task-pane only: `@azure/msal-browser` is imported only through `src/taskpane/naa.js` and must never reach `launchevent.js` (`check-bundle` enforces it); `api/shared/` and `api/config.json` are generated by `tools/prepare-api.js` (git-ignored), and the receipt key `NFM_RECEIPT_KEY` is an app setting, never a file, a log line or console output (the deploy script never prints it). Placeholder GUIDs (`00000000-...`) in `mfa` build but are refused by `env-config --deploy`.
- Tests never assert values of operator-owned environment files: use `tests/fixtures/environments` (`base`, `bypass-v1`, `lab-frozen`, `mfa-filled`, `mfa-placeholder`) through `NFM_ENVIRONMENTS_DIR`, honoured by `tools/env-config.js`, the build and `Deploy-NoFridayMail.ps1`. Only `example.json` (template) is read as-is from `deploy/environments`.
- Blocked days (`blockedDays`) forbid sending; working days (`workingDays`) only control which days are PROPOSED. Weekends are never blocked, never proposed. A day is proposed when it is a working day and not blocked. Both are overridable at build time (`BLOCKED_DAYS`, `WORKING_DAYS`, strict validation in `tools/blocked-days.js`).
- Task pane UI is hand-written Fluent 2 CSS in `src/taskpane/taskpane.html` (no UI library). Palette tokens live in that CSS for light and dark; `tests/theme.test.js` enforces AA contrast on them. Color math for `Office.context.officeTheme` is in `src/taskpane/theme.js`. Use `npm run preview` (root) to review the pane without Outlook; never reference the root `tools/preview` from the manifest or the production build. Icons are generated from the root `assets/*.svg` into `package/assets/` with `npm run icons` (root). The README images (`package/docs/images/readme-*.png`, light and dark, 2x) are rendered with headless Edge by the root `tools/New-DocumentationImages.js` (`npm run images`, root) from the CSS of `tools/Build-Documentation.js`, the real task pane and `tools/doc-assets/deploy-whatif.ansi` (a sanitized transcript of `Deploy-NoFridayMail.ps1 -WhatIf`); `tests/readme.test.js` checks them.
- The task pane button id in `manifest.xml` must equal `taskPaneCommandId` in `config.js` (checked by `tests/handlers.test.js`).
- UI languages are French (default, product language) and English. All strings live in `src/shared/config.js` as `languages.fr` / `languages.en` with identical keys and `{placeholders}` (checked by `tests/i18n.test.js`); the language is read at call time from `Office.context.displayLanguage`. Smart Alerts limits apply in each language: message 500 characters, `cancelLabel` 20 characters. `manifest.xml` keeps `DefaultLocale` fr-FR with `en-US`/`en-GB` overrides. `manifest.xml` is the development manifest (`https://localhost:3000`); the production manifest is generated by `tools/build-manifest.js` from `ADDIN_BASE_URL`.
- Public documentation is English only (`README.md`, `package/README.md`, `package/docs/NoFridayMail-UserGuide.md`, `package/docs/NoFridayMail-Guide.md`, their generated HTML: `npm run docs` at the root). The root `README.md` (public), `package/README.md` (runtime) and `SECURITY.md` follow the owner's frozen documentation standard (ordered sections, light/dark banner, exact disclaimer, exact `SECURITY.md`): do not reword the disclaimer or `SECURITY.md`; add project-specific warnings after the disclaimer, separated by an empty line.

## Changes to main

1. Fetch public main and prepare a short-lived branch from the current public history.
2. Include only the intended changes; do not import private development history.
3. Push the branch, open a pull request targeting main, and review the diff and available checks.
4. Merge the pull request. The initial solo-maintainer baseline requires no second-person approval.
5. Refresh the public clone after merging without discarding unrelated local changes.

Direct pushes, force pushes, and deletion of public main are prohibited. Do not bypass or weaken repository rules. New required CI checks and Git commit-signing requirements must be established and approved before they become blocking.

## Releases

1. Use a new version and create its v-prefixed tag on the intended commit already merged into public main. Update `CHANGELOG.md`, `package.json` and the manifest `Version` together.
2. Never move, delete, or reuse an existing version tag.
3. Use the existing packaging procedure on the reviewed release source: `tools/New-NoFridayMailPackage.ps1` builds the release ZIP from `git archive` of the `package/` folder of the tagged commit (the same files as "Download ZIP", without the `package/` prefix) plus the root `CHANGELOG.md` (exact committed bytes, hashed like the rest; the only file of the release ZIP that "Download ZIP" does not carry) and `PackageIntegrity.psd1`. CI runs it in `-Unsigned` mode only. Authenticode signing, timestamping and signing the manifest are performed by the owner, outside CI and outside this repository, with the owner's own procedure; the owner's certificate never reaches GitHub Actions.
4. Create a draft release and upload all intended assets before publication. Check the tag, commit, version, asset inventory, and hashes.
5. Publish the complete draft. Published assets are immutable; a correction requires a new version.
6. If configured, confirm the attestation workflow succeeds for the distributed files. A source-only fallback does not attest a missing release ZIP.

## What is downloaded

`.gitattributes` marks with `export-ignore` every entry of the repository root except `package/` (tests, CI, development tools, SVG sources, public README, `CHANGELOG.md`, `SECURITY.md`, `AGENTS.md`, `PROVENANCE.md`...). "Download ZIP" and source archives therefore carry the strict minimum, all of it inside `package/`; the release ZIP carries the same files plus the root `CHANGELOG.md`, which the package builder reads from the tagged commit (`/CHANGELOG.md -text`: exact bytes, as it is hashed in `PackageIntegrity.psd1`); `tests/` and `.github/` live only in the repository. A new root entry needs its `export-ignore` line (`tests/package-export.test.js` checks it). Keep the `export-ignore` rules and the files that `package/tools/Deploy-NoFridayMail.ps1` needs end to end in step when adding files. Attributes of files that will be signed (`-text`, only `package/tools/*.ps1` and the documents hashed by the integrity manifest) and export rules are on separate lines for separate paths; check a new rule with `git archive`.

## Security and recovery

Keep secret scanning and push protection enabled. Do not routinely bypass alerts. Dependency scanning is not a replacement for the project's tests and analysis. Follow SECURITY.md for sensitive reports. Maintain versioned backups of public Git history, release assets, and settings outside the repository; keep an additional copy off the development machine.

For a new public repository, configure these branch/tag protections and future-release immutability before the first release. Enable dependency graph, Dependabot alerts, secret scanning, push protection, and private vulnerability reporting. Personal-account repositories do not automatically inherit these settings. Automatic merges and automated dependency-update pull requests are not part of this baseline.

## CI and provenance

GitHub Actions runs the existing tests and package builder on a disposable Windows runner with Node.js 22 and PowerShell 7. It does not connect to Azure, Exchange or Microsoft 365, uses no secret and no signing certificate. CI helpers live under `.github/scripts` and are not part of the release package.

PowerShell syntax and analyzer execution must succeed. PSScriptAnalyzer diagnostics and CodeQL findings are initially advisory, not automatically fixed. CodeQL analyzes JavaScript/TypeScript and workflows; it does not analyze PowerShell. An unsuccessful scan is not evidence of security or complete coverage.

Required validation checks are enabled only after successful GitHub runs. Do not bypass them or weaken existing tests to publish. If a check fails, inspect its evidence and address the cause.

The release attestation workflow does not build or execute repository code. It attests the actual published ZIP bytes; it does not prove their original build. Manual attestation must run from the default branch with an explicit existing release tag. Missing releases or ZIPs fail explicitly; no source archive is substituted.

Actions are pinned to full commit IDs. Updates require review of the action source and an explicit pin change. Repository policies may reject unpinned or unapproved actions; never relax them to merge a contribution.
