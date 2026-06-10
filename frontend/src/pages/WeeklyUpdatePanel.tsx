/**
 * WeeklyUpdatePanel
 * Inline variant rendered inside a dashboard panel body.
 * Clicking Generate fetches live Jira data and Claude summaries from
 * POST /api/dashboards/{slug}/generate-update.
 *
 * Autosave behaviour:
 *   - After Generate completes → save immediately.
 *   - After any manual edit   → debounce 1.5 s, then save.
 *   - On mount                → restore from panel.contentJson if present.
 */
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { apiBase, fetchDashboard, fetchPanelContent, generateWeeklyUpdate, getCachedAccessToken, type PresenceEntry } from '../api';
import { WeeklyUpdateResponse, WeeklyUpdateSection } from '../types';
import './WeeklyUpdatePage.css';
import {
  LinkIcon,
  SectionMeta,
  SubSection,
  TicketCount,
  useOpenSections,
} from './weeklyUpdateData';

// ── Props ──────────────────────────────────────────────────────────────────────

interface WeeklyUpdatePanelProps {
  slug: string;
  panelId?: string;
  initialContent?: Record<string, unknown> | null;
  onSave?: (panelId: string, payload: { contentJson: Record<string, unknown> }) => Promise<void>;
  /** Fix version IDs currently selected in the dashboard filter. When provided
   *  and non-empty, only sections matching one of these IDs are shown. */
  activeFixVersionIds?: string[];
  /** Custom released-window (ISO yyyy-mm-dd) for the summary. When set, the
   *  backend includes released fix versions whose release date falls within
   *  [updateStart, updateEnd] instead of the default last-two-weeks window. */
  updateStart?: string;
  updateEnd?: string;
  /** Map of fix-version id → RAG, derived from the Gantt's schedule logic in
   *  DashboardPage (see computeFixVersionRag). When supplied, the RAG badge
   *  on each summary section is sourced from this map — overriding the
   *  legacy manual click-to-cycle state so the update panel always agrees
   *  with the Gantt bar colour. */
  ragStatusByVersionId?: Record<string, RagStatus>;
  /** Opens the dashboard-level presentation deck. Surfaced here as a button
   *  next to Generate; the deck/overlay itself live in DashboardPage. */
  onPresent?: () => void;
  /** Whether the assembled deck has any slides — gates the Present button. */
  canPresent?: boolean;
  /** Called when the user focuses a section's summary editor. */
  onEditingSection?: (sectionId: string) => void;
  /** Called when the user blurs a section's summary editor. */
  onEditingEnd?: () => void;
  /** Active presence entries for this panel (from the dashboard poll). */
  presenceEntries?: PresenceEntry[];
  /** Registers a content-merge handler with DashboardPage so SSE-driven
   *  remote updates (panel.updated events) can apply through this panel's
   *  applyRemoteContent path instead of being dropped on the floor. Pass
   *  null on unmount. */
  registerRemoteContentHandler?: (
    panelId: string,
    handler: ((contentJson: Record<string, unknown> | null) => void) | null,
  ) => void;
}

// ── Summary HTML sanitiser ─────────────────────────────────────────────────────
// Chrome inserts empty <div> / <br> elements into contentEditable fields as the
// user types and then deletes content. These inflate the element height even after
// the content is gone. On blur we strip those empty artifacts while preserving
// any non-empty block elements (intentional newlines the user typed).

const normaliseSummaryEl = (el: HTMLElement) => {
  // Strip trailing bare <br> nodes Chrome appends at the cursor position.
  while (el.lastChild?.nodeName === 'BR') {
    el.removeChild(el.lastChild);
  }

  // Strip empty <div>/<p> direct children (whitespace-only or containing only a <br>).
  // Non-empty blocks represent intentional line breaks and are left untouched.
  el.querySelectorAll(':scope > div, :scope > p').forEach((block) => {
    const isEmpty =
      (block.textContent ?? '').trim() === '' ||
      (block.childNodes.length === 1 && block.firstChild?.nodeName === 'BR');
    if (isEmpty) block.remove();
  });

  // Always dispatch so the panel body re-runs measure() after every blur,
  // even when there were no Chrome artifacts to remove.
  el.dispatchEvent(new CustomEvent('wu-normalised', { bubbles: true }));
};

// ── Allow-list sanitiser for summary HTML ──
// Runs any HTML that enters or leaves the summary contentEditable through
// DOMPurify with a tight allow-list. This covers three paths:
//   1. Backend-rendered `summaryFormat: 'html'` sections before they render.
//   2. User-edited content read back from the contentEditable on save.
//   3. Any HTML written into state via the API response.
// Without this, the new `summaryFormat: 'html'` bypass — which skips the
// `escapeApiSummary` escape step — would be an XSS sink: a crafted innerHTML
// could persist scripts, event handlers, or unsafe URLs that run on re-render.
const SUMMARY_SANITIZE_CONFIG = {
  // Allow only the tags we actually render. Structural tags for layout,
  // common inline formatting, lists, links, and our image wrapper.
  ALLOWED_TAGS: [
    'p', 'div', 'span', 'br', 'hr',
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'code', 'sub', 'sup',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'a',
    'img',
    'button',
  ],
  // Attributes needed by: links (href/target/rel), images (src/alt/title
  // + data-lightbox wiring), the resizable-image wrapper (class,
  // data-resizable-image, contenteditable), and the hover remove button
  // (class, type, aria-label, contenteditable).
  ALLOWED_ATTR: [
    'href', 'target', 'rel',
    'src', 'alt', 'title',
    'class', 'aria-label',
    'contenteditable', 'tabindex',
    'data-lightbox', 'data-resizable-image',
    'type',
  ],
  // Permit data: URIs (base64 images from paste/drop) alongside the
  // standard safe schemes. DOMPurify's default forbids data: for all tags.
  ALLOW_DATA_ATTR: true,
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel):|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  // Don't let sanitization leave behind template/MathML/etc. namespaces
  // the contentEditable can't re-parse cleanly.
  USE_PROFILES: { html: true },
  // KEEP_CONTENT strips disallowed tags but preserves their children —
  // safer than dropping whole subtrees for benign cases like stray
  // <font> wrappers.
  KEEP_CONTENT: true,
  // Explicitly opt out of DOM/fragment/trusted-type return modes so
  // DOMPurify.sanitize is typed as returning a plain string. Without these,
  // the overload resolver widens the return to `string | HTMLElement |
  // DocumentFragment | TrustedHTML` and the string assignment below errors.
  RETURN_DOM: false as const,
  RETURN_DOM_FRAGMENT: false as const,
  RETURN_TRUSTED_TYPE: false as const,
};

const sanitizeSummaryHtml = (html: string): string => {
  // Pass through DOMPurify first so any scripts/handlers/unsafe attributes
  // introduced via the API, paste, or edits are stripped before we look at
  // the markup.
  const clean = DOMPurify.sanitize(html, SUMMARY_SANITIZE_CONFIG) as string;
  // Then do our usual Chrome-artifact cleanup on a detached element so
  // dispatchEvent is a no-op (no DOM listeners fire). Use a block container
  // (<div>), not <p> — the structured summaries contain block children
  // (<p>, <div>, <ul>) which the HTML parser would auto-close/reparent out
  // of a <p> ancestor, silently mutating the markup before save/render.
  const tmp = document.createElement('div');
  tmp.innerHTML = clean;
  // Strip remote <img> srcs. ALLOWED_URI_REGEXP permits https? for links,
  // but that would also let pasted/imported HTML embed remote image URLs
  // that (a) bypass the paste/drop downscale + size cap and (b) leak the
  // referer + render third-party requests on every view. Inline-pasted
  // images are inserted as data:image/* URIs via insertImageFileAtCursor,
  // so anything else on an <img> is unexpected and should be dropped.
  tmp.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:image/')) {
      img.remove();
    }
  });
  // Strip any nested data-summary-for attributes. ALLOW_DATA_ATTR is on
  // (we rely on it elsewhere), so DOMPurify preserves data-* on pasted or
  // backend-rendered HTML. captureEdits() later runs querySelectorAll(
  // '[data-summary-for]') on the whole container — if a pasted fragment
  // carries this attribute, that inner element's innerHTML would silently
  // overwrite the matching section's summary on save. Only the outer
  // SummaryParagraph wrapper should carry this marker, so strip it from
  // anything that ends up inside sanitized content.
  tmp.querySelectorAll('[data-summary-for]').forEach((el) => {
    el.removeAttribute('data-summary-for');
  });
  // Normalise <a target="_blank"> links so they can't retain an opener
  // handle to the dashboard tab (window.opener nav + tabnabbing risk).
  // DOMPurify preserves rel when present but never injects it, so pasted
  // or backend HTML with target but no rel would slip through.
  tmp.querySelectorAll('a[target="_blank"]').forEach((a) => {
    const existing = (a.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
    const needed = ['noopener', 'noreferrer'];
    let changed = false;
    for (const token of needed) {
      if (!existing.includes(token)) {
        existing.push(token);
        changed = true;
      }
    }
    if (changed || !a.hasAttribute('rel')) {
      a.setAttribute('rel', existing.join(' '));
    }
  });
  normaliseSummaryEl(tmp);
  return tmp.innerHTML;
};

/**
 * Escape plain-text summaries that arrive from the API before storing them in
 * state.  API-generated summaries are prose (no HTML), but rendering them via
 * dangerouslySetInnerHTML without escaping would allow any HTML/script tags
 * that Claude or Jira data might inadvertently include to execute.
 */
const escapeApiSummary = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Preserve newlines from the model as visual line breaks. Applied after
    // the other escapes so any literal '<br>' in the raw text is already
    // neutralised to '&lt;br&gt;' before this runs.
    .replace(/\r?\n/g, '<br>');

