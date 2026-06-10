import React, { useEffect, useMemo, useRef, useState } from 'react';

type FilterItem = {
  id: string;
  label: string;
  meta?: string;
};

type FilterMultiSelectProps = {
  label: string;
  items: FilterItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  searchable?: boolean;
  disabledIds?: string[];
  /** Shown next to (and as a tooltip on) any row disabled via `disabledIds`. */
  disabledReason?: string;
  layout?: 'inline' | 'stacked';
  /** Show a loading indicator in the popover while items are being fetched. */
  loading?: boolean;
  /** Cap the number of items that can be selected at once. */
  maxSelected?: number;
  /**
   * Show a compact "N selected" count on the trigger instead of the full list
   * of labels, and narrow the trigger. Used where the selection is already
   * displayed elsewhere (e.g. lane tags) so the dropdown is just an editor.
   */
  countSummary?: boolean;
};

export const FilterMultiSelect: React.FC<FilterMultiSelectProps> = ({
  label,
  items,
  selected,
  onChange,
  placeholder,
  searchable = true,
  disabledIds = [],
  disabledReason,
  layout = 'inline',
  loading = false,
  maxSelected,
  countSummary = false
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Move focus to the search field whenever the popover opens, so keyboard
  // users can start filtering immediately without a manual tab. Skipped
  // gracefully when the popover is non-searchable (input ref is null).
  useEffect(() => {
    if (!open) return;
    searchInputRef.current?.focus();
  }, [open]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(query) || (item.meta || '').toLowerCase().includes(query)
    );
  }, [items, search]);

  const disabledSet = useMemo(() => new Set(disabledIds), [disabledIds]);

  const groupedItems = useMemo(() => {
    const selectedSet = new Set(selected);
    const selectedItems = filteredItems.filter((item) => selectedSet.has(item.id));
    const unselected = filteredItems.filter((item) => !selectedSet.has(item.id));
    // Keep selectable rows together at the top of the "All" list and sink the
    // disabled (assigned-elsewhere) rows to the bottom, so the dropdown isn't a
    // confusing mix of pickable and non-pickable entries. Stable: enabled and
    // disabled each retain their original relative order.
    const unselectedItems = [
      ...unselected.filter((item) => !disabledSet.has(item.id)),
      ...unselected.filter((item) => disabledSet.has(item.id))
    ];
    return { selectedItems, unselectedItems };
  }, [filteredItems, selected, disabledSet]);

  const selectedLabel = useMemo(() => {
    if (!selected.length) return placeholder;
    if (countSummary) {
      return `${selected.length} selected`;
    }
    if (selected.length <= 2) {
      return items
        .filter((item) => selected.includes(item.id))
        .map((item) => item.label)
        .join(', ');
    }
    return `${selected.length} selected`;
  }, [items, placeholder, selected]);

  // When a selection cap is set and reached, unchecked items can't be added
  // until the user removes one. Already-selected items stay toggle-able.
  const atCap = maxSelected != null && selected.length >= maxSelected;

  const toggleItem = (id: string) => {
    if (disabledSet.has(id)) return;
    if (selected.includes(id)) {
      onChange(selected.filter((item) => item !== id));
      return;
    }
    if (atCap) return;
    onChange([...selected, id]);
  };

  // When a search is active, "Select all" applies only to the filtered results
  // (the rows the user can actually see), unioned with the existing selection so
  // selections made under a previous query aren't dropped. With no search,
  // `filteredItems` is the full list, so this behaves as a plain select-all.
  // A `maxSelected` cap (if set) is applied to the resulting list.
  const handleSelectAll = () => {
    const next = new Set(selected);
    for (const item of filteredItems) {
      if (!disabledSet.has(item.id)) next.add(item.id);
    }
    const ids = [...next];
    onChange(maxSelected != null ? ids.slice(0, maxSelected) : ids);
  };
  const handleClearAll = () => onChange([]);

  return (
    <div
      className={`filter-group ${layout === 'stacked' ? 'filter-group--stacked' : ''}${
        countSummary ? ' filter-group--compact' : ''
      }`}
      ref={ref}
    >
      <span className="filter-label">{label}</span>
      <div className={`filter-select ${open ? 'open' : ''}`}>
        <button
          type="button"
          className="filter-trigger"
          aria-label={label || 'Filter'}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span>{selectedLabel}</span>
          <span className="chevron">{open ? '▴' : '▾'}</span>
        </button>
        {open && (
          <div className="filter-popover">
            {searchable && (
              <div className="filter-search">
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={`Search ${label.toLowerCase()}`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            )}
            <div className="filter-list">
              {loading && (
                <div className="filter-loading">
                  <span className="filter-spinner" aria-hidden="true" />
                  Loading…
                </div>
              )}
              {!loading && groupedItems.selectedItems.length > 0 && (
                <div className="filter-section-title">Selected</div>
              )}
              {groupedItems.selectedItems.map((item) => {
                const isDisabled =
                  !selected.includes(item.id) && (disabledSet.has(item.id) || atCap);
                return (
                  <label
                    key={item.id}
                    className={`filter-item${isDisabled ? ' is-disabled' : ''}`}
                    title={isDisabled && disabledReason ? disabledReason : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      disabled={isDisabled}
                      onChange={() => toggleItem(item.id)}
                    />
                    <span className="filter-key">{item.label}</span>
                    {item.meta && <span className="filter-name">{item.meta}</span>}
                    {isDisabled && disabledReason && (
                      <span className="filter-disabled-note">{disabledReason}</span>
                    )}
                  </label>
                );
              })}
              {groupedItems.unselectedItems.length > 0 && groupedItems.selectedItems.length > 0 && (
                <div className="filter-section-divider" />
              )}
              {groupedItems.unselectedItems.length > 0 && (
                <div className="filter-section-title">All</div>
              )}
              {groupedItems.unselectedItems.map((item) => {
                const isDisabled =
                  !selected.includes(item.id) && (disabledSet.has(item.id) || atCap);
                return (
                  <label
                    key={item.id}
                    className={`filter-item${isDisabled ? ' is-disabled' : ''}`}
                    title={isDisabled && disabledReason ? disabledReason : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      disabled={isDisabled}
                      onChange={() => toggleItem(item.id)}
                    />
                    <span className="filter-key">{item.label}</span>
                    {item.meta && <span className="filter-name">{item.meta}</span>}
                    {isDisabled && disabledReason && (
                      <span className="filter-disabled-note">{disabledReason}</span>
                    )}
                  </label>
                );
              })}
            </div>
            {atCap && (
              <div className="filter-cap-hint">
                Up to {maxSelected} can be selected — remove one to add another.
              </div>
            )}
            <div className="filter-actions">
              <button type="button" className="secondary" onClick={handleSelectAll}>
                Select all
              </button>
              <button type="button" className="secondary" onClick={handleClearAll}>
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
