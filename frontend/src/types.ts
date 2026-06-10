export type Project = {
  key: string;
  name: string;
};

export type Milestone = {
  id: string;
  label: string;
  date: string;
  color: string;
  projectScope?: string | null;
  /** When false, the milestone renders on the Gantt without its label. */
  showLabel?: boolean;
  dashboardId?: string | null;
};

export type Story = {
  id: string;
  key: string;
  summary: string;
  start?: string | null;
  end?: string | null;
  url?: string | null;
  // Jira statusCategory key ("new" | "indeterminate" | "done"). Drives the
  // story bar colour: new = grey, indeterminate = green, done = blue.
  status?: string | null;
  // Full Jira status name (e.g. "In Progress", "Done - Released") — shown in
  // the Gantt hover tooltip.
  statusName?: string | null;
};

export type Epic = {
  id: string;
  key: string;
  summary: string;
  start?: string | null;
  end?: string | null;
  url?: string | null;
  // Jira statusCategory key ("new" | "indeterminate" | "done"). When "done" the
  // Gantt forces the completed-colour bar irrespective of dates/progress.
  status?: string | null;
  // Per-epic progress derived from its stories (excluding Closed). Used to
  // shade the epic bar the same way fix-version bars are shaded.
  progressDone?: number | null;
  progressTotal?: number | null;
  stories: Story[];
};

export type FixVersion = {
  id: string;
  projectKey?: string | null;
  name: string;
  start?: string | null;
  release?: string | null;
  released?: boolean | null;
  archived?: boolean | null;
  url?: string | null;
  progressDone?: number | null;
  progressInProgress?: number | null;
  progressTotal?: number | null;
  uatStart?: string | null;
  uatEnd?: string | null;
  liveStart?: string | null;
  liveEnd?: string | null;
  notes?: string | null;
  epics: Epic[];
  /**
   * Ticket keys (e.g. "CORE-123") from OTHER projects that any epic or story
   * in this fix version is linked to. Populated server-side by walking each
   * ticket's `issuelinks`. Drives the external-dependencies exclamation
   * badge on the Gantt bar — tooltip lists these keys on hover.
   */
  externalLinks?: string[];
};

export type Dependency = {
  fromId: string;
  toId: string;
  type: string;
  fromKey?: string | null;
  toKey?: string | null;
  /** 'jira' for Jira-sourced deps, 'manual' for user-created dashboard overrides. */
  source?: string | null;
  /**
   * Primary key of the override row. Only populated for manual dependencies
   * so the UI has a handle for deletion; Jira-sourced deps are read-only.
   */
  id?: string | null;
};

export type DependencyNodeType = 'fix' | 'epic';

export type RoadmapResponse = {
  projects: Project[];
  fixVersions: FixVersion[];
  milestones: Milestone[];
  dependencies?: Dependency[];
  updatedAt: string;
  jiraBaseUrl?: string | null;
};

export type DashboardFilters = {
  projects: string[];
  fixVersions: string[];
  components: string[];
  incrementStart?: string | null;
  incrementEnd?: string | null;
  ganttMode?: 'standard' | 'swimlane';
  /** Timeline header granularity: 'month' (default) or 'quarter'. */
  timeScale?: 'month' | 'quarter';
  showDependencies?: boolean;
  /**
   * When true, dependency arrows only render for user-created (manual)
   * dependencies — Jira-sourced deps are hidden. Useful when the user
   * wants to focus only on overrides they've added themselves.
   */
  dependenciesManualOnly?: boolean;
  /**
   * When true, fix versions Jira has marked as released are hidden from the
   * Gantt (and everything derived from it). Lets the chart focus on
   * upcoming/in-flight work without the clutter of shipped versions.
   */
  hideReleasedFixVersions?: boolean;
  /**
   * Swimlane-only: when true, each bar is replaced by a single milestone
   * diamond at its end date, producing a condensed milestone-style view.
   */
  swimlaneMilestoneView?: boolean;
  swimlanes?: Swimlane[];
  /**
   * Optional top-level grouping that sits above swimlanes (swimlane mode) or
   * fix versions (standard mode). Rendered as a coloured left spine that
   * spans its member lanes/rows.
   */
  initiatives?: Initiative[];
  /** Master switch for the initiative grouping layer. When false the Gantt
   *  renders exactly as it did before initiatives existed. */
  showInitiatives?: boolean;
  /** Ids of initiatives whose spine is collapsed. Persisted so the folded
   *  state survives reloads. */
  collapsedInitiatives?: string[];
  /** Slide ids in the order they appear in presentation mode. The deck is
   *  assembled at dashboard level from every rich-text panel plus each
   *  weekly-update section; this list folds that natural order onto the
   *  user's drag-reorder. Reconciled on use: unknown ids are dropped and new
   *  slides append in natural order. */
  presentationOrder?: string[];
  /** Slide ids hidden from the presentation deck. Hidden slides still appear on
   *  the Overview/reorder screen (so they can be unhidden) but are skipped when
   *  presenting. Persisted so the choice survives reloads. */
  presentationHidden?: string[];
  /** Named colour categories that can be assigned to swimlane bars (manual mode). */
  barColourCategories?: BarColourCategory[];
  /** Maps fixVersionId → BarColourCategory id (manual mode). */
  fixVersionColours?: Record<string, string>;
  /** When true, bars use their assigned category colour instead of status colour.
   *  Legacy flag — superseded by `barColourMode` ('manual' === true). Kept in
   *  sync for back-compat with dashboards saved before the dropdown existed. */
  colourByCategory?: boolean;
  /**
   * How swimlane bars are coloured:
   *  - 'rag'        → status colour (red/amber/green) — the default
   *  - 'project'    → one auto colour per Jira project
   *  - 'swimlane'   → one auto colour per swimlane
   *  - 'initiative' → one auto colour per initiative
   *  - 'manual'     → user-defined categories assigned via right-click
   */
  barColourMode?: BarColourMode;
  /**
   * Per-group colour overrides for the auto modes (project/swimlane/initiative).
   * Keyed by the auto category id (e.g. "proj:CORE", "lane:<id>", "init:<id>")
   * so a user can recolour an auto-assigned group without losing the grouping.
   */
  autoBarColours?: Record<string, string>;
  /** Collapse state of the config cards, persisted with the dashboard. */
  filtersCollapsed?: boolean;
  milestonesCollapsed?: boolean;
  customBarsCollapsed?: boolean;
  /**
   * Fix versions scoping the Updates tab's fortnightly summary, kept separate
   * from the roadmap's `fixVersions`. When unset/empty the Updates tab falls
   * back to the roadmap's fix-version selection.
   */
  updateFixVersions?: string[];
  /**
   * Custom "released" window for the Updates tab summary. When set, released
   * fix versions are included only if their release date falls within
   * [updateStart, updateEnd]. When unset, the backend defaults to the last
   * two weeks. Kept separate from the roadmap's incrementStart/incrementEnd.
   */
  updateStart?: string | null;
  updateEnd?: string | null;
};

