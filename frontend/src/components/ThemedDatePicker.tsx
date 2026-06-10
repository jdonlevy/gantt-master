import { useEffect, useRef, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import { format, isValid, parse } from 'date-fns';
import 'react-day-picker/style.css';

export type ThemedDatePickerProps = {
  /** ISO `YYYY-MM-DD` string or empty string when unset. */
  value: string;
  /** Called with an ISO `YYYY-MM-DD` string, or empty string when cleared. */
  onChange: (iso: string) => void;
  /** Accessible label — wired through to the text input via aria-label. */
  label?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
};

const DISPLAY_FORMAT = 'dd/MM/yyyy';
const ISO_FORMAT = 'yyyy-MM-dd';

const isoToDisplay = (iso: string): string => {
  if (!iso) return '';
  const parsed = parse(iso, ISO_FORMAT, new Date());
  return isValid(parsed) ? format(parsed, DISPLAY_FORMAT) : '';
};

const displayToIso = (display: string): string | null => {
  if (!display) return '';
  const parsed = parse(display, DISPLAY_FORMAT, new Date());
  if (!isValid(parsed)) return null;
  return format(parsed, ISO_FORMAT);
};

const isoToDate = (iso: string): Date | undefined => {
  if (!iso) return undefined;
  const parsed = parse(iso, ISO_FORMAT, new Date());
  return isValid(parsed) ? parsed : undefined;
};

/**
 * Themed date picker that replaces native `<input type="date">`.
 *
 * Keeps the same "value is an ISO string" contract so callers can drop it in
 * without thinking about display formatting. Internally it shows the user a
 * dd/mm/yyyy string and opens a react-day-picker popup that we can style to
 * match the rest of the app via CSS variables.
 */
/**
 * Rough estimate of the popup's rendered height. Used only to decide whether
 * to anchor the popup above or below the input — it doesn't need to be exact,
 * just close enough that we pick the right side when the input is near the
 * bottom of the viewport. The compact calendar renders ~260px tall.
 */
const POPUP_HEIGHT_ESTIMATE = 280;

export const ThemedDatePicker = ({
  value,
  onChange,
  label,
  disabled,
  invalid,
  id,
}: ThemedDatePickerProps) => {
  const [open, setOpen] = useState(false);
  const [displayValue, setDisplayValue] = useState<string>(isoToDisplay(value));
  const [placeAbove, setPlaceAbove] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync with the ISO value coming from the parent.
  useEffect(() => {
    setDisplayValue(isoToDisplay(value));
  }, [value]);

  // Close the popup when the user clicks outside.
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  // When the popup opens, decide whether it should sit above or below the
  // input based on how much space is available in the viewport. Also listen
  // for scroll/resize so the placement stays correct.
  // NOTE: gated on `open` so closed instances never attach window listeners
  // — important on dashboards that render dozens of date pickers at once.
  useEffect(() => {
    if (!open) return;
    const recalc = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      // Prefer below, but flip up when there's not enough room AND there's
      // more room above.
      setPlaceAbove(
        spaceBelow < POPUP_HEIGHT_ESTIMATE && spaceAbove > spaceBelow
      );
    };
    recalc();
    window.addEventListener('scroll', recalc, true);
    window.addEventListener('resize', recalc);
    return () => {
      window.removeEventListener('scroll', recalc, true);
      window.removeEventListener('resize', recalc);
    };
  }, [open]);

  const handleTextChange = (next: string) => {
    setDisplayValue(next);
    if (!next) {
      onChange('');
      return;
    }
    const iso = displayToIso(next);
    if (iso !== null) {
      onChange(iso);
      return;
    }
    // The user is mid-typing an invalid string. Clear the controlled value so
    // the old (now stale) ISO can't be saved by the parent, but keep
    // `displayValue` so they can keep editing the visible text.
    onChange('');
  };

  const handleDayPicked = (day: Date | undefined) => {
    if (!day) {
      onChange('');
      setDisplayValue('');
      setOpen(false);
      return;
    }
    const iso = format(day, ISO_FORMAT);
    onChange(iso);
    setDisplayValue(format(day, DISPLAY_FORMAT));
    setOpen(false);
  };

  const selectedDate = isoToDate(value);

  return (
    <div
      className={`themed-date-picker${invalid ? ' is-invalid' : ''}${disabled ? ' is-disabled' : ''}`}
      ref={wrapperRef}
    >
      <div className="themed-date-picker__input-wrap">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          placeholder="dd/mm/yyyy"
          aria-label={label}
          value={displayValue}
          disabled={disabled}
          onChange={(event) => handleTextChange(event.target.value)}
          className="themed-date-picker__input"
        />
        <button
          type="button"
          className="themed-date-picker__trigger"
          aria-label={label ? `Open calendar for ${label}` : 'Open calendar'}
          disabled={disabled}
          onClick={() => setOpen((prev) => !prev)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </button>
      </div>

      {open && !disabled && (
        <div
          className={`themed-date-picker__popup${placeAbove ? ' is-above' : ''}`}
          role="dialog"
        >
          <DayPicker
            mode="single"
            selected={selectedDate}
            onSelect={handleDayPicked}
            weekStartsOn={1}
            defaultMonth={selectedDate ?? new Date()}
            showOutsideDays
          />
        </div>
      )}
    </div>
  );
};
