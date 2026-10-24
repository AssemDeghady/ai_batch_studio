/**
 * Live DOM Inspection Layer
 *
 * Implements semantic and accessible candidate discovery for prompt composers,
 * action controls (Submit/Send/Generate), and generation evidence.
 *
 * Evaluates elements by accessibility tree attributes (roles, labels, ARIA),
 * visibility, editability, surrounding context, and platform hints, scoring
 * candidates and recording explicit reasons for selection or rejection.
 */

export interface ComposerCandidate {
  element: HTMLElement;
  score: number;
  tagName: string;
  isContentEditable: boolean;
  accessibleName: string;
  placeholder: string;
  isVisible: boolean;
  isEnabled: boolean;
  reasons: string[];
  rejectionReason?: string;
}

export interface SubmitControlCandidate {
  element: HTMLElement;
  score: number;
  tagName: string;
  accessibleName: string;
  text: string;
  isVisible: boolean;
  isEnabled: boolean;
  reasons: string[];
  rejectionReason?: string;
}

export interface GenerationEvidence {
  state: 'idle' | 'streaming' | 'generating' | 'completed' | 'error' | 'unknown';
  evidence: string;
  activeIndicatorCount: number;
  stopButtonFound: boolean;
  errorMessages: string[];
  assetCount: number;
}

/**
 * Checks if an element is genuinely rendered and visible in the DOM.
 */
export function isElementVisible(el: Element): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;

  // Check hidden attribute
  if (el.hasAttribute('hidden')) return false;

  // Check layout dimensions only when a layout engine is active (in real browsers body has width/height; in jsdom it is 0)
  const body = el.ownerDocument?.body;
  const hasLayoutEngine = Boolean(
    body &&
      (body.offsetWidth > 0 ||
        body.offsetHeight > 0 ||
        body.getClientRects().length > 0)
  );

  if (hasLayoutEngine && el.offsetWidth === 0 && el.offsetHeight === 0) {
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
  }

  // Check computed style if available in DOM environment
  const doc = el.ownerDocument;
  const win = doc?.defaultView;
  if (win && typeof win.getComputedStyle === 'function') {
    try {
      const style = win.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        return false;
      }
    } catch {
      // In minimal test DOMs, computed style may not be fully mocked
    }
  }

  // Check aria-hidden
  if (el.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  return true;
}

/**
 * Extracts semantic accessible name/label from an element using ARIA, labels, and placeholders.
 */
export function getElementAccessibleName(el: Element): string {
  if (!el) return '';

  // 1. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && el.ownerDocument) {
    const labelEl = el.ownerDocument.getElementById(labelledBy);
    if (labelEl && labelEl.textContent) {
      return labelEl.textContent.trim();
    }
  }

  // 3. Associated <label>
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.labels && el.labels.length > 0) {
      const labelText = Array.from(el.labels)
        .map((l) => l.textContent || '')
        .join(' ')
        .trim();
      if (labelText) return labelText;
    }
  }

  // 4. placeholder
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  // 5. title attribute
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();

  // 6. Direct button or text content
  if (
    el instanceof HTMLButtonElement ||
    el.getAttribute('role') === 'button' ||
    el.tagName === 'BUTTON'
  ) {
    const text = el.textContent || '';
    if (text.trim()) return text.trim();
  }

  return '';
}

/**
 * Discovers and ranks candidate prompt composers in the document.
 */
