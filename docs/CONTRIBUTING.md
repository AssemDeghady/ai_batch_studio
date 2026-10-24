# Contributing to Batch Studio

Thank you for your interest in contributing to **Batch Studio**! As an open-source project, contributions from developers of all experience levels are welcome.

---

## 1. Development Setup

### Prerequisites:
- **Node.js**: `v20.x` or higher
- **npm**: `v10.x` or higher
- **Google Chrome**: Stable version (v116+ recommended for full Side Panel and Manifest V3 API support)
- **Git**

### Installation:
```bash
# 1. Fork and clone the repository
git clone https://github.com/your-username/batch-studio.git
cd batch-studio

# 2. Install dependencies
npm install

# 3. Verify TypeScript type checking
npm run typecheck

# 4. Run automated test suite
npm test

# 5. Build the development distribution
npm run build
```

---

## 2. Development Workflow

### Live Extension Reloading:
When modifying code in `src/`, Vite builds the distribution into the `dist/` directory.

```bash
# Watch mode for iterative development
npm run dev
```

To load the extension into Chrome:
1. Open Google Chrome and go to `chrome://extensions/`.
2. Toggle on **Developer mode** in the upper right.
3. Click **Load unpacked** and select the `dist/` folder in your repository clone.
4. After making code changes and re-running `npm run build`, click the reload icon on the Batch Studio card in `chrome://extensions/`.

---

## 3. Coding Guidelines & Standards

### 1. Trusted Types & CSP Safety
- Never assign arbitrary strings to `element.innerHTML`. On modern Google web applications (such as Google Flow), setting `innerHTML` directly throws a runtime `TypeError` due to strict TrustedHTML CSP enforcement.
- Use safe DOM node methods:
  ```typescript
  // Recommended
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  const p = doc.createElement('p');
  p.textContent = text;
  element.appendChild(p);

  // Avoid
  element.innerHTML = `<p>${text}</p>`; // Throws TrustedHTML violation
  ```

### 2. Framework-Safe Editor Input
- When entering prompts into Slate.js or ProseMirror contenteditable elements, do not wipe the container's child tree if it can be avoided, as this destroys internal framework Node WeakMaps.
- Always use `beforeinput` $\rightarrow$ `execCommand('insertText')` $\rightarrow$ `input` event sequencing.

### 3. Local-First & Privacy First
- Never introduce third-party analytics, telemetry, or remote telemetry pings.
- All user prompt data, task histories, and reference media must stay strictly on the local machine.

### 4. TypeScript Strict Mode
- All code must pass `npm run typecheck` (`tsc --noEmit`) without errors.
- Avoid using `any` where explicit union types or interfaces can be declared.

---

## 4. Testing Protocols

Before submitting a Pull Request, ensure that all automated test suites pass cleanly:

```bash
# Run the complete test suite
npm test
```

### Live Browser Smoke Testing:
Because generative AI web applications update their DOM class names and attributes over time, live smoke testing is strongly recommended when altering adapter logic:

1. Launch Chrome with remote debugging:
   ```bash
   chrome.exe --remote-debugging-port=9222 --user-data-dir="<path-to-test-profile>"
   ```
2. Log into the target platform (ChatGPT or Google Flow).
3. Test batch submission, generation monitoring, and file downloading with 1–2 sample prompts.

---

## 5. Pull Request Checklist

Before submitting a Pull Request:
- [ ] Code passes `npm run typecheck`.
- [ ] All 63+ unit and integration tests pass via `npm test`.
- [ ] Build succeeds without warnings via `npm run build`.
- [ ] New features or adapter changes include corresponding tests in `tests/`.
- [ ] Documentation in `docs/` or `README.md` is updated if new settings or workflows were introduced.
- [ ] Commit messages are descriptive and follow conventional commit formats (e.g. `feat:`, `fix:`, `docs:`, `refactor:`).
