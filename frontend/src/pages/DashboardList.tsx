import React, { useMemo, useRef, useState } from 'react';
import { createDashboard, deleteDashboard, duplicateDashboard, fetchDashboards, updateDashboard } from '../api';
import { DashboardFilters, DashboardSummary } from '../types';
import { Link, useNavigate } from 'react-router-dom';

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const FOLDERS = [
  'AI',
  'gPlan Outdoor',
  'International',
  'Outdoor Fulfilment',
  'Programme',
  'Radio',
  'Sales Ops',
  'Self Service',
  'Shared Services',
];

const defaultFilters: DashboardFilters = {
  projects: [],
  fixVersions: [],
  components: [],
  incrementStart: '2026-01-19',
  incrementEnd: '2026-06-30',
  ganttMode: 'standard',
  swimlanes: [],
};

type DashboardListProps = {
  authenticated: boolean;
};

export const DashboardList: React.FC<DashboardListProps> = ({ authenticated }) => {
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null);
  const [movingSlugs, setMovingSlugs] = useState<Set<string>>(new Set());
  const [duplicatingSlugs, setDuplicatingSlugs] = useState<Set<string>>(new Set());
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  // Track the element that opened the delete-confirm modal so we can restore
  // focus to it on close (WCAG 2.4.3).
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const confirmCancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const navigate = useNavigate();

  React.useEffect(() => {
    fetchDashboards()
      .then((data) => setDashboards(data))
      .catch((err) => setError(err.message || 'Failed to load dashboards'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return dashboards;
    const q = query.toLowerCase();
    return dashboards.filter(
      (dash) => dash.title.toLowerCase().includes(q) || dash.slug.toLowerCase().includes(q)
    );
  }, [dashboards, query]);

  const toggleFolder = (folder: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!title.trim() || !selectedFolder) return;
    setCreating(true);
    try {
      const created = await createDashboard({
        title: title.trim(),
        folder: selectedFolder,
        filters: defaultFilters,
      });
      navigate(`/dashboards/${created.slug}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create dashboard';
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = (slug: string, trigger?: HTMLElement | null) => {
    if (!authenticated) return;
    deleteTriggerRef.current = trigger ?? (document.activeElement as HTMLElement | null);
    setConfirmDeleteSlug(slug);
  };

  const closeConfirmDelete = () => {
    setConfirmDeleteSlug(null);
    // Restore focus to the trigger that opened the dialog.
    const trigger = deleteTriggerRef.current;
    deleteTriggerRef.current = null;
    if (trigger && document.contains(trigger)) {
      try { trigger.focus(); } catch { /* no-op */ }
    }
  };

  // Escape / focus trap / restore-focus for the delete-confirm modal.
  React.useEffect(() => {
    if (!confirmDeleteSlug) return;
    // Focus the Cancel button as the safest default action.
    const raf = requestAnimationFrame(() => {
      confirmCancelBtnRef.current?.focus();
    });
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirmDelete();
        return;
      }
      if (e.key !== 'Tab') return;
      // Trap Tab/Shift-Tab within the dialog.
      const dialog = confirmDialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDeleteSlug]);

  const handleConfirmDelete = async () => {
    const slug = confirmDeleteSlug;
    if (!slug) return;
    // Clear the trigger ref before closing — the trigger element will be
    // unmounted alongside the dashboard card, so there's nothing to restore.
    deleteTriggerRef.current = null;
    setConfirmDeleteSlug(null);
    setDeletingSlug(slug);
    try {
      await deleteDashboard(slug);
      setDashboards((prev) => prev.filter((dash) => dash.slug !== slug));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete dashboard';
      setError(message);
    } finally {
      setDeletingSlug(null);
    }
  };

  const handleMoveFolder = async (slug: string, newFolder: string | null) => {
    // Record only this dashboard's original folder so concurrent moves for other
    // cards are not affected if this one fails and needs to revert.
    const originalFolder = dashboards.find((d) => d.slug === slug)?.folder ?? null;

    setMovingSlugs((prev) => new Set(prev).add(slug));
    // Optimistic update so the UI feels instant
    setDashboards((prev) =>
      prev.map((dash) => (dash.slug === slug ? { ...dash, folder: newFolder } : dash))
    );
    try {
      try {
        await updateDashboard(slug, { folder: newFolder });
      } catch (err: unknown) {
        // PUT failed — revert the optimistic update.
        // If the follow-up fetch also fails, at least restore this one dashboard
        // and warn the user that local and server state may have diverged.
        let refetchFailed = false;
        try {
          const fresh = await fetchDashboards();
          setDashboards(fresh);
        } catch {
          refetchFailed = true;
          setDashboards((prev) =>
            prev.map((d) => (d.slug === slug ? { ...d, folder: originalFolder } : d))
          );
        }
        const baseMessage = err instanceof Error ? err.message : 'Failed to move dashboard';
        setError(
          refetchFailed
            ? `${baseMessage} — move failed and dashboard state may be out of sync. Please reload.`
            : baseMessage
        );
        return;
      }

      // PUT succeeded — best-effort re-sync from the server.  A failed refresh
      // should never roll back a successful move, so errors here are silently swallowed.
      try {
        const fresh = await fetchDashboards();
        setDashboards(fresh);
      } catch {
        // Optimistic update is already correct; leave the UI as-is.
      }
    } finally {
      setMovingSlugs((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
    }
  };

  const handleStartRename = (slug: string, currentTitle: string) => {
    setRenamingSlug(slug);
    setRenameValue(currentTitle);
  };

  const handleConfirmRename = async () => {
    if (!renamingSlug || !renameValue.trim()) return;
    setRenameSaving(true);
    try {
      const updated = await updateDashboard(renamingSlug, { title: renameValue.trim() });
      setDashboards((prev) =>
        prev.map((d) => (d.slug === renamingSlug ? { ...d, title: updated.title } : d))
      );
      setRenamingSlug(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to rename dashboard';
      setError(message);
    } finally {
      setRenameSaving(false);
    }
  };

  const handleDuplicate = async (slug: string) => {
    setDuplicatingSlugs((prev) => new Set(prev).add(slug));
    try {
      const copy = await duplicateDashboard(slug);
      setDashboards((prev) => [...prev, { id: copy.id, slug: copy.slug, title: copy.title, folder: copy.folder ?? null, description: copy.description ?? null, updatedAt: copy.updatedAt ?? null }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to duplicate dashboard';
      setError(message);
    } finally {
      setDuplicatingSlugs((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
    }
  };

  const getDashboardsInFolder = (folder: string) =>
    filtered.filter((d) => d.folder === folder);

  // Folders present in data but not in the known FOLDERS list — shown as-is so
  // backend values never silently disappear into the Unassigned bucket.
  const unknownFolders = useMemo(() => {
    const known = new Set(FOLDERS);
    const seen = new Set<string>();
    dashboards.forEach((d) => {
      if (d.folder && !known.has(d.folder)) seen.add(d.folder);
    });
    return Array.from(seen).sort();
  }, [dashboards]);

  const unassigned = filtered.filter((d) => !d.folder);

  return (
    <div className="dashboard-list">
      <div className="dashboard-list-header">
        <div>
          <h1>Dashboards</h1>
          <p>Choose a fortnightly update page or create a new dashboard.</p>
        </div>
        <div className="dashboard-actions">
          {authenticated ? (
            <div className="dashboard-create">
              <label htmlFor="new-dashboard-title" className="sr-only">New dashboard title</label>
              <input
                id="new-dashboard-title"
                type="text"
                placeholder="New dashboard title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <select
                value={selectedFolder}
                onChange={(event) => setSelectedFolder(event.target.value)}
                className="folder-select"
                aria-label="Select folder"
              >
                <option value="">Select folder…</option>
                {FOLDERS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary"
                onClick={handleCreate}
                disabled={creating || !title.trim() || !selectedFolder}
              >
                {creating ? 'Creating…' : 'Create dashboard'}
              </button>
            </div>
          ) : (
            <p className="muted">Sign in to create dashboards.</p>
          )}
        </div>
      </div>

      <div className="dashboard-search">
        <label htmlFor="dashboard-search-input" className="sr-only">Search dashboards</label>
        <input
          id="dashboard-search-input"
          type="search"
          placeholder="Search dashboards"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {loading && <div className="card">Loading dashboards…</div>}
      {error && <div className="card error">{error}</div>}

      {!loading && query.trim() && (
        <div>
          {filtered.length === 0 ? (
            <div className="card">No dashboards found.</div>
          ) : (
            <div className="dashboard-grid">
              {filtered.map((dashboard) => (
                <DashboardCard
                  key={dashboard.id}
                  dashboard={dashboard}
                  authenticated={authenticated}
                  folders={FOLDERS}
                  deleting={deletingSlug === dashboard.slug}
                  moving={movingSlugs.has(dashboard.slug)}
                  duplicating={duplicatingSlugs.has(dashboard.slug)}
                  renaming={renamingSlug === dashboard.slug}
                  renameValue={renamingSlug === dashboard.slug ? renameValue : ''}
                  renameSaving={renameSaving}
                  onDelete={handleDelete}
                  onMove={handleMoveFolder}
                  onRename={handleStartRename}
                  onRenameChange={setRenameValue}
                  onRenameConfirm={handleConfirmRename}
                  onRenameCancel={() => setRenamingSlug(null)}
                  onDuplicate={handleDuplicate}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !query.trim() && (
        <div className="folder-list">
          <div className="folder-list-label">
            Folders
            <span className="folder-list-summary">
              {dashboards.length} {dashboards.length === 1 ? 'dashboard' : 'dashboards'} across {FOLDERS.length + unknownFolders.length} folders
            </span>
          </div>

          {FOLDERS.map((folder) => {
            const items = getDashboardsInFolder(folder);
            const isOpen = openFolders.has(folder);
            const isEmpty = items.length === 0;
            return (
              <div key={folder} className={`folder-group${isEmpty ? ' folder-group--empty' : ''}${isOpen ? ' folder-group--open' : ''}`}>
                <button
                  type="button"
                  className="folder-header"
                  onClick={() => toggleFolder(folder)}
                  aria-expanded={isOpen}
                >
                  <span className="folder-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="folder-name">{folder}</span>
                  <span className={`folder-count${!isEmpty ? ' folder-count--active' : ''}`}>{items.length}</span>
                </button>

                {isOpen && (
                  <div className="folder-body">
                    {isEmpty ? (
                      <p className="folder-empty muted">No dashboards yet.</p>
                    ) : (
                      <div className="dashboard-grid">
                        {items.map((dashboard) => (
                          <DashboardCard
                            key={dashboard.id}
                            dashboard={dashboard}
                            authenticated={authenticated}
                            folders={FOLDERS}
                            deleting={deletingSlug === dashboard.slug}
                            moving={movingSlugs.has(dashboard.slug)}
                            duplicating={duplicatingSlugs.has(dashboard.slug)}
                            renaming={renamingSlug === dashboard.slug}
                            renameValue={renamingSlug === dashboard.slug ? renameValue : ''}
                            renameSaving={renameSaving}
                            onDelete={handleDelete}
                            onMove={handleMoveFolder}
                            onRename={handleStartRename}
                            onRenameChange={setRenameValue}
                            onRenameConfirm={handleConfirmRename}
                            onRenameCancel={() => setRenamingSlug(null)}
                            onDuplicate={handleDuplicate}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {unknownFolders.map((folder) => {
            const items = getDashboardsInFolder(folder);
            const isOpen = openFolders.has(folder);
            const isEmpty = items.length === 0;
            return (
              <div key={folder} className={`folder-group${isEmpty ? ' folder-group--empty' : ''}${isOpen ? ' folder-group--open' : ''}`}>
                <button
                  type="button"
                  className="folder-header"
                  onClick={() => toggleFolder(folder)}
                  aria-expanded={isOpen}
                >
                  <span className="folder-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="folder-name">{folder}</span>
                  <span className={`folder-count${!isEmpty ? ' folder-count--active' : ''}`}>{items.length}</span>
                </button>
                {isOpen && (
                  <div className="folder-body">
                    <div className="dashboard-grid">
                      {items.map((dashboard) => (
                        <DashboardCard
                          key={dashboard.id}
                          dashboard={dashboard}
                          authenticated={authenticated}
                          folders={FOLDERS}
                          deleting={deletingSlug === dashboard.slug}
                          moving={movingSlugs.has(dashboard.slug)}
                          duplicating={duplicatingSlugs.has(dashboard.slug)}
                          renaming={renamingSlug === dashboard.slug}
                          renameValue={renamingSlug === dashboard.slug ? renameValue : ''}
                          renameSaving={renameSaving}
                          onDelete={handleDelete}
                          onMove={handleMoveFolder}
                          onRename={handleStartRename}
                          onRenameChange={setRenameValue}
                          onRenameConfirm={handleConfirmRename}
                          onRenameCancel={() => setRenamingSlug(null)}
                          onDuplicate={handleDuplicate}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {unassigned.length > 0 && (
            <div className={`folder-group${openFolders.has('__unassigned__') ? ' folder-group--open' : ''}`}>
              <button
                type="button"
                className="folder-header"
                onClick={() => toggleFolder('__unassigned__')}
                aria-expanded={openFolders.has('__unassigned__')}
              >
                <span className="folder-chevron" aria-hidden="true">
                  {openFolders.has('__unassigned__') ? '▾' : '▸'}
                </span>
                <span className="folder-name">Unassigned</span>
                <span className="folder-count folder-count--active">{unassigned.length}</span>
              </button>
              {openFolders.has('__unassigned__') && (
                <div className="folder-body">
                  <div className="dashboard-grid">
                    {unassigned.map((dashboard) => (
                      <DashboardCard
                        key={dashboard.id}
                        dashboard={dashboard}
                        authenticated={authenticated}
                        folders={FOLDERS}
                        deleting={deletingSlug === dashboard.slug}
                        moving={movingSlugs.has(dashboard.slug)}
                        duplicating={duplicatingSlugs.has(dashboard.slug)}
                        renaming={renamingSlug === dashboard.slug}
                        renameValue={renamingSlug === dashboard.slug ? renameValue : ''}
                        renameSaving={renameSaving}
                        onDelete={handleDelete}
                        onMove={handleMoveFolder}
                        onRename={handleStartRename}
                        onRenameChange={setRenameValue}
                        onRenameConfirm={handleConfirmRename}
                        onRenameCancel={() => setRenamingSlug(null)}
                        onDuplicate={handleDuplicate}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {confirmDeleteSlug && (() => {
        const name = dashboards.find((d) => d.slug === confirmDeleteSlug)?.title ?? confirmDeleteSlug;
        return (
          <div
            className="confirm-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            // Backdrop click closes; clicks on the dialog itself stop propagation below.
            onClick={(e) => {
              if (e.target === e.currentTarget) closeConfirmDelete();
            }}
          >
            <div
              className="confirm-dialog"
              ref={confirmDialogRef}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="confirm-title" className="confirm-dialog-title">Delete dashboard?</h3>
              <p className="confirm-dialog-body">
                <strong>{name}</strong> will be permanently deleted. This cannot be undone.
              </p>
              <div className="confirm-dialog-actions">
                <button
                  type="button"
                  className="secondary"
                  ref={confirmCancelBtnRef}
                  onClick={closeConfirmDelete}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={handleConfirmDelete}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

type DashboardCardProps = {
  dashboard: DashboardSummary;
  authenticated: boolean;
  folders: string[];
  deleting: boolean;
  moving: boolean;
  duplicating: boolean;
  renaming: boolean;
  renameValue: string;
  renameSaving: boolean;
  onDelete: (slug: string, trigger?: HTMLElement | null) => void;
  onMove: (slug: string, folder: string | null) => void;
  onRename: (slug: string, currentTitle: string) => void;
  onRenameChange: (value: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  onDuplicate: (slug: string) => void;
};

const DashboardCard: React.FC<DashboardCardProps> = ({
  dashboard,
  authenticated,
  folders,
  deleting,
  moving,
  duplicating,
  renaming,
  renameValue,
  renameSaving,
  onDelete,
  onMove,
  onRename,
  onRenameChange,
  onRenameConfirm,
  onRenameCancel,
  onDuplicate,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  React.useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  const updated = relativeTime(dashboard.updatedAt);

  return (
    <div className="dashboard-card">
      {renaming ? (
        <div className="dashboard-card-rename">
          <input
            ref={renameInputRef}
            type="text"
            className="dashboard-rename-input"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameConfirm();
              if (e.key === 'Escape') onRenameCancel();
            }}
            aria-label="Rename dashboard"
          />
          <div className="dashboard-rename-actions">
            <button type="button" className="secondary" onClick={onRenameCancel} disabled={renameSaving}>Cancel</button>
            <button type="button" onClick={onRenameConfirm} disabled={renameSaving || !renameValue.trim()}>
              {renameSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <Link to={`/dashboards/${dashboard.slug}`} className="dashboard-card-link">
          <h3>{dashboard.title}</h3>
          {dashboard.description && (
            <p className="dashboard-card-description">{dashboard.description}</p>
          )}
          {updated && (
            <span className="dashboard-card-updated">Updated {updated}</span>
          )}
        </Link>
      )}
      {authenticated && (
        <div className="dashboard-card-meta" ref={menuRef}>
          <button
            ref={menuBtnRef}
            type="button"
            className="secondary dashboard-menu-btn"
            aria-label="Dashboard options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            ···
          </button>
          {menuOpen && (
            <div className="dashboard-card-menu">
              <button
                type="button"
                className="dashboard-card-menu-action"
                onClick={() => { setMenuOpen(false); onRename(dashboard.slug, dashboard.title); }}
              >
                Rename
              </button>
              <button
                type="button"
                className="dashboard-card-menu-action"
                onClick={() => { setMenuOpen(false); onDuplicate(dashboard.slug); }}
                disabled={duplicating}
              >
                {duplicating ? 'Duplicating…' : 'Duplicate'}
              </button>
              <hr className="dashboard-card-menu-divider" />
              <div className="dashboard-card-menu-section">
                <span className="dashboard-card-menu-label">Move to…</span>
                <select
                  className="folder-move-select"
                  value=""
                  onChange={(e) => {
                    const raw = e.target.value;
                    onMove(dashboard.slug, raw === '__unassigned__' ? null : raw);
                    setMenuOpen(false);
                  }}
                  disabled={moving}
                  aria-label="Move to folder"
                >
                  <option value="" disabled>
                    {moving ? 'Moving…' : 'Select folder…'}
                  </option>
                  {folders
                    .filter((f) => f !== dashboard.folder)
                    .map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  {dashboard.folder && (
                    <option value="__unassigned__">Unassigned</option>
                  )}
                </select>
              </div>
              <hr className="dashboard-card-menu-divider" />
              <button
                type="button"
                className="danger dashboard-card-menu-delete"
                onClick={() => {
                  setMenuOpen(false);
                  // Restore focus to the menu trigger when the dialog closes.
                  onDelete(dashboard.slug, menuBtnRef.current);
                }}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete dashboard'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
