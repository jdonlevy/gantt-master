/**
 * Global image lightbox.
 *
 * Listens for clicks on images inside content areas (AI summary paragraphs
 * and rich-text panel editors) and displays them full-size in a portal
 * overlay. Click anywhere or press Escape to close.
 *
 * Mounted once at DashboardPage root so a single instance serves every
 * image on the page.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// CSS selectors that scope which images should open the lightbox. Toolbar
// icons, avatars, and other chrome are excluded by requiring the click
// target to be inside one of these containers.
const LIGHTBOX_CONTAINER_SELECTOR = '.wu-section-summary, .panel-editor';

export const ImageLightbox: React.FC = () => {
  const [src, setSrc] = useState<string | null>(null);
  const [alt, setAlt] = useState<string>('');
  // Remember which element had focus before we opened the lightbox so we
  // can return focus there when the dialog closes (WCAG 2.4.3 focus order).
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const openFromElement = (img: HTMLImageElement, trigger: HTMLElement) => {
      lastFocusedRef.current = trigger;
      setSrc(img.currentSrc || img.src);
      setAlt(img.alt || '');
    };

    const handleClick = (event: MouseEvent) => {
      // Ignore non-primary clicks and modifier-held clicks (ctrl/cmd-click to
      // open in new tab should still work via the native behaviour).
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (!target) return;
      const img = target.closest('img') as HTMLImageElement | null;
      if (!img) return;
      if (!img.closest(LIGHTBOX_CONTAINER_SELECTOR)) return;

      event.preventDefault();
      event.stopPropagation();
      openFromElement(img, target);
    };

    // Keyboard activation: Enter / Space on a focused image (or a
    // focusable ancestor like the .rsz-img wrapper) should open the
    // lightbox, mirroring the click handler above. Without this, users
    // who can't use a mouse have no way to enlarge images.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (!target) return;

      // Direct image focus (rare; imgs aren't tabbable by default) or a
      // focused wrapper that contains exactly one image.
      let img: HTMLImageElement | null = null;
      if (target instanceof HTMLImageElement) {
        img = target;
      } else if (target.matches?.('span.rsz-img')) {
        img = target.querySelector('img');
      }
      if (!img) return;
      if (!img.closest(LIGHTBOX_CONTAINER_SELECTOR)) return;

      event.preventDefault();
      event.stopPropagation();
      openFromElement(img, target);
    };

    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  // Focus management: when the dialog opens, move focus to the close
  // button so keyboard users can dismiss it. When it closes, restore
  // focus to the element that opened it.
  useEffect(() => {
    if (!src) return;
    const previouslyFocused = lastFocusedRef.current;
    // Wait a tick for the portal to mount before focusing.
    const raf = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus();
        } catch {
          /* no-op — focusable may have been removed from DOM */
        }
      }
    };
  }, [src]);

  useEffect(() => {
    if (!src) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSrc(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src]);

  // ── Normaliser for .rsz-img wrappers outside TipTap ──
  // Image resizing was removed, but the AI summary contentEditables still
  // need two things for previously-saved and freshly-inserted images:
  //   1. A remove button injected into any wrapper that lacks one.
  //   2. Cleanup of inline styles left over from the old resize era
  //      (inline `resize`, `width`, `height`, `aspect-ratio`, and inner
  //      `<img>` width/height) — inline styles beat class styles, so
  //      without clearing them, old saved images would still try to
  //      resize/stretch despite the CSS class rules having changed.
  //
  // TipTap's NodeView handles rich-text panels, so wrappers inside a
  // `.ProseMirror` tree are skipped here.
  useEffect(() => {
    const normalise = (span: HTMLElement) => {
      if (span.closest('.ProseMirror')) return; // TipTap NodeView owns those

      // Clear any leftover resize-era inline styles on the wrapper.
      if (span.style.resize) span.style.resize = '';
      if (span.style.width) span.style.width = '';
      if (span.style.height) span.style.height = '';
      if (span.style.aspectRatio) span.style.aspectRatio = '';
      if (span.style.overflow) span.style.overflow = '';

      // Ensure the wrapper is focusable so keyboard users can tab onto it
      // and reveal the remove button via the :focus-within CSS rule. Skip
      // updating if the user has already overridden tabindex with a
      // non-empty value.
      if (!span.hasAttribute('tabindex')) {
        span.setAttribute('tabindex', '0');
      }

      // Same for the inner <img>: old inserts wrote width:100%/height:auto
      // or height:100% + object-fit. Clear those so the image renders at
      // its natural size, capped by CSS max-width:100%.
      const img = span.querySelector('img') as HTMLImageElement | null;
      if (img) {
        if (img.style.width) img.style.width = '';
        if (img.style.height) img.style.height = '';
        if (img.style.objectFit) img.style.objectFit = '';
      }

      // Only expose the remove button inside editable summaries. In read-only
      // view mode there's no persistence path for the removal (see the click
      // handler below which needs a `contenteditable="true"` ancestor to
      // dispatch an input event), and without this guard a click on the "×"
      // button would still strip the image from the DOM — making view mode
      // transiently editable until the next React rerender. If a stale
      // button is already present on a now-read-only wrapper, drop it.
      const inEditable = !!span.closest('[contenteditable="true"]');
      const existingBtn = span.querySelector(':scope > .rsz-img-remove');
      if (inEditable) {
        if (!existingBtn) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'rsz-img-remove';
          btn.setAttribute('contenteditable', 'false');
          btn.setAttribute('aria-label', 'Remove image');
          btn.textContent = '\u00d7';
          span.appendChild(btn);
        }
      } else if (existingBtn) {
        existingBtn.remove();
      }
    };

    // Initial sweep: any .rsz-img already in the DOM.
    document.querySelectorAll<HTMLElement>('span.rsz-img').forEach(normalise);

    // Catch newly-inserted .rsz-img wrappers (e.g. after pasting an image
    // into an AI summary) that may arrive after the initial sweep.
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches?.('span.rsz-img')) normalise(node);
          node.querySelectorAll?.<HTMLElement>('span.rsz-img').forEach(normalise);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Global click handler for the remove button on .rsz-img wrappers
    // that live outside ProseMirror (i.e. AI summary contentEditables).
    // TipTap's own NodeView wires its remove-button click internally, so
    // we skip any button inside a .ProseMirror tree here.
    const onRemoveClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest<HTMLElement>('.rsz-img-remove');
      if (!btn) return;
      if (btn.closest('.ProseMirror')) return; // NodeView handles it
      event.preventDefault();
      event.stopPropagation();
      const span = btn.closest<HTMLElement>('span.rsz-img');
      if (!span) return;
      // Walk up to the nearest contentEditable host so we can fire an
      // input event on it after the DOM change. handleSummaryBlur /
      // handleSummaryPaste / the React input handlers on that div then
      // see the updated innerHTML and persist the removal. Without a
      // contenteditable host we're in view mode — bail out before
      // touching the DOM so a stale/injected button can't make view
      // mode transiently editable.
      let host: HTMLElement | null = span.parentElement;
      while (host && host.getAttribute?.('contenteditable') !== 'true') {
        host = host.parentElement;
      }
      if (!host) return;
      span.remove();
      host.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // Capture phase so we intercept before the existing lightbox click
    // handler (which runs in capture and would otherwise cancel).
    document.addEventListener('click', onRemoveClick, true);

    return () => {
      document.removeEventListener('click', onRemoveClick, true);
      // Defensive: ensure observer is always disconnected on unmount, even if
      // a future edit refactors the click handler removal above to throw.
      try {
        observer.disconnect();
      } catch {
        /* no-op */
      }
    };
  }, []);

  if (!src) return null;

  return createPortal(
    <div className="image-lightbox" onClick={() => setSrc(null)} role="dialog" aria-modal="true" aria-label="Enlarged image">
      <img src={src} alt={alt} className="image-lightbox__img" onClick={(e) => e.stopPropagation()} />
      <button
        ref={closeButtonRef}
        type="button"
        className="image-lightbox__close"
        onClick={() => setSrc(null)}
        aria-label="Close"
      >
        ×
      </button>
    </div>,
    document.body,
  );
};

export default ImageLightbox;