/**
 * Escape plain-text summaries from the API. Sections whose `summaryFormat` is
 * 'html' are run through DOMPurify's allow-list instead of the text escape —
 * the backend already renders them as safe HTML (structured Done/Doing/To Do
 * layout), but defending-in-depth on the frontend keeps a compromised or
 * mis-configured backend from becoming an XSS sink via the persisted
 * content path.
 */
const escapeSectionSummary = (s: WeeklyUpdateSection): WeeklyUpdateSection =>
  s.summaryFormat === 'html'
    ? { ...s, summary: sanitizeSummaryHtml(s.summary) }
    : { ...s, summary: escapeApiSummary(s.summary) };

const escapeResponseSummaries = (data: WeeklyUpdateResponse): WeeklyUpdateResponse => ({
  ...data,
  released: data.released.map(escapeSectionSummary),
  active: data.active.map(escapeSectionSummary),
});

/**
 * Merge a freshly-generated response with the user's current (possibly-edited)
 * state. The goal is that clicking Generate refreshes structural data (ticket
 * counts, sub-sections, dates, badges) but preserves anything the user typed
 * into a section summary.
 *
 * Behaviour:
 *   - Sections present in BOTH: keep the user's edited summary; take every
 *     other field from the fresh response. `summaryFormat` is forced to 'html'
 *     because captureEdits() always sanitises to HTML.
 *   - Sections present in FRESH only: use the fresh summary as-is (newly
 *     qualifying fix versions).
 *   - Sections present in CURRENT only: dropped (no longer qualify for the
 *     weekly update — e.g. released >2 weeks ago or archived). Their prose
 *     is lost, matching the prior behaviour for dropped sections.
 */
const mergeWithEdits = (
  fresh: WeeklyUpdateResponse,
  current: WeeklyUpdateResponse | null,
): WeeklyUpdateResponse => {
  if (!current) return fresh;
  // Look up the *fresh* summary for each section ID so we only preserve a
  // current summary when it genuinely diverges from what the server just
  // returned. If current.summary == fresh.summary the user hasn't edited,
  // so using the fresh copy is a no-op but avoids clobbering an upstream
  // change that happened to arrive with identical ID (e.g. server
  // reformatted whitespace or the copy was rewritten while we were idle).
  const freshLookup: Record<string, WeeklyUpdateSection> = {};
  [...fresh.released, ...fresh.active].forEach((s) => {
    freshLookup[s.id] = s;
  });
  const editedSummaries: Record<string, string> = {};
  [...current.released, ...current.active].forEach((s) => {
    const freshMatch = freshLookup[s.id];
    if (!freshMatch) return; // section no longer in response — nothing to keep
    if (s.summary !== freshMatch.summary) {
      editedSummaries[s.id] = s.summary;
    }
  });
  const apply = (s: WeeklyUpdateSection): WeeklyUpdateSection =>
    Object.prototype.hasOwnProperty.call(editedSummaries, s.id)
      ? { ...s, summary: editedSummaries[s.id], summaryFormat: 'html' }
      : s;
  return {
    ...fresh,
    released: fresh.released.map(apply),
    active: fresh.active.map(apply),
  };
};

/**
 * Detect sections whose summary on the *server* has diverged from the copy
 * this client last synced. Called right before Generate/Regen to surface
 * multi-user conflicts: if another person edited a summary since we last
 * loaded or saved, that section will appear here and we'll warn the user
 * before their action could overwrite it.
 *
 * Returns an array of { id, name } pairs so the modal can list who/what is
 * at risk. An empty array means the server hasn't moved since our last sync.
 * Invalid or missing inputs short-circuit to empty (fail-open rather than
 * block the user with a false alarm if the shape is unexpected).
 */
const detectRemoteEdits = (
  serverContent: WeeklyUpdateResponse | null,
  lastKnownSaved: WeeklyUpdateResponse | null,
): Array<{ id: string; name: string }> => {
  if (!serverContent || !lastKnownSaved) return [];
  const lastKnownById: Record<string, WeeklyUpdateSection> = {};
  [...lastKnownSaved.released, ...lastKnownSaved.active].forEach((s) => {
    lastKnownById[s.id] = s;
  });
  const diffs: Array<{ id: string; name: string }> = [];
  [...serverContent.released, ...serverContent.active].forEach((serverSection) => {
    const prior = lastKnownById[serverSection.id];
    // New sections on the server that we didn't have last time aren't edits
    // of ours to worry about — they just show up when we regenerate anyway.
    if (!prior) return;
    if (prior.summary !== serverSection.summary) {
      diffs.push({ id: serverSection.id, name: serverSection.name });
    }
  });
  return diffs;
};

/**
 * Parse the raw `contentJson` blob stored in a DashboardPanel into a
 * WeeklyUpdateResponse. Returns null for shapes that don't look like a
 * generated update (e.g. empty panels or other panel types stored here
 * in error). Applies the same sanitiser used on mount so that any HTML
 * read back from the server is cleaned before comparison / rendering.
 */
export const parseStoredPanelContent = (
  raw: Record<string, unknown> | null | undefined,
): WeeklyUpdateResponse | null => {
  if (!raw) return null;
  try {
    const r = raw as unknown as WeeklyUpdateResponse;
    if (!Array.isArray(r.released) || !Array.isArray(r.active)) return null;
    const clean = (s: WeeklyUpdateSection): WeeklyUpdateSection => ({
      ...s,
      summary: sanitizeSummaryHtml(s.summary),
    });
    return { ...r, released: r.released.map(clean), active: r.active.map(clean) };
  } catch {
    return null;
  }
};

const handleSummaryBlur = (e: React.FocusEvent<HTMLDivElement>) => {
  normaliseSummaryEl(e.currentTarget);
};

// ── Image size cap ──
// Inlining a full-resolution screenshot as a base64 data URL can push a
// single summary into the multi-MB range. Because handleSave sends the
// summary in both `contentJson` and `contentHtml`, the request doubles on
// save and autosave latency becomes user-visible (or hits server limits).
// Cap the *encoded* data URL at ~1.5 MB. Anything larger gets downscaled
// via canvas until it fits; if even the downscaled version is still too
// large the insert is aborted with a user-visible message.
const MAX_IMAGE_DATA_URL_BYTES = 1.5 * 1024 * 1024;
const DOWNSCALE_MAX_DIMENSION = 1600;
const DOWNSCALE_QUALITY = 0.85;

const readFileAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('FileReader returned non-string'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });

const downscaleImageToDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { naturalWidth: w, naturalHeight: h } = img;
      if (!w || !h) {
        reject(new Error('image has zero dimension'));
        return;
      }
      const scale = Math.min(1, DOWNSCALE_MAX_DIMENSION / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas 2d context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, tw, th);
      // Preserve transparency for PNGs; re-encode everything else as JPEG
      // since it's much cheaper byte-for-byte for photographs/screenshots.
      const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      resolve(canvas.toDataURL(mime, DOWNSCALE_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image load failed'));
    };
    img.src = url;
  });

const prepareImageDataUrl = async (file: File): Promise<string | null> => {
  const raw = await readFileAsDataURL(file);
  if (raw.length <= MAX_IMAGE_DATA_URL_BYTES) return raw;
  try {
    const scaled = await downscaleImageToDataURL(file);
    if (scaled.length <= MAX_IMAGE_DATA_URL_BYTES) return scaled;
  } catch {
    // fall through to the oversized path
  }
  return null;
};

// ── Caret capture helpers ──
// FileReader.onload and the image prepare/downscale path both run
// asynchronously, so the live selection may have moved or the
// contentEditable may have lost focus by the time we try to insert.
// Capture the intended insertion range synchronously from the paste
// event, or from the drop coordinates for drop events, and restore
// it just before execCommand.
const captureSelectionRange = (): Range | null => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return sel.getRangeAt(0).cloneRange();
};

const rangeFromPoint = (x: number, y: number): Range | null => {
  const docAny = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof docAny.caretRangeFromPoint === 'function') {
    return docAny.caretRangeFromPoint(x, y);
  }
  if (typeof docAny.caretPositionFromPoint === 'function') {
    const pos = docAny.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
};

const restoreRange = (range: Range | null) => {
  if (!range) return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
};

/**
 * Inline an image File into a contentEditable element by reading it as a
 * base64 data URL and dispatching `insertHTML` at the given (saved) range.
 * Using a data URL keeps the feature self-contained (no backend upload) at
 * the cost of bloating stored content, so `prepareImageDataUrl` enforces
 * a size cap. Future productionisation: upload to a storage endpoint and
 * insert a URL reference.
 */
const insertImageFileAtCursor = (file: File, savedRange: Range | null) => {
  if (!file.type.startsWith('image/')) return;
  prepareImageDataUrl(file)
    .then((src) => {
      if (!src) {
        // Downscale failed or still too large — don't silently bloat storage.
        window.alert(
          'This image is too large to embed (must be under ~1.5 MB after downscaling). ' +
            'Please resize it and try again.'
        );
        return;
      }
      // Restore the caret before inserting so the image lands where the
      // paste/drop happened, not wherever focus has wandered during the
      // async prepare step.
      restoreRange(savedRange);
      // execCommand is deprecated but is still the most reliable way to
      // insert arbitrary HTML at the current selection inside a
      // contentEditable.
      //
      // The image is wrapped in a <span class="rsz-img"> so it:
      //   - Survives round-tripping through sanitizeSummaryHtml, which
      //     only strips empty block chrome (<br>, empty <div>/<p>) —
      //     non-empty spans pass through untouched.
      //   - Is marked `contenteditable="false"` so the caret can move
      //     past the image rather than splitting the wrapper mid-drag.
      //   - Anchors the hover-revealed remove button.
      // The inner <img> carries `data-lightbox="1"` so the global
      // ImageLightbox component opens it full-size on click. The image
      // renders at its natural size, capped to the container via CSS
      // `max-width: 100%`.
      const html =
        // tabindex="0" so keyboard users can tab onto the wrapper; the
        // remove button lives in the wrapper's focus-within scope so a
        // subsequent Tab lands on it and Enter/Space removes the image.
        `<span class="rsz-img" data-resizable-image contenteditable="false" tabindex="0">` +
        `<img src="${src}" data-lightbox="1">` +
        // Remove-image button — visually hidden by default, revealed on
        // hover or focus via CSS (display stays as flex so the button
        // remains in the tab order). Clicks are handled by the global
        // listener in components/ImageLightbox.tsx which removes the
        // parent wrapper and fires an input event so handleSummaryBlur
        // picks up the change when the user moves on.
        `<button type="button" class="rsz-img-remove" contenteditable="false" ` +
        `aria-label="Remove image">\u00d7</button>` +
        `</span>`;
      document.execCommand('insertHTML', false, html);
    })
    .catch((err) => {
      console.error('Failed to insert image into summary', err);
    });
};

