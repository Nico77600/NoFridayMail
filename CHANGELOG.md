# Changelog

## Unreleased

## 1.1.0 - 2026-10-30

First release.

- Blocks sending on configurable days (Friday by default) for emails and meeting invitations, with Outlook Smart Alerts (`OnMessageSend`, `OnAppointmentSend`), and offers a **Schedule send** task pane to pick another day and time. Works in classic Outlook for Windows, new Outlook, Outlook on the web and Outlook for Mac, with graceful degradation across Mailbox 1.12 to 1.15.
- French and English user interface (language read from Outlook), light and dark themes, Fluent 2 design checked for AA contrast. The manifest Description and button tooltip name the blocked days of the environment, so a deployment for another day (for example "NoTuesdayEmail") never says Friday.
- Environments: one JSON file per installation (display name, add-in Id, Azure names, blocked days, offered days and times, fallback language), validated by a schema and consistency checks, with the rules injected into the bundle at build time.
- Environment generator `tools/New-NoFridayMailEnvironment.ps1`: creates an environment file with its own add-in Id, generated once and kept for good (same Id = Outlook updates the add-in, unique across environments). The deploy script refuses a template or duplicated Id and never generates one itself.
- Deploy script `tools/Deploy-NoFridayMail.ps1` (PowerShell 7.4, `-WhatIf`): prerequisite checklist, Azure resource group and Static Web Apps creation, build, deployment with a pinned SWA CLI, post-deployment checks and manifest publication guidance. The deployment token is never written to disk or logs.
- Optional justified exceptional send (off by default): the task pane carries a justification in the `X-NoFriday-Bypass` header, checked by the `OnMessageSend` handler and by a server-side Exchange transport rule (guidance and rule patterns in the Guide, Purview DLP guidance included).
- Optional Entra MFA step for the exceptional send: identity verified with Nested App Authentication and an authentication context, and a signed receipt issued by a managed API (Azure Functions in the Static Web App); offline receipt verification tool `tools/verify-receipt.js`; log traces in Application Insights.
- Release packaging: the download carries only what is needed to deploy and use the add-in; the release ZIP adds `PackageIntegrity.psd1` (SHA-256 of every file and the expected signer), verified by `tools/Test-PackageIntegrity.ps1` before a deployment.
- Documentation: user guide (step by step) and technical guide (reference), in Markdown and generated HTML, README and security policy; GitHub Actions workflows for validation, CodeQL analysis and release attestation, with pinned actions.
