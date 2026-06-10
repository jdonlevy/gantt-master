/**
 * Custom TipTap Image extension with lightbox + remove-button support.
 *
 * Replaces the default @tiptap/extension-image so that:
 *   - Each image is wrapped in a <span class="rsz-img"> so we can anchor
 *     the remove-button overlay. The image itself is not resizable by
 *     the user — it renders at its natural size, capped to the
 *     container width by CSS `max-width: 100%`.
 *   - A hover-revealed remove button (styled via `.rsz-img-remove`) lets
 *     the user delete the image.
 *   - The inner <img> carries the data-lightbox marker so the global
 *     ImageLightbox component picks up clicks and shows the full image.
 *
 * Width/height attrs are still parsed from older saved docs so they
 * round-trip without errors, but they are no longer applied to the
 * wrapper — the resize feature has been removed.
 */
import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';

export const ResizableImage = Image.extend({
  name: 'image',

  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      // Kept as passive attributes so older saved docs still parse. We
      // no longer render these onto the DOM — the image renders at its
      // natural size (capped by max-width: 100%).
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          if (element.tagName === 'SPAN') {
            const w = parseInt(element.style?.width || '', 10);
            return Number.isFinite(w) ? w : null;
          }
          const attr = element.getAttribute('width');
          return attr ? parseInt(attr, 10) : null;
        },
        renderHTML: () => ({}),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          if (element.tagName === 'SPAN') {
            const h = parseInt(element.style?.height || '', 10);
            return Number.isFinite(h) ? h : null;
          }
          const attr = element.getAttribute('height');
          return attr ? parseInt(attr, 10) : null;
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        // Preferred: our own wrapper span (backwards-compat with the
        // older data-resizable-image attribute on saved docs).
        tag: 'span[data-resizable-image]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const img = node.querySelector('img');
          if (!img) return false;
          return {
            src: img.getAttribute('src') || '',
            alt: img.getAttribute('alt'),
            title: img.getAttribute('title'),
          };
        },
      },
      {
        // Fallback: a bare <img>.
        tag: 'img[src]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // Keep data-resizable-image so parseHTML still recognises the span
    // on round-trips, even though we no longer resize.
    const imgAttrs = { ...HTMLAttributes };
    delete (imgAttrs as Record<string, unknown>).width;
    delete (imgAttrs as Record<string, unknown>).height;

    return [
      'span',
      {
        class: 'rsz-img',
        'data-resizable-image': '',
        // tabindex makes the wrapper focusable so keyboard users can reach
        // the hover-revealed remove button via the focus-within CSS rule.
        tabindex: '0',
      },
      [
        'img',
        mergeAttributes(imgAttrs, {
          'data-lightbox': '1',
        }),
      ],
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const span = document.createElement('span');
      span.className = 'rsz-img';
      span.setAttribute('data-resizable-image', '');
      // Focusable so keyboard users can tab onto the wrapper and reach
      // the hover-revealed remove button via :focus-within. Mirrors the
      // static renderHTML output.
      span.setAttribute('tabindex', '0');

      const img = document.createElement('img');
      img.src = node.attrs.src || '';
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.title) img.title = node.attrs.title;
      img.setAttribute('data-lightbox', '1');
      span.appendChild(img);

      // Remove button: small × in the top-right corner of the image.
      // Hidden by default, revealed on hover via CSS (.rsz-img:hover
      // .rsz-img-remove). Clicking deletes the image node from the
      // editor's document.
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rsz-img-remove';
      removeBtn.setAttribute('aria-label', 'Remove image');
      removeBtn.setAttribute('contenteditable', 'false');
      removeBtn.textContent = '\u00d7';
      // Prevent the click from reaching the image (which would open the
      // lightbox) or from moving the ProseMirror selection into the node.
      const onRemoveMouseDown = (event: Event) => {
        event.preventDefault();
      };
      const onRemoveClick = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor
          .chain()
          .focus()
          .command(({ tr, dispatch }) => {
            tr.delete(pos, pos + node.nodeSize);
            if (dispatch) dispatch(tr);
            return true;
          })
          .run();
      };
      removeBtn.addEventListener('mousedown', onRemoveMouseDown);
      removeBtn.addEventListener('click', onRemoveClick);
      span.appendChild(removeBtn);

      return {
        dom: span,
        update(updatedNode) {
          // Reject non-image updates (ProseMirror will then destroy this
          // NodeView and create a fresh one for the new node type).
          if (updatedNode.type.name !== 'image') return false;

          // Read every attribute we care about off `updatedNode.attrs`
          // rather than the outer `node` closure. The closure is captured
          // once at construction and never refreshed — if we only diffed
          // against it, an edit that swaps the image to a new src and back
          // again (a→b→a) would leave the DOM showing `b`, and alt/title
          // changes would never propagate at all.
          const nextSrc = (updatedNode.attrs.src as string | null) ?? '';
          const nextAlt = (updatedNode.attrs.alt as string | null) ?? '';
          const nextTitle = (updatedNode.attrs.title as string | null) ?? '';

          if (img.getAttribute('src') !== nextSrc) img.src = nextSrc;
          if ((img.getAttribute('alt') ?? '') !== nextAlt) {
            if (nextAlt) img.alt = nextAlt;
            else img.removeAttribute('alt');
          }
          if ((img.getAttribute('title') ?? '') !== nextTitle) {
            if (nextTitle) img.title = nextTitle;
            else img.removeAttribute('title');
          }
          return true;
        },
        destroy() {
          removeBtn.removeEventListener('mousedown', onRemoveMouseDown);
          removeBtn.removeEventListener('click', onRemoveClick);
        },
      };
    };
  },
});

export default ResizableImage;
