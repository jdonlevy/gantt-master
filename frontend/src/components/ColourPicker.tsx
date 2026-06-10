import React, { useEffect, useRef, useState } from 'react';

const PRESETS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899',
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#2563eb', '#64748b', '#0f172a', '#ffffff'
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type ColourPickerProps = {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
};

/**
 * In-page colour picker that replaces the native `<input type="color">`. The
 * native control opens the OS colour panel (a separate window on macOS) which
 * doesn't dismiss when you click elsewhere in the page — this popover closes on
 * outside-click and Escape instead.
 */
export const ColourPicker: React.FC<ColourPickerProps> = ({ value, onChange, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value);
  const ref = useRef<HTMLDivElement | null>(null);

  // Keep the hex field in sync when the value changes externally / popover reopens.
  useEffect(() => {
    if (open) setHex(value);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const commitHex = (next: string) => {
    setHex(next);
    if (HEX_RE.test(next)) onChange(next);
  };

  return (
    <div className="colour-picker" ref={ref}>
      <button
        type="button"
        className="colour-picker-swatch"
        style={{ background: value }}
        aria-label={ariaLabel || 'Choose colour'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      />
      {open && (
        <div className="colour-picker-popover" role="dialog">
          <div className="colour-picker-grid">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`colour-picker-chip${
                  preset.toLowerCase() === value.toLowerCase() ? ' is-selected' : ''
                }`}
                style={{ background: preset }}
                aria-label={preset}
                onClick={() => {
                  onChange(preset);
                  setHex(preset);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="colour-picker-hex">
            <span>#</span>
            <input
              type="text"
              value={hex.replace(/^#/, '')}
              maxLength={6}
              aria-label="Hex colour"
              onChange={(event) => commitHex(`#${event.target.value.replace(/[^0-9a-fA-F]/g, '')}`)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
