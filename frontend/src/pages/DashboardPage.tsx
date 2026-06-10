import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  createCustomBar,
  updateCustomBar,
  createDashboardPanel,
  createDependencyOverride,
  createMilestone,
  deleteCustomBar,
  deleteDashboardPanel,
  deleteDependencyOverride,
  deleteMilestone,
  fetchDashboard,
  fetchDashboardSnapshot,
  fetchComponents,
  fetchFixVersions,
  fetchPanelContent,
  fetchPresence,
  fetchProjects,
  fetchRoadmap,
  clearPresence,
  setPresence,
  updateDashboard,
  updateDashboardPanel,
  updateDashboardPanelContent,
  updateDashboardSnapshot,
  updateFixVersionOverrides,
  updateMilestone,
  type PresenceEntry,
} from '../api';
import { FilterMultiSelect } from '../components/FilterMultiSelect';
import { ColourPicker } from '../components/ColourPicker';
import { FixVersionPicker, FixVersionPickerHandle } from '../components/FixVersionPicker';
import { ThemedDatePicker } from '../components/ThemedDatePicker';
import MetricsPanel from '../components/MetricsPanel';
import { RichTextPanel } from '../components/RichTextPanel';
import { ImageLightbox } from '../components/ImageLightbox';
import WeeklyUpdatePanel, { parseStoredPanelContent } from './WeeklyUpdatePanel';
import PresentationView, { PresentationSlide } from './PresentationView';
import { reconcileOrder } from './presentationOrder';
import { Gantt, GanttCreateDependencyArgs, computeFixVersionRag } from '../Gantt';
import { useDashboardEvents } from '../useDashboardEvents';
import { CustomBar, DashboardDetail, DashboardFilters, DashboardPanel, Dependency, FixVersion, Initiative, Milestone, Project, RoadmapResponse, Swimlane } from '../types';

const defaultStart = '2026-01-19';
const defaultEnd = '2026-06-30';
const GRID_ROW_HEIGHT = 56;
const GRID_ROW_GAP = 16;
const DEFAULT_PANEL_HEIGHT = 4;
const panelWidthLabels: Record<number, string> = {
  12: 'Full',
  8: 'Two-thirds',
  6: 'Half',
  4: 'Third',
  3: 'Quarter'
};

const createLaneId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeFilters = (filters?: DashboardFilters | null): DashboardFilters => ({
  projects: filters?.projects ?? [],
  fixVersions: (filters as any)?.fixVersions ?? (filters as any)?.statuses ?? [],
  components: (filters as any)?.components ?? (filters as any)?.types ?? [],
  incrementStart: filters?.incrementStart || defaultStart,
  incrementEnd: filters?.incrementEnd || defaultEnd,
  ganttMode: filters?.ganttMode ?? 'standard',
  timeScale: filters?.timeScale ?? 'month',
  showDependencies: filters?.showDependencies ?? true,
  // Default off: we don't want to surprise people who opened the dashboard
  // with dependencies suddenly disappearing. Opt-in via the filter toggle.
  dependenciesManualOnly: filters?.dependenciesManualOnly ?? false,
  // Default off: show released fix versions until a user opts to hide them.
  hideReleasedFixVersions: filters?.hideReleasedFixVersions ?? false,
  // Default off: standard bar view is the expected baseline.
  swimlaneMilestoneView: filters?.swimlaneMilestoneView ?? false,
  swimlanes: filters?.swimlanes ?? [],
  initiatives: filters?.initiatives ?? [],
  // Default off so existing dashboards render unchanged until a user opts in.
  showInitiatives: filters?.showInitiatives ?? false,
  collapsedInitiatives: filters?.collapsedInitiatives ?? [],
  presentationOrder: filters?.presentationOrder ?? [],
  presentationHidden: filters?.presentationHidden ?? [],
  barColourCategories: filters?.barColourCategories ?? [],
  fixVersionColours: filters?.fixVersionColours ?? {},
  colourByCategory: filters?.colourByCategory ?? false,
  // Back-compat: pre-dropdown dashboards only had the colourByCategory toggle.
  // Map that onto the new mode ('manual' when it was on, else 'rag').
  barColourMode: filters?.barColourMode ?? (filters?.colourByCategory ? 'manual' : 'rag'),
  autoBarColours: filters?.autoBarColours ?? {},
  filtersCollapsed: filters?.filtersCollapsed ?? false,
  milestonesCollapsed: filters?.milestonesCollapsed ?? false,
  customBarsCollapsed: filters?.customBarsCollapsed ?? false,
  updateFixVersions: filters?.updateFixVersions ?? [],
  // Empty by default → backend falls back to its standard last-two-weeks
  // released window. Stored as '' (not null) so the date inputs stay controlled.
  updateStart: filters?.updateStart ?? '',
  updateEnd: filters?.updateEnd ?? '',
});

type DashboardPageProps = {
  authenticated: boolean;
};

type PanelCardProps = {
  panel: DashboardPanel;
  editable: boolean;
  projects: string[];
  dashboardSlug: string;
  activeFixVersionIds: string[];
  /**
   * Custom released-window for the Updates summary (Updates tab only). Threaded
   * to WeeklyUpdatePanel so regenerate calls scope released fix versions to
   * this range. Empty strings mean "use the backend default (last 2 weeks)".
   */
  updateStart?: string;
  updateEnd?: string;
  /**
   * Map of fix-version id → RAG status, derived from the Gantt's schedule
   * logic (see computeFixVersionRag). Passed through to WeeklyUpdatePanel so
   * the RAG badge on each summary section matches the Gantt bar colour for
   * the same fix version.
   */
  ragStatusByVersionId?: Record<string, 'red' | 'amber' | 'green'>;
  /** Open the dashboard-level presentation deck. Only the weekly-update panel
   *  surfaces this (as a button next to Generate); other panel types ignore it. */
  onPresent?: () => void;
  /** Whether the assembled deck currently has any slides — gates the button. */
  canPresent?: boolean;
  onTitleChange: (panelId: string, title: string) => void;
  onTitleDraft: (panelId: string, title: string) => void;
  onContentSave: (panelId: string, payload: { contentJson?: Record<string, unknown>; contentHtml?: string }) => Promise<void>;
  onSpanChange: (panelId: string, span: number) => void;
  onWidthChange: (panelId: string, width: number) => void;
  spanOverride?: number;
  rowOverride?: number;
  collapsed?: boolean;
  onToggleCollapse: (panelId: string) => void;
  onDelete: (panelId: string) => void;
  onNoChanges?: () => void;
  onDragStart?: (panelId: string) => void;
  onDragEnd?: () => void;
  onDrop?: (panelId: string) => void;
  onDragEnter?: (panelId: string) => void;
  onDragLeave?: (panelId: string) => void;
  onStartMove?: (panelId: string) => void;
  isDragging?: boolean;
  isDropTarget?: boolean;
  editors?: Array<{ accountId: string; displayName: string; avatarUrl: string | null }>;
  onEditingStart?: (panelId: string) => void;
  onEditingEnd?: () => void;
  /** Full presence entries for this dashboard — passed to WeeklyUpdatePanel for section-level highlighting. */
  presenceEntries?: PresenceEntry[];
  /** Register a content-merge handler for SSE-driven cross-user updates.
   *  Pass `null` to deregister. */
  registerRemoteContentHandler?: (
    panelId: string,
    handler: ((contentJson: Record<string, unknown> | null) => void) | null,
  ) => void;
};

const PanelCard: React.FC<PanelCardProps> = ({
  panel,
  editable,
  projects,
  dashboardSlug,
  activeFixVersionIds,
  updateStart,
  updateEnd,
  ragStatusByVersionId,
  onPresent,
  canPresent = false,
  onTitleChange,
  onTitleDraft,
  onContentSave,
  onSpanChange,
  onWidthChange,
  spanOverride,
  rowOverride,
  collapsed = false,
  onToggleCollapse,
  onDelete,
  onNoChanges,
  onDragStart,
  onDragEnd,
  onDrop,
  onDragEnter,
  onDragLeave,
  onStartMove,
  isDragging = false,
  isDropTarget = false,
  editors = [],
  onEditingStart,
  onEditingEnd,
  presenceEntries = [],
  registerRemoteContentHandler,
}) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const saveHandlerRef = React.useRef<(() => Promise<void>) | null>(null);
  const [saveState, setSaveState] = useState({ dirty: false, saving: false });
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const panelMenuRef = React.useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (collapsed) return;
    if (!bodyRef.current || !headerRef.current) return;
    const bodyNode = bodyRef.current;
    const headerNode = headerRef.current;
    const measure = () => {
      const headerHeight = headerNode.getBoundingClientRect().height;
      // For weekly-update panels, `.wu-inline` is a normal block with height:auto
      // so its getBoundingClientRect().height accurately reflects the true content
      // height. bodyNode.scrollHeight is clamped to clientHeight (the flex-allocated
      // height) when content is smaller than the grid span — preventing shrinkage.
      const wuEl = bodyNode.querySelector('.wu-inline') as HTMLElement | null;
      let bodyHeight: number;
      if (wuEl) {
        const cs = getComputedStyle(bodyNode);
        const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        bodyHeight = wuEl.getBoundingClientRect().height + vPad;
      } else {
        bodyHeight = bodyNode.scrollHeight;
      }
      const total = headerHeight + bodyHeight;
      const span = Math.max(
        1,
        Math.ceil((total + GRID_ROW_GAP) / (GRID_ROW_HEIGHT + GRID_ROW_GAP))
      );
      onSpanChange(panel.id, span);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bodyNode);
    // Also observe .wu-inline directly — panel-body has flex:1 so its size is
    // fixed by the grid span and never shrinks; .wu-inline is a plain block
    // whose height tracks actual content, so its ResizeObserver fires on shrink.
    // We try immediately (may exist already) and also on each wu-normalised event
    // so we pick it up after the first generate.
    let wuObserved = false;
    const observeWuInline = () => {
      if (wuObserved) return;
      const el = bodyNode.querySelector('.wu-inline') as HTMLElement | null;
      if (el) { observer.observe(el); wuObserved = true; }
    };
    observeWuInline();
    // Re-measure when a summary element is normalised (content collapsed by blur).
    // The ResizeObserver alone won't fire in this case because panel-body's
    // flex-allocated layout size hasn't changed yet — this event breaks that deadlock.
    // Re-measure twice: immediately (catches most cases) and after 300 ms (catches
    // cases where the first rAF fires before the browser finishes layout of new content).
    let delayedTimer: ReturnType<typeof setTimeout> | null = null;
    const measureWithDelay = () => {
      observeWuInline(); // pick up .wu-inline if first generate just happened
      measure();
      if (delayedTimer) clearTimeout(delayedTimer);
      delayedTimer = setTimeout(measure, 300);
    };
    bodyNode.addEventListener('wu-normalised', measureWithDelay);
    measure();
    return () => {
      observer.disconnect();
      bodyNode.removeEventListener('wu-normalised', measureWithDelay);
      if (delayedTimer) clearTimeout(delayedTimer);
    };
  }, [panel.id, panel.height, onSpanChange, collapsed]);

  useEffect(() => {
    if (!panelMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (panelMenuRef.current && !panelMenuRef.current.contains(event.target as Node)) {
        setPanelMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [panelMenuOpen]);

  const effectiveSpan = collapsed ? 1 : spanOverride ?? panel.height;
  const showSave = panel.type === 'rich_text' && !collapsed;
  const noChanges = !saveState.dirty;
  const saveDisabled = !editable || saveState.saving || !saveHandlerRef.current;
  const saveMuted = noChanges || saveDisabled;
  const saveLabel = saveState.saving ? 'Saving…' : 'Save';
  const handleSaveClick = () => {
    if (!editable) return;
    if (saveState.saving) return;
    if (noChanges) {
      onNoChanges?.();
      return;
    }
    if (!saveHandlerRef.current) return;
    saveHandlerRef.current();
  };

  // Stable colours for up to 6 simultaneous editors — same palette used for
  // Gantt editor badges. Looped if there are ever more than 6.
  const PRESENCE_COLOURS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#a855f7'];
  const isEditableContentPanel =
    panel.type === 'rich_text' ||
    panel.type === 'weekly_update' ||
    panel.title?.toLowerCase() === 'weekly update';

  return (
    <div
      ref={ref}
      className={`dashboard-panel ${collapsed ? 'dashboard-panel--collapsed' : ''} ${panel.type === 'metrics' ? 'dashboard-panel--metrics' : ''} ${isDragging ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''}${editors.length > 0 ? ' is-being-edited' : ''}`}
      style={{
        gridColumn: `${panel.column} / span ${panel.width}`,
        gridRow: `${rowOverride ?? panel.row} / span ${effectiveSpan}`,
        ...(editors.length > 0 ? { '--presence-colour': PRESENCE_COLOURS[(editors.length - 1) % PRESENCE_COLOURS.length] } as React.CSSProperties : {}),
      }}
      onDragOver={(event) => {
        if (!editable) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDrop?.(panel.id);
      }}
      onDragEnter={() => onDragEnter?.(panel.id)}
      onDragLeave={() => onDragLeave?.(panel.id)}
    >
      <div
        className="panel-header"
        ref={headerRef}
      >
        <div className="panel-title-group">
          {editable && (
            <button
              type="button"
              className="panel-drag"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', panel.id);
                onDragStart?.(panel.id);
              }}
              onDragEnd={() => onDragEnd?.()}
              aria-label="Drag to reorder panel"
            >
              ::
            </button>
          )}
          {editable ? (
            <input
              type="text"
              aria-label="Panel title"
              value={panel.title || ''}
              placeholder="Panel title"
              onChange={(event) => onTitleDraft(panel.id, event.target.value)}
              onBlur={(event) => onTitleChange(panel.id, event.target.value)}
            />
          ) : (
            <span>{panel.title}</span>
          )}
        </div>
        {editors.length > 0 && (
          <div className="panel-presence-badges">
            {editors.map((e, i) => (
              <div
                key={e.accountId}
                className="panel-presence-avatar"
                data-tooltip={`${e.displayName} is editing`}
                style={{ background: PRESENCE_COLOURS[i % PRESENCE_COLOURS.length], zIndex: editors.length - i }}
              >
                {e.avatarUrl
                  ? <img src={e.avatarUrl} alt={e.displayName} />
                  : e.displayName.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
        )}
        <div className="panel-actions">
          {showSave && (
            <button
              type="button"
              className={`panel-save ${saveMuted ? 'is-muted' : ''}`}
              onClick={handleSaveClick}
              disabled={saveDisabled}
              aria-disabled={saveMuted}
            >
              {saveLabel}
            </button>
          )}
          <div className="panel-menu-anchor" ref={panelMenuRef}>
            <button
              type="button"
              className="icon-button"
              title="Panel options"
              aria-label="Panel options"
              onClick={() => setPanelMenuOpen((prev) => !prev)}
            >
              ...
            </button>
            {panelMenuOpen && (
              <div className="panel-menu">
                <div className="panel-menu-section">
                  <span className="panel-menu-label">Width</span>
                  <select
                    className="panel-width-select panel-width-select--menu"
                    value={panel.width}
                    onChange={(event) => {
                      if (!editable) return;
                      onWidthChange(panel.id, Number(event.target.value));
                      setPanelMenuOpen(false);
                    }}
                    disabled={!editable}
                  >
                    <option value={12}>{panelWidthLabels[12]}</option>
                    <option value={8}>{panelWidthLabels[8]}</option>
                    <option value={6}>{panelWidthLabels[6]}</option>
                    <option value={4}>{panelWidthLabels[4]}</option>
                    <option value={3}>{panelWidthLabels[3]}</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="panel-menu-item"
                  onClick={() => {
                    setPanelMenuOpen(false);
                    onToggleCollapse(panel.id);
                  }}
                >
                  {collapsed ? 'Expand' : 'Collapse'}
                </button>
                {editable && (
                  <button
                    type="button"
                    className="panel-menu-item"
                    onClick={() => {
                      setPanelMenuOpen(false);
                      onStartMove?.(panel.id);
                    }}
                  >
                    Move
                  </button>
                )}
                <button
                  type="button"
                  className="panel-menu-item danger"
                  onClick={() => {
                    if (!editable) return;
                    setPanelMenuOpen(false);
                    onDelete(panel.id);
                  }}
                  disabled={!editable}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {!collapsed && (
        (panel.type === 'weekly_update' || panel.title?.toLowerCase() === 'weekly update') ? (
          <div className="panel-body" ref={bodyRef}>
            <WeeklyUpdatePanel
              slug={dashboardSlug}
              panelId={panel.id}
              initialContent={panel.contentJson}
              onSave={onContentSave}
              activeFixVersionIds={activeFixVersionIds}
              updateStart={updateStart}
              updateEnd={updateEnd}
              ragStatusByVersionId={ragStatusByVersionId}
              onPresent={onPresent}
              canPresent={canPresent}
              onEditingSection={(sectionId) => onEditingStart?.(sectionId)}
              onEditingEnd={onEditingEnd}
              presenceEntries={presenceEntries}
              registerRemoteContentHandler={registerRemoteContentHandler}
            />
          </div>
        ) : panel.type === 'rich_text' ? (
          <RichTextPanel
            panel={panel}
            editable={editable}
            showToolbar
            onSave={onContentSave}
            bodyRef={bodyRef}
            onSaveStateChange={setSaveState}
            onRegisterSave={(handler: () => Promise<void>) => {
              saveHandlerRef.current = handler;
            }}
            onFocus={() => onEditingStart?.(panel.id)}
            onBlur={() => onEditingEnd?.()}
          />
        ) : panel.type === 'metrics' ? (
          <div className="panel-body" ref={bodyRef}>
            <MetricsPanel
              projects={projects}
              panelId={panel.id}
              dashboardSlug={dashboardSlug}
              activeFixVersionIds={activeFixVersionIds}
              initialNotes={panel.contentHtml ?? ''}
              onSaveNotes={(notes) =>
                onContentSave(panel.id, { contentHtml: notes })
              }
            />
          </div>
        ) : (
          <div className="panel-body" ref={bodyRef}>Unsupported panel type.</div>
        )
      )}
    </div>
  );
};

const computeLayoutRows = (
  panels: DashboardPanel[],
  spans: Record<string, number>,
  collapsed: Set<string>
) => {
  const sorted = [...panels].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    if (a.column !== b.column) return a.column - b.column;
    return (a.title || '').localeCompare(b.title || '');
  });

  const columnBottoms = new Array(12).fill(0);
  const placements: Record<string, number> = {};

  for (const panel of sorted) {
    const startCol = Math.max(1, panel.column);
    const endCol = Math.min(12, panel.column + panel.width - 1);
    const maxBottom = Math.max(...columnBottoms.slice(startCol - 1, endCol));
    const preferredRow = Math.max(1, panel.row);
    const rowStart = Math.max(preferredRow, maxBottom + 1);
    placements[panel.id] = rowStart;
    const span = collapsed.has(panel.id) ? 1 : spans[panel.id] || panel.height;
    const newBottom = rowStart + span - 1;
    for (let i = startCol - 1; i < endCol; i += 1) {
      columnBottoms[i] = Math.max(columnBottoms[i], newBottom);
    }
  }

  return placements;
};

// Controlled input for editing a custom bar's name. Previously the table row
// used `<input defaultValue={cb.name}>` (uncontrolled), which meant that any
// parent re-render landing while the user was typing would silently discard
// their unsaved edit. This component keeps an internal draft string and only
// pushes it back to the server on blur, while still picking up server-side
// renames via the `bar.name` prop changing.
const CustomBarNameInput: React.FC<{ bar: CustomBar; onCommit: (name: string) => void }> = ({ bar, onCommit }) => {
  const [draft, setDraft] = useState(bar.name);
  // Resync the draft if the upstream name changed *and* we're not actively
  // editing — otherwise an external rename would clobber the user's edit.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(bar.name);
  }, [bar.name]);
  return (
    <input
      type="text"
      aria-label="Custom bar name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={(e) => {
        focusedRef.current = false;
        const next = e.target.value;
        if (next && next !== bar.name) onCommit(next);
      }}
    />
  );
};