export function discoverComposerCandidates(
  doc: Document,
  hints?: { preferredSelectors?: string[]; keywordHints?: string[] }
): {
  bestCandidate: ComposerCandidate | null;
  allCandidates: ComposerCandidate[];
  diagnostics: string;
} {
  const allCandidates: ComposerCandidate[] = [];

  // Query all potential text editing elements: textarea, contenteditable, inputs, role=textbox
  const query = [
    'textarea',
    'div[contenteditable="true"]',
    'p[contenteditable="true"]',
    '[role="textbox"]',
    'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])'
  ].join(', ');

  const elements = Array.from(doc.querySelectorAll<HTMLElement>(query));

  for (const el of elements) {
    const isVisible = isElementVisible(el);
    const isEnabled = !(el as HTMLInputElement | HTMLTextAreaElement).disabled;
    const tagName = el.tagName.toLowerCase();
    const isContentEditable =
      el.getAttribute('contenteditable') === 'true' || el.isContentEditable === true;
    const accessibleName = getElementAccessibleName(el);
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const textContent = (el.textContent || '').trim();
    const id = el.id ? `#${el.id}` : '';
    const reasons: string[] = [];
    let score = 0;

    // Reject invisible or disabled elements
    if (!isVisible) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        isContentEditable,
        accessibleName,
        placeholder,
        isVisible: false,
        isEnabled,
        reasons: [],
        rejectionReason: 'Element is hidden or not rendered'
      });
      continue;
    }

    if (!isEnabled) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        isContentEditable,
        accessibleName,
        placeholder,
        isVisible: true,
        isEnabled: false,
        reasons: [],
        rejectionReason: 'Element is disabled'
      });
      continue;
    }

    // Reject search inputs, navigation inputs, or single-character code inputs
    const role = el.getAttribute('role');
    const inputType = el.getAttribute('type');
    if (inputType === 'search' || role === 'searchbox' || placeholder.includes('search')) {
      allCandidates.push({
        element: el,
        score: -50,
        tagName,
        isContentEditable,
        accessibleName,
        placeholder,
        isVisible: true,
        isEnabled: true,
        reasons: [],
        rejectionReason: 'Search or navigation input'
      });
      continue;
    }

    // Score based on element type
    if (tagName === 'textarea' || isContentEditable) {
      score += 40;
      reasons.push(tagName === 'textarea' ? 'Multi-line textarea (+40)' : 'contenteditable composer (+40)');
    } else if (tagName === 'input' && inputType === 'text') {
      score += 15;
      reasons.push('Single-line text input (+15)');
    }

    // Score based on accessible name and placeholder semantics
    const semanticText = `${accessibleName} ${placeholder}`.toLowerCase();
    const promptKeywords = [
      'prompt',
      'describe',
      'imagine',
      'message',
      'ask',
      'what',
      'create',
      'video',
      'image'
    ];

    for (const kw of promptKeywords) {
      if (semanticText.includes(kw)) {
        score += 25;
        reasons.push(`Contains prompt keyword "${kw}" in label/placeholder (+25)`);
        break;
      }
    }

    // Score based on preferred platform hints
    if (hints?.preferredSelectors) {
      for (const sel of hints.preferredSelectors) {
        if (el.matches(sel)) {
          score += 50;
          reasons.push(`Matches preferred platform selector hint "${sel}" (+50)`);
          break;
        }
      }
    }

    // Check surrounding container context (e.g., inside form or bottom composer bar)
    const container = el.closest('form, [data-testid*="composer"], footer, [role="region"], .composer');
    if (container) {
      score += 20;
      reasons.push('Located within a composer form or footer region (+20)');
    }

    allCandidates.push({
      element: el,
      score,
      tagName,
      isContentEditable,
      accessibleName,
      placeholder,
      isVisible: true,
      isEnabled: true,
      reasons
    });
  }

  allCandidates.sort((a, b) => b.score - a.score);

  const bestCandidate = allCandidates.length > 0 && allCandidates[0].score > 0 ? allCandidates[0] : null;

  const diagnostics =
    allCandidates.length === 0
      ? 'No editable text elements found in document.'
      : bestCandidate
      ? `Selected candidate <${bestCandidate.tagName}${
          bestCandidate.element.id ? ` id="${bestCandidate.element.id}"` : ''
        }> (score: ${bestCandidate.score}). Reasons: ${bestCandidate.reasons.join(', ')}.`
      : `Found ${allCandidates.length} candidate(s), but none met the minimum confidence threshold.`;

  return { bestCandidate, allCandidates, diagnostics };
}

