import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { format, isValid, parse } from 'date-fns';
import { FixVersion } from '../types';
import { ThemedDatePicker } from './ThemedDatePicker';

export type FixVersionPatch = {
  uatStart?: string | null;
  uatEnd?: string | null;
  liveStart?: string | null;
  liveEnd?: string | null;
};

export type FixVersionPickerHandle = {
  /** Wipes the draft date fields. Does not call onSave. */
  clearDates: () => void;
};

type Props = {
  fixVersions: FixVersion[];
  onSave: (fixVersionId: string, patch: FixVersionPatch) => Promise<void> | void;
  /**
   * Lets a parent render its own "Clear dates" button somewhere else (e.g. in
   * the card header) while still reflecting the picker's internal state.
   */
  onCanClearChange?: (canClear: boolean) => void;
  /**
   * Called when the user selects or deselects a fix version to edit.
   * Receives the fix version id, or null when the selection is cleared.
   */
  onEditingChange?: (fixVersionId: string | null) => void;
};

type DraftState = {
  uatStart: string;
  uatEnd: string;
  liveStart: string;
  liveEnd: string;
};

const EMPTY_DRAFT: DraftState = {
  uatStart: '',
  uatEnd: '',
  liveStart: '',
  liveEnd: '',
};

const formatDate = (value?: string | null): string => {
  if (!value) return '—';
  // Parse as a local date (matches ThemedDatePicker), otherwise `new Date(iso)`
  // reads YYYY-MM-DD as UTC midnight and the day can slip backwards for users
  // in negative-UTC timezones.
  const parsed = parse(value, 'yyyy-MM-dd', new Date());
  if (!isValid(parsed)) return '—';
  return format(parsed, 'dd/MM/yyyy');
};

/**
 * Compact picker that replaces the per-row fix-version table.
 *
 * Contract preserved for the Gantt:
 *   - on Save, we call `onSave` with the same patch shape the old table used
 *     (`{ uatStart?, uatEnd?, liveStart?, liveEnd? }`), which flows through
 *     DashboardPage.handleOverrideChange → updateFixVersionOverrides and
 *     updates the `roadmap.fixVersions` entry the Gantt consumes.
 *   - Release is read-only and sourced from Jira (fix.release).
 */