/**
 * Insert a sanitized HTML fragment at the given range. Runs the payload
 * through sanitizeSummaryHtml first so the same allow-list + remote-img
 * stripping that guards stored summaries also guards paste/drop insertions.
 * This prevents pasted HTML (e.g. from a web page, Jira, or an email) from
 * injecting <img src="https://..."> elements that would bypass the size
 * cap and cause uncontrolled third-party image requests on every render.
 */
const insertSanitizedHtmlAtCursor = (html: string, savedRange: Range | null) => {
  const clean = sanitizeSummaryHtml(html);
  if (!clean) return;
  restoreRange(savedRange);
  document.execCommand('insertHTML', false, clean);
};

const handleSummaryPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  // Prefer inline-image paste first: it has the downscale + size-cap path.
  const items = clipboard.items;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file || !file.type.startsWith('image/')) continue;
      event.preventDefault();
      // Capture the current caret position synchronously — the async
      // prepare/downscale step may take hundreds of ms, and by the time
      // insertHTML runs the live selection could be anywhere.
      const savedRange = captureSelectionRange();
      insertImageFileAtCursor(file, savedRange);
      return;
    }
  }
  // Fall back to an HTML payload — intercept so the browser's default
  // contentEditable paste doesn't silently pull in remote <img src="https://">
  // tags that would bypass the downscale/size-cap constraints.
  const html = clipboard.getData('text/html');
  if (html) {
    event.preventDefault();
    const savedRange = captureSelectionRange();
    insertSanitizedHtmlAtCursor(html, savedRange);
  }
  // text/plain (no HTML, no file) can fall through to the default paste —
  // no remote-image risk, and we'd otherwise lose line-break handling.
};

const handleSummaryDrop = (event: React.DragEvent<HTMLDivElement>) => {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  // Focus the drop target so the browser considers this contentEditable
  // the active input when we later call execCommand.
  event.currentTarget.focus();
  const files = transfer.files;
  const imageFile = files && files.length
    ? Array.from(files).find((f) => f.type.startsWith('image/'))
    : undefined;
  if (imageFile) {
    event.preventDefault();
    // Translate the drop coordinates into a caret Range before kicking off
    // the async prepare step. Falling back to the live selection only
    // matters for very old browsers; modern Chrome/Safari/Firefox all
    // support one of the two APIs in rangeFromPoint().
    const dropRange = rangeFromPoint(event.clientX, event.clientY) ?? captureSelectionRange();
    insertImageFileAtCursor(imageFile, dropRange);
    return;
  }
  // Same HTML-intercept rationale as paste: dropped HTML (e.g. dragging a
  // selection from another page) can otherwise insert remote <img> elements
  // the sanitize-on-save path would have to clean up after the fact.
  const html = transfer.getData('text/html');
  if (html) {
    event.preventDefault();
    const dropRange = rangeFromPoint(event.clientX, event.clientY) ?? captureSelectionRange();
    insertSanitizedHtmlAtCursor(html, dropRange);
  }
};

/**
 * Editable summary paragraph with a collapsible formatting toolbar.
 * The toolbar uses execCommand so it doesn't require Tiptap — the existing
 * contentEditable + sanitize-on-save pipeline is preserved unchanged.
 * Toolbar starts collapsed to avoid cluttering compact section cards.
 */
const SummaryParagraph: React.FC<{
  sectionId: string;
  initialHtml: string;
  onBlur: (e: React.FocusEvent<HTMLDivElement>) => void;
}> = ({ sectionId, initialHtml, onBlur }) => {
  const ref = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(true);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Seed innerHTML on every new section or summary — useLayoutEffect avoids a flash.
  useLayoutEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml;
  }, [sectionId, initialHtml]);

  // Close any open dropdown when clicking outside the toolbar
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [openMenu]);

  // Keep focus on the contentEditable and run an execCommand.
  // Called via onMouseDown so focus hasn't been lost yet.
  const exec = useCallback((cmd: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, value ?? undefined);
  }, []);

  const handleCode = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    ref.current?.focus();
    restoreRange(savedRangeRef.current);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const codeEl = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)
      ?.closest('code');
    if (codeEl) {
      // Unwrap by selecting the whole <code> and replacing it with its inner
      // HTML via execCommand. A direct DOM replaceWith would desync the
      // browser's native undo stack (cmd+z would skip/ignore the change);
      // execCommand keeps the operation on the stack and fires its own input
      // event, so the unwrap is undoable like every other toolbar action.
      const unwrapRange = document.createRange();
      unwrapRange.selectNode(codeEl);
      sel.removeAllRanges();
      sel.addRange(unwrapRange);
      document.execCommand('insertHTML', false, codeEl.innerHTML);
    } else {
      const text = range.toString();
      document.execCommand('insertHTML', false, `<code>${text || '\u200b'}</code>`);
    }
  }, []);

  const handleLink = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    ref.current?.focus();
    const url = window.prompt('Link URL');
    if (url) document.execCommand('createLink', false, url);
  }, []);

  const handleImageBtn = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    savedRangeRef.current = captureSelectionRange();
    imageInputRef.current?.click();
  }, []);

  const handleImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) insertImageFileAtCursor(file, savedRangeRef.current);
    e.target.value = '';
  }, []);

  const handleBlockFormat = useCallback((tag: string) => {
    ref.current?.focus();
    restoreRange(savedRangeRef.current);
    document.execCommand('formatBlock', false, tag);
    setOpenMenu(null);
  }, []);

  const handleList = useCallback((type: 'bullet' | 'ordered') => {
    ref.current?.focus();
    restoreRange(savedRangeRef.current);
    document.execCommand(type === 'bullet' ? 'insertUnorderedList' : 'insertOrderedList');
    setOpenMenu(null);
  }, []);

  // Prevent the toolbar button from stealing focus (onMouseDown fires before blur)
  const hold = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); fn(); };

  return (
    <div className="wu-summary-editor">
      <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFile} />
      <div
        ref={menuContainerRef}
        className={`panel-toolbar wu-summary-toolbar${toolbarCollapsed ? ' panel-toolbar--collapsed' : ''}`}
      >
        {/* Paragraph / Heading */}
        <div className="toolbar-group">
          <button type="button" className="toolbar-trigger"
            onMouseDown={(e) => { e.preventDefault(); savedRangeRef.current = captureSelectionRange(); }}
            onClick={() => setOpenMenu(openMenu === 'fmt' ? null : 'fmt')}
          >
            Para ▾
          </button>
          {openMenu === 'fmt' && (
            <div className="toolbar-menu">
              <button type="button" onMouseDown={hold(() => handleBlockFormat('p'))}>Paragraph</button>
              <button type="button" onMouseDown={hold(() => handleBlockFormat('h1'))}>Heading 1</button>
              <button type="button" onMouseDown={hold(() => handleBlockFormat('h2'))}>Heading 2</button>
              <button type="button" onMouseDown={hold(() => handleBlockFormat('h3'))}>Heading 3</button>
            </div>
          )}
        </div>

        {/* Inline formatting */}
        <div className="toolbar-group">
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('bold'); }}>B</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('italic'); }}>I</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('underline'); }}>U</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('strikeThrough'); }}>S</button>
          <button type="button" onMouseDown={handleCode}>{'</>'}</button>
        </div>

        {/* Lists */}
        <div className="toolbar-group">
          <button type="button" className="toolbar-trigger"
            onMouseDown={(e) => { e.preventDefault(); savedRangeRef.current = captureSelectionRange(); }}
            onClick={() => setOpenMenu(openMenu === 'list' ? null : 'list')}
          >
            List ▾
          </button>
          {openMenu === 'list' && (
            <div className="toolbar-menu">
              <button type="button" onMouseDown={hold(() => handleList('bullet'))}>Bulleted list</button>
              <button type="button" onMouseDown={hold(() => handleList('ordered'))}>Numbered list</button>
            </div>
          )}
        </div>

        {/* Link / Image / Divider */}
        <div className="toolbar-group">
          <button type="button" onMouseDown={handleLink}>Link</button>
          <button type="button" onMouseDown={handleImageBtn}>Image</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('insertHTML', '<hr>'); }}>Divider</button>
        </div>

        {/* Collapse toggle — always last so margin-left:auto pins it right */}
        <button
          type="button"
          className="toolbar-collapse-btn"
          onClick={() => { setToolbarCollapsed((c) => !c); setOpenMenu(null); }}
          title={toolbarCollapsed ? 'Show formatting toolbar' : 'Hide formatting toolbar'}
        >
          {toolbarCollapsed ? 'Aa ▾' : '✕'}
        </button>
      </div>

      {/* Rendered as <div> (not <p>) so structured summaries can contain block
          children (<p>, <ul>, <li>). */}
      <div
        ref={ref}
        className="wu-section-summary"
        contentEditable
        suppressContentEditableWarning
        data-summary-for={sectionId}
        onBlur={onBlur}
        onPaste={handleSummaryPaste}
        onDrop={handleSummaryDrop}
      />
    </div>
  );
};

