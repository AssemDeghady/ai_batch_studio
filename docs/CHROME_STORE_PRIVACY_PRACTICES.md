# Chrome Web Store — Privacy Practices & Justifications Guide

This document contains the exact text required to pass the **Privacy practices** review on the Chrome Web Store Developer Dashboard for **AI Batch Studio**.

---

## 1. Single Purpose Description

**Field:** `Single purpose description`  
**Character limit:** Up to 1,000 characters

```text
AI Batch Studio automates sequential batch prompt execution, reference asset management, and media file downloading for generative AI image and video workflows on ChatGPT and Google Flow.
```

---

## 2. Permission Justifications

Copy and paste the exact text below into each corresponding permission justification field:

### `alarms`
```text
Used to schedule background service worker keep-alive ticks and periodic queue health checks during long-running multi-minute image and video generations, preventing the Manifest V3 service worker from terminating prematurely mid-batch.
```

### `debugger`
```text
Used via the Chrome DevTools Protocol (CDP Input.insertText) to dispatch trusted hardware-level keystrokes to complex reactive rich-text editors (Slate.js on ChatGPT and ProseMirror on Google Flow) when synthetic DOM events fail or when tabs run in background mode, ensuring reliable prompt insertion without corrupting editor state.
```

### `downloads`
```text
Used to automatically save completed AI-generated image and video files directly into organized subfolders (e.g. Downloads/BatchStudio/{project}/{date}/) using user-configured filename templates, eliminating repetitive manual right-click saving.
```

### `host permission use`
*(Applies to `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://flow.google.com/*`, etc.)*
```text
Host permissions are strictly scoped to supported generative AI platforms (ChatGPT and Google Flow). They allow the extension's content script to interact with the composer DOM, attach reference images, and detect when media generation finishes. No other websites or domains are accessed.
```

### `notifications`
```text
Used to send native desktop notifications alerting the user when a long-running batch completes or when human attention is required (such as a platform CAPTCHA prompt, rate limit, or circuit breaker safety pause).
```

### `remote code use`
- **Option to select:** **No, I am not using remote code**
- **Justification / Explanation (if requested):**
```text
The extension does not load, fetch, or execute any external or remote scripts. All JavaScript, styles, assets, and libraries are 100% packaged locally within the extension distribution bundle in full compliance with Manifest V3 policies.
```

### `scripting`
```text
Used by the background service worker to programmatically inject DOM observation helpers and message bridges into authorized ChatGPT and Google Flow tabs to monitor generation progress and extract output elements.
```

### `sidePanel`
```text
Used to render the extension's primary studio interface and live queue monitor within Chrome's native Side Panel, allowing users to configure batches and monitor generations alongside their active generative platform tab without switching windows.
```

### `storage`
```text
Used via chrome.storage.local to save user preferences, batch configurations, auto-numbering counters, timeout policies, and UI themes entirely on the client device. No data is transmitted to external servers.
```

### `tabs`
```text
Used to query and discover open ChatGPT or Google Flow tabs, verify that target tabs are responsive, or navigate to the platform tab when the user clicks 'Open Platform' from the queue monitor.
```

---

## 3. Data Usage & Certification Checkboxes

Under the **Data usage** and **Certification** sections:

1. **Does your extension collect user data?**
   - Select: **No**, the extension does not collect or transmit user data. (All prompts, images, and preferences are stored strictly client-side in the user's browser IndexedDB and `chrome.storage.local`).
2. **Certification Checkboxes:**
   - [x] Check: **I certify that my data usage complies with the Developer Program Policies.**
   - [x] Check: **I certify that the extension does not sell user data to third parties.**
   - [x] Check: **I certify that the extension does not use or transfer user data for purposes unrelated to the single purpose.**
   - [x] Check: **I certify that the extension does not use or transfer user data for creditworthiness or lending purposes.**
