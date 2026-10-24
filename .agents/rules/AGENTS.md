# AI Batch Studio — Agent Guidelines & Repository Rules

This document defines core architectural invariants, critical rules, and operating protocols for AI coding agents working on the **AI Batch Studio** codebase.

---

## 1. Project Overview & Tech Stack

**AI Batch Studio** is an open-source, client-side Manifest V3 Chrome extension for sequential batch prompt execution, reference asset management, and media downloading on **ChatGPT** and **Google Flow**.

- **Language / Runtime**: TypeScript 5.6 (Strict Mode enabled), Node.js 20+
- **Frontend UI**: React 18.3, Lucide React icons, Vanilla CSS custom properties design system
- **Build & Packaging**: Vite 5, custom postbuild & zip scripts (`scripts/postbuild.mjs`, `scripts/package-zip.mjs`)
- **Test Framework**: Vitest 2.1 with JSDOM and Fake-IndexedDB
- **Browser APIs**: Chrome Extension Manifest V3 (`storage`, `downloads`, `alarms`, `notifications`, `tabs`, `scripting`, `sidePanel`, `debugger`)

---

## 2. Non-Negotiable Architectural Invariants

### Invariant 1: Trusted Types & CSP Safety (No Unsafe innerHTML)
- **Constraint**: Google Flow (`flow.google.com`) and modern Google web properties enforce strict Content Security Policies with **Trusted Types** enabled.
- **Rule**: **NEVER** assign strings directly to `element.innerHTML` in content scripts, DOM interaction helpers, or platform adapters. Doing so causes an immediate runtime exception: `TypeError: Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment`.
- **Pattern**:
  ```typescript
  // CORRECT: Safe DOM Node removal and replacement
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  const p = doc.createElement('p');
  p.textContent = text;
  element.appendChild(p);

  // FORBIDDEN: Will throw TrustedHTML violation
  element.innerHTML = `<p>${text}</p>`;
  element.innerHTML = '';
  ```

### Invariant 2: Framework-Safe Rich-Text Composer Inputs
- **Constraint**: Generative web applications use complex reactive rich-text frameworks (Slate.js on ChatGPT, ProseMirror on Google Flow).
- **Rule**: Never blow away or destroy the root internal nodes of live rich-text editors. Wiping a Slate.js editor destroys React DOM-to-Node WeakMaps, leaving the Generate button permanently disabled.
- **Pattern**:
  - Always place a DOM `Selection` range inside the editor leaf node.
  - Dispatch cancelable `beforeinput` (`inputType: "insertText"`).
  - Execute `document.execCommand('insertText', false, text)`.
  - Dispatch reactive `input` and `selectionchange` events.
  - If synthetic DOM events fail in background tabs, escalate to trusted hardware keystrokes via `chrome.debugger` (`Input.insertText`).

### Invariant 3: Lossless Cross-Origin Download Serialization
- **Constraint**: Chrome Manifest V3 security restricts `chrome.downloads.download` called from a background service worker from directly accessing `blob:https://...` URLs created in another renderer process.
- **Rule**: When downloading media represented by a `blob:` URL (e.g. ChatGPT images), the content script **must** fetch the blob within the tab context, serialize it into a lossless Base64 `data:` URI via `FileReader.readAsDataURL`, and pass the data URI to the background worker for downloading.
- **Rule for Video**: For Google Flow video outputs (`flow-video-tile`), the adapter must click the tile to open the detail view, trigger `button[aria-label="Download media"]`, select the original resolution item (e.g. `"360p Original size"` or `"720p Upscaled"`), filter out `"270p Animated GIF"`, and verify that the resulting file is saved as a valid `.mp4`.

### Invariant 4: Decoupled Generation vs. Download Lifecycle
- **Constraint**: Media generation consumes compute credits, platform time, or rate limits. If a file download fails (e.g., full disk, permission prompt canceled, temporary network timeout), the prompt must **not** be re-generated.
- **Rule**: Generation completion and file downloading must be tracked separately.
  - Successful generation with failed download $\rightarrow$ State: `download_failed`.
  - The UI presents a **Retry Download** action that invokes `downloadResult` directly from the existing detected asset on the page without re-submitting the prompt.

### Invariant 5: Observable Submission Evidence Verification
- **Constraint**: Network lag or framework change detection can cause brief delays between clicking "Generate" and the platform registering the request.
- **Rule**: Never assume a submit button click worked without observable proof.
- **Rule**: The adapter must verify at least one proof signal:
  1. Composer text cleared or disabled.
  2. Generation progress indicator (spinner, shimmer, progress percentage `0%`-`100%`) visible.
  3. Stop/cancel streaming button present.
  4. New tile or placeholder inserted into the grid canvas.
