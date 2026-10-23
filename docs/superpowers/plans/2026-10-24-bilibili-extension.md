# Bili 本地下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Deliver a locally loadable pure Chrome extension for Bilibili video/audio selection, download and browser-local processing.
**Architecture:** MV3 service worker owns trusted API access and Chrome downloads. An isolated content panel communicates through typed messages; offscreen hosts a serial job queue and packaged single-thread FFmpeg worker.
**Tech Stack:** JavaScript ESM, Node 24 built-in tests, esbuild, FFmpeg.wasm, Playwright Chromium.
**Spec:** ../specs/2026-10-24-bilibili-extension-design.md

## Global Constraints
- Pure Chrome extension; no helper process at use time. Chrome 116+.
- 512 MiB aggregate input processing budget, one active processing job, at most 5 pending jobs.
- No remote executable code, cookies exported, signed media URLs in persistent extension storage, DRM decryption or permission bypass.
- Project-local caches, test profiles, downloads and artifacts. Source directory is not a Git repository; work in the designated empty workspace without touching another repository.
- User explicitly authorized autonomous implementation and testing; no additional plan approval round.

## Shared Contracts
`src/core/bilibili.js` exports `parsePageUrl(url)`, `resolveMedia(url,{fetchImpl,signal}={}) -> Context`, `getCatalog(context,{quality,fetchImpl,signal}={}) -> Catalog`, `signWbi(params,imgKey,subKey,wts)`, `normalizePlayInfo(payload,context) -> Catalog`.
Context: `{kind:'ugc'|'pgc', bvid?,aid?,cid,epId?,seasonId?,title,partTitle,pageUrl,duration,parts:[{id,title,pageUrl}],selectedPartId}`.
Catalog: `{context,videos:Track[],audios:Track[],progressive:Track[],qualities:[{id,label}],warnings:string[]}`. Track: `{key,kind:'video'|'audio'|'progressive',quality,qualityLabel,codec,mime,bandwidth,width?,height?,fps?,audioRole?,urls:string[],size?,segments?:[{urls,size,duration}],duration?}`. Track key stable across URL refresh and includes codec/audio role.
`src/core/media.js`: `isMediaUrl(url)`, `sanitizeFilename(name)`, `planOutput(catalog,selection) -> Plan`, `ffmpegArgs(plan)`. Selection `{mode:'video'|'audio'|'raw',videoKey?,audioKey?,format:'mp4'|'mkv'|'m4a'|'mp3'|'wav'|'flac'|'original',rawTarget?:'video'|'audio'|'both'}`. Plan `{inputs:[{name,urls,size?}],outputName,outputMime,args,raw:boolean,notes:[]}`; no network side effects.
Runtime request `{target:'background',type,payload}`; response `{ok:true,data}` / `{ok:false,error}`. Types: `CATALOG {url,quality?}` -> Catalog; `ENQUEUE {url,selection}` -> job; `JOBS {}` -> Job[]; `CANCEL {id}`; `OPEN_PANEL {tabId?}`; `OPEN_TASKS {}`. Jobs `{id,title,status,progress,message,createdAt,downloadIds?,error?}`. No media URLs returned in jobs.
Offscreen messages use `target:'offscreen'`, types `RUN {id,plan,title}`, `CANCEL {id}`, `SNAPSHOT {}`, `RELEASE {id}`. Offscreen emits `PROGRESS {job}`, `SAVE {id,url,filename}`, `FAILED {id,error}` to background. It runs one task at a time; background owns pending queue and refreshes URLs immediately before dispatch.

## Review Focus
- SPA navigation while catalog loads: stale response must not replace current page and selected part must match.
- Service worker restart while media is processing/saving: reconcile offscreen snapshot and Chrome download records; never duplicate a job.
- Missing Content-Length or failed backup URL: enforce aggregate byte budget and release previous partial bytes before retry.
- Cancelling between conversion and Chrome save: release Blob only after download ends; no leaked worker or permanently blocked queue.
- Mixed codec/container or DRM/preview responses: explicit errors/notes; never silently pick another source quality.