// ── Confirmation modal ─────────────────────────────────────────────────────────
// Shared modal for both the main Generate action and per-section regenerate.
// Kept identical in structure to the original Generate confirmation so the
// UX is consistent — only the copy changes based on what the user is about
// to do.

interface ConfirmModalProps {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Inline banner rendered at the top of a ConfirmModal body when the server
 * has edits that arrived from another client since we last synced. Lists the
 * affected section names so the user knows exactly whose work might be at
 * risk, and highlights the one they're regenerating (if applicable) since
 * that prose *will* be overwritten by the regen even after the merge.
 */
const RemoteEditsWarning: React.FC<{
  edits: Array<{ id: string; name: string }>;
  /** When regenerating a specific section, call it out in the list so the
   *  user sees that *this one's* edits will be lost (the merge will keep
   *  everyone else's, but the regen target is overwritten by design). */
  targetSectionId?: string;
}> = ({ edits, targetSectionId }) => {
  if (edits.length === 0) return null;
  const targetIsEdited = edits.some((e) => e.id === targetSectionId);
  return (
    <div
      style={{
        marginBottom: 12,
        padding: '10px 12px',
        background: 'rgba(251,191,36,0.08)',
        border: '1px solid rgba(251,191,36,0.3)',
        borderRadius: 8,
        color: '#fbbf24',
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: '#fde68a', display: 'block', marginBottom: 4 }}>
        ⚠ Someone else has edited this panel
      </strong>
      {edits.length === 1
        ? `Section "${edits[0].name}" has been updated by another user since you loaded this page.`
        : `${edits.length} sections have been updated by other users since you loaded this page: ${edits
            .map((e) => `"${e.name}"`)
            .join(', ')}.`}{' '}
      Their edits will be preserved unless you're regenerating that specific section.
      {targetIsEdited && (
        <div style={{ marginTop: 6, color: '#fde68a' }}>
          Note: the section you're regenerating was just edited by someone else —
          their prose will be replaced.
        </div>
      )}
    </div>
  );
};

// Unique id helper for aria-labelledby so multiple confirm modals in the same
// React tree (theoretical, but cheap to guarantee) never collide.
let confirmModalIdSeq = 0;

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}) => {
  // Stable id for the heading so aria-labelledby can point at it without
  // relying on DOM position.
  const titleIdRef = useRef<string>(`wu-modal-title-${++confirmModalIdSeq}`);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  // Remember which element had focus before the dialog opened so we can
  // restore focus to it when the modal closes (WCAG 2.4.3 focus order).
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Move focus to the confirm button on open. A tiny delay lets the
    // portal/ref land before we try to focus.
    const raf = requestAnimationFrame(() => {
      confirmBtnRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const prev = previousFocusRef.current;
      if (prev && document.contains(prev)) {
        try {
          prev.focus();
        } catch {
          /* no-op: previously focused node may have been unmounted */
        }
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      // Simple focus trap: only Cancel and Confirm buttons are focusable
      // targets inside the dialog, so cycle between them based on shift.
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="wu-modal-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="wu-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="wu-modal-title" id={titleIdRef.current}>{title}</h3>
        <div className="wu-modal-body">{body}</div>
        <div className="wu-modal-actions">
          <button ref={cancelBtnRef} className="wu-modal-cancel" onClick={onCancel}>Cancel</button>
          <button ref={confirmBtnRef} className="wu-modal-confirm" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

// ── RAG indicator ──────────────────────────────────────────────────────────────

type RagStatus = 'red' | 'amber' | 'green';
const RAG_CYCLE: Record<RagStatus, RagStatus> = { red: 'amber', amber: 'green', green: 'red' };
const RAG_LABEL: Record<RagStatus, string> = { red: 'Red', amber: 'Amber', green: 'Green' };

const RagIndicator: React.FC<{ status: RagStatus; onChange: (s: RagStatus) => void }> = ({
  status,
  onChange,
}) => (
  <button
    className={`wu-rag wu-rag--${status}`}
    onClick={() => onChange(RAG_CYCLE[status])}
    title={`RAG status: ${RAG_LABEL[status]} — click to change`}
  >
    <span className="wu-rag-dot" />
    {RAG_LABEL[status]}
  </button>
);

// ── Section renderer ───────────────────────────────────────────────────────────

const WU_PRESENCE_COLOURS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#a855f7'];

const SectionView: React.FC<{
  section: WeeklyUpdateSection;
  openSections: Set<string>;
  toggle: (id: string) => void;
  onHide?: (id: string) => void;
  ragStatus?: RagStatus;
  onRagChange?: (id: string, s: RagStatus) => void;
  onRegenerate?: (id: string) => void;
  isRegenerating?: boolean;
  regenDisabled?: boolean;
  editors?: Array<{ accountId: string; displayName: string; avatarUrl: string | null }>;
  onSummaryFocus?: () => void;
  onSummaryBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
}> = ({
  section,
  openSections,
  toggle,
  onHide,
  ragStatus,
  onRagChange,
  onRegenerate,
  isRegenerating = false,
  regenDisabled = false,
  editors = [],
  onSummaryFocus,
  onSummaryBlur,
}) => (
  <div
    className={`wu-section${editors.length > 0 ? ' is-being-edited' : ''}`}
    style={editors.length > 0 ? { '--presence-colour': WU_PRESENCE_COLOURS[(editors.length - 1) % WU_PRESENCE_COLOURS.length] } as React.CSSProperties : undefined}
    onFocus={(e) => {
      if ((e.target as HTMLElement).isContentEditable) onSummaryFocus?.();
    }}
  >
    {/* Regenerate button — pinned top-right, just left of Hide. Only rendered
        when a callback is supplied (i.e. editable contexts). */}
    {onRegenerate && (
      <button
        type="button"
        className={`wu-regen-btn${isRegenerating ? ' is-spinning' : ''}`}
        onClick={() => onRegenerate(section.id)}
        disabled={regenDisabled || isRegenerating}
        title={isRegenerating ? 'Regenerating…' : 'Regenerate this section from live Jira data'}
        aria-label={`Regenerate ${section.name}`}
      >
        <span className="wu-regen-btn-icon" aria-hidden="true">↻</span>
        {isRegenerating ? 'Regen…' : 'Regen'}
      </button>
    )}
    {/* Hide button — pinned top-right of the card */}
    {onHide && (
      <button className="wu-hide-btn" onClick={() => onHide(section.id)} title="Hide from summary">
        Hide
      </button>
    )}

    <div className="wu-section-header">
      <a className="wu-section-name" href={section.href} target="_blank" rel="noreferrer">
        {section.name}
        <LinkIcon />
      </a>
      <div className="wu-section-badges">
        {section.ticketTodo === 0 && section.ticketTotal > 0 ? (
          <span className={`wu-badge ${ragStatus ? `wu-badge--rag-${ragStatus}` : 'wu-badge--pending-rel'}`}>Pending release</span>
        ) : (
          <span className={`wu-badge ${ragStatus ? `wu-badge--rag-${ragStatus}` : section.statusClass}`}>{section.statusLabel}</span>
        )}
      </div>
      {editors.length > 0 && (
        <div className="wu-presence-badges">
          {editors.map((e, i) => (
            <div
              key={e.accountId}
              className="wu-presence-avatar"
              data-tooltip={`${e.displayName} is editing`}
              style={{ background: WU_PRESENCE_COLOURS[i % WU_PRESENCE_COLOURS.length] }}
            >
              {e.avatarUrl
                ? <img src={e.avatarUrl} alt={e.displayName} />
                : e.displayName.charAt(0).toUpperCase()}
            </div>
          ))}
        </div>
      )}
    </div>

    {ragStatus && onRagChange && (
      <div className="wu-rag-row">
        <RagIndicator status={ragStatus} onChange={(s) => onRagChange(section.id, s)} />
      </div>
    )}

    <SectionMeta
      uatStart={section.uatStart ?? undefined}
      targetEnd={section.targetEnd ?? undefined}
      targetEndUrgent={section.targetEndUrgent}
      versionNote={section.versionNote ?? undefined}
    />
    <SummaryParagraph
      sectionId={section.id}
      initialHtml={section.summary}
      onBlur={onSummaryBlur ?? handleSummaryBlur}
    />
    {editors.length > 0 && (
      <div className="wu-editing-label">
        {editors[0].displayName} is editing
      </div>
    )}

    {/* Ticket count above the sub-section dropdowns */}
    {section.subSections.length > 0 && (
      <div className="wu-ticket-count-row">
        <TicketCount todo={section.ticketTodo} total={section.ticketTotal} />
      </div>
    )}

    {section.subSections.map((ss) => (
      <SubSection
        key={ss.id}
        data={ss}
        open={openSections.has(ss.id)}
        onToggle={() => toggle(ss.id)}
      />
    ))}
  </div>
);

// ── Conciseness dropdown ───────────────────────────────────────────────────────

const CONCISENESS_LABELS: Record<number, string> = {
  1: 'Very brief',
  2: 'Brief',
  3: 'Standard',
  4: 'Detailed',
  5: 'Very detailed',
};


// ── Save status indicator ──────────────────────────────────────────────────────

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const SaveIndicator: React.FC<{ status: SaveStatus }> = ({ status }) => {
  if (status === 'idle') return null;
  const colour = status === 'saving' ? '#4b5563' : status === 'error' ? '#f87171' : '#4ade80';
  const label = status === 'saving' ? 'Saving…' : status === 'error' ? '⚠ Save failed' : '✓ Saved';
  return (
    <span
      style={{
        fontSize: 11,
        color: colour,
        transition: 'color 0.3s',
        userSelect: 'none',
      }}
    >
      {label}
    </span>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────

const WeeklyUpdatePanel: React.FC<WeeklyUpdatePanelProps> = ({
  slug,
  panelId,
  initialContent,
  onSave,
  activeFixVersionIds,
  updateStart,
  updateEnd,
  ragStatusByVersionId,
  onPresent,
  canPresent = false,
  onEditingSection,
  onEditingEnd,
  presenceEntries = [],
  registerRemoteContentHandler,
}) => {
  const { openSections, toggle } = useOpenSections();
  const [generated, setGenerated] = useState<WeeklyUpdateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [isDirty, setIsDirty] = useState(false);
  const [ragStatuses, setRagStatuses] = useState<Map<string, RagStatus>>(new Map());
  // Section-id currently being regenerated via the per-section button, or null
  // if no regeneration is in flight. Used to disable concurrent regens and
  // render a spinner on the relevant button.
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  // Pending confirmation state. When non-null, a modal is shown asking the
  // user to confirm before the generate/regen action actually fires. The
  // optional remoteEdits array carries section names that another user has
  // edited since we last synced — when present, the modal shows a warning
  // so the user isn't blindsided. remoteContent is the refetched server
  // state that we'll use as the new baseline on confirm.
  //   { type: 'generate' }                    → main ✦ Generate button
  //   { type: 'regen', sectionId, sectionName } → per-section ↻ Regen button
  type PendingConfirm =
    | {
        type: 'generate';
        remoteEdits: Array<{ id: string; name: string }>;
        remoteContent: WeeklyUpdateResponse | null;
      }
    | {
        type: 'regen';
        sectionId: string;
        sectionName: string;
        conciseness: number;
        remoteEdits: Array<{ id: string; name: string }>;
        remoteContent: WeeklyUpdateResponse | null;
      }
    | null;
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  // True while we're refetching server state to decide whether to show the
  // conflict warning. Disables the Generate/Regen buttons during that window
  // so the user can't spam click.
  const [preparingConfirm, setPreparingConfirm] = useState(false);

  // Ref to the outer .wu-inline element so a ResizeObserver can watch its
  // actual height (the parent panel-body's height is held constant by the
  // dashboard grid and doesn't shrink when content collapses).
  const wuInlineRef = useRef<HTMLDivElement>(null);
  // Ref to the editable content container (for DOM capture on save)
  const containerRef = useRef<HTMLDivElement>(null);
  // Mirror of `generated` for use inside debounce callbacks
  const generatedRef = useRef<WeeklyUpdateResponse | null>(null);
  // Last content we know the server has — seeded on mount from initialContent
  // and updated after every successful doSave. Used to detect divergence when
  // another user has edited the same panel in parallel: if the server's
  // current contentJson differs from this reference, someone else saved
  // between our last sync and now.
  const lastKnownSavedRef = useRef<WeeklyUpdateResponse | null>(null);
  // Debounce timer for edit-triggered saves
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which section the local user is currently focused on — prevents live sync
  // from overwriting text they're actively typing.
  const focusedSectionIdRef = useRef<string | null>(null);
  // Retry timer for one-shot retry after a failed save
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `isDirty` so the beforeunload listener always reads the latest
  // value without needing to re-register on every keystroke.
  const dirtyRef = useRef(false);
  // Tracks whether the component is still mounted, so setState calls that
  // resolve after an async generate/save/refetch can no-op safely if the
  // user navigated away during the round-trip.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Must re-assert true on setup: under React StrictMode (dev) the effect
    // runs setup→cleanup→setup, and without this the cleanup's `false` would
    // stick for the component's whole life, making every async guard bail
    // (e.g. Generate stuck on "Checking…", runGenerate never setGenerated).
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Monotonic counter bumped on every keystroke. doSave snapshots this at
  // PUT-send time; if it has advanced when the response lands, the user
  // typed during the round-trip and dirtyRef must stay true so the
  // beforeunload guard still fires the keepalive for those newer edits.
  // Cheap O(1) alternative to re-serializing the DOM on every save.
  const editVersionRef = useRef(0);

  // Keep generatedRef in sync whenever generated state changes
  useEffect(() => {
    generatedRef.current = generated;
  }, [generated]);

  // Clear any pending timers on unmount to prevent state updates
  // on an unmounted component.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  // ── Restore saved content on mount ──────────────────────────────────────────
  useEffect(() => {
    const cleaned = parseStoredPanelContent(initialContent ?? null);
    if (!cleaned) return;
    setGenerated(cleaned);
    generatedRef.current = cleaned;
    // Remember what was on the server at mount so later refetches can detect
    // edits that arrived from another client.
    lastKnownSavedRef.current = cleaned;
    const initialRag = new Map<string, RagStatus>();
    cleaned.released.forEach((s) => initialRag.set(s.id, 'green'));
    setRagStatuses(initialRag);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Section-level focus tracking for presence
  const handleSectionFocus = useCallback((sectionId: string) => {
    focusedSectionIdRef.current = sectionId;
    onEditingSection?.(sectionId);
  }, [onEditingSection]);

  // Clear presence when the user clicks outside the panel entirely.
  // mousedown is used instead of onBlur because relatedTarget is null for
  // non-focusable clicks and fires spuriously during typing.
  const onEditingEndRef = useRef(onEditingEnd);
  useEffect(() => { onEditingEndRef.current = onEditingEnd; }, [onEditingEnd]);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!focusedSectionIdRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(e.target as Node)) {
        focusedSectionIdRef.current = null;
        onEditingEndRef.current?.();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live sync helpers ────────────────────────────────────────────────────────

  // Register a remote-content handler with DashboardPage so the SSE
  // `panel.updated` push routes through this panel's smart merge logic
  // (applyRemoteContent skips the user's focused section). Without this
  // registration the SSE event would only update the panel row in
  // DashboardPage state, which WeeklyUpdatePanel ignores after mount.
  useEffect(() => {
    if (!panelId || !registerRemoteContentHandler) return;
    const handler = (contentJson: Record<string, unknown> | null) => {
      // If the user is currently focused on a section, applyRemoteContent
      // will skip that section to protect their typing. Mark the missed
      // flag so handleSectionBlur knows to refetch + reapply once focus
      // is released. We check focus *here* rather than inside the merge
      // because once the merge runs we've lost the information about
      // whether any section was skipped.
      if (focusedSectionIdRef.current !== null) {
        remoteUpdateMissedRef.current = true;
      }
      applyRemoteContentRef.current?.(contentJson, null);
    };
    registerRemoteContentHandler(panelId, handler);
    return () => registerRemoteContentHandler(panelId, null);
  }, [panelId, registerRemoteContentHandler]);

  // Stable ref to applyRemoteContent — the handler we registered above
  // is captured once and must always call the latest implementation.
  const applyRemoteContentRef = useRef<((cj: Record<string, unknown> | null, ids: Set<string> | null) => void) | null>(null);

  // True when one or more SSE-pushed updates arrived while the local user
  // was focused on the section they modified. applyRemoteContent skipped
  // those sections to avoid clobbering in-flight typing, so we owe the
  // user a fresh-from-server merge once focus is released. Set in the
  // registered SSE handler whenever it sees a focus skip; consumed by
  // handleSectionBlur which does a one-shot refetch + apply.
  const remoteUpdateMissedRef = useRef(false);

  // Merge remote sections into local state, skipping sections the local user is editing.
  // When `editorBarIds` is provided, only sections with an active remote editor are updated;
  // when null, all non-focused sections are replaced (used for the final post-edit fetch).
  const applyRemoteContent = useCallback((contentJson: Record<string, unknown> | null, editorBarIds: Set<string> | null) => {
    const remote = parseStoredPanelContent(contentJson ?? null);
    if (!remote) return;
    setGenerated((prev) => {
      if (!prev) return remote;
      const byId = new Map([...remote.released, ...remote.active].map((s) => [s.id, s]));
      const merge = (sections: WeeklyUpdateSection[]) =>
        sections.map((s) => {
          if (focusedSectionIdRef.current === s.id) return s;
          if (editorBarIds !== null && !editorBarIds.has(s.id)) return s;
          return byId.get(s.id) ?? s;
        });
      return { ...prev, released: merge(prev.released), active: merge(prev.active) };
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the ref-of-applyRemoteContent in sync so the SSE handler we
  // registered above always calls the current implementation. The handler
  // was captured once at registration time — going through the ref lets us
  // swap in a fresh closure if applyRemoteContent's deps ever expand.
  useEffect(() => {
    applyRemoteContentRef.current = applyRemoteContent;
  }, [applyRemoteContent]);

  // ── Live sync via SSE ────────────────────────────────────────────────────────
  // Cross-user content sync is now pushed from the server through
  // DashboardPage's EventSource (see useDashboardEvents.ts). When a peer
  // PUTs new content, the server publishes `panel.updated`, DashboardPage
  // refetches, and routes the new contentJson into the handler we registered
  // above — which calls applyRemoteContent. No polling effects required.
  //
  // `hasRemoteEditors` still drives section-level "is-being-edited" visuals
  // and is fed by the presence poll in DashboardPage (kept for that UX cue).
  const hasRemoteEditors = presenceEntries.length > 0;

  const hideSection = (id: string) => setHiddenIds((prev) => new Set([...prev, id]));
  const unhideAll = () => setHiddenIds(new Set());

  // Re-fire wu-normalised whenever the inline block can change size:
  //   - hiddenIds:           user hid/restored a section
  //   - activeFixVersionIds: dashboard fix-version filter changed
  //   - openSections:        subsection ticket-status dropdown toggled
  //   - generated / loading: fresh AI generate completed / in-flight
  // ResizeObserver alone misses these because the flex-allocated panel-body
  // height is held put by its parent; we dispatch `wu-normalised` after the
  // DOM commits so PanelCard re-measures and collapses trailing whitespace
  // (or un-clips new content after a generate).
  useEffect(() => {
    if (!containerRef.current) return;
    // Use rAF so the browser has laid out the new (shrunken) DOM before we
    // re-measure — measuring synchronously would still see the old height.
    const id = requestAnimationFrame(() => {
      containerRef.current?.dispatchEvent(
        new CustomEvent('wu-normalised', { bubbles: true }),
      );
    });
    return () => cancelAnimationFrame(id);
  }, [hiddenIds, activeFixVersionIds, openSections, generated, loading]);

  // Universal size-change watcher: any time .wu-inline's height actually
  // changes (typing into a contentEditable, regenerating a section into a
  // shorter summary, image insertion, etc.), tell the parent panel to
  // re-measure. The state-keyed effect above only fires when generated/hidden
  // change, which misses direct DOM edits — that's how a "very detailed →
  // very brief" regen left a tall empty gutter at the bottom of the card.
  useEffect(() => {
    const el = wuInlineRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (h === lastHeight) return;
      lastHeight = h;
      el.dispatchEvent(new CustomEvent('wu-normalised', { bubbles: true }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const setRag = (id: string, s: RagStatus) =>
    setRagStatuses((prev) => new Map([...prev, [id, s]]));
  // When a prop-supplied RAG map is present (DashboardPage wires this from the
  // Gantt's schedule logic), it is the source of truth: each section's RAG
  // matches the Gantt bar colour for the same fix version. Only fall back to
  // the legacy manual-cycle state when the prop isn't provided.
  const getRag = (id: string): RagStatus =>
    ragStatusByVersionId?.[id] ?? ragStatuses.get(id) ?? 'amber';
  // RAG is editable only for sections whose fix-version id is NOT present in
  // the external map. Checking the whole map for truthiness used to freeze
  // every badge as soon as `ragStatusByVersionId` was passed (even an empty
  // object), which wrongly disabled editing when the Gantt hadn't published
  // a status for that specific fix version yet.
  const ragEditable = (id: string): boolean =>
    !ragStatusByVersionId ||
    !Object.prototype.hasOwnProperty.call(ragStatusByVersionId, id);

  // ── Capture edited summaries from the DOM ───────────────────────────────────
  // Only the section summary paragraphs are user-editable; ticket rows
  // (.wu-item-text) are rendered read-only from Jira, so there's nothing to
  // capture for them.
  const captureEdits = (): WeeklyUpdateResponse | null => {
    const current = generatedRef.current;
    if (!current || !containerRef.current) return null;

    // Summary paragraphs keyed by section id
    const summaryMap: Record<string, string> = {};
    containerRef.current.querySelectorAll<HTMLElement>('[data-summary-for]').forEach((el) => {
      if (el.dataset.summaryFor) summaryMap[el.dataset.summaryFor] = sanitizeSummaryHtml(el.innerHTML);
    });

    const applyEdits = (s: WeeklyUpdateSection): WeeklyUpdateSection => ({
      ...s,
      summary: summaryMap[s.id] ?? s.summary,
    });

    return {
      ...current,
      released: current.released.map(applyEdits),
      active: current.active.map(applyEdits),
    };
  };


  // ── Persist to backend ───────────────────────────────────────────────────────
  // Retries once on failure: a single network blip shouldn't cost the user
  // their edit. Only after the retry also fails do we surface the error
  // indicator so they can decide what to do next.
  const doSave = async (data: WeeklyUpdateResponse, attempt = 0) => {
    if (!panelId || !onSave) return;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // Snapshot the edit version *before* the network call. If it advances
    // during the await (handleInput bumps it on every keystroke), the user
    // typed during the round-trip and the dirty flag must survive so
    // beforeunload still fires for the newer edits.
    const sentVersion = editVersionRef.current;
    setSaveStatus('saving');
    try {
      await onSave(panelId, { contentJson: data as unknown as Record<string, unknown> });
      // Record what's now on the server so we can detect remote edits the next
      // time Generate/Regen refetches. Take a structural clone so later in-memory
      // mutations don't retroactively flow into this reference copy.
      lastKnownSavedRef.current = JSON.parse(JSON.stringify(data)) as WeeklyUpdateResponse;
      if (!mountedRef.current) return;
      if (editVersionRef.current === sentVersion) {
        setIsDirty(false);
        dirtyRef.current = false;
      }
      setSaveStatus('saved');
      setTimeout(() => {
        if (!mountedRef.current) return;
        setSaveStatus((s) => (s === 'saved' ? 'idle' : s));
      }, 2500);
    } catch {
      if (!mountedRef.current) return;
      if (attempt < 1) {
        // First failure — schedule one retry after 3 s with the latest in-DOM
        // edits (a more recent change may have landed during the network call).
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (!mountedRef.current) return;
          const latest = captureEdits() ?? data;
          doSave(latest, attempt + 1);
        }, 3000);
        return;
      }
      // Show an error indicator for 4 s so the user knows the save failed,
      // then revert to idle so they can attempt to save again.
      setSaveStatus('error');
      setTimeout(() => {
        if (!mountedRef.current) return;
        setSaveStatus((s) => (s === 'error' ? 'idle' : s));
      }, 4000);
    }
  };

  // ── Flush a pending debounced save immediately ───────────────────────────────
  // Called from section blur and beforeunload so an edit that happens within
  // the 1.5 s debounce window isn't lost when the user moves focus elsewhere
  // or closes the tab.
  // Returns a promise that resolves once the flushed PUT finishes (or
  // resolves immediately if there was nothing to flush). Callers that
  // need to act *after* the server has the latest local content — e.g.
  // the deferred-remote-merge path in handleSectionBlur — should await
  // this so they don't race against an in-flight save.
  const flushPendingSave = (): Promise<void> => {
    if (!saveTimerRef.current) return Promise.resolve();
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const updated = captureEdits();
    if (!updated) return Promise.resolve();
    generatedRef.current = updated;
    return doSave(updated);
  };

  // Blur handler for the editable summary divs. Runs the existing
  // whitespace normaliser, flushes the debounce, then — if any remote
  // SSE update was missed while we held focus — refetches the latest
  // panel content and merges. We chain the refetch onto the flush
  // promise so a slow save can't return the server's pre-save state
  // and clobber the user's just-saved edit.
  const handleSectionBlur = async (e: React.FocusEvent<HTMLDivElement>) => {
    handleSummaryBlur(e);
    const savePromise = flushPendingSave();
    // Clear focus marker so applyRemoteContent stops protecting this
    // section. (It will be re-set by handleSectionFocus on the next
    // focus event — no double-clear risk.)
    focusedSectionIdRef.current = null;
    if (!remoteUpdateMissedRef.current || !panelId) return;
    remoteUpdateMissedRef.current = false;
    try {
      // Wait for the local PUT to land before fetching the server view —
      // otherwise we could race and merge pre-save content on top of the
      // edit we just persisted.
      await savePromise;
      const { contentJson } = await fetchPanelContent(slug, panelId);
      applyRemoteContentRef.current?.(contentJson, null);
    } catch { /* best-effort; next SSE event will resync */ }
  };

  // ── beforeunload safety net ──────────────────────────────────────────────────
  // If the user closes the tab / navigates while a debounced save is pending,
  // (a) warn them with the browser's native "leave page?" dialog and
  // (b) fire a best-effort keepalive PUT so the edit survives even if they
  //     confirm leaving. `keepalive: true` keeps the request in flight after
  //     the page is torn down — modern equivalent of sendBeacon for PUTs.
  //
  // Auth: pulled synchronously from the api module's cached access token
  // (refreshed on every regular apiFetch). We can't await MSAL during
  // unload — the browser cancels in-flight async work — so we rely on the
  // most recent token that flowed through the normal save path. If no
  // token is cached (impossible in practice if the user has been editing,
  // since editing implies prior authenticated saves) we skip the keepalive
  // — better than firing a guaranteed-401 request.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      const data = captureEdits() ?? generatedRef.current;
      const token = getCachedAccessToken();
      if (panelId && data) {
        if (!token) {
          // No cached token. Firing the PUT anyway would 401 silently — the
          // page is unloading so the user never sees the error and their
          // edit is just lost. Skip the keepalive instead, and surface a
          // console warning so this is at least diagnosable from devtools
          // / Sentry breadcrumbs if anyone reports lost edits.
          // eslint-disable-next-line no-console
          console.warn(
            '[WeeklyUpdatePanel] beforeunload: no cached access token; skipping keepalive PUT (edit may be lost).',
          );
        } else {
          try {
            fetch(`${apiBase}/api/dashboards/${slug}/panels/${panelId}/content`, {
              method: 'PUT',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ contentJson: data }),
              keepalive: true,
            }).catch(() => { /* best-effort; page is unloading */ });
          } catch { /* ignore — best-effort flush */ }
        }
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [slug, panelId]);

  // ── Generate ─────────────────────────────────────────────────────────────────
  // `snapshotOverride` lets callers pass an already-merged snapshot (e.g.
  // the result of `adoptRemoteBaseline`) to bypass a fresh `captureEdits()`.
  // This is important when we've JUST called `setGenerated(...)` — React
  // hasn't re-rendered yet, so `captureEdits()` would read stale DOM (showing
  // pre-adopt summaries) and overwrite the fresh remote-baseline summaries
  // we just adopted. Passing the merged snapshot directly avoids that race.
  const runGenerate = async (snapshotOverride?: WeeklyUpdateResponse) => {
    setLoading(true);
    setError(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      // Snapshot the user's in-DOM edits BEFORE the network call so any prose
      // they've typed survives a regenerate that refreshes structural data
      // (ticket counts, sub-sections, dates) around it.
      const snapshot = snapshotOverride ?? captureEdits() ?? generatedRef.current;
      const raw = await generateWeeklyUpdate(slug, activeFixVersionIds, undefined, {
        from: updateStart,
        to: updateEnd,
      });
      if (!mountedRef.current) return;
      // Escape plain-text summaries before storing — they are rendered via
      // innerHTML and could carry XSS payloads from the API.
      const fresh = escapeResponseSummaries(raw);
      // Merge: keep edited summaries for sections that still qualify, pick up
      // fresh summaries for newly-qualifying ones, drop those no longer in
      // the response.
      const merged = mergeWithEdits(fresh, snapshot);
      setIsDirty(false);
      dirtyRef.current = false;
      setHiddenIds(new Set());
      setGenerated(merged);
      generatedRef.current = merged;
      // Seed RAG for any section we haven't seen before — existing entries
      // (e.g. amber manually set by the user, or green for prior releases)
      // are preserved. Released sections default to green; active sections
      // fall through to getRag's amber default.
      setRagStatuses((prev) => {
        const next = new Map(prev);
        (merged.released ?? []).forEach((s) => {
          if (!next.has(s.id)) next.set(s.id, 'green');
        });
        return next;
      });
      // Autosave immediately
      doSave(merged);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to generate update';
      setError(msg);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // Refetch whatever this panel's contentJson is on the server right now.
  // Returns null if the panel has no stored content yet (first ever generate)
  // or if the fetch fails — callers treat null as "no remote edits to check".
  const refetchServerContent = async (): Promise<WeeklyUpdateResponse | null> => {
    if (!panelId) return null;
    try {
      const detail = await fetchDashboard(slug);
      const panel = detail.panels.find((p) => p.id === panelId);
      if (!panel) return null;
      return parseStoredPanelContent(panel.contentJson ?? null);
    } catch {
      // Network/API hiccup — fail-open rather than block the user.
      return null;
    }
  };

  // Clicking ✦ Generate opens the confirm modal. Actually running is deferred
  // to the modal's Confirm handler below. Before showing the modal we refetch
  // the server's current panel state and diff it against lastKnownSaved so we
  // can warn the user if another person has edited sections since our last
  // sync. mergeWithEdits preserves existing section prose, so normal modal
  // copy focuses on what *does* change (structural data, section lists,
  // status shifts) rather than "overwrite?".
  const handleGenerate = async () => {
    if (loading || regeneratingId || preparingConfirm) return;
    // Fast path: nothing generated yet → no edits to worry about, skip modal.
    if (!generated) {
      runGenerate();
      return;
    }
    setPreparingConfirm(true);
    try {
      const remoteContent = await refetchServerContent();
      if (!mountedRef.current) return;
      const remoteEdits = detectRemoteEdits(remoteContent, lastKnownSavedRef.current);
      setPendingConfirm({ type: 'generate', remoteEdits, remoteContent });
    } finally {
      if (mountedRef.current) setPreparingConfirm(false);
    }
  };

  // Clicking ↻ Regen on a section opens the same modal with regen-specific
  // copy. We look up the section name up-front so the modal can reference it,
  // and also refetch server state to check for concurrent-editor conflicts.
  const requestRegenerateSection = async (sectionId: string) => {
    if (regeneratingId || loading || preparingConfirm) return;
    const current = generatedRef.current;
    const section =
      current?.released.find((s) => s.id === sectionId) ||
      current?.active.find((s) => s.id === sectionId);
    if (!section) return;
    setPreparingConfirm(true);
    try {
      const remoteContent = await refetchServerContent();
      if (!mountedRef.current) return;
      const remoteEdits = detectRemoteEdits(remoteContent, lastKnownSavedRef.current);
      setPendingConfirm({
        type: 'regen',
        sectionId,
        sectionName: section.name,
        conciseness: 3,
        remoteEdits,
        remoteContent,
      });
    } finally {
      if (mountedRef.current) setPreparingConfirm(false);
    }
  };

  // Before running a confirmed Generate/Regen, fold any detected remote edits
  // into our local state so we don't clobber them. The flow:
  //   1. Snapshot the current DOM (our unsaved prose edits).
  //   2. Take the fresh server copy as the new baseline.
  //   3. Layer our DOM edits back on top — wins conflicts (they're what the
  //      user has right now).
  //   4. Set that as our `generated` state and bump lastKnownSavedRef so the
  //      follow-on save doesn't re-detect the same conflict.
  // No-op when remoteContent is null (fetch failed) or empty (no divergence).
  // Returns the merged snapshot (or null when there's nothing to adopt) so the
  // caller can hand it directly to runGenerate/regenerateSection as a
  // `snapshotOverride`. Without that, the follow-on captureEdits() would read
  // a still-stale DOM (React hasn't re-rendered yet after setGenerated) and
  // clobber the fresh remote summaries we just merged in.
  const adoptRemoteBaseline = (
    remoteContent: WeeklyUpdateResponse | null,
  ): WeeklyUpdateResponse | null => {
    if (!remoteContent) return null;
    const snapshot = captureEdits() ?? generatedRef.current;
    const merged = mergeWithEdits(remoteContent, snapshot);
    setGenerated(merged);
    generatedRef.current = merged;
    lastKnownSavedRef.current = JSON.parse(JSON.stringify(remoteContent)) as WeeklyUpdateResponse;
    return merged;
  };

  // ── Per-section regenerate ──────────────────────────────────────────────────
  // Refreshes a single fix version's data by hitting the same endpoint with a
  // one-element fixVersions filter. Unlike the full Generate flow, this one
  // intentionally overwrites the targeted section's summary — that IS the
  // point of the button. Other sections keep whatever the user has typed.
  // See `runGenerate` for the rationale behind `snapshotOverride` — same
  // stale-DOM race after `adoptRemoteBaseline` applies here.
  const regenerateSection = async (
    sectionId: string,
    conciseness: number = 3,
    snapshotOverride?: WeeklyUpdateResponse,
  ) => {
    if (regeneratingId) return;
    setRegeneratingId(sectionId);
    setError(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      const snapshot = snapshotOverride ?? captureEdits() ?? generatedRef.current;
      if (!snapshot) return;
      const raw = await generateWeeklyUpdate(slug, [sectionId], conciseness, {
        from: updateStart,
        to: updateEnd,
      });
      if (!mountedRef.current) return;
      const fresh = escapeResponseSummaries(raw);
      const freshSection =
        fresh.released.find((s) => s.id === sectionId) ||
        fresh.active.find((s) => s.id === sectionId);
      if (!freshSection) {
        setError('This fix version no longer qualifies for the weekly update.');
        return;
      }
      const isNowReleased = fresh.released.some((s) => s.id === sectionId);
      const wasReleased = snapshot.released.some((s) => s.id === sectionId);
      const replaceInPlace = (arr: WeeklyUpdateSection[]) =>
        arr.map((s) => (s.id === sectionId ? freshSection : s));
      const strip = (arr: WeeklyUpdateSection[]) => arr.filter((s) => s.id !== sectionId);
      let updated: WeeklyUpdateResponse;
      if (isNowReleased === wasReleased) {
        // Common case: section stays in the same array — replace in place so
        // ordering is preserved.
        updated = {
          ...snapshot,
          released: isNowReleased ? replaceInPlace(snapshot.released) : snapshot.released,
          active: isNowReleased ? snapshot.active : replaceInPlace(snapshot.active),
        };
      } else {
        // Rare case: the fix version changed category (e.g. got released
        // since the last full refresh). Move it between arrays — full Generate
        // is what restores the proper sort order.
        updated = {
          ...snapshot,
          released: isNowReleased
            ? [...strip(snapshot.released), freshSection]
            : strip(snapshot.released),
          active: isNowReleased ? strip(snapshot.active) : [...strip(snapshot.active), freshSection],
        };
      }
      setGenerated(updated);
      generatedRef.current = updated;
      doSave(updated);
      // Cross-user propagation is now handled by the SSE `panel.updated`
      // event emitted server-side from update_panel_content. Peers fetch
      // and merge automatically — no presence-ping workaround needed.
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to regenerate section';
      setError(msg);
    } finally {
      if (mountedRef.current) setRegeneratingId(null);
    }
  };

  // ── Debounced edit save ───────────────────────────────────────────────────────
  const handleInput = () => {
    if (!isDirty) setIsDirty(true);
    dirtyRef.current = true;
    // Bump the version on every keystroke. doSave compares the value
    // captured at PUT-send time against this one when the response lands
    // to decide whether the user typed during the round-trip — if so,
    // dirtyRef must stay true so beforeunload still fires for those edits.
    editVersionRef.current++;
    // Renew presence on every keystroke — cancels any pending stopEditing timer
    // so that spurious blur/focus events during typing don't drop the highlight.
    if (focusedSectionIdRef.current) {
      onEditingSection?.(focusedSectionIdRef.current);
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const updated = captureEdits();
      if (updated) {
        // Keep the ref in sync with user edits so that if a section remounts
        // (e.g. after hide/restore) it rehydrates from the latest edit, not
        // from stale generated data.
        generatedRef.current = updated;
        doSave(updated);
      }
    }, 1500);
  };

  const releasedSections = generated?.released ?? null;
  const activeSections = generated?.active ?? null;
  const dateRange = generated?.dateRange ?? null;
  const isGenerated = generated !== null;

  // Fix-version filter from the dashboard. Only applied when a non-empty list is
  // provided — an empty/undefined array means "no filter, show everything".
  const fixVersionFilter =
    activeFixVersionIds && activeFixVersionIds.length > 0
      ? new Set(activeFixVersionIds)
      : null;
  const matchesFilter = (id: string) => !fixVersionFilter || fixVersionFilter.has(id);

  const visibleReleased =
    releasedSections?.filter((s) => !hiddenIds.has(s.id) && matchesFilter(s.id)) ?? null;
  const visibleActive =
    activeSections?.filter((s) => !hiddenIds.has(s.id) && matchesFilter(s.id)) ?? null;

  // Released items that match the fix-version filter (before the manual hide
  // filter is applied). If this is empty we show a "no releases" message
  // rather than "all released items hidden", because the selected fix versions
  // genuinely had no recent releases.
  const releasedMatchingFilter =
    releasedSections?.filter((s) => matchesFilter(s.id)) ?? null;

  return (
    <>
      <div className="wu-inline" ref={wuInlineRef}>
        {/* ── Action bar ── */}
        <div className="wu-inline-actions">
          <span className="wu-inline-meta">
            {dateRange ?? 'Click Generate to build the update from live Jira data'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SaveIndicator status={saveStatus} />
            {hiddenIds.size > 0 && (
              <button className="wu-unhide-btn" onClick={unhideAll}>
                {hiddenIds.size} hidden · restore all
              </button>
            )}
            {onPresent && canPresent && (
              <button
                className="wu-btn-present"
                onClick={onPresent}
                title="Present the update and rich-text panels as a full-screen slide deck"
              >
                ▷ Present
              </button>
            )}
            <button
              className="wu-btn-generate"
              onClick={handleGenerate}
              disabled={loading || preparingConfirm}
            >
              {loading ? '⏳ Generating…' : preparingConfirm ? '⏳ Checking…' : '✦ Generate Summaries'}
            </button>
          </div>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div style={{
            marginTop: 10, padding: '8px 12px',
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, color: '#f87171', fontSize: 12,
          }}>
            {error}
          </div>
        )}

        {/* ── Loading ── */}
        {loading && (
          <div style={{
            marginTop: 16, padding: '24px', textAlign: 'center',
            color: '#64748b', fontSize: 13,
            background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)',
            borderRadius: 10,
          }}>
            Fetching Jira data and generating summaries…
          </div>
        )}

        {!loading && !isGenerated && (
          <div style={{
            marginTop: 32, padding: '32px 24px', textAlign: 'center',
            color: '#374151', fontSize: 13,
            border: '1px dashed #1e2230', borderRadius: 12,
          }}>
            No update generated yet — click <strong style={{ color: '#6366f1' }}>✦ Generate Summaries</strong> to pull live Jira data.
          </div>
        )}

        {!loading && isGenerated && (
          <div ref={containerRef} onInput={handleInput}>
            <div className="wu-edit-hint" style={{ marginTop: 12 }}>
              ✦ Generated from live Jira — click summaries to edit
            </div>

            {/* ── Recently released (within the selected window) ── */}
            <div className="wu-released-section">
              <div className="wu-released-label">
                <div className="wu-released-dot" />
                Recently released
              </div>

              {visibleReleased && visibleReleased.length > 0 ? (
                visibleReleased.map((rel) => {
                  const relEditors = presenceEntries
                    .filter((e) => e.barId === rel.id)
                    .map((e) => ({ accountId: e.accountId, displayName: e.displayName, avatarUrl: e.avatarUrl }));
                  return (
                  <div
                    key={rel.id}
                    className={`wu-released-item${relEditors.length > 0 ? ' is-being-edited' : ''}`}
                    style={relEditors.length > 0 ? { '--presence-colour': WU_PRESENCE_COLOURS[(relEditors.length - 1) % WU_PRESENCE_COLOURS.length] } as React.CSSProperties : undefined}
                    onFocus={(e) => {
                      if ((e.target as HTMLElement).isContentEditable) handleSectionFocus(rel.id);
                    }}
                  >
                    <button
                      type="button"
                      className={`wu-regen-btn${regeneratingId === rel.id ? ' is-spinning' : ''}`}
                      onClick={() => requestRegenerateSection(rel.id)}
                      disabled={
                        loading ||
                        preparingConfirm ||
                        (regeneratingId !== null && regeneratingId !== rel.id)
                      }
                      title={regeneratingId === rel.id ? 'Regenerating…' : 'Regenerate this section from live Jira data'}
                      aria-label={`Regenerate ${rel.name}`}
                    >
                      <span className="wu-regen-btn-icon" aria-hidden="true">↻</span>
                      {regeneratingId === rel.id ? 'Regen…' : 'Regen'}
                    </button>
                    <button className="wu-hide-btn" onClick={() => hideSection(rel.id)} title="Hide from summary">Hide</button>
                    <div className="wu-section-header">
                      <a className="wu-section-name wu-section-name--released" href={rel.href} target="_blank" rel="noreferrer">
                        {rel.name}<LinkIcon />
                      </a>
                      <span className="wu-badge wu-badge--released">Released</span>
                      <div className="wu-divider-line" />
                      {rel.releasedDate && (
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#4ade80', whiteSpace: 'nowrap' }}>
                          Released {rel.releasedDate}
                        </span>
                      )}
                    </div>
                    <SummaryParagraph
                      sectionId={rel.id}
                      initialHtml={rel.summary}
                      onBlur={handleSectionBlur}
                    />
                    {rel.subSections.length > 0 && (
                      <div className="wu-ticket-count-row">
                        <TicketCount todo={rel.ticketTodo} total={rel.ticketTotal} />
                      </div>
                    )}
                    {rel.subSections.map((ss) => (
                      <SubSection key={ss.id} data={ss} open={openSections.has(ss.id)} onToggle={() => toggle(ss.id)} />
                    ))}
                  </div>
                  );
                })
              ) : releasedMatchingFilter && releasedMatchingFilter.length === 0 ? (
                <p style={{ fontSize: 12, color: '#4b5563', margin: '8px 0 0' }}>No releases in the selected period.</p>
              ) : (
                <p style={{ fontSize: 12, color: '#4b5563', margin: '8px 0 0' }}>All released items hidden.</p>
              )}
            </div>

            {/* ── Active fix versions ── */}
            <div className="wu-columns">
              {(visibleActive ?? []).map((section) => (
                <SectionView
                  key={section.id}
                  section={section}
                  openSections={openSections}
                  toggle={toggle}
                  onHide={hideSection}
                  ragStatus={getRag(section.id)}
                  onRagChange={ragEditable(section.id) ? setRag : undefined}
                  onRegenerate={requestRegenerateSection}
                  isRegenerating={regeneratingId === section.id}
                  regenDisabled={
                    loading ||
                    preparingConfirm ||
                    (regeneratingId !== null && regeneratingId !== section.id)
                  }
                  editors={presenceEntries
                    .filter((e) => e.barId === section.id)
                    .map((e) => ({ accountId: e.accountId, displayName: e.displayName, avatarUrl: e.avatarUrl }))}
                  onSummaryFocus={() => handleSectionFocus(section.id)}
                  onSummaryBlur={handleSectionBlur}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Confirmation modal ── */}
      {pendingConfirm && pendingConfirm.type === 'generate' && (
        <ConfirmModal
          title="Refresh from live Jira?"
          body={
            <>
              {pendingConfirm.remoteEdits.length > 0 && (
                <RemoteEditsWarning edits={pendingConfirm.remoteEdits} />
              )}
              This will pull fresh ticket data, dates, and sub-section lists.
              Your edited section prose will be preserved. Any sections that
              no longer qualify (e.g. released more than two weeks ago) will
              be dropped, and any newly-qualifying sections will be added.
            </>
          }
          confirmLabel="Generate"
          onConfirm={() => {
            const remote = pendingConfirm.remoteContent;
            setPendingConfirm(null);
            // Pass the merged snapshot straight into runGenerate so it doesn't
            // re-read still-stale DOM (React hasn't re-rendered the adopted
            // baseline yet). Falls through to captureEdits() when adopt is a
            // no-op (no remote content fetched).
            const merged = adoptRemoteBaseline(remote);
            runGenerate(merged ?? undefined);
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
      {pendingConfirm && pendingConfirm.type === 'regen' && (
        <ConfirmModal
          title={`Regenerate "${pendingConfirm.sectionName}"?`}
          body={
            <>
              {pendingConfirm.remoteEdits.some((e) => e.id === pendingConfirm.sectionId) && (
                <RemoteEditsWarning
                  edits={pendingConfirm.remoteEdits.filter((e) => e.id === pendingConfirm.sectionId)}
                  targetSectionId={pendingConfirm.sectionId}
                />
              )}
              This will replace the current summary for this section only with
              a fresh AI-generated one from live Jira data. Other sections are
              unaffected. Any prose you've typed in this section will be lost.
              <div className="wu-conciseness-control">
                <label className="wu-conciseness-control-label">Update length</label>
                <div className="wu-conciseness-options">
                  {([1, 2, 3, 4, 5] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`wu-conciseness-option${pendingConfirm.conciseness === v ? ' is-active' : ''}`}
                      onClick={() => setPendingConfirm((prev) =>
                        prev?.type === 'regen' ? { ...prev, conciseness: v } : prev
                      )}
                    >
                      {CONCISENESS_LABELS[v]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          }
          confirmLabel="Regenerate"
          onConfirm={() => {
            const sectionId = pendingConfirm.sectionId;
            const remote = pendingConfirm.remoteContent;
            const sectionConciseness = pendingConfirm.conciseness;
            setPendingConfirm(null);
            // See runGenerate's confirm handler above for why we thread the
            // merged snapshot through instead of relying on captureEdits().
            const merged = adoptRemoteBaseline(remote);
            regenerateSection(sectionId, sectionConciseness, merged ?? undefined);
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </>
  );
};

export default WeeklyUpdatePanel;