export const DashboardPage: React.FC<DashboardPageProps> = ({ authenticated }) => {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null);
  const [panels, setPanels] = useState<DashboardPanel[]>([]);
  // When true, the full-screen presentation overlay is shown (deck assembled
  // from every rich-text panel plus each weekly-update section).
  const [presenting, setPresenting] = useState(false);
  const [filters, setFilters] = useState<DashboardFilters>(() => normalizeFilters(null));
  const [filtersDirty, setFiltersDirty] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState<string>('');
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [fixVersionOptions, setFixVersionOptions] = useState<FixVersion[]>([]);
  const [fixVersionsLoading, setFixVersionsLoading] = useState(false);
  const [components, setComponents] = useState<{ id: string; name: string }[]>([]);
  const [roadmap, setRoadmap] = useState<RoadmapResponse | null>(null);
  // Bumped after successful create/delete of manual deps to force the
  // fetchRoadmap effect to re-run. Combined with the `ignore` flag below,
  // this discards any in-flight roadmap request that would otherwise resolve
  // after the optimistic mutation and revive just-deleted dependencies.
  const [roadmapNonce, setRoadmapNonce] = useState(0);
  // Snapshot lookup state. On a plain page load we prefer the cached snapshot
  // (fast) and skip the slow live Jira fetch; we only know whether a snapshot
  // exists once this resolves. 'pending' → still loading the snapshot, 'hit' →
  // cache present (use it, no live fetch), 'miss' → no cache (must fetch live).
  const [snapshotState, setSnapshotState] = useState<'pending' | 'hit' | 'miss'>('pending');
  // Which tab is showing. Updates is the default landing tab; Roadmap holds the
  // Gantt + fix-version/milestone editors. Both stay in the same page (the
  // roadmap data is fetched once on mount) so switching tabs is instant.
  // Backed by the URL `?tab=` query param so a page refresh reloads on the same
  // tab the user was viewing rather than snapping back to Updates.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: 'updates' | 'roadmap' = searchParams.get('tab') === 'roadmap' ? 'roadmap' : 'updates';
  const setActiveTab = useCallback(
    (tab: 'updates' | 'roadmap') => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          // Keep the default (Updates) param-free so URLs stay clean.
          if (tab === 'updates') next.delete('tab');
          else next.set('tab', tab);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [customBars, setCustomBars] = useState<CustomBar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error` so the UI can render a clear "Dashboard not found"
  // state instead of a generic error card when the slug doesn't exist.
  const [notFound, setNotFound] = useState(false);
  // In-flight guard for handleAddPanel — double-clicks would otherwise POST
  // twice and create duplicate panels. Cleared in finally.
  const [addingPanel, setAddingPanel] = useState(false);
  const [collapsedFixVersions, setCollapsedFixVersions] = useState<Set<string>>(new Set());
  const [collapsedEpics, setCollapsedEpics] = useState<Set<string>>(new Set());
  const [newMilestone, setNewMilestone] = useState({ label: '', date: '', color: '#22c55e', projectScope: '' });
  const [panelSpans, setPanelSpans] = useState<Record<string, number>>({});
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set());
  const [newCustomBar, setNewCustomBar] = useState({ name: '', swimlaneId: '', start: '', end: '', color: '#a78bfa', allLanes: false });
  const [fixVersionPickerCanClear, setFixVersionPickerCanClear] = useState(false);
  const fixVersionPickerRef = useRef<FixVersionPickerHandle | null>(null);
  const handleFixVersionCanClearChange = useCallback((canClear: boolean) => {
    setFixVersionPickerCanClear(canClear);
  }, []);
  const [newPanelWidth, setNewPanelWidth] = useState(12);
  const [toast, setToast] = useState({ message: '', visible: false });
  const toastTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [presence, setPresenceState] = useState<PresenceEntry[]>([]);
  const presenceIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Heartbeat: resend presence every 15s while the user is actively editing so
  // the entry doesn't expire (TTL = 30s) before they finish.
  const activeEditRef = React.useRef<{ slug: string; barId: string } | null>(null);
  const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const stopEditingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks in-flight dependency-create POSTs, keyed by the optimistic `temp:`
  // id. Lets handleRemoveDependency wait for the server-issued id instead of
  // silently dropping Remove clicks made before the POST resolves.
  const pendingCreatesRef = useRef<Map<string, Promise<string>>>(new Map());
  // AbortController for the in-flight /api/roadmap fetch. We abort this when
  // the user makes an optimistic dependency edit so a late-arriving pre-edit
  // response can't overwrite the optimistic state (and the snapshot cache).
  // The roadmap effect itself re-runs via `roadmapNonce`; the ref lets the
  // dep-edit handlers kill the old request even without a deps-change.
  const roadmapAbortRef = useRef<AbortController | null>(null);
  // Last roadmap signature we wrote to the snapshot cache. The roadmap effect
  // skips updateDashboardSnapshot when the new payload's signature matches —
  // avoids hammering the snapshot endpoint on every filter tick when nothing
  // material changed. Signature is a cheap shallow fingerprint, not a deep
  // diff: enough to skip identical refetches without missing real updates.
  const lastSnapshotSigRef = useRef<string | null>(null);
  // Gate for the "use the cached snapshot on first load" behaviour. The roadmap
  // effect makes a one-time decision per dashboard: on the very first run, fall
  // back to the snapshot (no live fetch) if one exists. Once decided, every
  // later run — filter change or explicit Refresh — fetches live as normal.
  // Reset to false whenever the slug changes (see the snapshot effect).
  const initialRoadmapDecisionRef = useRef(false);
  // Signature of the inputs the last live roadmap fetch (or snapshot hit) was
  // satisfied with. The roadmap effect compares the current `roadmapFetchKey`
  // against this and skips the live fetch when they match. This guards against
  // the effect re-running with *identical filter values* but new array
  // identities — e.g. StrictMode double-invoking the dashboard fetch, which
  // calls setFilters twice and recreates the projects/fixVersions/components
  // arrays. Without this, such a spurious re-run would bypass the one-time
  // decision gate and trigger a redundant ~12s live Jira fetch over a snapshot
  // we already have.
  const lastRoadmapFetchKeyRef = useRef<string | null>(null);
  const [draggingPanelId, setDraggingPanelId] = useState<string | null>(null);
  const [isMenuMove, setIsMenuMove] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [placingPanel, setPlacingPanel] = useState(false);
  const [placement, setPlacement] = useState<{ row: number; column: number } | null>(null);
  const [placementValid, setPlacementValid] = useState(false);
  const panelsRef = React.useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setRoadmap(null);
    setMilestones([]);
    setCustomBars([]);
    setCollapsedFixVersions(new Set());
    setNotFound(false);
    setError(null);
    fetchDashboard(slug)
      .then((data) => {
        setDashboard(data);
        setPanels(data.panels || []);
        setCollapsedPanels(new Set((data.panels || []).filter((p) => p.collapsed).map((p) => p.id)));
        setFilters(normalizeFilters(data.filters));
        setCustomBars(data.customBars || []);
        setFiltersDirty(false);
        setDescriptionDraft(data.description ?? '');
      })
      .catch((err) => {
        // apiFetch attaches `status` to thrown errors — surface 404s as a
        // distinct "not found" state so the UI can render a clear message
        // instead of a generic error card.
        if (err?.status === 404) {
          setNotFound(true);
        } else {
          setError(err?.message || 'Failed to load dashboard');
        }
      })
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

  // Per-panel handlers that know how to merge a fresh remote content payload
  // into their local state without clobbering in-flight user edits (e.g.
  // WeeklyUpdatePanel's applyRemoteContent skips focused sections). Panels
  // register themselves here on mount and clear on unmount.
  const panelRemoteHandlersRef = useRef<Map<string, (contentJson: Record<string, unknown> | null) => void>>(new Map());
  const registerPanelRemoteHandler = useCallback(
    (panelId: string, handler: ((cj: Record<string, unknown> | null) => void) | null) => {
      if (handler) panelRemoteHandlersRef.current.set(panelId, handler);
      else panelRemoteHandlersRef.current.delete(panelId);
    },
    [],
  );

  // Subscribe to the dashboard's server-sent event stream. The server pushes
  // a `panel.updated` event whenever any panel's content mutates, so peers
  // refetch only the affected panel — no polling loops, no race windows.
  // Replaces the previous presence-driven content fetch + 10s backup poll.
  const handlePanelUpdated = useCallback(
    ({ panelId }: { panelId: string; updatedAt: string | null }) => {
      if (!slug) return;
      fetchPanelContent(slug, panelId)
        .then(({ contentJson, updatedAt: serverUpdatedAt }) => {
          // If the panel has registered a smart merge handler (e.g. weekly
          // update merging by section, preserving the user's focused edits),
          // route through it. The handler decides what to do with the new
          // content.
          const handler = panelRemoteHandlersRef.current.get(panelId);
          if (handler) handler(contentJson);
          // Always refresh the panel row in state so unmount/remount paths,
          // RichTextPanel switches, and post-disconnect refetches read the
          // latest content. Panels that already applied via the handler treat
          // this as a benign no-op since their displayed state was just
          // merged.
          setPanels((prev) =>
            prev.map((panel) =>
              panel.id === panelId
                ? { ...panel, contentJson: (contentJson ?? {}) as DashboardPanel['contentJson'], updatedAt: serverUpdatedAt ?? panel.updatedAt }
                : panel,
            ),
          );
        })
        .catch(() => { /* best-effort; transient fetch failure is recovered by the next event or reconnect */ });
    },
    [slug],
  );

  const handleEventStreamOpen = useCallback(() => {
    // On (re)connect, refresh dashboard state so we don't sit on stale
    // content from events emitted while disconnected.
    if (!slug) return;
    fetchDashboard(slug)
      .then((data) => setPanels(data.panels || []))
      .catch((err) => { console.warn('[dashboard] event-stream reconnect refresh failed:', err); });
  }, [slug]);

  useDashboardEvents(slug, {
    onPanelUpdated: handlePanelUpdated,
    onOpen: handleEventStreamOpen,
  });

  // Poll for other users' presence on this dashboard every 2 seconds.
  useEffect(() => {
    if (!authenticated || !slug) return;
    // `cancelled` guards against late resolutions from a stale poll closure
    // when the slug changes mid-flight — without this, navigating between
    // dashboards lets the old poll's response overwrite the new dashboard's
    // presence state.
    let cancelled = false;
    const poll = () => {
      fetchPresence(slug)
        .then((entries) => {
          if (cancelled) return;
          setPresenceState((prev) => {
            if (
              prev.length === entries.length &&
              prev.every((p, i) => p.accountId === entries[i]?.accountId && p.barId === entries[i]?.barId)
            ) return prev;
            return entries;
          });
        })
        .catch((err) => { console.warn('[dashboard] presence poll failed:', err); });
    };
    poll();
    presenceIntervalRef.current = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
        presenceIntervalRef.current = null;
      }
    };
  }, [authenticated, slug]);

  // Clear our presence entry when navigating away or when the dashboard slug changes.
  useEffect(() => {
    return () => {
      if (stopEditingTimerRef.current) clearTimeout(stopEditingTimerRef.current);
      stopEditingTimerRef.current = null;
      activeEditRef.current = null;
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
      if (authenticated) clearPresence().catch((err) => {
        console.warn('[dashboard] clearPresence on unmount failed:', err);
      });
    };
  }, [authenticated, slug]);

  const startEditing = React.useCallback((barId: string) => {
    if (!slug) return;
    // Cancel any pending stop so blur→focus/input events don't clear presence.
    if (stopEditingTimerRef.current) {
      clearTimeout(stopEditingTimerRef.current);
      stopEditingTimerRef.current = null;
    }
    // Only send HTTP if target changed — input events fire on every keystroke
    // so we skip the request when already tracking the same section.
    const alreadyTracking = activeEditRef.current?.barId === barId;
    activeEditRef.current = { slug, barId };
    if (!alreadyTracking) {
      setPresence(slug, barId).catch((err) => {
        console.warn('[dashboard] setPresence (start editing) failed:', err);
      });
    }
    if (!heartbeatIntervalRef.current) {
      heartbeatIntervalRef.current = setInterval(() => {
        const edit = activeEditRef.current;
        if (edit) setPresence(edit.slug, edit.barId).catch((err) => {
          // Repeated heartbeat failures mean presence entries are expiring on
          // the server; surface so debugging session loss is easier.
          console.warn('[dashboard] presence heartbeat failed:', err);
        });
      }, 15000);
    }
  }, [slug]);

  const stopEditing = React.useCallback(() => {
    // Short grace period in case a blur→focus transition briefly fires
    // (e.g. switching between two sections).
    if (stopEditingTimerRef.current) clearTimeout(stopEditingTimerRef.current);
    stopEditingTimerRef.current = setTimeout(() => {
      activeEditRef.current = null;
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      clearPresence().catch((err) => {
        console.warn('[dashboard] clearPresence (stop editing) failed:', err);
      });
    }, 200);
  }, []);

  // Memoized so that FixVersionPicker's onEditingChange effect doesn't fire
  // on every re-render (e.g. the presence poll every 2s), which would
  // call stopEditing() repeatedly and clear the weekly-update presence.
  const handleGanttEditingChange = React.useCallback((fixVersionId: string | null) => {
    if (slug && fixVersionId) {
      startEditing(fixVersionId);
    } else {
      stopEditing();
    }
  }, [slug, startEditing, stopEditing]);

  // Load the cached snapshot immediately on (re)load. On a plain page refresh
  // this is the roadmap the user sees — the live Jira fetch is skipped unless
  // the snapshot is missing or the user changes a filter / clicks Refresh (see
  // the roadmap effect below, gated on `snapshotState`).
  useEffect(() => {
    if (!slug) return;
    let active = true;
    // New dashboard: reset the snapshot lookup + the one-time "use cache on
    // first load" decision so the gate re-arms for this slug.
    setSnapshotState('pending');
    initialRoadmapDecisionRef.current = false;
    lastRoadmapFetchKeyRef.current = null;
    fetchDashboardSnapshot(slug)
      .then((data) => {
        if (!active) return;
        if (!data) {
          setSnapshotState('miss');
          return;
        }
        setRoadmap((prev) => prev ?? data);
        setMilestones((prev) => (prev.length ? prev : data.milestones || []));
        setCollapsedFixVersions((prev) => (prev.size ? prev : new Set(data.fixVersions.map((fix) => fix.id))));
        // Epics also start collapsed — expanding a fix version reveals the
        // epic bars but keeps their stories hidden until the user drills in.
        setCollapsedEpics(new Set(data.fixVersions.flatMap((fix) => fix.epics.map((epic) => epic.id))));
        setSnapshotState('hit');
      })
      .catch((err) => {
        // Snapshot is best-effort; log for debugging but don't surface to user.
        // Treat a failure as a miss so the live fetch still runs.
        console.debug('fetchDashboardSnapshot failed for slug', slug, err);
        if (active) setSnapshotState('miss');
      });
    return () => { active = false; };
  }, [slug]);

  useEffect(() => {
    if (!authenticated) return;
    fetchProjects()
      .then((projectData) => {
        setProjects(projectData);
      })
      .catch((err) => setError(err.message || 'Failed to load filters'));
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !filters.projects.length) return;
    // Rapid filter changes (project picker, date range) would otherwise race;
    // a late resolution could overwrite the options for the *current* filter
    // set with a stale list. `cancelled` mirrors the snapshot effect's
    // approach since fetchFixVersions doesn't accept an AbortSignal.
    let cancelled = false;
    setFixVersionsLoading(true);
    fetchFixVersions(
      filters.projects,
      filters.incrementStart || defaultStart,
      filters.incrementEnd || defaultEnd
    )
      .then((options) => {
        if (cancelled) return;
        setFixVersionOptions(options);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load fix versions');
      })
      .finally(() => {
        if (cancelled) return;
        setFixVersionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [authenticated, filters.projects, filters.incrementStart, filters.incrementEnd]);

  useEffect(() => {
    if (!authenticated || !filters.projects.length) return;
    fetchComponents(filters.projects)
      .then(setComponents)
      .catch((err) => setError(err.message || 'Failed to load components'));
  }, [authenticated, filters.projects]);

  // New dashboards intentionally start with no project selected — the user
  // picks one explicitly via the Filters bar. We previously auto-selected
  // projects[0] when filters.projects was empty, which prevented brand-new
  // dashboards from ever being empty and surprised users who wanted to open
  // an empty dashboard and pick a project themselves. Removed: let the
  // empty state stand until the user chooses.

  // Stable string fingerprint of everything the live roadmap fetch consumes,
  // plus `roadmapNonce` so an explicit Refresh (which bumps the nonce) always
  // forces a new fetch. Being a string, it has value identity — re-creating the
  // underlying filter arrays with identical contents yields the same key, so it
  // won't spuriously re-trigger the fetch the way the raw array deps did.
  const roadmapFetchKey = useMemo(
    () =>
      JSON.stringify({
        projects: filters.projects,
        fixVersions: filters.fixVersions,
        components: filters.components,
        start: filters.incrementStart || defaultStart,
        end: filters.incrementEnd || defaultEnd,
        nonce: roadmapNonce
      }),
    [
      filters.projects,
      filters.fixVersions,
      filters.components,
      filters.incrementStart,
      filters.incrementEnd,
      roadmapNonce
    ]
  );

  useEffect(() => {
    if (!authenticated || !dashboard || !filters.projects.length) return;
    // On the FIRST run for this dashboard, prefer the cached snapshot over a
    // slow live Jira fetch. We can only decide once the snapshot lookup has
    // resolved, so bail out while it's still 'pending' (the effect re-runs when
    // `snapshotState` settles). A 'hit' means the snapshot effect already
    // populated the roadmap — use it and skip the fetch. A 'miss' falls through
    // to fetch live.
    if (!initialRoadmapDecisionRef.current) {
      if (snapshotState === 'pending') return;
      initialRoadmapDecisionRef.current = true;
      if (snapshotState === 'hit') {
        // Record the inputs the snapshot already satisfies so the guard below
        // suppresses a redundant live fetch when this effect re-runs with the
        // same values (e.g. StrictMode's double dashboard fetch recreating the
        // filter arrays, or `dashboard` changing identity).
        lastRoadmapFetchKeyRef.current = roadmapFetchKey;
        setLoading(false);
        return;
      }
    }
    // Skip the live fetch when nothing it actually consumes has changed. A real
    // filter change (or a Refresh-driven nonce bump) produces a new
    // `roadmapFetchKey` and falls through; identical-value re-runs no-op here.
    if (lastRoadmapFetchKeyRef.current === roadmapFetchKey) return;
    lastRoadmapFetchKeyRef.current = roadmapFetchKey;
    // Two cancellation channels for in-flight fetches:
    //  - `ignore`: flips true on effect cleanup (deps change). Drops late
    //    resolutions from this effect instance when deps have moved on.
    //  - AbortController in `roadmapAbortRef`: lets OPTIMISTIC dep-edit
    //    handlers cancel the request mid-flight even when no deps change,
    //    so a pre-edit response can't overwrite the optimistic state +
    //    snapshot cache after the user has already mutated it.
    let ignore = false;
    roadmapAbortRef.current?.abort();
    const controller = new AbortController();
    roadmapAbortRef.current = controller;
    setLoading(true);
    setError(null);
    fetchRoadmap(
      filters.projects,
      filters.incrementStart || defaultStart,
      filters.incrementEnd || defaultEnd,
      filters.fixVersions,
      filters.components,
      dashboard.id,
      controller.signal
    )
      .then((data) => {
        if (ignore || controller.signal.aborted) return;
        setRoadmap(data);
        setMilestones(data.milestones || []);
        setCollapsedFixVersions(new Set(data.fixVersions.map((fix) => fix.id)));
        // Epics also start collapsed — expanding a fix version reveals the
        // epic bars but keeps their stories hidden until the user drills in.
        setCollapsedEpics(new Set(data.fixVersions.flatMap((fix) => fix.epics.map((epic) => epic.id))));
        if (slug) {
          // Shallow signature: fix-version count + their id|updatedAt pairs +
          // milestone count. Cheap to compute, sufficient to detect "nothing
          // changed since last write" without a deep diff utility.
          const sig = [
            data.fixVersions.length,
            data.milestones?.length ?? 0,
            ...data.fixVersions.map((f) => `${f.id}|${(f as any).updatedAt ?? ''}`),
          ].join(',');
          if (sig !== lastSnapshotSigRef.current) {
            lastSnapshotSigRef.current = sig;
            updateDashboardSnapshot(slug, data).catch(() => null);
          }
        }
      })
      .catch((err) => {
        if (ignore || controller.signal.aborted) return;
        // AbortError surfaces as a DOMException on fetch — swallow it since
        // the user-initiated abort path handles state cleanup itself.
        if (err?.name === 'AbortError') return;
        setError(err.message || 'Failed to load roadmap');
      })
      .finally(() => {
        if (ignore || controller.signal.aborted) return;
        setLoading(false);
      });
    return () => {
      ignore = true;
      controller.abort();
    };
    // Only re-fetch when a filter the Jira call actually consumes changes.
    // Earlier we depended on the whole `filters` object, which meant purely
    // presentational toggles (ganttMode, swimlaneMilestoneView, showDependencies,
    // dependenciesManualOnly, swimlanes, …) triggered a full
    // roadmap refetch — hitting Jira unnecessarily and wiping the chart while
    // users were just switching views. List the exact inputs to fetchRoadmap
    // here so view-only toggles stay instant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    authenticated,
    dashboard,
    roadmapFetchKey,
    snapshotState
  ]);

  const projectItems = useMemo(
    () => projects.map((project) => ({ id: project.key, label: project.name, meta: project.key })),
    [projects]
  );

  const fixVersionItems = useMemo(
    () =>
      fixVersionOptions
        .map((fix) => ({
          id: fix.id,
          label: fix.projectKey ? `${fix.projectKey} > ${fix.name}` : fix.name
        }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [fixVersionOptions]
  );

  const fixVersionNameById = useMemo(() => {
    const map = new Map<string, string>();
    fixVersionOptions.forEach((fix) => {
      map.set(fix.id, fix.name);
    });
    return map;
  }, [fixVersionOptions]);

  const activeFixVersionSet = useMemo(() => {
    if (!filters.fixVersions.length) return null;
    const byId = new Map<string, FixVersion>();
    const byName = new Map<string, string[]>();
    fixVersionOptions.forEach((fix) => {
      byId.set(fix.id, fix);
      const list = byName.get(fix.name) || [];
      list.push(fix.id);
      byName.set(fix.name, list);
    });
    const allowed = new Set<string>();
    filters.fixVersions.forEach((value) => {
      if (byId.has(value)) {
        allowed.add(value);
      }
    });
    filters.fixVersions.forEach((value) => {
      if (byId.has(value)) return;
      const ids = byName.get(value);
      ids?.forEach((id) => allowed.add(id));
    });
    return allowed;
  }, [filters.fixVersions, fixVersionOptions]);

  // The Updates tab scopes its summary by its OWN fix-version selection
  // (filters.updateFixVersions), independent of the roadmap's fixVersions.
  // Falls back to the roadmap's active set when the user hasn't picked any.
  const updateActiveFixVersionSet = useMemo(() => {
    const selected = filters.updateFixVersions ?? [];
    if (!selected.length) return activeFixVersionSet;
    const byId = new Map<string, FixVersion>();
    const byName = new Map<string, string[]>();
    fixVersionOptions.forEach((fix) => {
      byId.set(fix.id, fix);
      const list = byName.get(fix.name) || [];
      list.push(fix.id);
      byName.set(fix.name, list);
    });
    const allowed = new Set<string>();
    selected.forEach((value) => {
      if (byId.has(value)) allowed.add(value);
    });
    selected.forEach((value) => {
      if (byId.has(value)) return;
      byName.get(value)?.forEach((id) => allowed.add(id));
    });
    return allowed;
  }, [filters.updateFixVersions, fixVersionOptions, activeFixVersionSet]);

  // Build a fix-version id → RAG map using the same schedule logic that drives
  // the Gantt bar colour, so the weekly-update panel's RAG badge agrees with
  // the Gantt for the same fix version.
  const ragByFixVersionId = useMemo(() => {
    const today = new Date();
    const map: Record<string, 'red' | 'amber' | 'green'> = {};
    (roadmap?.fixVersions ?? []).forEach((fix) => {
      map[fix.id] = computeFixVersionRag(fix, today);
    });
    return map;
  }, [roadmap?.fixVersions]);

  const swimlaneFixVersionItems = useMemo(() => {
    const options = activeFixVersionSet
      ? fixVersionOptions.filter((fix) => activeFixVersionSet.has(fix.id))
      : fixVersionOptions;
    return options
      .map((fix) => ({
        id: fix.id,
        label: fix.projectKey ? `${fix.projectKey} > ${fix.name}` : fix.name
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [fixVersionOptions, activeFixVersionSet]);

  const componentItems = useMemo(
    () => components.map((component) => ({ id: component.name, label: component.name })),
    [components]
  );

  const handleFilterChange = (next: Partial<DashboardFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setFiltersDirty(true);
  };

  // Collapse/expand of the filter, milestone and custom-bar sections is a
  // layout preference, not a filter edit — so it must NOT flip the "unsaved
  // changes" flag. We still persist it so the folded state survives a reload,
  // but we merge it onto the SAVED baseline (not the live, possibly-dirty
  // filters) so a pending edit isn't flushed early. Failures (e.g. viewers
  // without write access) are swallowed — the local toggle still applies.
  const handleUiPrefChange = (next: Partial<DashboardFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    if (!slug || !dashboard) return;
    const baseline = normalizeFilters(dashboard.filters);
    updateDashboard(slug, { filters: { ...baseline, ...next } })
      .then((updated) => setDashboard(updated))
      .catch(() => null);
  };

  // ── Presentation deck ───────────────────────────────────────────────────────
  // Assemble a single slide deck from every panel: rich-text panels become one
  // slide each, and each weekly-update panel expands into one slide per fix-
  // version section (released first, then active). Panels are walked in layout
  // order (top-to-bottom, left-to-right) so the natural sequence mirrors the
  // dashboard. The user's saved drag-order is folded on at use (see below).
  const presentationDeck = useMemo(() => {
    const sorted = [...panels].sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row;
      if (a.column !== b.column) return a.column - b.column;
      return (a.title || '').localeCompare(b.title || '');
    });
    const natural: PresentationSlide[] = [];
    let released = 0;
    let active = 0;
    let project = '';
    let dateRange: string | null = null;
    for (const panel of sorted) {
      const isWeekly =
        panel.type === 'weekly_update' || panel.title?.toLowerCase() === 'weekly update';
      if (isWeekly) {
        const content = parseStoredPanelContent(panel.contentJson ?? null);
        if (!content) continue;
        if (!project && content.project) project = content.project;
        if (!dateRange && content.dateRange) dateRange = content.dateRange;
        for (const section of content.released) {
          natural.push({ kind: 'section', id: section.id, section, released: true });
          released += 1;
        }
        for (const section of content.active) {
          natural.push({ kind: 'section', id: section.id, section, released: false });
          active += 1;
        }
      } else if (panel.type === 'rich_text') {
        const html = (panel.contentHtml ?? '').trim();
        if (!html) continue;
        natural.push({ kind: 'richText', id: `rt:${panel.id}`, title: panel.title || 'Note', html });
      }
    }
    // REVERT: remove this roadmap slide marker to drop the roadmap from the deck.
    // Appended last so the roadmap closes out the deck by default.
    if ((roadmap?.fixVersions?.length ?? 0) > 0) {
      natural.push({ kind: 'roadmap', id: 'roadmap', title: 'Roadmap' });
    }
    return { natural, released, active, project, dateRange };
  }, [panels, roadmap]);

  // Fold the saved order onto the natural deck: unknown ids drop out, new
  // slides append in natural order (reconcileOrder keeps exactly the live set).
  const orderedPresentationSlides = useMemo(() => {
    const byId = new Map(presentationDeck.natural.map((s) => [s.id, s]));
    return reconcileOrder(
      presentationDeck.natural.map((s) => s.id),
      filters.presentationOrder,
    )
      .map((id) => byId.get(id))
      .filter((s): s is PresentationSlide => Boolean(s));
  }, [presentationDeck, filters.presentationOrder]);

  // Persist a new slide sequence after a drag-reorder. Treated as a UI pref so
  // it saves immediately against the saved baseline without flipping the
  // "unsaved changes" flag or flushing pending filter edits.
  const handlePresentationReorder = (ids: string[]) => {
    handleUiPrefChange({ presentationOrder: ids });
  };

  // Toggle a slide's hidden state on the presentation Overview, persisted the
  // same way as the slide order (immediate UI pref, no dirty flag).
  const handlePresentationToggleHidden = (id: string) => {
    const current = filters.presentationHidden ?? [];
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    handleUiPrefChange({ presentationHidden: next });
  };

  const updateSwimlane = (laneId: string, patch: Partial<Swimlane>) => {
    handleFilterChange({
      swimlanes: (filters.swimlanes || []).map((lane) => (lane.id === laneId ? { ...lane, ...patch } : lane))
    });
  };

  const removeSwimlane = (laneId: string) => {
    handleFilterChange({
      swimlanes: (filters.swimlanes || []).filter((lane) => lane.id !== laneId),
      // Also drop the lane from any initiative's membership so its id doesn't
      // linger as a stale "ghost" in the grouping (which inflated lane counts).
      initiatives: (filters.initiatives || []).map((init) => ({
        ...init,
        swimlaneIds: (init.swimlaneIds || []).filter((id) => id !== laneId)
      }))
    });
  };

  const addSwimlane = () => {
    const next: Swimlane = { id: createLaneId(), name: 'New lane', fixVersionIds: [] };
    handleFilterChange({ swimlanes: [...(filters.swimlanes || []), next] });
  };

  // Create a lane and drop it straight into an initiative (used by the grouped
  // editor's per-group "Add lane" button). The lane is appended to the flat
  // list and its id pushed onto the initiative's swimlaneIds in one update.
  const addSwimlaneToInitiative = (initiativeId: string) => {
    const lane: Swimlane = { id: createLaneId(), name: 'New lane', fixVersionIds: [] };
    handleFilterChange({
      swimlanes: [...(filters.swimlanes || []), lane],
      initiatives: (filters.initiatives || []).map((init) =>
        init.id === initiativeId
          ? { ...init, swimlaneIds: [...(init.swimlaneIds || []), lane.id] }
          : init
      )
    });
  };

  // Drag-to-reorder lanes. Lane order is just the array order (the Gantt
  // renders lanes in this sequence), so reordering = moving the dragged lane
  // to the drop target's index. `dragLaneId` tracks the lane being dragged and
  // `dragOverLaneId` the row currently hovered, for drop-indicator styling.
  const [dragLaneId, setDragLaneId] = useState<string | null>(null);
  const [dragOverLaneId, setDragOverLaneId] = useState<string | null>(null);
  // Whether the hovered row's drop indicator sits below it (dropping the lane
  // *after* the target) vs above it (before). Driven by which half of the row
  // the cursor is in, so the blue bar previews where the lane will land.
  const [dragOverLaneAfter, setDragOverLaneAfter] = useState(false);
  // The container (initiative id, or '__ungrouped__') a dragged lane is hovering
  // over, so the whole group highlights as a drop target.
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  // The whole lane card / initiative header is grabbable for reordering, but a
  // focused name input must still allow click-drag text selection. We disable
  // dragging on the card/header whose name field is being edited.
  const [editingNameId, setEditingNameId] = useState<string | null>(null);

  const clearLaneDrag = () => {
    setDragLaneId(null);
    setDragOverLaneId(null);
    setDragOverGroupId(null);
  };

  // The initiative that owns a given lane (undefined if ungrouped).
  const initiativeOfSwimlane = (laneId: string) =>
    (filters.initiatives || []).find((init) => (init.swimlaneIds || []).includes(laneId));

  // Rebuild the flat `filters.swimlanes` order to mirror the grouped order:
  // each initiative's lanes (in swimlaneIds order), then any ungrouped lanes
  // (in their existing flat order). Keeps the flat list — used when
  // initiatives are off — consistent with the on-screen grouped arrangement.
  const rebuildSwimlaneOrder = (lanes: Swimlane[], inits: Initiative[]) => {
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    const used = new Set<string>();
    const ordered: Swimlane[] = [];
    for (const init of inits) {
      for (const sid of init.swimlaneIds || []) {
        const lane = laneById.get(sid);
        if (lane && !used.has(sid)) {
          ordered.push(lane);
          used.add(sid);
        }
      }
    }
    for (const lane of lanes) {
      if (!used.has(lane.id)) ordered.push(lane);
    }
    return ordered;
  };

  // Move a lane to a target container, optionally before a specific lane.
  //  - toInitId: the destination initiative id, or null for the Ungrouped pool.
  //  - toLaneId: drop before this lane within the destination (null = append).
  // Handles every case in one place: reorder within a group, reorder ungrouped,
  // and dragging across boundaries (ungrouped ↔ initiative, initiative ↔
  // initiative). Membership lives in each initiative's swimlaneIds; the flat
  // `filters.swimlanes` list is rebuilt to mirror the grouped order afterwards,
  // with ungrouped lanes keeping the order of the flat array.
  const moveLane = (
    fromId: string,
    toInitId: string | null,
    toLaneId: string | null,
    after = false
  ) => {
    if (fromId === toLaneId) return;
    const lanesArr = [...(filters.swimlanes || [])];
    // Drop the lane out of every initiative first, then add it back to the
    // target (if grouped) at the requested position.
    const nextInits = (filters.initiatives || []).map((init) => ({
      ...init,
      swimlaneIds: (init.swimlaneIds || []).filter((id) => id !== fromId)
    }));
    if (toInitId) {
      const target = nextInits.find((init) => init.id === toInitId);
      if (!target) return;
      if (toLaneId) {
        const idx = target.swimlaneIds.indexOf(toLaneId);
        const at = idx === -1 ? target.swimlaneIds.length : after ? idx + 1 : idx;
        target.swimlaneIds = [
          ...target.swimlaneIds.slice(0, at),
          fromId,
          ...target.swimlaneIds.slice(at)
        ];
      } else {
        target.swimlaneIds = [...target.swimlaneIds, fromId];
      }
    } else {
      // Ungrouped target — position within the flat array drives ungrouped order.
      const fromIdx = lanesArr.findIndex((lane) => lane.id === fromId);
      if (fromIdx !== -1) {
        const [moved] = lanesArr.splice(fromIdx, 1);
        const toIdx = toLaneId ? lanesArr.findIndex((lane) => lane.id === toLaneId) : -1;
        if (toIdx === -1) lanesArr.push(moved);
        else lanesArr.splice(after ? toIdx + 1 : toIdx, 0, moved);
      }
    }
    handleFilterChange({
      initiatives: nextInits,
      swimlanes: rebuildSwimlaneOrder(lanesArr, nextInits)
    });
  };

  const assignedFixVersions = useMemo(() => {
    const assigned = new Set<string>();
    (filters.swimlanes || []).forEach((lane) => lane.fixVersionIds.forEach((id) => assigned.add(id)));
    return assigned;
  }, [filters.swimlanes]);

  const updateInitiative = (initiativeId: string, patch: Partial<Initiative>) => {
    handleFilterChange({
      initiatives: (filters.initiatives || []).map((init) =>
        init.id === initiativeId ? { ...init, ...patch } : init
      )
    });
  };

  const removeInitiative = (initiativeId: string) => {
    handleFilterChange({
      initiatives: (filters.initiatives || []).filter((init) => init.id !== initiativeId)
    });
  };

  const addInitiative = () => {
    const next: Initiative = {
      id: createLaneId(),
      name: 'New initiative',
      colour: '#6366f1',
      swimlaneIds: [],
      fixVersionIds: []
    };
    handleFilterChange({ initiatives: [...(filters.initiatives || []), next] });
  };

  // Drag-to-reorder initiatives — mirrors the swimlane reorder. Initiative
  // order is the filters.initiatives array order (the Gantt renders spines in
  // this sequence).
  const [dragInitiativeId, setDragInitiativeId] = useState<string | null>(null);
  const [dragOverInitiativeId, setDragOverInitiativeId] = useState<string | null>(null);
  // Whether the hovered initiative's drop indicator sits below it (dropping the
  // group *after* the target) vs above it — driven by the cursor's half.
  const [dragOverInitiativeAfter, setDragOverInitiativeAfter] = useState(false);

  const reorderInitiatives = (fromId: string, toId: string, after = false) => {
    if (fromId === toId) return;
    const inits = filters.initiatives || [];
    const fromIdx = inits.findIndex((init) => init.id === fromId);
    if (fromIdx === -1) return;
    const next = [...inits];
    const [moved] = next.splice(fromIdx, 1);
    const toIdx = next.findIndex((init) => init.id === toId);
    if (toIdx === -1) return;
    next.splice(after ? toIdx + 1 : toIdx, 0, moved);
    // In swimlane mode, moving an initiative also moves its lanes at the top,
    // so re-sync the flat lane order to mirror the new grouped order. (Standard
    // mode groups fix versions, not lanes, so nothing to re-sync there.)
    if (filters.ganttMode === 'swimlane') {
      handleFilterChange({
        initiatives: next,
        swimlanes: rebuildSwimlaneOrder(filters.swimlanes || [], next)
      });
    } else {
      handleFilterChange({ initiatives: next });
    }
  };

  // Single commit point for an initiative drag. `onDragEnd` always fires (even
  // when the pointer is released off the editor, above the first card, or in a
  // gap), so committing here — using the last tracked drop target — makes the
  // reorder land reliably instead of only when a card/body `onDrop` happens to
  // catch the release. Drop handlers just keep the target up to date.
  const commitInitiativeReorder = () => {
    if (
      dragInitiativeId &&
      dragOverInitiativeId &&
      dragOverInitiativeId !== dragInitiativeId
    ) {
      reorderInitiatives(dragInitiativeId, dragOverInitiativeId, dragOverInitiativeAfter);
    }
    setDragInitiativeId(null);
    setDragOverInitiativeId(null);
    setDragOverInitiativeAfter(false);
  };

  // Swimlanes already claimed by another initiative — disabled in each
  // initiative's picker so a lane can't belong to two initiatives at once.
  const assignedSwimlanes = useMemo(() => {
    const assigned = new Set<string>();
    (filters.initiatives || []).forEach((init) => init.swimlaneIds.forEach((id) => assigned.add(id)));
    return assigned;
  }, [filters.initiatives]);

  const initiativeSwimlaneItems = useMemo(
    () => (filters.swimlanes || []).map((lane) => ({ id: lane.id, label: lane.name })),
    [filters.swimlanes]
  );

  // Fix versions already claimed by another initiative — disabled in each
  // initiative's picker (standard mode) so a fix version can't belong to two
  // initiatives at once. Mirrors `assignedSwimlanes` for the swimlane picker.
  const assignedInitiativeFixVersions = useMemo(() => {
    const assigned = new Set<string>();
    (filters.initiatives || []).forEach((init) =>
      (init.fixVersionIds || []).forEach((id) => assigned.add(id))
    );
    return assigned;
  }, [filters.initiatives]);

  // Collapsed spine state lives in the persisted filters so a folded
  // initiative stays folded after a reload. It's a UI preference, so it's
  // saved silently (handleUiPrefChange) without flagging unsaved changes.
  const collapsedInitiatives = useMemo(
    () => new Set(filters.collapsedInitiatives ?? []),
    [filters.collapsedInitiatives]
  );

  const toggleInitiative = (id: string) => {
    const current = filters.collapsedInitiatives ?? [];
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    handleUiPrefChange({ collapsedInitiatives: next });
  };

  // Card collapse prefs live in the persisted filters (saved via the filters
  // Save button) so a folded card stays folded after a reload, matching the
  // initiative-spine collapse behaviour.
  const filtersCollapsed = filters.filtersCollapsed ?? false;
  const milestonesCollapsed = filters.milestonesCollapsed ?? false;
  const customBarsCollapsed = filters.customBarsCollapsed ?? false;

  const handleSaveFilters = async () => {
    if (!dashboard || !slug) return;
    try {
      const updated = await updateDashboard(slug, { filters });
      setDashboard(updated);
      setFilters(normalizeFilters(updated.filters));
      setFiltersDirty(false);
    } catch (err: any) {
      setError(err.message || 'Failed to save filters');
    }
  };

  const showToast = (message: string) => {
    setToast({ message, visible: true });
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, 2200);
  };

  const dateRangeInvalid =
    !!filters.incrementStart &&
    !!filters.incrementEnd &&
    filters.incrementStart > filters.incrementEnd;

  const handleSaveFiltersClick = () => {
    if (!authenticated || !filtersDirty || dateRangeInvalid) return;
    handleSaveFilters();
  };

  const layoutRows = useMemo(
    () => computeLayoutRows(panels, panelSpans, collapsedPanels),
    [panels, panelSpans, collapsedPanels]
  );

  const getPanelSpan = (panel: DashboardPanel) => {
    if (collapsedPanels.has(panel.id)) return 1;
    return panelSpans[panel.id] || panel.height;
  };

  const getPanelRects = (ignoreIds?: string[]) =>
    panels
      .filter((panel) => !ignoreIds || !ignoreIds.includes(panel.id))
      .map((panel) => ({
        id: panel.id,
        row: (layoutRows[panel.id] ?? panel.row),
        column: panel.column,
        width: panel.width,
        height: getPanelSpan(panel)
      }));

  const isPlacementAvailable = (
    row: number,
    column: number,
    width: number,
    height: number,
    ignoreIds?: string | string[]
  ) => {
    const startCol = column;
    const endCol = column + width - 1;
    const startRow = row;
    const endRow = row + height - 1;
    if (startCol < 1 || endCol > 12 || startRow < 1) return false;
    const ignored = ignoreIds ? (Array.isArray(ignoreIds) ? ignoreIds : [ignoreIds]) : undefined;
    const rects = getPanelRects(ignored);
    return !rects.some((panel) => {
      const overlapColumns = startCol <= panel.column + panel.width - 1 && endCol >= panel.column;
      const overlapRows = startRow <= panel.row + panel.height - 1 && endRow >= panel.row;
      return overlapColumns && overlapRows;
    });
  };

  const clampColumn = (column: number) => {
    const maxStart = Math.max(1, 12 - newPanelWidth + 1);
    return Math.min(Math.max(1, column), maxStart);
  };

  const getPlacementFromPoint = (clientX: number, clientY: number) => {
    if (!panelsRef.current) return null;
    const rect = panelsRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const styles = window.getComputedStyle(panelsRef.current);
    const rowHeight = Number.parseFloat(styles.gridAutoRows || `${GRID_ROW_HEIGHT}`) || GRID_ROW_HEIGHT;
    const rowGap = Number.parseFloat(styles.rowGap || styles.gridRowGap || `${GRID_ROW_GAP}`) || GRID_ROW_GAP;
    const columnWidth = rect.width / 12;
    const column = clampColumn(Math.floor(x / columnWidth) + 1);
    const rowSize = rowHeight + rowGap;
    const row = Math.max(1, Math.floor(y / rowSize) + 1);
    return { row, column };
  };

  const getPlacementFromEvent = (event: React.MouseEvent<HTMLDivElement>) =>
    getPlacementFromPoint(event.clientX, event.clientY);

  const getDraggedPanel = () => panels.find((panel) => panel.id === draggingPanelId) || null;

  const handlePanelDragStart = (panelId: string) => {
    if (!authenticated) return;
    setDraggingPanelId(panelId);
  };

  const handlePanelDragEnd = () => {
    setDraggingPanelId(null);
    setIsMenuMove(false);
    setDropTargetId(null);
    setPlacement(null);
    setPlacementValid(false);
  };

  // Menu-initiated move: set draggingPanelId without a real drag event so
  // swap overlays appear on other panels and the user can click one to swap.
  const handleStartPanelMove = (panelId: string) => {
    if (!authenticated) return;
    setIsMenuMove(true);
    setDraggingPanelId(panelId);
  };

  const handlePanelDrop = async (targetId: string) => {
    if (!authenticated || !slug || !draggingPanelId || draggingPanelId === targetId) return;
    const source = panels.find((panel) => panel.id === draggingPanelId);
    const target = panels.find((panel) => panel.id === targetId);
    if (!source || !target) return;
    const sourceRow = layoutRows[source.id] ?? source.row;
    const targetRow = layoutRows[target.id] ?? target.row;
    const sourceColumn = source.column;
    const targetColumn = target.column;
    const ignoreIds = [source.id, target.id];
    const sourceHeight = getPanelSpan(source);
    const targetHeight = getPanelSpan(target);
    const sourceFits = isPlacementAvailable(targetRow, targetColumn, source.width, sourceHeight, ignoreIds);
    const targetFits = isPlacementAvailable(sourceRow, sourceColumn, target.width, targetHeight, ignoreIds);
    if (!sourceFits || !targetFits) {
      showToast('Not enough space to swap panels.');
      setDraggingPanelId(null);
      setDropTargetId(null);
      return;
    }
    setPanels((prev) =>
      prev.map((panel) => {
        if (panel.id === source.id) return { ...panel, row: targetRow, column: targetColumn };
        if (panel.id === target.id) return { ...panel, row: sourceRow, column: sourceColumn };
        return panel;
      })
    );
    setDraggingPanelId(null);
    setDropTargetId(null);
    try {
      await Promise.all([
        updateDashboardPanel(slug, source.id, { row: targetRow, column: targetColumn }),
        updateDashboardPanel(slug, target.id, { row: sourceRow, column: sourceColumn })
      ]);
    } catch (err: any) {
      setError(err.message || 'Failed to reorder panels');
    }
  };

  const movePanelTo = async (panelId: string, row: number, column: number) => {
    if (!slug) return;
    setPanels((prev) => prev.map((panel) => (panel.id === panelId ? { ...panel, row, column } : panel)));
    try {
      await updateDashboardPanel(slug, panelId, { row, column });
    } catch (err: any) {
      setError(err.message || 'Failed to move panel');
    }
  };

  const handleAddPanel = async (position?: { row: number; column: number }) => {
    if (!slug) return;
    // Bail if a previous click is still in flight — double-clicks would
    // otherwise POST twice and create duplicate panels.
    if (addingPanel) return;
    const maxRow = panels.reduce((max, panel) => {
      const row = layoutRows[panel.id] ?? panel.row;
      const span = getPanelSpan(panel);
      return Math.max(max, row + span - 1);
    }, 0);
    const nextRow = maxRow + 1;
    const row = position?.row ?? nextRow;
    const column = position?.column ?? 1;
    setAddingPanel(true);
    try {
      const created = await createDashboardPanel(slug, {
        type: 'rich_text',
        title: 'New panel',
        row,
        column,
        width: newPanelWidth,
        height: DEFAULT_PANEL_HEIGHT
      });
      setPanels((prev) => [...prev, created]);
    } catch (err: any) {
      setError(err.message || 'Failed to add panel');
    } finally {
      setAddingPanel(false);
    }
  };

  const startPlacement = () => {
    if (!authenticated) return;
    setPlacingPanel(true);
  };

  const cancelPlacement = () => {
    setPlacingPanel(false);
    setPlacement(null);
    setPlacementValid(false);
  };

  const handlePanelsMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!placingPanel) return;
    const next = getPlacementFromEvent(event);
    if (!next) return;
    setPlacement(next);
    setPlacementValid(isPlacementAvailable(next.row, next.column, newPanelWidth, DEFAULT_PANEL_HEIGHT));
  };

  const handlePanelsClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!placingPanel) return;
    const next = getPlacementFromEvent(event);
    if (!next) return;
    if (!isPlacementAvailable(next.row, next.column, newPanelWidth, DEFAULT_PANEL_HEIGHT)) {
      showToast('No space here!');
      return;
    }
    handleAddPanel(next);
    cancelPlacement();
  };

  const handlePlacementTargetClick = (row: number, column: number) => {
    if (draggingPanelId) {
      const dragged = getDraggedPanel();
      if (!dragged) return;
      const draggedHeight = getPanelSpan(dragged);
      if (!isPlacementAvailable(row, column, dragged.width, draggedHeight, dragged.id)) {
        showToast('No space here!');
        return;
      }
      movePanelTo(dragged.id, row, column);
      handlePanelDragEnd();
      return;
    }
    if (!placingPanel) return;
    if (!isPlacementAvailable(row, column, newPanelWidth, DEFAULT_PANEL_HEIGHT)) {
      showToast('No space here!');
      return;
    }
    handleAddPanel({ row, column });
    cancelPlacement();
  };

  useEffect(() => {
    if (!placement) return;
    if (draggingPanelId) {
      const dragged = getDraggedPanel();
      if (!dragged) return;
      setPlacementValid(isPlacementAvailable(placement.row, placement.column, dragged.width, getPanelSpan(dragged), dragged.id));
      return;
    }
    if (!placingPanel) return;
    setPlacementValid(isPlacementAvailable(placement.row, placement.column, newPanelWidth, DEFAULT_PANEL_HEIGHT));
  }, [placingPanel, draggingPanelId, placement, newPanelWidth, panels, panelSpans, collapsedPanels, layoutRows]);

  useEffect(() => {
    if (!placingPanel) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelPlacement();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placingPanel]);

  useEffect(() => {
    if (!draggingPanelId) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handlePanelDragEnd();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [draggingPanelId]);

  const handlePanelTitle = async (panelId: string, title: string) => {
    if (!slug) return;
    try {
      const updated = await updateDashboardPanel(slug, panelId, { title });
      setPanels((prev) => prev.map((panel) => (panel.id === updated.id ? updated : panel)));
    } catch (err: any) {
      setError(err.message || 'Failed to update panel');
    }
  };

  const handlePanelTitleDraft = (panelId: string, title: string) => {
    setPanels((prev) => prev.map((item) => (item.id === panelId ? { ...item, title } : item)));
  };

  const handlePanelSpan = (panelId: string, span: number) => {
    setPanelSpans((prev) => {
      if (prev[panelId] === span) return prev;
      return { ...prev, [panelId]: span };
    });
  };

  const handlePanelWidth = async (panelId: string, width: number) => {
    if (!slug) return;
    const panel = panels.find((item) => item.id === panelId);
    if (!panel) return;
    const maxWidth = Math.max(1, 12 - panel.column + 1);
    const clamped = Math.min(width, maxWidth);
    try {
      const updated = await updateDashboardPanel(slug, panelId, { width: clamped });
      setPanels((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err: any) {
      setError(err.message || 'Failed to update panel width');
    }
  };

  const handleToggleCollapse = async (panelId: string) => {
    const collapsed = !collapsedPanels.has(panelId);
    setCollapsedPanels((prev) => {
      const next = new Set(prev);
      if (collapsed) {
        next.add(panelId);
      } else {
        next.delete(panelId);
      }
      return next;
    });
    if (!slug) return;
    try {
      const updated = await updateDashboardPanel(slug, panelId, { collapsed });
      setPanels((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err: any) {
      setError(err.message || 'Failed to update panel');
    }
  };

  const handleDeletePanel = async (panelId: string) => {
    if (!slug) return;
    // TODO: replace window.confirm with the shared styled
    // ConfirmModal used in WeeklyUpdatePanel for visual consistency with the
    // rest of the app's destructive-action prompts. Kept as window.confirm
    // for now because DashboardPage has no existing modal infrastructure and
    // lifting WeeklyUpdatePanel's ConfirmModal out is a separate refactor.
    const confirmed = window.confirm('Delete this panel? This cannot be undone.');
    if (!confirmed) return;
    try {
      await deleteDashboardPanel(slug, panelId);
      setPanels((prev) => prev.filter((panel) => panel.id !== panelId));
      setPanelSpans((prev) => {
        const next = { ...prev };
        delete next[panelId];
        return next;
      });
      setCollapsedPanels((prev) => {
        const next = new Set(prev);
        next.delete(panelId);
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to delete panel');
    }
  };

  const handlePanelContent = async (panelId: string, payload: { contentJson?: Record<string, unknown>; contentHtml?: string }) => {
    if (!slug) return;
    try {
      const updated = await updateDashboardPanelContent(slug, panelId, payload);
      setPanels((prev) => prev.map((panel) => (panel.id === updated.id ? updated : panel)));
    } catch (err: any) {
      setError(err.message || 'Failed to save panel');
    }
  };

  const handleOverrideChange = async (
    fixVersionId: string,
    patch: {
      uatStart?: string | null;
      uatEnd?: string | null;
      liveStart?: string | null;
      liveEnd?: string | null;
      notes?: string | null;
    }
  ) => {
    // Snapshot the affected fix version *before* the PUT so we can restore
    // its previous values if the server rejects the change. Previous code
    // only applied the update on success, but if the caller had already
    // applied an optimistic UI change (or the user kept editing while the
    // request was in flight), a failed PUT would leave the UI inconsistent
    // with no error surfaced. We now restore + toast on failure.
    const previousFix = roadmap?.fixVersions.find((fix) => fix.id === fixVersionId);
    try {
      const updated = await updateFixVersionOverrides({
        fixVersionId,
        dashboardId: dashboard?.id,
        ...patch
      });

      setRoadmap((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          fixVersions: prev.fixVersions.map((fix) => {
            if (fix.id !== fixVersionId) return fix;
            const next = { ...fix };
            if (Object.prototype.hasOwnProperty.call(updated, 'uatStart')) {
              next.uatStart = updated.uatStart ?? null;
            }
            if (Object.prototype.hasOwnProperty.call(updated, 'uatEnd')) {
              next.uatEnd = updated.uatEnd ?? null;
            }
            if (Object.prototype.hasOwnProperty.call(updated, 'liveStart')) {
              next.liveStart = updated.liveStart ?? null;
            }
            if (Object.prototype.hasOwnProperty.call(updated, 'liveEnd')) {
              next.liveEnd = updated.liveEnd ?? null;
            }
            if (Object.prototype.hasOwnProperty.call(updated, 'notes')) {
              next.notes = updated.notes ?? null;
            }
            return next;
          })
        };
      });
    } catch (err: any) {
      // Roll back to the pre-PUT snapshot so the UI doesn't appear to have
      // accepted the change. Also surface a toast — the existing `setError`
      // path renders as a card at the top of the page but a transient toast
      // is more discoverable for an inline edit.
      if (previousFix) {
        setRoadmap((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            fixVersions: prev.fixVersions.map((fix) =>
              fix.id === fixVersionId ? previousFix : fix
            ),
          };
        });
      }
      showToast(err?.message || 'Failed to update override');
      setError(err?.message || 'Failed to update override');
    }
  };

  // Create a manual "A blocks B" dependency. Optimistically adds the edge to
  // the current roadmap so the arrow renders immediately; on failure we roll
  // back and surface a toast. We key the temporary row by a `temp:` prefix so
  // the server-issued UUID can be swapped in once the POST resolves — this
  // lets Remove work even if the user acts before the network settles.
  const handleCreateDependency = useCallback(
    async (args: GanttCreateDependencyArgs) => {
      // Kill any in-flight /api/roadmap so a pre-edit response can't land
      // after the optimistic insert below and overwrite it with stale data.
      roadmapAbortRef.current?.abort();
      // Guard against double-creation of the same pair. We check in the
      // updater (rather than reading `roadmap` from the closure) to avoid
      // stale-state races when two drops happen in quick succession — and
      // we use a flag to short-circuit the network call when the dep is
      // already in state, instead of still firing a guaranteed-409 POST.
      let alreadyExists = false;
      const tempId = `temp:${args.fromId}:${args.toId}:${Date.now()}`;
      const tempDep: Dependency = {
        fromId: args.fromId,
        toId: args.toId,
        type: 'blocks',
        source: 'manual',
        id: tempId
      };

      setRoadmap((prev) => {
        if (!prev) return prev;
        const existing = prev.dependencies ?? [];
        alreadyExists = existing.some(
          (dep) => dep.fromId === args.fromId && dep.toId === args.toId
        );
        if (alreadyExists) return prev;
        return { ...prev, dependencies: [...existing, tempDep] };
      });

      if (alreadyExists) {
        showToast('Dependency already exists.');
        return;
      }

      // Wrap the POST + state-swap in a promise we can register in
      // pendingCreatesRef. handleRemoveDependency awaits this promise when
      // the user clicks Remove on a `temp:` edge before the create has
      // settled, so we can DELETE the real server-issued id instead of
      // silently dropping the click.
      const createPromise: Promise<string> = (async () => {
        try {
          const created = await createDependencyOverride({
            fromId: args.fromId,
            toId: args.toId,
            fromType: args.fromType,
            toType: args.toType,
            dashboardId: dashboard?.id ?? null
          });
          // Swap the temp id for the server-issued override id, and capture
          // the updated roadmap so we can push it to the cached snapshot
          // below. Without the snapshot push, a page reload would render the
          // snapshot's stale copy (without this new dep, or with the temp
          // id) before the live roadmap fetch settles.
          let nextRoadmap: RoadmapResponse | null = null;
          setRoadmap((prev) => {
            if (!prev) return prev;
            const next = {
              ...prev,
              dependencies: (prev.dependencies ?? []).map((dep) =>
                dep.id === tempId ? { ...dep, id: created.id } : dep
              )
            };
            nextRoadmap = next;
            return next;
          });
          if (slug && nextRoadmap) {
            updateDashboardSnapshot(slug, nextRoadmap).catch(() => null);
          }
          // NOTE: We intentionally do NOT bump roadmapNonce here. The
          // optimistic state above + the snapshot write already reflect the
          // new dependency, and triggering fetchRoadmap causes a full Jira
          // roundtrip and a "loading" flash for a single-edge change. If a
          // stale in-flight fetch overwrites the optimistic state (rare —
          // would require the user to change filters and add a dep in quick
          // succession), the next natural refresh reconciles it.
          return created.id;
        } catch (err: any) {
          // Roll back the optimistic add.
          setRoadmap((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              dependencies: (prev.dependencies ?? []).filter((dep) => dep.id !== tempId)
            };
          });
          const status = err?.status;
          if (status === 409) {
            showToast('Dependency already exists (or conflicts with a reverse link).');
          } else if (status === 422) {
            showToast('Invalid dependency.');
          } else {
            showToast(err?.message || 'Failed to create dependency');
          }
          throw err;
        }
      })();

      pendingCreatesRef.current.set(tempId, createPromise);
      // Always clean up the entry — success or failure — so the map doesn't
      // grow unboundedly across the session.
      createPromise.finally(() => {
        pendingCreatesRef.current.delete(tempId);
      });

      // Preserve the prior contract: handleCreateDependency awaits the POST
      // and re-throws on failure so the Gantt's drag-create flow can react.
      await createPromise;
    },
    [dashboard?.id, slug]
  );

  // Delete a manual dependency override. Optimistically removes the edge;
  // reinstates it on failure. Silently no-ops if the override id is missing
  // (e.g. the caller passed a Jira-sourced dependency by mistake).
  //
  // If the caller passes a `temp:` id, the corresponding create POST is
  // still in flight. Wait for it to settle so we can DELETE the real
  // server-issued id — otherwise the click would be silently dropped while
  // the UI was still showing the edge as removable.
  const handleRemoveDependency = useCallback(async (edgeId: string) => {
    if (!edgeId) return;
    // Same rationale as handleCreateDependency: cancel any in-flight roadmap
    // fetch before we optimistically remove the edge, so a pre-remove Jira
    // response can't revive the just-deleted dependency a few seconds later.
    roadmapAbortRef.current?.abort();

    let overrideId = edgeId;
    if (edgeId.startsWith('temp:')) {
      const pending = pendingCreatesRef.current.get(edgeId);
      if (!pending) {
        // Either the create already swapped its temp id out (so the caller
        // is holding a stale id and a re-render will give them the real
        // one), or it already failed and rolled itself back. Either way,
        // there's nothing for us to remove here.
        return;
      }
      try {
        overrideId = await pending;
      } catch {
        // Create failed; its own catch block already rolled the optimistic
        // edge back, so there's no server record and no UI edge to clean up.
        return;
      }
    }

    let removed: Dependency | null = null;
    // Capture the post-remove roadmap from the updater so we can push it to
    // the cached snapshot after the network settles. Without this, the next
    // page load would re-serve the stale snapshot (ghost deps) and any click
    // on the ghost edge would hit 404 against the real DB.
    let nextRoadmap: RoadmapResponse | null = null;

    setRoadmap((prev) => {
      if (!prev) return prev;
      const existing = prev.dependencies ?? [];
      removed = existing.find((dep) => dep.id === overrideId) ?? null;
      const next = { ...prev, dependencies: existing.filter((dep) => dep.id !== overrideId) };
      nextRoadmap = next;
      return next;
    });

    const syncSnapshot = () => {
      if (slug && nextRoadmap) {
        updateDashboardSnapshot(slug, nextRoadmap).catch(() => null);
      }
      // NOTE: We intentionally do NOT bump roadmapNonce here. Matches the
      // create-dependency path — a single-edge mutation shouldn't trigger a
      // full Jira refresh. The optimistic removal + snapshot push already
      // reflect the deletion, and the next natural refresh reconciles any
      // stale in-flight response.
    };

    try {
      await deleteDependencyOverride(overrideId);
      syncSnapshot();
    } catch (err: any) {
      // 404 means the server has no record of this override — either it was
      // already deleted (stale snapshot / another tab) or the UI's copy has
      // drifted from the DB. Either way, the user's intent ("remove this
      // edge") is already satisfied, so we keep the optimistic removal and
      // push the updated state to the snapshot so it doesn't resurrect the
      // ghost on the next page load. Any other error is a real failure —
      // roll back so the UI matches reality.
      if (err?.status === 404) {
        syncSnapshot();
        return;
      }
      // Rollback: put the edge back in place.
      if (removed) {
        const rollback = removed;
        setRoadmap((prev) => {
          if (!prev) return prev;
          return { ...prev, dependencies: [...(prev.dependencies ?? []), rollback] };
        });
      }
      showToast(err?.message || 'Failed to remove dependency');
      throw err;
    }
  }, [slug]);

  const handleCustomBarCreate = async () => {
    if (!newCustomBar.name.trim() || (!newCustomBar.swimlaneId && !newCustomBar.allLanes) || !newCustomBar.start || !newCustomBar.end || !dashboard) return;
    try {
      const created = await createCustomBar({
        name: newCustomBar.name.trim(),
        swimlaneId: newCustomBar.allLanes ? null : newCustomBar.swimlaneId,
        start: newCustomBar.start,
        end: newCustomBar.end,
        color: newCustomBar.color,
        showName: true,
        dashboardId: dashboard.id,
      });
      setCustomBars((prev) => [...prev, created]);
      setNewCustomBar({ name: '', swimlaneId: '', start: '', end: '', color: '#a78bfa', allLanes: false });
    } catch (err: any) {
      setError(err.message || 'Failed to create custom bar');
    }
  };

  const handleCustomBarUpdate = async (bar: CustomBar, patch: Partial<Pick<CustomBar, 'name' | 'start' | 'end' | 'color' | 'showName'>>) => {
    try {
      const updated = await updateCustomBar(bar.id, patch);
      setCustomBars((prev) => prev.map((b) => (b.id === bar.id ? updated : b)));
    } catch (err: any) {
      setError(err.message || 'Failed to update custom bar');
    }
  };

  const handleCustomBarDelete = async (barId: string) => {
    try {
      await deleteCustomBar(barId);
      setCustomBars((prev) => prev.filter((b) => b.id !== barId));
    } catch (err: any) {
      setError(err.message || 'Failed to delete custom bar');
    }
  };

  const handleMilestoneCreate = async () => {
    if (!newMilestone.label || !newMilestone.date) return;
    try {
      const created = await createMilestone({
        label: newMilestone.label,
        date: newMilestone.date,
        color: newMilestone.color,
        projectScope: newMilestone.projectScope || null,
        showLabel: true,
        dashboardId: dashboard?.id
      });
      setMilestones((prev) => [...prev, created]);
      setNewMilestone({ label: '', date: '', color: '#22c55e', projectScope: '' });
    } catch (err: any) {
      setError(err.message || 'Failed to create milestone');
    }
  };

  const handleMilestoneUpdate = async (milestone: Milestone, patch: Partial<Milestone>) => {
    try {
      const updated = await updateMilestone(milestone.id, patch);
      setMilestones((prev) => prev.map((item) => (item.id === milestone.id ? updated : item)));
    } catch (err: any) {
      setError(err.message || 'Failed to update milestone');
    }
  };

  const handleMilestoneDelete = async (milestone: Milestone) => {
    try {
      await deleteMilestone(milestone.id);
      setMilestones((prev) => prev.filter((item) => item.id !== milestone.id));
    } catch (err: any) {
      setError(err.message || 'Failed to delete milestone');
    }
  };

  const toggleFixVersion = (id: string) => {
    setCollapsedFixVersions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleEpic = (id: string) => {
    setCollapsedEpics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filteredMilestones = useMemo(() => {
    if (!filters.projects.length) return milestones;
    return milestones.filter((m) => !m.projectScope || filters.projects.includes(m.projectScope));
  }, [milestones, filters.projects]);

  const handleDescriptionSave = async () => {
    if (!slug || !authenticated) return;
    const trimmed = descriptionDraft.trim();
    if (trimmed === (dashboard?.description ?? '')) return;
    try {
      // Send null (not undefined) when clearing — undefined is omitted by
      // JSON.stringify so the backend would never receive the clear signal.
      const updated = await updateDashboard(slug, { description: trimmed || null });
      setDashboard(updated);
    } catch {
      // silently revert on failure
      setDescriptionDraft(dashboard?.description ?? '');
    }
  };

  // A single lane card for the grouped swimlane editor — used both inside an
  // initiative group and in the Ungrouped container. Drag reorders within the
  // lane's own container (same initiative, or both ungrouped); cross-boundary
  // drops are a no-op, so only same-container targets light up.
  const renderLaneCard = (lane: Swimlane) => {
    const disabled = new Set(assignedFixVersions);
    lane.fixVersionIds.forEach((id) => disabled.delete(id));
    const filteredIds = activeFixVersionSet
      ? lane.fixVersionIds.filter((id) => !activeFixVersionSet.has(id))
      : [];
    const filteredLabel =
      filteredIds.length > 0
        ? `Filtered out: ${filteredIds.map((id) => fixVersionNameById.get(id) || id).join(', ')}`
        : '';
    const isDragging = dragLaneId === lane.id;
    // The directional above/below indicator only makes sense when reordering
    // within a group. For a cross-initiative drag we instead light up the whole
    // target group (is-lane-target), so suppress the per-card bar in that case.
    const sameContainer =
      !!dragLaneId &&
      (initiativeOfSwimlane(dragLaneId)?.id ?? null) === (initiativeOfSwimlane(lane.id)?.id ?? null);
    const isDragOver = dragOverLaneId === lane.id && dragLaneId !== lane.id && sameContainer;
    // Lanes can be dropped onto any other lane — within their group, or across
    // into another group / the ungrouped pool.
    const dropAllowed = !!dragLaneId && dragLaneId !== lane.id;
    const tags = lane.fixVersionIds
      .filter((id) => !activeFixVersionSet || activeFixVersionSet.has(id))
      .map((id) => ({ id, name: fixVersionNameById.get(id) || id }));
    // While the fix-version catalogue is still loading we can't resolve names or
    // tell which ids are filtered out, so show a loading hint rather than a
    // misleading "No fix versions" / "N hidden by filter".
    const fixVersionsPending =
      fixVersionsLoading && fixVersionOptions.length === 0 && lane.fixVersionIds.length > 0;
    return (
      <div
        key={lane.id}
        className={`lane-card${isDragging ? ' is-dragging' : ''}${
          isDragOver ? (dragOverLaneAfter ? ' is-drag-over-below' : ' is-drag-over') : ''
        }`}
        draggable={editingNameId !== lane.id}
        onDragStart={(event) => {
          setDragLaneId(lane.id);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', lane.id);
        }}
        onDragEnd={clearLaneDrag}
        onDragOver={(event) => {
          if (!dropAllowed) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          // Cross-initiative drag: don't show the per-card bar; light up the
          // whole target group instead so the destination is obvious.
          if (!sameContainer) {
            const groupId = initiativeOfSwimlane(lane.id)?.id ?? '__ungrouped__';
            if (dragOverLaneId !== null) setDragOverLaneId(null);
            if (dragOverGroupId !== groupId) setDragOverGroupId(groupId);
            return;
          }
          // Drop above or below the target based on which half the cursor is in,
          // so the blue indicator previews exactly where the lane will land.
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          if (dragOverLaneId !== lane.id) setDragOverLaneId(lane.id);
          if (dragOverLaneAfter !== after) setDragOverLaneAfter(after);
        }}
        onDrop={(event) => {
          if (!dropAllowed) return;
          event.preventDefault();
          event.stopPropagation();
          moveLane(
            dragLaneId!,
            initiativeOfSwimlane(lane.id)?.id ?? null,
            lane.id,
            dragOverLaneAfter
          );
          clearLaneDrag();
        }}
      >
        <input
          className="lane-card-name"
          type="text"
          aria-label="Lane name"
          value={lane.name}
          onFocus={() => setEditingNameId(lane.id)}
          onBlur={() => setEditingNameId((prev) => (prev === lane.id ? null : prev))}
          onChange={(event) => updateSwimlane(lane.id, { name: event.target.value })}
          placeholder="Lane name"
        />
        <div className="lane-card-tags">
          {fixVersionsPending ? (
            <span className="lane-tag lane-tag--loading">
              <span className="filter-spinner" aria-hidden="true" />
              Loading fix versions…
            </span>
          ) : (
            <>
              {tags.length === 0 ? (
                <span className="lane-tag lane-tag--empty">No fix versions</span>
              ) : (
                tags.map((tag) => (
                  <span className="lane-tag lane-tag--removable" key={`${lane.id}-tag-${tag.id}`}>
                    {tag.name}
                    <button
                      type="button"
                      className="lane-tag-remove"
                      aria-label="Remove fix version"
                      title="Remove"
                      onClick={() =>
                        updateSwimlane(lane.id, {
                          fixVersionIds: lane.fixVersionIds.filter((fid) => fid !== tag.id)
                        })
                      }
                    >
                      ✕
                    </button>
                  </span>
                ))
              )}
              {filteredIds.length > 0 && (
                <span className="lane-tag lane-tag--hidden" title={filteredLabel}>
                  {filteredIds.length} hidden by filter
                </span>
              )}
            </>
          )}
        </div>
        <div className="lane-card-actions">
          <FilterMultiSelect
            label="Fix versions"
            items={swimlaneFixVersionItems}
            selected={lane.fixVersionIds}
            onChange={(next) => updateSwimlane(lane.id, { fixVersionIds: next })}
            placeholder="Edit"
            disabledIds={[...disabled]}
            disabledReason="In another lane"
            countSummary
          />
          <button
            type="button"
            className="icon-btn danger"
            aria-label="Remove lane"
            title="Remove lane"
            onClick={() => removeSwimlane(lane.id)}
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  // Single Gantt element, referenced both in the dashboard layout and (via the
  // presentation deck) on a roadmap slide. Extracted so the two render paths
  // stay in sync. REVERT: inline this back at its <Gantt/> usage below and drop
  // the roadmap slide wiring.
  const ganttElement = (
    <Gantt
      fixVersions={roadmap?.fixVersions ?? []}
      milestones={filteredMilestones}
      dependencies={roadmap?.dependencies ?? []}
      incrementStart={filters.incrementStart || defaultStart}
      incrementEnd={filters.incrementEnd || defaultEnd}
      jiraBaseUrl={roadmap?.jiraBaseUrl ?? ''}
      mode={filters.ganttMode === 'swimlane' ? 'swimlane' : 'standard'}
      timeScale={filters.timeScale === 'quarter' ? 'quarter' : 'month'}
      onTimeScaleChange={(scale) => handleUiPrefChange({ timeScale: scale })}
      swimlanes={filters.swimlanes || []}
      initiatives={filters.initiatives || []}
      showInitiatives={filters.showInitiatives ?? false}
      collapsedInitiatives={collapsedInitiatives}
      onToggleInitiative={toggleInitiative}
      onShowInitiativesChange={(value) =>
        handleUiPrefChange({ showInitiatives: value })
      }
      activeFixVersionIds={filters.fixVersions}
      showDependencies={filters.showDependencies ?? false}
      dependenciesManualOnly={filters.dependenciesManualOnly ?? false}
      hideReleasedFixVersions={filters.hideReleasedFixVersions ?? false}
      onHideReleasedFixVersionsChange={(value) =>
        handleUiPrefChange({ hideReleasedFixVersions: value })
      }
      swimlaneMilestoneView={filters.swimlaneMilestoneView ?? false}
      onSwimlaneMilestoneViewChange={(value) =>
        handleUiPrefChange({ swimlaneMilestoneView: value })
      }
      onShowDependenciesChange={(value) =>
        handleUiPrefChange({ showDependencies: value })
      }
      projects={roadmap?.projects ?? []}
      barColourCategories={filters.barColourCategories ?? []}
      fixVersionColours={filters.fixVersionColours ?? {}}
      colourMode={filters.barColourMode ?? 'rag'}
      onColourModeChange={(mode) =>
        handleUiPrefChange({ barColourMode: mode, colourByCategory: mode === 'manual' })
      }
      autoBarColours={filters.autoBarColours ?? {}}
      onAutoBarColoursChange={(colours) =>
        handleFilterChange({ autoBarColours: colours })
      }
      onBarColourCategoriesChange={(categories) =>
        handleFilterChange({ barColourCategories: categories })
      }
      onFixVersionColoursChange={(colours) =>
        handleFilterChange({ fixVersionColours: colours })
      }
      customBars={customBars}
      collapsedFixVersions={collapsedFixVersions}
      collapsedEpics={collapsedEpics}
      onToggleFixVersion={toggleFixVersion}
      onToggleEpic={toggleEpic}
      onCreateDependency={handleCreateDependency}
      onRemoveDependency={handleRemoveDependency}
      loading={loading}
      onRefresh={() => setRoadmapNonce((n) => n + 1)}
    />
  );

  return (
    <div className="dashboard-page" data-density="compact">
      <div className="dashboard-title">
        <div className="dashboard-title-text">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="secondary dashboard-back" onClick={() => navigate('/dashboards')}>
              Back to dashboards
            </button>
          </div>
          <div>
            <h1>{dashboard?.title || 'Dashboard'}</h1>
            {authenticated ? (
              <textarea
                className={`dashboard-description-input${descriptionFocused ? ' dashboard-description-input--focused' : ''}`}
                value={descriptionDraft}
                placeholder="Add a description…"
                rows={1}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                onFocus={() => setDescriptionFocused(true)}
                onBlur={() => { setDescriptionFocused(false); handleDescriptionSave(); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
              />
            ) : (
              dashboard?.description && (
                <p className="dashboard-description-static">{dashboard.description}</p>
              )
            )}
          </div>
        </div>
      </div>

      <nav className="dashboard-tabs" role="tablist" aria-label="Dashboard views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'updates'}
          className={`dashboard-tab ${activeTab === 'updates' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('updates')}
        >
          Updates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'roadmap'}
          className={`dashboard-tab ${activeTab === 'roadmap' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('roadmap')}
        >
          Roadmap
        </button>
      </nav>

      {activeTab === 'updates' && (
        <div className="card filters-bar update-filters-bar">
          <div className="filters-header">
            <div className="filters-title">
              <span>Update filters</span>
              <span className={`filters-status ${filtersDirty ? 'filters-status--dirty' : ''}`}>
                {filtersDirty ? 'Unsaved changes' : 'Scopes this summary — separate from the roadmap'}
              </span>
            </div>
            <div className="filters-actions">
              <button
                type="button"
                className="primary"
                onClick={handleSaveFiltersClick}
                disabled={!authenticated || !filtersDirty || dateRangeInvalid}
              >
                Save as default
              </button>
            </div>
          </div>
          <div className="filters-grid">
            <FilterMultiSelect
              label="Projects"
              items={projectItems}
              selected={filters.projects}
              onChange={(next) => handleFilterChange({ projects: next })}
              placeholder="Select projects"
              maxSelected={15}
            />
            <FilterMultiSelect
              label="Fix versions"
              items={fixVersionItems}
              selected={filters.updateFixVersions ?? []}
              onChange={(next) => handleFilterChange({ updateFixVersions: next })}
              placeholder="All fix versions"
              loading={fixVersionsLoading && fixVersionItems.length === 0}
              maxSelected={100}
            />
            <div className="filter-group update-date-range">
              <div className="filter-group">
                <span className="filter-label">Date from</span>
                <input
                  className="date-input"
                  type="date"
                  value={filters.updateStart || ''}
                  max={filters.updateEnd || ''}
                  onChange={(event) => handleFilterChange({ updateStart: event.target.value })}
                />
              </div>
              <div className="filter-group">
                <span className="filter-label">Date to</span>
                <input
                  className="date-input"
                  type="date"
                  value={filters.updateEnd || ''}
                  min={filters.updateStart || ''}
                  onChange={(event) => handleFilterChange({ updateEnd: event.target.value })}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'roadmap' && (
      <div className={`card filters-bar ${filtersCollapsed ? 'filters-bar--collapsed' : ''}`}>
        <div className="filters-header">
          <div className="filters-title">
            <span>Filters</span>
            <span className={`filters-status ${filtersDirty ? 'filters-status--dirty' : ''}`}>
              {filtersDirty ? 'Unsaved changes' : 'Saved to this dashboard'}
            </span>
          </div>
          <div className="filters-actions">
            <button
              type="button"
              className="primary"
              onClick={handleSaveFiltersClick}
              disabled={!authenticated || !filtersDirty || dateRangeInvalid}
            >
              Save as default
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => handleUiPrefChange({ filtersCollapsed: !filtersCollapsed })}
            >
              {filtersCollapsed ? 'Expand' : 'Collapse'}
            </button>
          </div>
        </div>
        {!filtersCollapsed && (
          <div className="filters-grid">
            <FilterMultiSelect
              label="Projects"
              items={projectItems}
              selected={filters.projects}
              onChange={(next) => handleFilterChange({ projects: next })}
              placeholder="Select projects"
              maxSelected={15}
            />
            <FilterMultiSelect
              label="Fix versions"
              items={fixVersionItems}
              selected={filters.fixVersions}
              onChange={(next) => handleFilterChange({ fixVersions: next })}
              placeholder="All fix versions"
              loading={fixVersionsLoading && fixVersionItems.length === 0}
              maxSelected={100}
            />
            <FilterMultiSelect
              label="Components"
              items={componentItems}
              selected={filters.components}
              onChange={(next) => handleFilterChange({ components: next })}
              placeholder="All components"
            />
            <div className="filter-group">
              <span className="filter-label">Gantt view</span>
              <div className="toggle-group">
                <button
                  type="button"
                  className={`toggle-pill ${filters.ganttMode !== 'swimlane' ? 'is-active' : ''}`}
                  onClick={() => handleFilterChange({ ganttMode: 'standard' })}
                >
                  Standard
                </button>
                <button
                  type="button"
                  className={`toggle-pill ${filters.ganttMode === 'swimlane' ? 'is-active' : ''}`}
                  onClick={() => handleFilterChange({ ganttMode: 'swimlane' })}
                >
                  Swimlane
                </button>
              </div>
            </div>
            <div className="filter-group">
              <span className="filter-label">Increment start</span>
              <input
                className={`date-input${dateRangeInvalid ? ' date-input--error' : ''}`}
                type="date"
                value={filters.incrementStart || ''}
                max={filters.incrementEnd || ''}
                onChange={(event) => handleFilterChange({ incrementStart: event.target.value })}
              />
            </div>
            <div className="filter-group">
              <span className="filter-label">Increment end</span>
              <input
                className={`date-input${dateRangeInvalid ? ' date-input--error' : ''}`}
                type="date"
                value={filters.incrementEnd || ''}
                min={filters.incrementStart || ''}
                onChange={(event) => handleFilterChange({ incrementEnd: event.target.value })}
              />
            </div>
            {dateRangeInvalid && (
              <p className="date-range-error">Start date must be before end date</p>
            )}
          </div>
        )}
        {!filtersCollapsed && filters.ganttMode === 'swimlane' && (() => {
          const lanes = filters.swimlanes || [];
          const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
          const inits = filters.initiatives || [];
          const grouped = new Set<string>();
          inits.forEach((init) => (init.swimlaneIds || []).forEach((id) => grouped.add(id)));
          const ungrouped = lanes.filter((lane) => !grouped.has(lane.id));
          return (
            <div className="swimlane-editor lane-group-editor">
              <div className="swimlane-editor-header">
                <div>
                  <span className="swimlane-title">Lanes &amp; Initiatives</span>
                  <span className="muted swimlane-subtitle">
                    Drag a lane to reorder it within its initiative; drag an initiative header to
                    move the whole group.
                  </span>
                </div>
                <div className="initiative-editor-actions">
                  <button type="button" className="secondary" onClick={addSwimlane}>
                    Add lane
                  </button>
                  <button type="button" className="secondary" onClick={addInitiative}>
                    Add initiative
                  </button>
                </div>
              </div>
              <div className="swimlane-editor-body">
                {inits.length === 0 && ungrouped.length === 0 && (
                  <div className="swimlane-empty">
                    No lanes or initiatives yet. Add one to organize fix versions.
                  </div>
                )}
                {inits.map((init) => {
                  const colour = init.colour || '#6366f1';
                  const initLanes = (init.swimlaneIds || [])
                    .map((id) => laneById.get(id))
                    .filter((lane): lane is Swimlane => !!lane);
                  const membershipDisabled = new Set(assignedSwimlanes);
                  (init.swimlaneIds || []).forEach((id) => membershipDisabled.delete(id));
                  const isDragging = dragInitiativeId === init.id;
                  const isDragOver =
                    dragOverInitiativeId === init.id && dragInitiativeId !== init.id;
                  const collapsed = collapsedInitiatives.has(init.id);
                  return (
                    <div
                      key={init.id}
                      className={`lane-group${isDragging ? ' is-dragging' : ''}${
                        isDragOver ? (dragOverInitiativeAfter ? ' is-drag-over-below' : ' is-drag-over') : ''
                      }${collapsed ? ' is-collapsed' : ''}${
                        dragOverGroupId === init.id ? ' is-lane-target' : ''
                      }`}
                      style={{ ['--ini' as any]: colour }}
                      onDragOver={(event) => {
                        if (!dragInitiativeId) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = 'move';
                        // Drop above or below the target based on the cursor's half
                        // so the indicator previews where the group will land.
                        const rect = event.currentTarget.getBoundingClientRect();
                        const after = event.clientY > rect.top + rect.height / 2;
                        if (dragOverInitiativeId !== init.id) setDragOverInitiativeId(init.id);
                        if (dragOverInitiativeAfter !== after) setDragOverInitiativeAfter(after);
                      }}
                      onDrop={(event) => {
                        if (!dragInitiativeId) return;
                        event.preventDefault();
                        event.stopPropagation();
                        // Commit happens in the header's onDragEnd using the tracked target.
                      }}
                    >
                      <div
                        className="lane-group-head"
                        draggable={editingNameId !== init.id}
                        onDragStart={(event) => {
                          // A lane drag starts from a card inside the body; only
                          // start an initiative drag when nothing else is dragging.
                          if (dragLaneId) return;
                          setDragInitiativeId(init.id);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', init.id);
                        }}
                        onDragEnd={commitInitiativeReorder}
                        onDragOver={(event) => {
                          if (!dragLaneId) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = 'move';
                          if (dragOverGroupId !== init.id) setDragOverGroupId(init.id);
                        }}
                        onDrop={(event) => {
                          if (!dragLaneId) return;
                          event.preventDefault();
                          event.stopPropagation();
                          // Dropped on the initiative header → move the lane to
                          // the TOP of this initiative (before its first lane).
                          const firstLaneId =
                            initLanes.find((l) => l.id !== dragLaneId)?.id ?? null;
                          moveLane(dragLaneId, init.id, firstLaneId, false);
                          clearLaneDrag();
                        }}
                      >
                        <button
                          type="button"
                          className="lane-group-collapse"
                          aria-label={collapsed ? 'Expand initiative' : 'Collapse initiative'}
                          aria-expanded={!collapsed}
                          title={collapsed ? 'Expand' : 'Collapse'}
                          onClick={() => toggleInitiative(init.id)}
                        >
                          {collapsed ? '▸' : '▾'}
                        </button>
                        <ColourPicker
                          value={colour}
                          ariaLabel="Initiative colour"
                          onChange={(next) => updateInitiative(init.id, { colour: next })}
                        />
                        <input
                          className="lane-group-name"
                          type="text"
                          aria-label="Initiative name"
                          value={init.name}
                          onFocus={() => setEditingNameId(init.id)}
                          onBlur={() => setEditingNameId((prev) => (prev === init.id ? null : prev))}
                          onChange={(event) => updateInitiative(init.id, { name: event.target.value })}
                          placeholder="Initiative name"
                        />
                        <span className="lane-group-count">
                          {initLanes.length} {initLanes.length === 1 ? 'lane' : 'lanes'}
                        </span>
                        <div className="lane-group-head-actions">
                          <FilterMultiSelect
                            label="Lanes"
                            items={initiativeSwimlaneItems}
                            selected={initLanes.map((lane) => lane.id)}
                            onChange={(next) => updateInitiative(init.id, { swimlaneIds: next })}
                            placeholder="Add lanes"
                            disabledIds={[...membershipDisabled]}
                            disabledReason="In another initiative"
                          />
                          <button
                            type="button"
                            className="icon-btn danger"
                            aria-label="Remove initiative"
                            title="Remove initiative"
                            onClick={() => removeInitiative(init.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      {!collapsed && (
                        <div
                          className="lane-group-body"
                          onDragOver={(event) => {
                            if (!dragLaneId) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            if (dragOverGroupId !== init.id) setDragOverGroupId(init.id);
                          }}
                          onDrop={(event) => {
                            if (!dragLaneId) return;
                            event.preventDefault();
                            // Dropped on the group's open space → append to this
                            // initiative. (Drops on a lane card are handled there
                            // and stop propagation.)
                            moveLane(dragLaneId, init.id, null);
                            clearLaneDrag();
                          }}
                        >
                          {initLanes.length === 0 ? (
                            <div className="lane-group-empty">
                              No lanes in this initiative yet — use “Add lanes” or
                              <button
                                type="button"
                                className="lane-add-inline"
                                onClick={() => addSwimlaneToInitiative(init.id)}
                              >
                                + add a new lane
                              </button>
                            </div>
                          ) : (
                            <>
                              {initLanes.map((lane) => renderLaneCard(lane))}
                              <div className="lane-add-row">
                                <button
                                  type="button"
                                  className="lane-add-inline"
                                  onClick={() => addSwimlaneToInitiative(init.id)}
                                >
                                  + Add a lane to {init.name || 'this initiative'}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div
                  className={`lane-group lane-group--ungrouped${
                    dragOverGroupId === '__ungrouped__' ? ' is-lane-target' : ''
                  }`}
                >
                  <div
                    className="lane-group-head"
                    onDragOver={(event) => {
                      if (!dragLaneId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = 'move';
                      if (dragOverGroupId !== '__ungrouped__') setDragOverGroupId('__ungrouped__');
                    }}
                    onDrop={(event) => {
                      if (!dragLaneId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      moveLane(dragLaneId, null, null);
                      clearLaneDrag();
                    }}
                  >
                    <span className="lane-group-count">Ungrouped lanes</span>
                  </div>
                  <div
                    className="lane-group-body"
                    onDragOver={(event) => {
                      if (!dragLaneId) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      if (dragOverGroupId !== '__ungrouped__') setDragOverGroupId('__ungrouped__');
                    }}
                    onDrop={(event) => {
                      if (!dragLaneId) return;
                      event.preventDefault();
                      // Dropped on open space → move out of any initiative to the
                      // end of the ungrouped pool.
                      moveLane(dragLaneId, null, null);
                      clearLaneDrag();
                    }}
                  >
                    {ungrouped.map((lane) => renderLaneCard(lane))}
                    <div className="lane-add-row">
                      <button type="button" className="lane-add-inline" onClick={addSwimlane}>
                        + Add a lane here
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              {filtersDirty && (
                <div className="swimlane-editor-footer">
                  <span className="filters-status filters-status--dirty">Unsaved changes</span>
                  <button
                    type="button"
                    className="primary"
                    onClick={handleSaveFiltersClick}
                    disabled={!authenticated || dateRangeInvalid}
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          );
        })()}
        {!filtersCollapsed && filters.ganttMode !== 'swimlane' && (() => {
          const inits = filters.initiatives || [];
          const fixLabelById = new Map(swimlaneFixVersionItems.map((item) => [item.id, item.label]));
          return (
          <div className="swimlane-editor lane-group-editor">
            <div className="swimlane-editor-header">
              <div>
                <span className="swimlane-title">Initiatives</span>
                <span className="muted swimlane-subtitle">
                  Group fix versions under an initiative header — drag an initiative
                  header to reorder.
                </span>
              </div>
              <div className="initiative-editor-actions">
                <button type="button" className="secondary" onClick={addInitiative}>
                  Add initiative
                </button>
              </div>
            </div>
            <div
              className="swimlane-editor-body"
              onDragOver={(event) => {
                if (!dragInitiativeId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                // This fires only in the gaps above/below/between cards (cards
                // stopPropagation). Snap the tracked target to the top card when
                // the cursor is above the list, or the bottom card when below it,
                // so releasing off-card still reorders to the right end. Read the
                // first/last child rects directly (cheaper than querySelectorAll
                // on every dragover, which made this path feel laggy).
                const firstCard = event.currentTarget.firstElementChild;
                const lastCard = event.currentTarget.lastElementChild;
                if (!firstCard || !lastCard) return;
                const first = firstCard.getBoundingClientRect();
                const last = lastCard.getBoundingClientRect();
                if (event.clientY < first.top + first.height / 2) {
                  if (dragOverInitiativeId !== inits[0].id) setDragOverInitiativeId(inits[0].id);
                  if (dragOverInitiativeAfter) setDragOverInitiativeAfter(false);
                } else if (event.clientY > last.bottom - last.height / 2) {
                  const lastInit = inits[inits.length - 1];
                  if (dragOverInitiativeId !== lastInit.id) setDragOverInitiativeId(lastInit.id);
                  if (!dragOverInitiativeAfter) setDragOverInitiativeAfter(true);
                }
              }}
              onDrop={(event) => {
                if (!dragInitiativeId) return;
                event.preventDefault();
                // Commit happens in onDragEnd; just swallow the drop here.
              }}
            >
              {inits.length === 0 && (
                <div className="swimlane-empty">
                  No initiatives yet. Add one to group fix versions.
                </div>
              )}
              {inits.map((init) => {
                const colour = init.colour || '#6366f1';
                const disabled = new Set(assignedInitiativeFixVersions);
                (init.fixVersionIds || []).forEach((id) => disabled.delete(id));
                const fixIds = init.fixVersionIds || [];
                const fixVersionsPending =
                  fixVersionsLoading && fixVersionOptions.length === 0 && fixIds.length > 0;
                const isDragging = dragInitiativeId === init.id;
                const isDragOver = dragOverInitiativeId === init.id && dragInitiativeId !== init.id;
                const collapsed = collapsedInitiatives.has(init.id);
                return (
                  <div
                    key={init.id}
                    className={`lane-group${isDragging ? ' is-dragging' : ''}${
                      isDragOver ? (dragOverInitiativeAfter ? ' is-drag-over-below' : ' is-drag-over') : ''
                    }${collapsed ? ' is-collapsed' : ''}`}
                    style={{ ['--ini' as any]: colour }}
                    onDragOver={(event) => {
                      if (!dragInitiativeId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = 'move';
                      // Drop above or below the target based on the cursor's half so
                      // the indicator previews where the group will land.
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientY > rect.top + rect.height / 2;
                      if (dragOverInitiativeId !== init.id) setDragOverInitiativeId(init.id);
                      if (dragOverInitiativeAfter !== after) setDragOverInitiativeAfter(after);
                    }}
                    onDrop={(event) => {
                      if (!dragInitiativeId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      // Commit happens in onDragEnd using the tracked target.
                    }}
                  >
                    <div
                      className="lane-group-head"
                      draggable={editingNameId !== init.id}
                      onDragStart={(event) => {
                        setDragInitiativeId(init.id);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', init.id);
                      }}
                      onDragEnd={commitInitiativeReorder}
                    >
                      <button
                        type="button"
                        className="lane-group-collapse"
                        aria-label={collapsed ? 'Expand initiative' : 'Collapse initiative'}
                        aria-expanded={!collapsed}
                        title={collapsed ? 'Expand' : 'Collapse'}
                        onClick={() => toggleInitiative(init.id)}
                      >
                        {collapsed ? '▸' : '▾'}
                      </button>
                      <ColourPicker
                        value={colour}
                        ariaLabel="Initiative colour"
                        onChange={(next) => updateInitiative(init.id, { colour: next })}
                      />
                      <input
                        className="lane-group-name"
                        type="text"
                        aria-label="Initiative name"
                        value={init.name}
                        onFocus={() => setEditingNameId(init.id)}
                        onBlur={() => setEditingNameId((prev) => (prev === init.id ? null : prev))}
                        onChange={(event) => updateInitiative(init.id, { name: event.target.value })}
                        placeholder="Initiative name"
                      />
                      <span className="lane-group-count">
                        {fixIds.length} {fixIds.length === 1 ? 'version' : 'versions'}
                      </span>
                      <div className="lane-group-head-actions">
                        <FilterMultiSelect
                          label="Fix versions"
                          items={swimlaneFixVersionItems}
                          selected={fixIds}
                          onChange={(next) => updateInitiative(init.id, { fixVersionIds: next })}
                          placeholder="Add fix versions"
                          disabledIds={[...disabled]}
                          disabledReason="In another initiative"
                        />
                        <button
                          type="button"
                          className="icon-btn danger"
                          aria-label="Remove initiative"
                          title="Remove initiative"
                          onClick={() => removeInitiative(init.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    {!collapsed && (
                      <div className="lane-group-body">
                        {fixVersionsPending ? (
                          <div className="lane-card-tags">
                            <span className="lane-tag lane-tag--loading">
                              <span className="filter-spinner" aria-hidden="true" />
                              Loading fix versions…
                            </span>
                          </div>
                        ) : fixIds.length === 0 ? (
                          <div className="lane-group-empty">
                            No fix versions in this initiative yet — use “Add fix versions”.
                          </div>
                        ) : (
                          <div className="lane-card-tags">
                            {fixIds.map((id) => (
                              <span key={id} className="lane-tag lane-tag--removable">
                                {fixLabelById.get(id) || id}
                                <button
                                  type="button"
                                  className="lane-tag-remove"
                                  aria-label="Remove fix version"
                                  title="Remove"
                                  onClick={() =>
                                    updateInitiative(init.id, {
                                      fixVersionIds: fixIds.filter((fid) => fid !== id)
                                    })
                                  }
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {filtersDirty && (
              <div className="swimlane-editor-footer">
                <span className="filters-status filters-status--dirty">Unsaved changes</span>
                <button
                  type="button"
                  className="primary"
                  onClick={handleSaveFiltersClick}
                  disabled={!authenticated || dateRangeInvalid}
                >
                  Save
                </button>
              </div>
            )}
          </div>
          );
        })()}
      </div>
      )}

      {error && <div className="card error">{error}</div>}
      {loading && !dashboard && <div className="card">Loading…</div>}
      {!loading && !dashboard && notFound && (
        <div className="card dashboard-not-found" role="alert">
          <h2>Dashboard not found</h2>
          <p>
            No dashboard exists at <code>/{slug}</code>. It may have been deleted or you
            might have followed a stale link.
          </p>
          <button type="button" className="primary" onClick={() => navigate('/dashboards')}>
            Back to dashboards
          </button>
        </div>
      )}
      {!loading && !dashboard && !notFound && <div className="card">Dashboard not found.</div>}

      {activeTab === 'updates' && (
      <>
      <div
        className={`dashboard-panels ${placingPanel ? 'dashboard-panels--placing' : ''} ${draggingPanelId ? 'dashboard-panels--dragging' : ''}`}
        ref={panelsRef}
        onMouseMove={handlePanelsMouseMove}
        onMouseLeave={() => {
          if (!placingPanel) return;
          setPlacement(null);
          setPlacementValid(false);
        }}
        onClick={handlePanelsClick}
        onDragOver={(event) => {
          if (!draggingPanelId) return;
          event.preventDefault();
          const next = getPlacementFromPoint(event.clientX, event.clientY);
          if (!next) return;
          const dragged = getDraggedPanel();
          if (!dragged) return;
          setPlacement(next);
          setPlacementValid(isPlacementAvailable(next.row, next.column, dragged.width, getPanelSpan(dragged), dragged.id));
        }}
        onDrop={(event) => {
          if (!draggingPanelId) return;
          event.preventDefault();
          const next = getPlacementFromPoint(event.clientX, event.clientY);
          const dragged = getDraggedPanel();
          if (!dragged || !next) return;
          if (!isPlacementAvailable(next.row, next.column, dragged.width, getPanelSpan(dragged), dragged.id)) {
            showToast('No space here!');
            handlePanelDragEnd();
            return;
          }
          movePanelTo(dragged.id, next.row, next.column);
          handlePanelDragEnd();
        }}
      >
        {panels.map((panel) => (
          <PanelCard
            key={panel.id}
            panel={panel}
            editable={authenticated}
            projects={filters.projects}
            dashboardSlug={slug ?? ''}
            activeFixVersionIds={
              // The Updates tab uses its OWN fix-version selection
              // (updateActiveFixVersionSet), which falls back to the roadmap's
              // active set, then to the raw saved value. Resolving through the
              // set handles legacy fix-version NAMES (pre-ID era) — passing raw
              // names would hide everything since the panel filters by id.
              updateActiveFixVersionSet
                ? Array.from(updateActiveFixVersionSet)
                : (filters.updateFixVersions?.length ? filters.updateFixVersions : filters.fixVersions)
            }
            updateStart={filters.updateStart || ''}
            updateEnd={filters.updateEnd || ''}
            ragStatusByVersionId={ragByFixVersionId}
            onPresent={() => setPresenting(true)}
            canPresent={presentationDeck.natural.length > 0}
            onTitleChange={handlePanelTitle}
            onTitleDraft={handlePanelTitleDraft}
            onContentSave={handlePanelContent}
            onSpanChange={handlePanelSpan}
            onWidthChange={handlePanelWidth}
            spanOverride={panelSpans[panel.id]}
            rowOverride={layoutRows[panel.id]}
            collapsed={collapsedPanels.has(panel.id)}
            onToggleCollapse={handleToggleCollapse}
            onDelete={handleDeletePanel}
            onNoChanges={() => showToast('No changes to save!')}
            onDragStart={handlePanelDragStart}
            onDragEnd={handlePanelDragEnd}
            onDrop={handlePanelDrop}
            onDragEnter={(panelId) => setDropTargetId(panelId)}
            onDragLeave={(panelId) => {
              setDropTargetId((prev) => (prev === panelId ? null : prev));
            }}
            onStartMove={handleStartPanelMove}
            isDragging={draggingPanelId === panel.id && !isMenuMove}
            isDropTarget={dropTargetId === panel.id}
            editors={presence
              .filter((e) => e.barId === panel.id)
              .map((e) => ({ accountId: e.accountId, displayName: e.displayName, avatarUrl: e.avatarUrl }))}
            onEditingStart={startEditing}
            onEditingEnd={stopEditing}
            presenceEntries={presence}
            registerRemoteContentHandler={registerPanelRemoteHandler}
          />
        ))}
        {(placingPanel || draggingPanelId) && panels.map((panel) => {
          if (draggingPanelId && panel.id === draggingPanelId) return null;
          const row = layoutRows[panel.id] ?? panel.row;
          const height = getPanelSpan(panel);
          const dragged = getDraggedPanel();
          const targetWidth = draggingPanelId && dragged ? dragged.width : newPanelWidth;
          const targetHeight = draggingPanelId && dragged ? getPanelSpan(dragged) : DEFAULT_PANEL_HEIGHT;
          const ignoreId = draggingPanelId && dragged ? dragged.id : undefined;
          const targets: Array<{ key: string; row: number; column: number; span: number; label: string; variant: string }> = [];
          // Scan same row for any free column spans (covers gaps left/right of panel)
          for (let col = 1; col + targetWidth - 1 <= 12; col++) {
            if (col === panel.column) { col = panel.column + panel.width - 1; continue; }
            if (isPlacementAvailable(row, col, targetWidth, targetHeight, ignoreId)) {
              targets.push({ key: `${panel.id}-samerow-${col}`, row, column: col, span: targetHeight, label: 'Place here', variant: 'side' });
            }
          }
          // Below: scan all free column positions in the row below
          const belowRow = row + height;
          for (let col = 1; col + targetWidth - 1 <= 12; col++) {
            if (isPlacementAvailable(belowRow, col, targetWidth, targetHeight, ignoreId)) {
              targets.push({ key: `${panel.id}-below-${col}`, row: belowRow, column: col, span: targetHeight, label: 'New line', variant: 'below' });
              // only one "new line" target per row needed — skip to next valid position
              col += targetWidth - 1;
            }
          }
          const slotTargets = targets.map((target) => (
            <button
              key={target.key}
              type="button"
              className={`panel-target panel-target--${target.variant}`}
              style={{
                gridColumn: `${target.column} / span ${targetWidth}`,
                gridRow: `${target.row} / span ${target.span}`
              }}
              onClick={(event) => {
                event.stopPropagation();
                handlePlacementTargetClick(target.row, target.column);
              }}
              onDragOver={(event) => {
                if (!draggingPanelId) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                if (!draggingPanelId) return;
                event.preventDefault();
                handlePlacementTargetClick(target.row, target.column);
              }}
              onMouseEnter={() => {
                setPlacement({ row: target.row, column: target.column });
                setPlacementValid(true);
              }}
            >
              {target.label}
            </button>
          ));
          // In menu-move mode, render a swap overlay on top of the panel
          const swapOverlay = draggingPanelId ? (
            <button
              key={`${panel.id}-swap`}
              type="button"
              className="panel-target panel-target--swap"
              style={{
                gridColumn: `${panel.column} / span ${panel.width}`,
                gridRow: `${row} / span ${height}`
              }}
              onClick={(event) => {
                event.stopPropagation();
                handlePanelDrop(panel.id);
              }}
            >
              Swap here
            </button>
          ) : null;
          return [swapOverlay, ...slotTargets];
        })}
        {/* Also scan the dragged panel's own row for free slots (excluded from map above) */}
        {draggingPanelId && (() => {
          const dragged = getDraggedPanel();
          if (!dragged) return null;
          const dragRow = layoutRows[dragged.id] ?? dragged.row;
          const dragHeight = getPanelSpan(dragged);
          const tW = dragged.width;
          const tH = dragHeight;
          const sameRowTargets: React.ReactNode[] = [];
          for (let col = 1; col + tW - 1 <= 12; col++) {
            if (isPlacementAvailable(dragRow, col, tW, tH, dragged.id)) {
              sameRowTargets.push(
                <button
                  key={`dragged-samerow-${col}`}
                  type="button"
                  className="panel-target panel-target--side"
                  style={{ gridColumn: `${col} / span ${tW}`, gridRow: `${dragRow} / span ${tH}` }}
                  onClick={(e) => { e.stopPropagation(); handlePlacementTargetClick(dragRow, col); }}
                  onMouseEnter={() => { setPlacement({ row: dragRow, column: col }); setPlacementValid(true); }}
                >
                  Place here
                </button>
              );
              col += tW - 1;
            }
          }
          return sameRowTargets;
        })()}
        {(placingPanel || draggingPanelId) && placement && (
          <div
            className={`panel-placement ${placementValid ? 'is-valid' : 'is-invalid'}`}
            style={{
              gridColumn: `${placement.column} / span ${draggingPanelId && getDraggedPanel() ? getDraggedPanel()!.width : newPanelWidth}`,
              gridRow: `${placement.row} / span ${draggingPanelId && getDraggedPanel() ? getPanelSpan(getDraggedPanel()!) : DEFAULT_PANEL_HEIGHT}`
            }}
          />
        )}
      </div>
      <div className={`add-panel-card ${!authenticated ? 'is-disabled' : ''}`}>
        <div className="add-panel-header">
          <span className="add-panel-title">Add panel</span>
          {placingPanel && <span className="add-panel-hint">Click a spot in the grid</span>}
          {draggingPanelId && !placingPanel && <span className="add-panel-hint">Hover a panel to swap, or click a slot to place — Esc to cancel</span>}
        </div>
        <div className="add-panel-controls">
          <div className="panel-width-control panel-width-control--inline">
            <span className="filter-label">Width</span>
            <select
              className="panel-width-select"
              value={newPanelWidth}
              onChange={(event) => setNewPanelWidth(Number(event.target.value))}
              disabled={!authenticated}
            >
              <option value={12}>{panelWidthLabels[12]}</option>
              <option value={8}>{panelWidthLabels[8]}</option>
              <option value={6}>{panelWidthLabels[6]}</option>
              <option value={4}>{panelWidthLabels[4]}</option>
              <option value={3}>{panelWidthLabels[3]}</option>
            </select>
          </div>
          <button
            type="button"
            className={`secondary ${placingPanel ? 'is-muted' : ''}`}
            onClick={startPlacement}
            disabled={!authenticated || addingPanel}
          >
            {addingPanel ? 'Adding…' : placingPanel ? 'Click a spot' : 'Place panel'}
          </button>
          {placingPanel && (
            <button type="button" className="ghost" onClick={cancelPlacement}>
              Cancel
            </button>
          )}
        </div>
      </div>
      </>
      )}
      <div className={`toast ${toast.visible ? 'toast--visible' : ''}`} role="status" aria-live="polite">
        {toast.message}
      </div>

      {activeTab === 'roadmap' && !roadmap && !loading && dashboard && (
        <div className="card roadmap-empty">
          {filters.projects.length === 0 ? (
            <>
              <h3>No project selected</h3>
              <p>
                Pick a project in the Filters above to load its roadmap. New dashboards
                start empty so you can choose what to show.
              </p>
            </>
          ) : (
            <>
              <h3>Roadmap not loaded</h3>
              <p>The roadmap hasn’t loaded yet. Load it to pull the latest fix versions from Jira.</p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  // Skip the "use cached snapshot on first load" gate — a manual
                  // load is an explicit request for a live fetch, so it must not
                  // be blocked while the snapshot lookup is still pending.
                  initialRoadmapDecisionRef.current = true;
                  setRoadmapNonce((n) => n + 1);
                }}
              >
                Load roadmap
              </button>
            </>
          )}
        </div>
      )}
      {activeTab === 'roadmap' && (roadmap || loading) && (
        <div className="layout">
          <div className="card fix-versions-card">
            {roadmap?.updatedAt && (
              <span className="gantt-last-refreshed" title={new Date(roadmap.updatedAt).toLocaleString('en-GB')}>
                Last refreshed{' '}
                {new Date(roadmap.updatedAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
            {loading && (
              <div className="gantt-updating-indicator" role="status" aria-live="polite">
                <span className="gantt-updating-indicator__spinner" aria-hidden="true" />
                <span>Updating…</span>
              </div>
            )}
            {ganttElement}
          </div>

          {roadmap && <div className="card fix-versions-table-card">
            <div className="section-header">
              <h3>Fix versions</h3>
              <button
                type="button"
                className="secondary"
                onClick={() => fixVersionPickerRef.current?.clearDates()}
                disabled={!fixVersionPickerCanClear}
              >
                Clear dates
              </button>
            </div>
            <FixVersionPicker
              ref={fixVersionPickerRef}
              fixVersions={roadmap.fixVersions}
              onSave={(fixVersionId, patch) => handleOverrideChange(fixVersionId, patch)}
              onCanClearChange={handleFixVersionCanClearChange}
              onEditingChange={handleGanttEditingChange}
            />
          </div>}

          {filters.ganttMode === 'swimlane' && (
          <div className={`card custom-bars-card${customBarsCollapsed ? ' is-collapsed' : ''}`}>
            <div className="section-header">
              <h3>Custom bars</h3>
              <button
                type="button"
                className="secondary"
                onClick={() => handleUiPrefChange({ customBarsCollapsed: !customBarsCollapsed })}
              >
                {customBarsCollapsed ? 'Expand' : 'Collapse'}
              </button>
            </div>
            {!customBarsCollapsed && (
              <>
                <div className="custom-bars-form">
                  <input
                    type="text"
                    aria-label="New custom bar name"
                    placeholder="Name"
                    value={newCustomBar.name}
                    onChange={(e) => setNewCustomBar((prev) => ({ ...prev, name: e.target.value }))}
                  />
                  <select
                    value={newCustomBar.allLanes ? '__all__' : newCustomBar.swimlaneId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setNewCustomBar((prev) => ({ ...prev, swimlaneId: val === '__all__' ? '' : val, allLanes: val === '__all__' }));
                    }}
                  >
                    <option value="">Select swimlane…</option>
                    <option value="__all__">All swimlanes</option>
                    {(filters.swimlanes || []).map((lane) => (
                      <option key={lane.id} value={lane.id}>{lane.name}</option>
                    ))}
                  </select>
                  <ThemedDatePicker
                    label="Start date"
                    value={newCustomBar.start}
                    invalid={!!(newCustomBar.start && newCustomBar.end && newCustomBar.start > newCustomBar.end)}
                    onChange={(iso) => setNewCustomBar((prev) => ({ ...prev, start: iso }))}
                  />
                  <ThemedDatePicker
                    label="End date"
                    value={newCustomBar.end}
                    invalid={!!(newCustomBar.start && newCustomBar.end && newCustomBar.start > newCustomBar.end)}
                    onChange={(iso) => setNewCustomBar((prev) => ({ ...prev, end: iso }))}
                  />
                  <div className="initiative-colour" title="Pick bar colour">
                    <span className="color-picker-label">Colour</span>
                    <ColourPicker
                      value={newCustomBar.color}
                      ariaLabel="Bar colour"
                      onChange={(next) => setNewCustomBar((prev) => ({ ...prev, color: next }))}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={!newCustomBar.name.trim() || (!newCustomBar.swimlaneId && !newCustomBar.allLanes) || !newCustomBar.start || !newCustomBar.end || !dashboard || (newCustomBar.start > newCustomBar.end)}
                    onClick={handleCustomBarCreate}
                  >
                    Add bar
                  </button>
                </div>
                {!!(newCustomBar.start && newCustomBar.end && newCustomBar.start > newCustomBar.end) && (
                  <div role="alert" className="fix-version-picker__error">
                    Start date must be on or before end date.
                  </div>
                )}
                {customBars.length > 0 && (
                  <table className="table custom-bars-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Swimlane</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Color</th>
                        <th>Show name</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {customBars.map((cb) => {
                        const laneName = cb.swimlaneId === null
                          ? 'All swimlanes'
                          : (filters.swimlanes ?? []).find((l) => l.id === cb.swimlaneId)?.name ?? cb.swimlaneId;
                        const datesInvalid = !!(cb.start && cb.end && cb.start > cb.end);
                        return (
                          <tr key={cb.id}>
                            <td>
                              <CustomBarNameInput
                                bar={cb}
                                onCommit={(name) => handleCustomBarUpdate(cb, { name })}
                              />
                            </td>
                            <td><span className="custom-bar-lane-tag">{laneName}</span></td>
                            <td>
                              <ThemedDatePicker
                                label={`Start for ${cb.name || 'bar'}`}
                                value={cb.start}
                                invalid={datesInvalid}
                                onChange={(iso) => {
                                  if (iso && iso !== cb.start) handleCustomBarUpdate(cb, { start: iso });
                                }}
                              />
                            </td>
                            <td>
                              <ThemedDatePicker
                                label={`End for ${cb.name || 'bar'}`}
                                value={cb.end}
                                invalid={datesInvalid}
                                onChange={(iso) => {
                                  if (iso && iso !== cb.end) handleCustomBarUpdate(cb, { end: iso });
                                }}
                              />
                            </td>
                            <td>
                              <ColourPicker
                                value={cb.color}
                                ariaLabel={`Colour for ${cb.name || 'bar'}`}
                                onChange={(next) => handleCustomBarUpdate(cb, { color: next })}
                              />
                            </td>
                            <td>
                              <label className="custom-bar-show-name">
                                <input
                                  type="checkbox"
                                  checked={cb.showName}
                                  aria-label={`Show name on Gantt for ${cb.name || 'bar'}`}
                                  onChange={(e) => handleCustomBarUpdate(cb, { showName: e.target.checked })}
                                />
                              </label>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => handleCustomBarDelete(cb.id)}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
          )}

          <div className={`card milestone-card${milestonesCollapsed ? ' is-collapsed' : ''}`}>
            <div className="section-header">
              <h3>Milestones</h3>
              <button
                type="button"
                className="secondary"
                onClick={() => handleUiPrefChange({ milestonesCollapsed: !milestonesCollapsed })}
              >
                {milestonesCollapsed ? 'Expand' : 'Collapse'}
              </button>
            </div>
            {!milestonesCollapsed && (
              <>
                <div className="milestone-form">
                  <input
                    type="text"
                    aria-label="New milestone label"
                    placeholder="Label"
                    maxLength={20}
                    value={newMilestone.label}
                    onChange={(event) => setNewMilestone((prev) => ({ ...prev, label: event.target.value }))}
                  />
                  <ThemedDatePicker
                    label="Milestone date"
                    value={newMilestone.date}
                    onChange={(iso) => setNewMilestone((prev) => ({ ...prev, date: iso }))}
                  />
                  <div className="initiative-colour" title="Pick milestone colour">
                    <span className="color-picker-label">Colour</span>
                    <ColourPicker
                      value={newMilestone.color}
                      ariaLabel="Milestone colour"
                      onChange={(next) => setNewMilestone((prev) => ({ ...prev, color: next }))}
                    />
                  </div>
                  <select
                    value={newMilestone.projectScope}
                    onChange={(event) => setNewMilestone((prev) => ({ ...prev, projectScope: event.target.value }))}
                  >
                    <option value="">All projects</option>
                    {filters.projects.map((project) => (
                      <option key={project} value={project}>
                        {project}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={handleMilestoneCreate}>
                    Add milestone
                  </button>
                </div>
                <table className="table milestone-table">
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Date</th>
                      <th>Color</th>
                      <th>Scope</th>
                      <th>Show label</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {milestones.map((milestone) => (
                      <tr key={milestone.id}>
                        <td>
                          <input
                            type="text"
                            aria-label="Milestone label"
                            maxLength={20}
                            value={milestone.label}
                            onChange={(event) => handleMilestoneUpdate(milestone, { label: event.target.value })}
                          />
                        </td>
                        <td>
                          <ThemedDatePicker
                            label={`Date for ${milestone.label || 'milestone'}`}
                            value={milestone.date}
                            onChange={(iso) => {
                              // ThemedDatePicker fires onChange('') on every
                              // keystroke of an incomplete date, so guard
                              // against hammering the backend with blank
                              // updates mid-typing. We only persist full ISO
                              // strings; a different value is required here.
                              if (iso && iso !== milestone.date) {
                                handleMilestoneUpdate(milestone, { date: iso });
                              }
                            }}
                          />
                        </td>
                        <td>
                          <ColourPicker
                            value={milestone.color}
                            ariaLabel={`Colour for ${milestone.label || 'milestone'}`}
                            onChange={(next) => handleMilestoneUpdate(milestone, { color: next })}
                          />
                        </td>
                        <td>{milestone.projectScope || 'All'}</td>
                        <td>
                          <label className="custom-bar-show-name">
                            <input
                              type="checkbox"
                              checked={milestone.showLabel !== false}
                              aria-label={`Show label on Gantt for ${milestone.label || 'milestone'}`}
                              onChange={(e) => handleMilestoneUpdate(milestone, { showLabel: e.target.checked })}
                            />
                          </label>
                        </td>
                        <td>
                          <button className="secondary" onClick={() => handleMilestoneDelete(milestone)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
      {/* Single global image lightbox — handles clicks on images inside any
          AI summary paragraph or rich-text panel on this dashboard. */}
      <ImageLightbox />

      {/* Full-screen presentation overlay (portaled onto document.body). */}
      {presenting && (
        <PresentationView
          project={presentationDeck.project}
          deckTitle={dashboard?.title ?? ''}
          dateRange={presentationDeck.dateRange}
          slides={orderedPresentationSlides}
          hiddenIds={filters.presentationHidden ?? []}
          roadmapNode={ganttElement}
          releasedCount={presentationDeck.released}
          activeCount={presentationDeck.active}
          onReorder={handlePresentationReorder}
          onToggleHidden={handlePresentationToggleHidden}
          onClose={() => setPresenting(false)}
        />
      )}
    </div>
  );
};
