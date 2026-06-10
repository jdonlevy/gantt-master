import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Strike from '@tiptap/extension-strike';
import { ResizableImage } from '../tiptap/ResizableImage';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextStyle from '@tiptap/extension-text-style';
import type { Level } from '@tiptap/extension-heading';
import { Node as TiptapNode, type CommandProps } from '@tiptap/core';
import { DashboardPanel } from '../types';
import { ColourPicker } from './ColourPicker';

type StatusPillAttrs = {
  status: string;
  label: string;
  color: string;
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    statusPill: {
      insertStatusPill: (attrs: StatusPillAttrs) => ReturnType;
    };
    fontSize: {
      setFontSize: (size: number | null) => ReturnType;
    };
  }
}
const hexToRgba = (hex: string, alpha: number) => {
  const sanitized = hex.replace('#', '');
  if (sanitized.length !== 6) return `rgba(34, 197, 94, ${alpha})`;
  const r = parseInt(sanitized.slice(0, 2), 16);
  const g = parseInt(sanitized.slice(2, 4), 16);
  const b = parseInt(sanitized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const StatusPill = TiptapNode.create({
  name: 'statusPill',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      status: { default: 'done' },
      label: { default: 'Done' },
      color: { default: '#22c55e' }
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-status-pill]' }];
  },
  renderHTML({ node }) {
    const color = node.attrs.color || '#22c55e';
    const bg = hexToRgba(color, 0.18);
    return [
      'span',
      {
        'data-status-pill': '',
        'data-status': node.attrs.status,
        class: `status-pill`,
        style: `border-color: ${color}; color: ${color}; background-color: ${bg};`
      },
      node.attrs.label
    ];
  },
  addCommands() {
    return {
      insertStatusPill:
        (attrs: StatusPillAttrs) =>
        ({ commands }: CommandProps) =>
          commands.insertContent({ type: this.name, attrs })
    };
  }
});

const editorExtensions = [
  StarterKit,
  Underline,
  Strike,
  TextStyle,
  Link.configure({ openOnClick: false }),
  ResizableImage,
  TaskList,
  TaskItem.configure({ nested: true }),
  StatusPill
];