- **Rule**: If submission cannot be confirmed with certainty, transition the task to `needs_attention` rather than blind duplicate re-submission.

### Invariant 6: Model Independence on Google Flow
- **Constraint**: Google Flow frequently updates available models (Veo 2, Veo 3 Quality/Fast, Omni 1.1 Flash, Imagen 3).
- **Rule**: Do not hardcode model selector dropdowns or attempt to force model switches on Google Flow. The extension must respect whatever model and configuration the user has active in their Google Flow dock session (`"Video · 360p · 4s crop_16_9 x1"`).

---

## 3. Directory & File Responsibilities

| Path | Responsibility |
| :--- | :--- |
| `src/background/serviceWorker.ts` | MV3 background service worker, queue orchestrator, `chrome.alarms` keep-alive listener, trusted CDP hardware event dispatcher (`chrome.debugger`), and download coordination. |
| `src/adapters/types.ts` | `PlatformDomAdapter` interface definition and adapter contract types. |
| `src/adapters/chatgptAdapter.ts` | ChatGPT DOM adapter: Slate.js composer targeting, multi-turn isolation, reference attachment, blob $\rightarrow$ data URL serialization. |
| `src/adapters/googleFlowAdapter.ts` | Google Flow DOM adapter: ProseMirror input, dock inspection, `<flow-video-tile>` asset detection, detail view download automation. |
| `src/adapters/tabBridgeAdapter.ts` | Messaging bridge connecting the background service worker to the platform content scripts. |
| `src/browser/browserInteraction.ts` | Human-like typing simulation, DOM selection, TrustedHTML-safe child replacement, and event bubbling. |
| `src/browser/domInspection.ts` | DOM inspection heuristics: composer discovery, submit controls, progress spinners, busy state detection, and output elements. |
| `src/content/index.ts` | Content script entry point: tab bridge listener and platform adapter instantiator. |
| `src/core/queueEngine.ts` | Sequential batch queue execution, safe observation timeout policy, and task coordination. |
| `src/core/stateMachine.ts` | Finite state machine governing valid task state transitions. |
| `src/core/fileNaming.ts` | Filename template token evaluator (`{number}`, `{project}`, `{prompt}`, `{date}`, `{time}`) and auto-numbering formatter. |
| `src/core/promptParser.ts` | Plain-text line parser and RFC 4180 CSV parser with header mapping and reference splitting. |
| `src/core/referenceManager.ts` | Image attachment validator (file size $\le 20\text{ MB}$, MIME type checking, blob integrity). |
| `src/storage/db.ts` | IndexedDB wrapper managing the `BatchStudioDB` database (`batches`, `tasks`, `references` stores). |
| `src/storage/preferences.ts` | User preference persistence via `chrome.storage.local`. |
| `src/ui/App.tsx` | Main React application layout, batch setup form, platform/workflow toggles, and navigation. |
| `src/ui/components/QueueView.tsx` | Queue monitor, live task progress cards, pause/resume/stop controls, and retry triggers. |

---

## 4. Verification & Testing Protocol

Before completing any coding task or pull request, agents must run and verify the following commands:

```bash
# 1. Typecheck: Verify strict TypeScript compilation
npm run typecheck

# 2. Automated Tests: Run all 63+ Vitest unit, integration, and adapter fixture tests
npm test

# 3. Production Build: Ensure Vite builds unpackable distribution without errors
npm run build
```

### Live Browser Testing Protocol:
When modifying adapter selectors or interaction logic, verify against a live browser session:
1. Connect to or launch Chrome with remote debugging:
   `chrome.exe --remote-debugging-port=9222 --user-data-dir="<path-to-test-profile>"`
2. Verify target tab responsiveness.
3. Test a live 1-prompt batch end-to-end to confirm prompt entry $\rightarrow$ progress tracking $\rightarrow$ download $\rightarrow$ verified file write to disk.

---

## 5. Security & Privacy Rules

- **Zero Telemetry**: Do not add external analytics, tracking scripts, or remote endpoints.
- **No Credential Access**: Never read or log user passwords, bearer tokens, or session cookies.
- **Local Storage Budget**: Store media blobs strictly in `IndexedDB`. Never store raw multi-megabyte image/video blobs in `chrome.storage.local` to prevent quota exhaustion.