export const FixVersionPicker = forwardRef<FixVersionPickerHandle, Props>(
  function FixVersionPicker({ fixVersions, onSave, onCanClearChange, onEditingChange }, ref) {
    const [selectedId, setSelectedId] = useState<string>('');
    const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
    const [errors, setErrors] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [saveConfirmed, setSaveConfirmed] = useState(false);
    const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Tracks whether the component is still mounted, so the deferred
    // setSaveConfirmed(false) inside savedTimeoutRef can't fire setState
    // on an unmounted component if the timer wins the race against the
    // cleanup effect below.
    const mountedRef = useRef(true);

    const selected = useMemo(
      () => fixVersions.find((fix) => fix.id === selectedId),
      [fixVersions, selectedId]
    );

    // Notify parent when the active selection changes (presence tracking).
    useEffect(() => {
      onEditingChange?.(selectedId || null);
    }, [selectedId, onEditingChange]);

    // When the user picks a different fix version, pull back any saved dates.
    // Keyed on `selectedId` (not the `selected` object) so that when the
    // parent re-renders after a save with a fresh `fixVersions` array, we
    // don't wipe the "Saved" confirmation the user just earned.
    useEffect(() => {
      const match = fixVersions.find((fix) => fix.id === selectedId);
      if (!match) {
        setDraft(EMPTY_DRAFT);
      } else {
        setDraft({
          uatStart: match.uatStart || '',
          uatEnd: match.uatEnd || '',
          liveStart: match.liveStart || '',
          liveEnd: match.liveEnd || '',
        });
      }
      setErrors([]);
      setSaveConfirmed(false);
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
        savedTimeoutRef.current = null;
      }
      // fixVersions intentionally omitted — we only want to reset draft state
      // when the user changes the selection, not when the parent re-renders
      // with an updated fixVersions array after a save.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId]);

    // Clean up any pending "Saved" timeout on unmount, and flip the mounted
    // flag so a timer that fires concurrently with unmount bails out.
    useEffect(() => {
      return () => {
        mountedRef.current = false;
        if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
      };
    }, []);

    const validate = (next: DraftState): string[] => {
      const messages: string[] = [];
      if (next.uatStart && next.uatEnd && next.uatStart > next.uatEnd) {
        messages.push('UAT start date must be on or before UAT end date.');
      }
      if (next.liveStart && next.liveEnd && next.liveStart > next.liveEnd) {
        messages.push('Live start date must be on or before Live end date.');
      }
      return messages;
    };

    const updateField = (field: keyof DraftState, value: string) => {
      const next = { ...draft, [field]: value };
      setDraft(next);
      setErrors(validate(next));
      setSaveConfirmed(false);
    };

    const invalidFields = useMemo(() => {
      const flags = {
        uatStart: false,
        uatEnd: false,
        liveStart: false,
        liveEnd: false,
      };
      if (draft.uatStart && draft.uatEnd && draft.uatStart > draft.uatEnd) {
        flags.uatStart = true;
        flags.uatEnd = true;
      }
      if (draft.liveStart && draft.liveEnd && draft.liveStart > draft.liveEnd) {
        flags.liveStart = true;
        flags.liveEnd = true;
      }
      return flags;
    }, [draft]);

    const canSave = !!selectedId && errors.length === 0 && !saving;

    const hasAnyDraftDate =
      !!draft.uatStart || !!draft.uatEnd || !!draft.liveStart || !!draft.liveEnd;

    const canClear = !!selectedId && hasAnyDraftDate && !saving;

    // Surface canClear to the parent so it can render a Clear button elsewhere
    // (e.g. in the card header) and keep it in sync with internal state.
    useEffect(() => {
      onCanClearChange?.(canClear);
    }, [canClear, onCanClearChange]);

    const handleClear = () => {
      // Wipe the draft fields only — user still has to click Save to commit the
      // cleared state to the backend. This stays consistent with the explicit
      // save UX: nothing is persisted until Save is pressed.
      setDraft(EMPTY_DRAFT);
      setErrors([]);
      setSaveConfirmed(false);
    };

    useImperativeHandle(
      ref,
      () => ({
        clearDates: handleClear,
      }),
      // handleClear only touches setState setters, which are stable — safe to
      // depend on nothing here.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    // Show the "Saved" confirmation and auto-dismiss after a few seconds.
    // Uses a ref so rapid repeat-saves cancel the previous timer cleanly.
    const flashSaveConfirmed = () => {
      setSaveConfirmed(true);
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = setTimeout(() => {
        savedTimeoutRef.current = null;
        if (!mountedRef.current) return;
        setSaveConfirmed(false);
      }, 3000);
    };

    const handleSave = async () => {
      if (!canSave || !selected) return;
      const validationErrors = validate(draft);
      if (validationErrors.length) {
        setErrors(validationErrors);
        return;
      }

      // Only send fields that changed from what the server currently has,
      // so we don't clobber `notes` or write `null` to fields the user didn't
      // touch. An empty string clears the date on the backend (existing behaviour).
      const patch: FixVersionPatch = {};
      if (draft.uatStart !== (selected.uatStart || '')) patch.uatStart = draft.uatStart;
      if (draft.uatEnd !== (selected.uatEnd || '')) patch.uatEnd = draft.uatEnd;
      if (draft.liveStart !== (selected.liveStart || '')) patch.liveStart = draft.liveStart;
      if (draft.liveEnd !== (selected.liveEnd || '')) patch.liveEnd = draft.liveEnd;

      if (Object.keys(patch).length === 0) {
        flashSaveConfirmed();
        return;
      }

      try {
        setSaving(true);
        await onSave(selected.id, patch);
        flashSaveConfirmed();
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="fix-version-picker">
        <div className="fix-version-picker__labels">
          <div>Fix version</div>
          <div>UAT start</div>
          <div>UAT end</div>
          <div>Live start</div>
          <div>Live end</div>
          <div>Release</div>
          <div></div>
        </div>

        <div className="fix-version-picker__row">
          <select
            aria-label="Fix version"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">Select fix version…</option>
            {fixVersions.map((fix) => (
              <option key={fix.id} value={fix.id}>
                {fix.name}
              </option>
            ))}
          </select>

          <ThemedDatePicker
            label="UAT start"
            value={draft.uatStart}
            disabled={!selectedId}
            invalid={invalidFields.uatStart}
            onChange={(iso) => updateField('uatStart', iso)}
          />
          <ThemedDatePicker
            label="UAT end"
            value={draft.uatEnd}
            disabled={!selectedId}
            invalid={invalidFields.uatEnd}
            onChange={(iso) => updateField('uatEnd', iso)}
          />
          <ThemedDatePicker
            label="Live start"
            value={draft.liveStart}
            disabled={!selectedId}
            invalid={invalidFields.liveStart}
            onChange={(iso) => updateField('liveStart', iso)}
          />
          <ThemedDatePicker
            label="Live end"
            value={draft.liveEnd}
            disabled={!selectedId}
            invalid={invalidFields.liveEnd}
            onChange={(iso) => updateField('liveEnd', iso)}
          />

          <div
            className={`fix-version-picker__release${selected?.release ? '' : ' is-empty'}`}
            aria-label="Release date from Jira"
          >
            <span>{formatDate(selected?.release)}</span>
            <span className="fix-version-picker__jira-tag">Jira</span>
          </div>

          <div className="fix-version-picker__actions">
            <button
              type="button"
              className="fix-version-picker__save"
              onClick={handleSave}
              disabled={!canSave}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {errors.length > 0 && (
          <div role="alert" className="fix-version-picker__error">
            {errors.join(' ')}
          </div>
        )}
        {saveConfirmed && errors.length === 0 && (
          <div className="fix-version-picker__saved" role="status">Saved</div>
        )}
      </div>
    );
  }
);