const FontSize = TiptapNode.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize?.replace('px', '') || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}px` } : {}
          }
        }
      }
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (size: number | null) =>
        ({ chain }: CommandProps) =>
          size ? chain().setMark('textStyle', { fontSize: size }).run() : chain().setMark('textStyle', { fontSize: null }).run()
    };
  }
});

const fontSizeOptions = [
  { id: 'xs', label: 'Extra Small', value: 12 },
  { id: 'sm', label: 'Small', value: 14 },
  { id: 'md', label: 'Medium', value: 16 },
  { id: 'lg', label: 'Large', value: 18 },
  { id: 'xl', label: 'Extra Large', value: 22 }
];

const statusOptions = [
  { id: 'done', label: 'Done' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' }
];

type RichTextPanelProps = {
  panel: DashboardPanel;
  editable: boolean;
  onSave: (panelId: string, payload: { contentJson?: Record<string, unknown>; contentHtml?: string }) => Promise<void>;
  bodyRef?: React.RefObject<HTMLDivElement>;
  showToolbar?: boolean;
  onSaveStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
  onRegisterSave?: (handler: () => Promise<void>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

export const RichTextPanel: React.FC<RichTextPanelProps> = ({
  panel,
  editable,
  onSave,
  bodyRef,
  showToolbar = true,
  onSaveStateChange,
  onRegisterSave,
  onFocus,
  onBlur,
}) => {
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [labelText, setLabelText] = useState('Done');
  const [labelColor, setLabelColor] = useState('#22c55e');
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [openMenu]);

  const content = useMemo(() => {
    if (panel.contentJson && Object.keys(panel.contentJson).length) {
      return panel.contentJson;
    }
    if (panel.contentHtml) {
      return panel.contentHtml;
    }
    return '';
  }, [panel.contentHtml, panel.contentJson]);

  const editor = useEditor({
    extensions: [...editorExtensions, FontSize],
    content,
    editable,
    onUpdate: () => {
      if (!dirty) {
        setDirty(true);
      }
    }
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // Paste / drag-drop image support.
  //
  // Files dropped onto the editor or pasted from the clipboard are converted
  // to base64 data URLs and inserted as <img> nodes. No backend upload is
  // performed — the image travels inline inside the panel's saved content.
  // This keeps the feature self-contained for the POC but inflates stored
  // content size; a future productionisation step should replace this with
  // an upload endpoint that stores the file and inserts a URL reference.
  useEffect(() => {
    if (!editor || !editable) return;
    const dom = editor.view.dom;

    // Images are stored inline as base64 data URLs, so an unbounded paste
    // can easily push a single panel into the multi-MB range. 2 MB is a
    // reasonable upper bound for screenshot-sized content while still
    // blocking obviously-too-big photos/PDF screenshots.
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

    // Insert an image file at an optional doc position. If no position is
    // supplied we fall back to the current selection, which is the natural
    // behaviour for paste (no cursor coords) and for programmatic inserts.
    const insertFromFile = (file: File, pos?: number) => {
      if (file.size > MAX_IMAGE_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        // Lightweight, non-blocking surface: window.alert is consistent
        // with how other editor-level errors are reported in this POC.
        // eslint-disable-next-line no-alert
        window.alert(
          `Image is ${mb} MB which exceeds the 2 MB inline limit. ` +
            `Please reduce the file size or link to the image instead.`
        );
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result;
        if (typeof src !== 'string') return;
        if (typeof pos === 'number') {
          // Drop path: place the image exactly under the mouse rather than
          // at wherever the caret happened to be when the drag started.
          editor
            .chain()
            .focus()
            .insertContentAt(pos, { type: 'image', attrs: { src } })
            .run();
        } else {
          editor.chain().focus().setImage({ src }).run();
        }
      };
      reader.readAsDataURL(file);
    };

    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file || !file.type.startsWith('image/')) continue;
        event.preventDefault();
        insertFromFile(file);
        return;
      }
    };

    const handleDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files || !files.length) return;
      const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
      if (!imageFile) return;
      event.preventDefault();
      // posAtCoords maps an (x, y) pixel pair to a document position. When
      // the drop lands outside any node (e.g. beyond the last paragraph)
      // it returns null — in that case we fall back to current-selection
      // insertion, matching the paste behaviour.
      const coords = editor.view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });
      insertFromFile(imageFile, coords?.pos);
    };

    dom.addEventListener('paste', handlePaste);
    dom.addEventListener('drop', handleDrop);
    return () => {
      dom.removeEventListener('paste', handlePaste);
      dom.removeEventListener('drop', handleDrop);
    };
  }, [editor, editable]);

  // Serialised snapshot of whatever we most recently hydrated into the
  // editor (initial mount, post-save echo, or remote SSE update). Used to
  // dedupe the parent's `panel` re-render that follows every save — the
  // useMemo below produces a new `content` reference even when the JSON is
  // identical, and without this guard the sync effect would re-hydrate the
  // editor on its own save response and clobber any keystrokes that landed
  // during the round-trip.
  const lastAppliedContentRef = useRef<string>('');

  // Initial hydration on editor mount / panel switch. Always re-seeds so a
  // user switching panels sees the new panel's content immediately.
  useEffect(() => {
    if (!editor) return;
    if (!content) {
      editor.commands.clearContent();
      lastAppliedContentRef.current = '';
      setDirty(false);
      return;
    }
    editor.commands.setContent(content, false);
    lastAppliedContentRef.current = JSON.stringify(content);
    setDirty(false);
    // `content` / `contentJson` intentionally omitted: this effect is the
    // mount/panel-switch hydration pass. Per-change remote updates are
    // handled by the SSE-driven effect below, which uses
    // `lastAppliedContentRef` to guard against re-application loops on the
    // server's post-save echo. Listing `content` here would re-fire on
    // every parent re-render and clobber in-flight keystrokes.
  }, [editor, panel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // React to remote content changes pushed via SSE (DashboardPage updates
  // the panel row → useMemo recomputes `content` → this effect runs).
  // Gated on clean local state: if the user has unsaved edits in progress
  // (`dirty`) or a save is mid-flight (`saving`), we skip rather than
  // clobber in-flight typing. The lastAppliedContentRef check also prevents
  // re-hydration on the parent's post-save re-render when the new content
  // is structurally identical to what we just put in the editor.
  useEffect(() => {
    if (!editor) return;
    if (dirty || saving) return;
    const next = content ? JSON.stringify(content) : '';
    if (next === lastAppliedContentRef.current) return;
    if (!content) {
      editor.commands.clearContent();
    } else {
      editor.commands.setContent(content, false);
    }
    lastAppliedContentRef.current = next;
  }, [editor, content, dirty, saving]);

  useEffect(() => {
    if (!onSaveStateChange) return;
    onSaveStateChange({ dirty, saving });
  }, [dirty, saving, onSaveStateChange]);

  const handleSave = useCallback(async () => {
    if (!editor) return;
    setSaving(true);
    setDirty(false);
    const json = editor.getJSON();
    try {
      await onSave(panel.id, {
        contentJson: json,
        contentHtml: editor.getHTML()
      });
      // Record what we just persisted so the parent's follow-up re-render
      // (which produces a new `content` reference with structurally-equal
      // JSON) doesn't trigger a re-hydration that would wipe any
      // keystrokes the user typed during the save round-trip.
      lastAppliedContentRef.current = JSON.stringify(json);
    } finally {
      setSaving(false);
    }
  }, [editor, onSave, panel.id]);

  useEffect(() => {
    if (!onRegisterSave) return;
    onRegisterSave(async () => {
      await handleSave();
    });
  }, [onRegisterSave, handleSave]);

  const insertStatus = (status: string, labelOverride?: string, colorOverride?: string) => {
    if (!editor) return;
    const label = labelOverride ?? labelText;
    const color = colorOverride ?? labelColor;
    editor.chain().focus().command(({ tr }) => {
      tr.insertText('');
      return true;
    }).run();
    editor.commands.insertStatusPill({ status, label: label || status, color });
    setOpenMenu(null);
  };

  const insertImage = () => {
    if (!editor) return;
    const url = window.prompt('Image URL');
    if (!url) return;
    editor.chain().focus().setImage({ src: url }).run();
    setOpenMenu(null);
  };

  const applyHeading = (level: Level | null) => {
    if (!editor) return;
    if (!level) {
      editor.chain().focus().setParagraph().run();
      setOpenMenu(null);
      return;
    }
    editor.chain().focus().toggleHeading({ level }).run();
    setOpenMenu(null);
  };

  const applyList = (type: 'bullet' | 'ordered' | 'task') => {
    if (!editor) return;
    if (type === 'bullet') {
      editor.chain().focus().toggleBulletList().run();
    } else if (type === 'ordered') {
      editor.chain().focus().toggleOrderedList().run();
    } else {
      editor.chain().focus().toggleTaskList().run();
    }
    setOpenMenu(null);
  };

  return (
    <div className="panel-body" ref={bodyRef} onFocus={onFocus} onBlur={onBlur}>
      {editable && showToolbar && (
        <div className={`panel-toolbar${toolbarCollapsed ? ' panel-toolbar--collapsed' : ''}`} ref={menuRef}>
          <div className="toolbar-group">
            <button type="button" className="toolbar-trigger" onClick={() => setOpenMenu(openMenu === 'format' ? null : 'format')}>
              {editor?.isActive('heading', { level: 2 }) ? 'Heading' : 'Paragraph'} ▾
            </button>
            {openMenu === 'format' && (
              <div className="toolbar-menu">
                <button type="button" onClick={() => applyHeading(null)}>Paragraph</button>
                <button type="button" onClick={() => applyHeading(1)}>Heading 1</button>
                <button type="button" onClick={() => applyHeading(2)}>Heading 2</button>
                <button type="button" onClick={() => applyHeading(3)}>Heading 3</button>
                <button type="button" onClick={() => applyHeading(4)}>Heading 4</button>
                <button type="button" onClick={() => applyHeading(5)}>Heading 5</button>
                <button type="button" onClick={() => applyHeading(6)}>Heading 6</button>
                <button type="button" onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Quote</button>
                <button type="button" onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>Code block</button>
              </div>
            )}
          </div>

          <div className="toolbar-group">
            <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()}>
              B
            </button>
            <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()}>
              I
            </button>
            <button type="button" onClick={() => editor?.chain().focus().toggleUnderline().run()}>
              U
            </button>
            <button type="button" onClick={() => editor?.chain().focus().toggleStrike().run()}>
              S
            </button>
            <button type="button" onClick={() => editor?.chain().focus().toggleCode().run()}>
              {'</>'}
            </button>
          </div>

          <div className="toolbar-group">
            <button type="button" className="toolbar-trigger" onClick={() => setOpenMenu(openMenu === 'font' ? null : 'font')}>
              Font size ▾
            </button>
            {openMenu === 'font' && (
              <div className="toolbar-menu">
                {fontSizeOptions.map((option) => (
                  <button key={option.id} type="button" onClick={() => {
                    editor?.commands.setFontSize(option.value);
                    setOpenMenu(null);
                  }}>
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="toolbar-group">
            <button type="button" className="toolbar-trigger" onClick={() => setOpenMenu(openMenu === 'list' ? null : 'list')}>
              List ▾
            </button>
            {openMenu === 'list' && (
              <div className="toolbar-menu">
                <button type="button" onClick={() => applyList('bullet')}>Bulleted list</button>
                <button type="button" onClick={() => applyList('ordered')}>Numbered list</button>
                <button type="button" onClick={() => applyList('task')}>Checkboxes</button>
              </div>
            )}
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              onClick={() => {
                const url = window.prompt('Link URL');
                if (url) {
                  editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
                }
                setOpenMenu(null);
              }}
            >
              Link
            </button>
            <button type="button" onClick={insertImage}>
              Image
            </button>
            <button
              type="button"
              onClick={() => {
                editor?.chain().focus().setHorizontalRule().run();
                setOpenMenu(null);
              }}
            >
              Divider
            </button>
          </div>

          <div className="toolbar-group">
            <button type="button" className="toolbar-trigger" onClick={() => setOpenMenu(openMenu === 'status' ? null : 'status')}>
              Label ▾
            </button>
            {openMenu === 'status' && (
              <div className="toolbar-menu">
                <div className="toolbar-field">
                  <label>Text</label>
                  <input
                    type="text"
                    value={labelText}
                    onChange={(event) => setLabelText(event.target.value)}
                  />
                </div>
                <div className="toolbar-field">
                  <label>Color</label>
                  <div className="color-row">
                    <ColourPicker
                      value={labelColor}
                      ariaLabel="Label colour"
                      onChange={(next) => setLabelColor(next)}
                    />
                  </div>
                </div>
                <div className="toolbar-field">
                  <label>Presets</label>
                  <div className="preset-row">
                    {statusOptions.map((option) => (
                      <button key={option.id} type="button" onClick={() => insertStatus(option.id, option.label, option.id === 'done' ? '#22c55e' : option.id === 'blocked' ? '#ef4444' : '#f97316')}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="button" className="primary" onClick={() => insertStatus('custom')}>
                  Insert label
                </button>
              </div>
            )}
          </div>

          <button type="button" className="primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </button>

          <button
            type="button"
            className="toolbar-collapse-btn"
            onClick={() => { setToolbarCollapsed((c) => !c); setOpenMenu(null); }}
            title={toolbarCollapsed ? 'Show formatting toolbar' : 'Hide formatting toolbar'}
          >
            {toolbarCollapsed ? 'Aa ▾' : '✕'}
          </button>
        </div>
      )}
      <div className={`panel-editor ${editable ? 'panel-editor--editable' : ''}`}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};