/**
 * Discovers and ranks candidate submit / send / generate buttons in relation to the composer.
 */
export function discoverSubmitControlCandidates(
  doc: Document,
  composerEl?: HTMLElement | null,
  hints?: { preferredSelectors?: string[] }
): {
  bestCandidate: SubmitControlCandidate | null;
  allCandidates: SubmitControlCandidate[];
  diagnostics: string;
} {
  const allCandidates: SubmitControlCandidate[] = [];

  const query = [
    'button',
    'input[type="submit"]',
    '[role="button"]'
  ].join(', ');

  const elements = Array.from(doc.querySelectorAll<HTMLElement>(query));

  // Determine composer parent form or container to calculate proximity
  // Look up to 8 parent levels or standard semantic container tags
  let composerContainer: HTMLElement | null = null;
  if (composerEl) {
    composerContainer = composerEl.closest(
      'form, [data-testid*="composer"], footer, .composer, [role="region"], div[class*="prompt"], div[class*="dock"], div[class*="bottom"], div[class*="bar"], div[class*="input-container"]'
    );
    if (!composerContainer && composerEl.parentElement) {
      let p: HTMLElement | null = composerEl.parentElement;
      for (let i = 0; i < 8 && p && p !== doc.body; i++) {
        const tag = p.tagName.toLowerCase();
        if (
          tag === 'main' ||
          tag === 'aisandbox-root' ||
          tag === 'nav' ||
          tag === 'aside' ||
          p.getAttribute('role') === 'navigation'
        ) {
          break;
        }
        const buttonsInAncestor = Array.from(
          p.querySelectorAll<HTMLElement>('button, [role="button"]')
        ).filter((btn) => {
          const btnText = `${btn.textContent || ''} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
          return !/\b(close|clear|cancel|dismiss)\b|^[×✕✖x]$/.test(btnText.trim());
        });
        const hasFollowingActionBtn = buttonsInAncestor.some((btn) => {
          if (typeof composerEl.compareDocumentPosition === 'function') {
            return Boolean(composerEl.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING);
          }
          return true;
        });
        if (hasFollowingActionBtn && (buttonsInAncestor.length >= 2 || i >= 2)) {
          composerContainer = p;
          break;
        }
        p = p.parentElement;
      }
    }
  }

  for (const el of elements) {
    const isVisible = isElementVisible(el);
    const isEnabled = !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
    const tagName = el.tagName.toLowerCase();
    const accessibleName = getElementAccessibleName(el);
    const textContent = (el.textContent || '').trim();
    const ariaLabel = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const reasons: string[] = [];
    let score = 0;

    if (!isVisible) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        accessibleName,
        text: textContent,
        isVisible: false,
        isEnabled,
        reasons: [],
        rejectionReason: 'Hidden button'
      });
      continue;
    }

    const lowerCombined = `${accessibleName} ${textContent} ${ariaLabel} ${title}`.toLowerCase();

    // 1. CRITICAL: Strictly reject collection-management, folder, or workspace controls
    if (
      lowerCombined.includes('collection') ||
      lowerCombined.includes('folder') ||
      lowerCombined.includes('project') ||
      lowerCombined.includes('workspace') ||
      lowerCombined.includes('library') ||
      el.hasAttribute('data-collection-id') ||
      el.closest('[data-testid*="collection"], .collection-card, .collection-item')
    ) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        accessibleName,
        text: textContent,
        isVisible: true,
        isEnabled,
        reasons: [],
        rejectionReason: 'Collection or project management control'
      });
      continue;
    }

    // 2. Strictly reject navigation, dismiss, cancel, clear, help, sidebar, menu controls
    if (
      lowerCombined.includes('close') ||
      lowerCombined.includes('dismiss') ||
      lowerCombined.includes('cancel') ||
      lowerCombined.includes('clear') ||
      lowerCombined.includes('reset') ||
      lowerCombined.includes('back') ||
      lowerCombined.includes('menu') ||
      lowerCombined.includes('help') ||
      lowerCombined.includes('sidebar') ||
      lowerCombined.includes('history') ||
      lowerCombined.includes('share') ||
      lowerCombined.includes('favorite') ||
      lowerCombined.includes('bookmark')
    ) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        accessibleName,
        text: textContent,
        isVisible: true,
        isEnabled,
        reasons: [],
        rejectionReason: 'Navigation, clear, or modal dismissal control'
      });
      continue;
    }

    // Check if element explicitly matches preferred platform selectors
    const isPreferred = Boolean(
      hints?.preferredSelectors &&
        hints.preferredSelectors.some((sel) => {
          try {
            return sel !== 'button' && el.matches(sel);
          } catch {
            return false;
          }
        })
    );

    // 2b. Strictly reject any control inside a dialog, modal, popup overlay, OneGoogleBar, or dropdown menu
    // (Unless the element explicitly matches the platform's preferred submit button selectors)
    if (
      !isPreferred &&
      el.closest(
        '[role="dialog"], [role="menu"], [role="listbox"], [data-popup], .modal, .dialog, .settings-dialog, .boqOnegoogleliteOgbOneGoogleBar, #gb, mat-sidenav:not(.mat-sidenav-container), .mat-drawer:not(.mat-drawer-container)'
      )
    ) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        accessibleName,
        text: textContent,
        isVisible: true,
        isEnabled,
        reasons: [],
        rejectionReason: 'Inside settings dialog, account bar, or popup overlay'
      });
      continue;
    }

    // 3. Strictly reject settings, selectors, add/upload, agents, quality pills, and dropdown toggles
    const settingOrUploadKeywords = [
      'model',
      'select model',
      'aspect',
      'ratio',
      'duration',
      'voice',
      'microphone',
      'dictate',
      'agent',
      'attach',
      'upload',
      'add media',
      'add image',
      'add file',
      'add reference',
      'insert',
      '360p',
      '720p',
      '1080p',
      '4k',
      'fps',
      'resolution',
      'banana',
      'veo',
      'imagen',
      '16:9',
      '4:3',
      '1:1',
      '3:4',
      '9:16',
      'x1',
      'x2',
      'x3',
      'x4',
      'credits',
      'generating will use',
      'preset',
      'style',
      'camera',
      'motion',
      'enhance prompt',
      'enhance'
    ];
    if (settingOrUploadKeywords.some((kw) => lowerCombined.includes(kw))) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        accessibleName,
        text: textContent,
        isVisible: true,
        isEnabled,
        reasons: [],
        rejectionReason: 'Generation settings, selector, or upload control'
      });
      continue;
    }

    // 3b. Strictly reject dropdown toggle pills (aria-haspopup, aria-expanded) or single symbol + / chevron / sidebar icon ligature
    const hasPopup = el.getAttribute('aria-haspopup');
    const isExpanded = el.hasAttribute('aria-expanded');
    const lowerTextTrimmed = textContent.toLowerCase();
    const nonSubmitIconLigatures = new Set([
      '+',
      '▾',
      '▼',
      '×',
      '✕',
      '✖',
      'x',
      'close',
      'clear',
      'cancel',
      'add',
      'add_circle',
      'delete',
      'restore_from_trash',
      'view_sidebar',
      'dock_to_right',
      'grid_view',
      'auto_awesome_mosaic',
      'movie',
      'theaters',
      'image',
      'photo_library',
      'folder',
      'more_vert',
      'more_horiz',
      'settings',
      'tune'
    ]);
    const isSingleSymbol =
      nonSubmitIconLigatures.has(lowerTextTrimmed) ||
      ariaLabel === '+';

    if (
      hasPopup === 'menu' ||
      hasPopup === 'listbox' ||
      hasPopup === 'dialog' ||
      hasPopup === 'true' ||
      isExpanded ||
      isSingleSymbol
    ) {
      allCandidates.push({
        element: el,
        score: -100,
        tagName,
        accessibleName,
        text: textContent,
        isVisible: true,
        isEnabled,
        reasons: [],
        rejectionReason: 'Dropdown toggle, popup selector, or symbol button'
      });
      continue;
    }

    // 4. Preferred platform selector hints
    if (hints?.preferredSelectors) {
      for (const sel of hints.preferredSelectors) {
        if (sel !== 'button' && el.matches(sel)) {
          score += 60;
          reasons.push(`Matches preferred platform selector hint "${sel}" (+60)`);
          break;
        }
      }
    }

    // 5. Proximity to composer: major requirement (DOM container OR geometric dock proximity)
    let isGeometricallyInDock = false;
    if (
      composerEl &&
      typeof el.getBoundingClientRect === 'function' &&
      !el.closest('nav, aside, header, [role="navigation"]')
    ) {
      try {
        const elRect = el.getBoundingClientRect();
        const compRect = composerEl.getBoundingClientRect();
        if (compRect.width > 0 && elRect.width > 0) {
          const verticalDelta = Math.abs(elRect.bottom - compRect.bottom);
          const horizontalOverlapOrRight = elRect.right >= compRect.left - 40 && elRect.left <= compRect.right + 220;
          if (verticalDelta <= 140 && horizontalOverlapOrRight) {
            isGeometricallyInDock = true;
          }
        }
      } catch {
        // Safe for mock/test environments
      }
    }

    const isInsideComposer = Boolean((composerContainer && composerContainer.contains(el)) || isGeometricallyInDock);
    if (isInsideComposer) {
      score += 45;
      reasons.push('Located inside composer container (+45)');
    } else if (composerEl) {
      // If composer exists but button is outside composer container and has no explicit testid
      const hasExplicitTestId = Boolean(
        el.getAttribute('data-testid')?.includes('send') ||
        el.getAttribute('data-testid')?.includes('generate')
      );
      if (!hasExplicitTestId) {
        score -= 40;
        reasons.push('Located outside composer container (-40)');
      }
    }

    // 5b. Relative position to composer prompt input in DOM order
    if (composerEl && typeof composerEl.compareDocumentPosition === 'function') {
      const position = composerEl.compareDocumentPosition(el);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        score += 25;
        reasons.push('Positioned after composer in DOM order (+25)');
      } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        score -= 25;
        reasons.push('Positioned before composer in DOM order (-25)');
      }
    }

    // 5c. Horizontal position relative to composer (action buttons reside on the right)
    if (composerEl && typeof el.getBoundingClientRect === 'function') {
      try {
        const elRect = el.getBoundingClientRect();
        const compRect = composerEl.getBoundingClientRect();
        if (compRect.width > 0 && elRect.width > 0) {
          const elCenterX = elRect.left + elRect.width / 2;
          const compCenterX = compRect.left + compRect.width / 2;
          if (elCenterX > compCenterX) {
            score += 30;
            reasons.push('Positioned on right side of composer (+30)');
          }
        }
      } catch {
        // Safe for mock/test environments
      }
    }

    // 5d. Semantic tag preference
    if (tagName === 'button') {
      score += 20;
      reasons.push('Semantic <button> element (+20)');
    } else if (tagName === 'input' && (el as HTMLInputElement).type === 'submit') {
      score += 30;
      reasons.push('Explicit <input type="submit"> (+30)');
    }

    // 6. Action-specific keywords (deliberately excluding generic "create")
    const actionKeywords = [
      'generate video',
      'generate image',
      'generate',
      'run prompt',
      'run',
      'send prompt',
      'send',
      'submit',
      'arrow_forward',
      'arrow_upward',
      'arrow_right',
      'north_east'
    ];
    for (const kw of actionKeywords) {
      if (lowerCombined.includes(kw)) {
        score += 40;
        reasons.push(`Contains action keyword "${kw}" in label (+40)`);
        break;
      }
    }

    // 7. Circular / arrow / play / run SVG or Google/Material Symbol icon detection (requiring directional cues)
    const iconChild = el.querySelector(
      '[class*="google-symbols"], [class*="google-material-icons"], [class*="material-symbols"], [class*="material-icons"], mat-icon, google-symbol, i'
    );
    const iconChildText = (iconChild?.textContent || '').trim().toLowerCase();
    const hasExplicitArrowOrActionIcon = Boolean(
      el.querySelector(
        'svg[data-icon*="arrow" i], svg[data-icon*="send" i], svg[data-icon*="run" i], svg[data-icon*="play" i], svg[aria-label*="Send" i], svg[aria-label*="Generate" i], svg[aria-label*="Submit" i], svg[aria-label*="Arrow" i], svg[class*="arrow" i], svg[class*="send" i], svg.lucide-arrow-right, svg.lucide-arrow-up, svg.lucide-send, svg.lucide-play'
      ) ||
      /arrow|send|play|forward|spark|north_east|east|auto_awesome/i.test(iconChildText) ||
      /^(arrow_forward|arrow_upward|arrow_right|arrow_right_alt|send|north_east|east|play_arrow|auto_awesome|spark)$/i.test(
        textContent
      )
    );
    const hasAnySvg = Boolean(el.querySelector('svg, mat-icon'));

    if (hasExplicitArrowOrActionIcon) {
      score += 35;
      reasons.push('Contains directional / action icon (+35)');
    } else if (hasAnySvg) {
      score += 10;
      reasons.push('Contains icon (+10)');
    }

    // 8. Circular / Google Flow primary action button styling check (class names OR computed CSS border-radius)
    const classList = (el.className || '').toString().toLowerCase();
    if (classList.includes('flow-icon-button-secondary')) {
      score += 65;
      reasons.push('Google Flow primary white action icon button (.flow-icon-button-secondary) (+65)');
    }
    let hasComputedRoundRadius = false;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const computed = window.getComputedStyle(el);
        const radius = computed.borderRadius || computed.borderTopLeftRadius || '';
        const numRadius = parseFloat(radius);
        if (radius.includes('50%') || radius.includes('999') || numRadius >= 12) {
          hasComputedRoundRadius = true;
        }
      } catch {
        // Safe for test environments
      }
    }
    const isCircular =
      hasComputedRoundRadius ||
      classList.includes('flow-icon-button-secondary') ||
      classList.includes('circle') ||
      classList.includes('rounded-full') ||
      classList.includes('circular') ||
      classList.includes('round') ||
      classList.includes('submit') ||
      classList.includes('send') ||
      classList.includes('generate');

    if (isCircular) {
      score += 20;
      reasons.push('Circular / submit button styling (+20)');
    }

    // 8b. Trailing circular action button bonus (e.g. Google Flow rightmost (→) circular button)
    const isInsideAndFollowing =
      isInsideComposer &&
      Boolean(
        composerEl &&
        typeof composerEl.compareDocumentPosition === 'function' &&
        composerEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      );

    if (isInsideAndFollowing && (isCircular || hasExplicitArrowOrActionIcon || hasAnySvg)) {
      score += 50;
      reasons.push('Trailing action button in composer dock (+50)');
    }

    // 9. Active enabled status
    if (isEnabled) {
      score += 10;
      reasons.push('Button is currently enabled (+10)');
    } else {
      reasons.push('Button is currently disabled (awaiting text)');
    }

    allCandidates.push({
      element: el,
      score,
      tagName,
      accessibleName,
      text: textContent,
      isVisible: true,
      isEnabled,
      reasons
    });
  }

  allCandidates.sort((a, b) => b.score - a.score);

  // Require minimum score of 30 to prevent choosing arbitrary unrelated buttons
  const bestCandidate =
    allCandidates.length > 0 && allCandidates[0].score >= 30 ? allCandidates[0] : null;

  const diagnostics =
    allCandidates.length === 0
      ? 'No visible action buttons found.'
      : bestCandidate
      ? `Selected button "${bestCandidate.accessibleName || bestCandidate.text || bestCandidate.tagName}" (score: ${
          bestCandidate.score
        }). Reasons: ${bestCandidate.reasons.join(', ')}.`
      : `Found ${allCandidates.length} button(s), but none scored as a valid submit control.`;

  return { bestCandidate, allCandidates, diagnostics };
}

/**
 * Strictly filters and returns genuine generated output elements (<img> or <video>) on the page,
 * excluding Google Account bar avatars (.boqOnegoogleliteOgbOneGoogleBar, /ogw/, /a/, =s32),
 * navigation icons, composer thumbnails, and hidden elements.
 */
export function queryGeneratedOutputElements(
  doc: Document,
  taskType?: 'image' | 'video'
): HTMLElement[] {
  const hasLayoutEngine = Boolean(doc.body && doc.body.offsetWidth > 0);
  const results: HTMLElement[] = [];

  const excludedContainerSelector =
    '.boqOnegoogleliteOgbOneGoogleBar, #gb, mat-sidenav:not(.mat-sidenav-container), .mat-drawer:not(.mat-drawer-container), nav, header, aside, [role="navigation"], [role="menu"], [data-testid*="composer"], footer, .composer';

  if (!taskType || taskType === 'video') {
    const videoCandidates = Array.from(
      doc.querySelectorAll<HTMLElement>(
        'video[src], [data-testid="flow-video-result"] video, .flow-output-card video, aisandbox-root video, main video, flow-video-tile img, flow-video-tile, [data-testid="flow-video-result"]'
      )
    ).filter((el) => {
      if (el.closest(excludedContainerSelector)) {
        return false;
      }
      const vid = el as HTMLVideoElement;
      const img = el as HTMLImageElement;
      const src =
        vid.currentSrc ||
        vid.src ||
        img.currentSrc ||
        img.src ||
        el.getAttribute('src') ||
        el.querySelector('video')?.currentSrc ||
        el.querySelector('video')?.src ||
        el.querySelector('video source')?.getAttribute('src') ||
        el.querySelector('img')?.currentSrc ||
        el.querySelector('img')?.src ||
        el.querySelector('source')?.getAttribute('src') ||
        '';
      return Boolean(src);
    });
    results.push(...videoCandidates);
  }

  if (!taskType || taskType === 'image') {
    const explicitFixtures = Array.from(
      doc.querySelectorAll<HTMLImageElement>(
        'img[src*="oaiusercontent"], [data-testid="flow-image-result"] img, .flow-output-card img, img[data-flow-generated="true"], img.generated-image, figure img[src]'
      )
    ).filter((img) => !img.closest(excludedContainerSelector) && !img.closest('flow-video-tile'));

    const workspaceImages = Array.from(
      doc.querySelectorAll<HTMLImageElement>(
        'img[src*="flow-content.google"], img[src*="googleusercontent"], img[src*="ggpht"], img[src^="blob:"], img[src^="data:image/"], aisandbox-root img[src], main img[src]'
      )
    ).filter((img) => {
      if (img.closest(excludedContainerSelector) || img.closest('flow-video-tile')) {
        return false;
      }
      const src = (img.currentSrc || img.src || img.getAttribute('src') || '').toLowerCase();
      const cls = (img.className || '').toString().toLowerCase();
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      if (
        !src ||
        src.includes('/ogw/') ||
        /(?:googleusercontent\.com|ggpht\.com)\/(?:a|a-)\b/i.test(src) ||
        /=s(16|20|24|32|40|48|64|83|96)\b/.test(src) ||
        src.includes('aitestkitchen/website/flow') ||
        src.includes('favicon') ||
        cls.includes('gb_0') ||
        cls.includes('gbii') ||
        cls.includes('avatar') ||
        alt.includes('avatar') ||
        alt.includes('profile')
      ) {
        return false;
      }
      if (hasLayoutEngine && typeof img.getBoundingClientRect === 'function') {
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 72 || rect.height < 72)) {
          return false;
        }
      }
      return true;
    });

    results.push(...explicitFixtures, ...workspaceImages);
  }

  // Deduplicate by DOM element and by normalized media source URL so duplicate <img> layers
  // inside a single Google Flow tile (e.g. blurred backdrop + main image) are only counted once.
  const uniqueElements: HTMLElement[] = [];
  const seenElements = new Set<HTMLElement>();
  const seenSrcs = new Set<string>();

  for (const el of results) {
    if (seenElements.has(el)) continue;
    seenElements.add(el);

    const rawSrc =
      (el as HTMLImageElement | HTMLVideoElement).currentSrc ||
      (el as HTMLImageElement | HTMLVideoElement).src ||
      el.getAttribute('src') ||
      el.querySelector('source')?.getAttribute('src') ||
      '';
    const normSrc = rawSrc.trim();
    if (normSrc) {
      if (seenSrcs.has(normSrc)) continue;
      seenSrcs.add(normSrc);
    }

    uniqueElements.push(el);
  }

  return uniqueElements;
}

/**
 * Inspects observable generation evidence (stop buttons, progress bars, spinners, errors, outputs).
 */
export function inspectObservableGenerationState(doc: Document): GenerationEvidence {
  const stopButtons = Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[data-testid="stop-button"], button[aria-label*="Stop streaming" i], button[aria-label*="Stop generating" i]'
    )
  ).filter(isElementVisible);

  const activeIndicators = Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[data-testid="image-gen-loading"], [data-testid="flow-generating-indicator"], .dalle-progress, .flow-generation-progress, [role="progressbar"], [aria-busy="true"]:not([aria-label*="profile" i]):not([aria-label*="menu" i]), .flow-loader, .result-streaming, mat-progress-spinner, mat-spinner, md-circular-progress, md-linear-progress, [class*="shimmer" i], [class*="skeleton" i]'
    )
  ).filter(isElementVisible);

  const errorElements = Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[data-testid="conversation-error"], [data-testid="flow-error-banner"], [role="alert"][data-error="true"], .result-error, .flow-error-message, .policy-violation'
    )
  ).filter(isElementVisible);

  const errorMessages = errorElements
    .map((e) => (e.textContent || '').trim())
    .filter(Boolean);

  const validOutputs = queryGeneratedOutputElements(doc).filter(isElementVisible);
  const assetCount = validOutputs.length;

  if (errorMessages.length > 0) {
    return {
      state: 'error',
      evidence: `Error banner visible: "${errorMessages[0]}"`,
      activeIndicatorCount: activeIndicators.length,
      stopButtonFound: stopButtons.length > 0,
      errorMessages,
      assetCount
    };
  }

  if (stopButtons.length > 0) {
    return {
      state: 'streaming',
      evidence: 'Stop streaming/generating control is actively visible',
      activeIndicatorCount: activeIndicators.length,
      stopButtonFound: true,
      errorMessages: [],
      assetCount
    };
  }

  if (activeIndicators.length > 0) {
    return {
      state: 'generating',
      evidence: `Active progress indicator visible (${activeIndicators.length} active elements)`,
      activeIndicatorCount: activeIndicators.length,
      stopButtonFound: false,
      errorMessages: [],
      assetCount
    };
  }

  if (assetCount > 0) {
    return {
      state: 'completed',
      evidence: `Generated asset elements identified (${assetCount} assets visible)`,
      activeIndicatorCount: 0,
      stopButtonFound: false,
      errorMessages: [],
      assetCount
    };
  }

  return {
    state: 'idle',
    evidence: 'No active indicators or newly generated outputs detected',
    activeIndicatorCount: 0,
    stopButtonFound: false,
    errorMessages: [],
    assetCount: 0
  };
}