export type BarColourMode = 'rag' | 'project' | 'swimlane' | 'initiative' | 'manual';

export type Swimlane = {
  id: string;
  name: string;
  fixVersionIds: string[];
};

export type Initiative = {
  id: string;
  name: string;
  /** Optional hex colour for the initiative spine. Falls back to a neutral
   *  tint when unset. */
  colour?: string;
  /** Member swimlane ids — groups lanes in swimlane mode. */
  swimlaneIds: string[];
  /** Member fix-version ids — groups fix-version rows in standard mode. */
  fixVersionIds: string[];
};

export type BarColourCategory = {
  id: string;
  name: string;
  colour: string;
};

export type CustomBar = {
  id: string;
  name: string;
  /** null means "all swimlanes" */
  swimlaneId: string | null;
  start: string;
  end: string;
  color: string;
  /** When false, the bar renders on the Gantt without its name label. */
  showName: boolean;
  dashboardId: string;
};

export type DashboardSummary = {
  id: string;
  slug: string;
  title: string;
  folder?: string | null;
  description?: string | null;
  updatedAt?: string | null;
};

export type DashboardPanel = {
  id: string;
  type: string;
  title?: string | null;
  row: number;
  column: number;
  width: number;
  height: number;
  collapsed?: boolean;
  contentJson?: Record<string, unknown> | null;
  contentHtml?: string | null;
  updatedAt?: string | null;
};

export type DashboardDetail = {
  id: string;
  slug: string;
  title: string;
  folder?: string | null;
  description?: string | null;
  filters?: DashboardFilters | null;
  panels: DashboardPanel[];
  customBars?: CustomBar[];
  updatedAt?: string | null;
};

export type MetricsIssue = {
  key: string;
  summary: string;
  status: string;
  project: string;
  url?: string | null;
};

export type MetricsResponse = {
  count: number;
  issues: MetricsIssue[];
};

// ── Weekly update generate response ───────────────────────────────────────────

export type WeeklyUpdateItem = {
  text: string;
  badge?: string;
  badgeClass?: string;
};

export type WeeklyUpdateSubSection = {
  id: string;
  label: string;
  items: WeeklyUpdateItem[];
};

export type WeeklyUpdateSection = {
  id: string;
  name: string;
  href: string;
  increment: string;
  statusLabel: string;
  statusClass: string;
  ticketTodo: number;
  ticketTotal: number;
  uatStart?: string | null;
  targetEnd?: string | null;
  targetEndUrgent?: boolean;
  versionNote?: string | null;
  summary: string;
  /** When "html", the summary string is already safe HTML rendered by the
   *  backend (structured Done/Doing/To Do layout). When absent or "text",
   *  the summary is plain prose that the frontend must HTML-escape before
   *  inserting. Older cached responses omit this field → treated as text. */
  summaryFormat?: 'html' | 'text';
  subSections: WeeklyUpdateSubSection[];
  releasedDate?: string | null;
};

export type WeeklyUpdateResponse = {
  generatedAt: string;
  dateRange: string;
  project: string;
  released: WeeklyUpdateSection[];
  active: WeeklyUpdateSection[];
};