## Task 1: Resource discovery (parallel API implementer)
Files: `src/core/bilibili.js`, `src/core/wbi.js`, `tests/bilibili.test.js`.
- [ ] Write tests for BV/av/P/ep/ss, WBI known vector, quality/codec preservation, Dolby/FLAC, PGC wrappers, durl, DRM/preview, API error.
- [ ] Run `node --test tests/bilibili.test.js`, expect missing implementation failure.
- [ ] Implement shared contracts; inject fetch only at API boundary, use credentials include and request timeout.
- [ ] Run same tests, expect all pass; report exact command and limitations.

## Task 2: Embedded panel (parallel UI implementer)
Files: `src/content.js`, `src/panel.js`, `src/panel.css`, `src/popup.js`, `static/popup.html`, `static/popup.css`, `static/tasks.html`, `src/tasks.js`.
- [ ] Use shared runtime contracts. Build Chinese UI in Shadow DOM with quality/video/audio/format controls, video/audio/raw tabs, job list, cancel, refresh and clear actionable errors.
- [ ] Preserve selection only when available, discard stale asynchronous catalog loads, re-resolve SPA navigation, never insert untrusted HTML.
- [ ] Provide task view independent of video page. Chrome popup opens embedded panel and tasks page.
- [ ] Root browser harness verifies UI behavior with controlled API and actual extension loading.

## Task 3: Download engine and build (root)
Files: package/manifest/build; `src/core/media.js`, `src/core/transfer.js`, `src/background.js`, `src/offscreen.js`, `tests/media.test.js`, `tests/transfer.test.js`.
- [ ] Write failing tests for filename, URL security, codec/container command plans, byte limits, failed CDN backup, abort and queue transitions.
- [ ] Implement offscreen raw fetch streamed into OPFS, Chrome save from local File/Blob, and FFmpeg processing plans with private inputs. Bundle FFmpeg ESM files and WASM locally.
- [ ] Implement background sender validation, API flow, bounded queue, persistent summaries, scoped Referer rules and restart reconciliation.
- [ ] Implement offscreen transfers, cancellation, FFmpeg lifecycle, Blob lifetime and completion acknowledgement.
- [ ] `npm test` and `npm run build` must pass; inspect manifest paths and bundle for missing or remote runtime dependencies.

## Task 4: Browser verification, review and delivery (root + independent reviewer)
Files: `tests/browser.mjs`, fixtures, `scripts/package.mjs`, `README.md`, `PRIVACY.md`, `THIRD_PARTY_NOTICES.md`, `docs/TEST_REPORT.md`.
- [ ] Load unpacked extension in project-local Chromium profile; verify manifest, UI, network request header scoping and user flow with deterministic media.
- [ ] Execute real FFmpeg.wasm mux and audio formats in extension context; verify output structure/decodability with synthetic inputs.
- [ ] Exercise cancellation, retry, raw OPFS download/save/cleanup, service worker/offscreen state recovery; report exact automated vs live-service boundaries.
- [ ] Run low-frequency anonymous live API smoke; never imply authenticated playback was tested.
- [ ] Independent full-source review, fix actionable defects with regression tests, then final full build/test and ZIP SHA-256 generation.
- [ ] Deliver `dist/`, `release/` ZIPs, instructions and clear validation report. No external publication.

## Implementation amendment: raw OPFS pipeline (2026-10-24)

Raw media uses offscreen fetch with the extension's scoped request headers, streams into OPFS, and saves a local File/Blob through Chrome downloads. It no longer submits CDN URLs directly to the native download manager. The 512 MiB aggregate input budget applies to FFmpeg processing only; raw media is constrained by disk space and browser storage quota. Preserve temporary files until saving completes; clean them on completion/failure/cancellation and clear abandoned files at the next processing start after an abnormal exit. This is not persistent resumable downloading. Root implementation and browser verification own the runtime changes and evidence; UI and privacy text must reflect temporary disk storage.
