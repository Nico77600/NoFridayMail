# Changelog — NoFridayMail

All notable changes are listed here. Versions follow MAJOR.MINOR.PATCH (see the developer guide, Annex C).
Author: Nicolas Fabert.

## [1.1.1] — 2026-10-30

README and documentation visuals aligned with the house style of the other repositories. No change to the add-in, to the scripts or to the deployment: the signed PowerShell files are unchanged.

### Changed
- README rewritten as a guided path for beginners: banner, navigation, "Why", "Get started" (set up once 1 to 4, then A for one person or B for everyone, with commented commands and screenshots), "How it works", "Exceptional send", then the standard sections.
- The technical guide is now called the **developer guide** (title, subtitle, links); the file names are unchanged.
- The guided path (user guide, chapter 1, and developer guide, quick start) and the steps of chapters 4 and 5 follow the same seven steps: install the tools, create your environment, simulate, deploy the site; then A (get the manifest, sideload in Outlook, send a test mail) or B (Integrated apps, pilot group then everyone, updates).
- CHANGELOG in the format of the other repositories.
- Version 1.1.1 (`package.json`, `api/package.json`, `deploy/environments/prod.json` 1.1.1.0, front matter of the guides). The tag `v1.1.0` exists and is never reused.

### Changed (repository layout)
- The product moved into a `package/` folder: exactly what an operator needs (sources, API, deploy files, manifest, documentation, icons, the deploy script and its tools, its own `README.md`, `LICENSE`, `THIRD-PARTY-NOTICES.md`). "Download ZIP", `git archive` and the release ZIP carry `package/` only (the ZIP root is its content). Tests, CI, developer tools, the public README, `CHANGELOG.md` and `SECURITY.md` stay at the repository root. The four signed PowerShell files are byte-identical at their new paths.
- `npm ci`, `npm run build` and the deploy script run in `package/`; `npm test`, `npm run docs`, `npm run images`, `npm run icons` and `npm run preview` run at the repository root (new development `package.json`).
- The package builder archives the `package/` subtree only; `.github/ci.json` declares `runtimeRoot: package`.

### Added
- `tools/New-DocumentationImages.js` (`npm run images`) renders the README images from the CSS and the icons of the HTML guides, in a light and a dark version at 2x (2160 px wide), with headless Microsoft Edge: banner, why, guided path, how it works, and product screenshots (task pane, exceptional send section, Smart Alerts dialog, console of `Deploy-NoFridayMail.ps1 -WhatIf` on a sample environment).
- `tests/readme.test.js`: every image of the README exists in a light and a dark version, the `<picture>` blocks are consistent, the images have alternative texts and the picture files have the expected size.

### Removed
- The hand-made SVG banner and flow diagram (`assets/doc`) and their PNG files; the application icons (`assets/icon*.svg`) stay.

## [1.1.0] — 2026-10-30

First release.

### Added
- Blocks sending on configurable days (Friday by default) for emails and meeting invitations, with Outlook Smart Alerts (`OnMessageSend`, `OnAppointmentSend`), and offers a **Schedule send** task pane to pick another day and time. Works in classic Outlook for Windows, new Outlook, Outlook on the web and Outlook for Mac, with graceful degradation across Mailbox 1.12 to 1.15.
- French and English user interface (language read from Outlook), light and dark themes, Fluent 2 design checked for AA contrast. The manifest Description and button tooltip name the blocked days of the environment, so a deployment for another day (for example "NoTuesdayEmail") never says Friday.
- Environments: one JSON file per installation (display name, add-in Id, Azure names, blocked days, offered days and times, fallback language), validated by a schema and consistency checks, with the rules injected into the bundle at build time.
- Environment generator `tools/New-NoFridayMailEnvironment.ps1`: creates an environment file with its own add-in Id, generated once and kept for good (same Id = Outlook updates the add-in, unique across environments). The deploy script refuses a template or duplicated Id and never generates one itself.
- Deploy script `tools/Deploy-NoFridayMail.ps1` (PowerShell 7.4, `-WhatIf`): prerequisite checklist, Azure resource group and Static Web Apps creation, build, deployment with a pinned SWA CLI, post-deployment checks and manifest publication guidance. The deployment token is never written to disk or logs.
- Optional justified exceptional send (off by default): the task pane carries a justification in the `X-NoFriday-Bypass` header, checked by the `OnMessageSend` handler and by a server-side Exchange transport rule (guidance and rule patterns in the Guide, Purview DLP guidance included).
- Optional Entra MFA step for the exceptional send: identity verified with Nested App Authentication and an authentication context, and a signed receipt issued by a managed API (Azure Functions in the Static Web App); offline receipt verification tool `tools/verify-receipt.js`; log traces in Application Insights.
- Release packaging: the download carries only what is needed to deploy and use the add-in; the release ZIP adds `PackageIntegrity.psd1` (SHA-256 of every file and the expected signer), verified by `tools/Test-PackageIntegrity.ps1` before a deployment.
- Documentation: user guide (step by step) and technical guide (reference), in Markdown and generated HTML, README and security policy; GitHub Actions workflows for validation, CodeQL analysis and release attestation, with pinned actions.
