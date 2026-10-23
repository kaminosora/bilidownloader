# Implementation ledger — 2026-10-24-bilibili-extension

Design approved by user. Plan: superpowers/plans/2026-10-24-bilibili-extension.md.

Ruling: Work in the designated project directory. It was empty and is not a Git repository; no unrelated checkout or Git metadata will be modified. Release source ZIP supplies a recoverable source snapshot.
Ruling: Parallel resource/UI implementation with root integration and an independent final review; user authorized autonomous execution.
Pre-flight: API, UI and engine share the exact Context/Catalog/Selection/runtime interfaces in the plan.

Task 1: complete. API/WBI, DASH and progressive resources, exact part selection, actual-format gating and failure handling implemented and tested.
Task 2: complete. Embedded Shadow DOM panel, popup and task page implemented; SPA and stale-response handling verified.
Task 3: complete. Local FFmpeg WASM, cancellable queue, OPFS original tracks, Chrome save tracking and worker recovery implemented and tested.
Task 4: complete. Local loadable dist, runtime/source ZIP archives and SHA256SUMS produced with checked allowlists and ZIP CRC verification. See TEST_REPORT.md for commands, measured results and untested boundaries.

Integration ruling: Chrome direct CDN downloads bypassed the request-header rule and returned 403 in the live test. Original tracks now stream through extension fetch into OPFS and save via local File Blob URLs. This preserves the approved pure-extension scope and removes the FFmpeg input budget from original-track downloads, while requiring temporary disk space. Design and privacy documentation reflect this change.

Independent code review findings were resolved. Browser recovery covers a worker exit between native download creation and ID persistence; mocked lifecycle tests cover stale ID queries and cancellation of sibling downloads on failure. No external publication or user browser configuration changes were made.

## 1.0.1 follow-up

The user requested a task-panel action to reveal saved files in the system file manager and explicitly authorized public GitHub publication as `kaminosora/bilidownloader`. The small UI action reuses the existing downloads permission and job IDs; it accepts no arbitrary path or unrelated download ID. Both task surfaces, missing/incomplete files and persistent errors are covered. 94 module tests and 18 browser checks passed. A local main branch now holds the source; runtime/source ZIPs and SHA-256 sums are the release artifacts. The earlier no-publication statement describes the initial 1.0.0 delivery only.
