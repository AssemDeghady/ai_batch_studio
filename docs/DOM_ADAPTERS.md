# Platform DOM Adapters Guide

This guide details the internal workings of the DOM Adapters in **AI Batch Studio** and explains how to create new adapters for additional generative AI platforms.

---

## 1. The `PlatformDomAdapter` Interface

All platform adapters implement the `PlatformDomAdapter` interface defined in [`src/adapters/types.ts`](file:///w:/Projects/Web/Batch-Studio/src/adapters/types.ts):

```typescript
export interface PlatformDomAdapter {
  platform: PlatformId;

  // Verifies that the platform tab is ready, logged in, and capable of the requested task
  checkAvailability(
    taskType: TaskType,
    settings?: GenerationSettings
  ): Promise<AdapterAvailabilityResult>;

  // Uploads/attaches reference images into the platform's composer
  attachReferences(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[]
  ): Promise<AdapterReferenceResult>;

  // Types the prompt and activates generation
  submitTask(
    task: TaskRecord,
    references: ResolvedReferenceAttachment[],
    options?: AdapterSubmissionOptions
  ): Promise<AdapterSubmissionResult>;

  // Polls active generation progress, spinners, percentages, or completion
  getTaskStatus(task: TaskRecord): Promise<AdapterStatusInspection>;

  // Extracts detected media assets (URLs, dimensions, download buttons)
  getResults(task: TaskRecord): Promise<DetectedPlatformAsset[]>;

  // Triggers official download or resolves media URL for saving to disk
  downloadResult(
    asset: DetectedPlatformAsset,
    suggestedFilename: string
  ): Promise<AdapterDownloadActionResult>;

  // Recovery routine called when reconnecting to an in-progress generation
  recoverTask(task: TaskRecord): Promise<AdapterStatusInspection>;

  // Cleanup resources when the adapter is disposed
  dispose(): Promise<void>;
}
```

---

## 2. ChatGPT Adapter (`ChatGPTDomAdapter`)

### Target URLs:
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

### Key Implementations & Workflows:

1. **Composer Input**:
   - Locates the Slate.js editor container (`#prompt-textarea`, `div[contenteditable="true"]`).
   - Uses `Range` placement and composed `InputEvent` dispatching.
   - Preserves Slate's internal React WeakMaps by avoiding `innerHTML` overwrites.

2. **Reference Attachment**:
   - Identifies the native file input (`input[type="file"]`).
   - Injects reference images using a synthetic `DataTransfer` object.
   - Monitors upload progress chips and awaits thumbnail preview rendering before submitting.

3. **Generation Observation & Busy Detection**:
   - Scopes busy state checks (`[aria-busy="true"]`) to the latest chat turn (`article[data-testid*="conversation-turn"]`).
   - Specifically ignores global navigation elements (such as profile avatar dropdowns that carry `aria-busy="true"` attributes) to prevent false-positive infinite generation loops.
   - Detects streaming stop controls (`button[data-testid="stop-button"]`, `button[aria-label*="Stop" i]`).

4. **Lossless Download Pipeline**:
   - ChatGPT renders generated images with ephemeral `blob:` URLs.
   - Background service workers cannot directly fetch tab-scoped blob URLs.
   - `ChatGPTDomAdapter` fetches the blob within the tab context, converts it via `FileReader.readAsDataURL`, and passes the data URI to Chrome Downloads, ensuring full-resolution, lossless `.png` capture.

---

## 3. Google Flow Adapter (`GoogleFlowDomAdapter`)

### Target URLs:
- `https://flow.google.com/*`
- `https://labs.google/*`
- `https://aitestkitchen.withgoogle.com/*`

### Key Implementations & Workflows:

1. **Model-Independent Design**:
   - Google Flow frequently updates available models (Veo 2, Veo 3 Quality/Fast, Omni 1.1 Flash, Imagen 3).
   - Rather than attempting to force hardcoded model switches, `GoogleFlowDomAdapter` respects the active model and configuration already established in the user's project dock (`"Video · 360p · 4s crop_16_9 x1"`).

2. **ProseMirror Composer & TrustedHTML Compliance**:
   - Prompt input is managed by ProseMirror inside `div.ProseMirror[contenteditable="true"]`.
   - Adheres to Google's strict Trusted Types Content Security Policy:
     - Direct string assignments to `innerHTML` throw `TypeError: This document requires 'TrustedHTML' assignment`.
     - `GoogleFlowDomAdapter` uses standard DOM Node methods (`replaceChildren` and `removeChild`) which bypass TrustedHTML restrictions safely.

3. **Canvas Asset Detection**:
   - Google Flow does not render bare `<video>` elements on the project grid.
   - Videos are rendered as `<flow-video-tile>` components containing an `<img class="thumbnail">` and play icon overlay.
   - `GoogleFlowDomAdapter` monitors the creation of new `flow-video-tile` elements and maps them directly to `.mp4` video outputs.

4. **Automated Detail View & Download Resolution Menu**:
   - To trigger downloads, the adapter clicks the video tile to open the Single-Item Detail View.
   - Locates `button[aria-label="Download media"]`.
   - Activates the resolution dropdown menu and clicks `"360p Original size"` (or `"720p Upscaled"`), explicitly filtering out `"270p Animated GIF"`.
   - Upon initiating the download, it automatically clicks the `"arrow_back"` or `"Done"` button to return to the project canvas for the next task in the queue.

---

## 4. How to Implement a New Platform Adapter

To add support for a new platform (e.g. Midjourney Web, Claude, Runway, Kling):

### Step 1: Create the Adapter File
Create `src/adapters/<platform>Adapter.ts` and implement `PlatformDomAdapter`:

```typescript
import { PlatformDomAdapter, AdapterSubmissionResult, ... } from './types';
import { TaskRecord, DetectedPlatformAsset } from '../types/models';

export class MyPlatformDomAdapter implements PlatformDomAdapter {
  public platform = 'my_platform' as const;

  constructor(private doc: Document, private getUrl: () => string) {}

  public async checkAvailability(taskType: TaskType): Promise<AdapterAvailabilityResult> {
    // Check if user is logged in and prompt box is visible
    const composer = this.doc.querySelector('textarea, div[contenteditable="true"]');
    return { available: Boolean(composer) };
  }

  // Implement remaining interface methods...
}
```

### Step 2: Register the Platform in Types
Add your platform identifier to `PlatformId` in [`src/types/models.ts`](file:///w:/Projects/Web/Batch-Studio/src/types/models.ts):

```typescript
export type PlatformId = 'chatgpt' | 'google_flow' | 'my_platform';
```

### Step 3: Configure Manifest Matches
Add target host patterns to `host_permissions` and `content_scripts.matches` in [`public/manifest.json`](file:///w:/Projects/Web/Batch-Studio/public/manifest.json):

```json
"host_permissions": [
  "https://myplatform.com/*"
]
```

### Step 4: Register in Content Script Entry
In [`src/content/index.ts`](file:///w:/Projects/Web/Batch-Studio/src/content/index.ts), instantiate your adapter when the current tab URL matches your platform.

### Step 5: Add Unit & Fixture Tests
Create fixture tests in [`tests/adapters.test.ts`](file:///w:/Projects/Web/Batch-Studio/tests/adapters.test.ts) to verify submission, status tracking, and download handling against simulated HTML documents.
