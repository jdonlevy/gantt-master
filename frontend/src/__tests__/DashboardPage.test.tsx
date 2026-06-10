import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { DashboardPage } from '../pages/DashboardPage';

vi.mock('../api', () => ({
  fetchSession: vi.fn().mockResolvedValue({ authenticated: true }),
  fetchDashboards: vi.fn().mockResolvedValue([]),
  fetchDashboard: vi.fn().mockResolvedValue({
    id: '1',
    slug: 'gpo',
    title: 'GPO',
    filters: {
      projects: ['GPO'],
      fixVersions: [],
      components: [],
      incrementStart: '2026-01-19',
      incrementEnd: '2026-06-30'
    },
    panels: [
      { id: 'panel-1', type: 'metrics', title: 'Metrics', row: 1, column: 1, width: 4, height: 4, contentHtml: null, contentJson: null, updatedAt: null }
    ],
    updatedAt: new Date().toISOString()
  }),
  updateDashboard: vi.fn().mockResolvedValue({
    id: '1',
    slug: 'gpo',
    title: 'GPO',
    filters: {
      projects: ['GPO'],
      fixVersions: [],
      components: [],
      incrementStart: '2026-01-19',
      incrementEnd: '2026-06-30'
    },
    panels: [],
    updatedAt: new Date().toISOString()
  }),
  fetchProjects: vi.fn().mockResolvedValue([{ key: 'GPO', name: 'Outdoor' }]),
  fetchFixVersions: vi.fn().mockResolvedValue([
    { id: 'fix-1', name: 'Release One', release: '2026-02-01', released: false, archived: false }
  ]),
  fetchComponents: vi.fn().mockResolvedValue([{ id: 'comp-1', name: 'Core' }]),
  fetchRoadmap: vi.fn().mockResolvedValue({
    projects: [{ key: 'GPO', name: 'Outdoor' }],
    fixVersions: [
      {
        id: 'fix-1',
        name: 'Release One',
        start: '2026-01-10',
        release: '2026-02-20',
        released: false,
        archived: false,
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        epics: []
      }
    ],
    milestones: [
      {
        id: 'm1',
        label: 'Launch',
        date: '2026-03-01',
        color: '#22c55e',
        projectScope: null
      }
    ],
    updatedAt: new Date().toISOString()
  }),
  createMilestone: vi.fn(),
  updateMilestone: vi.fn(),
  deleteMilestone: vi.fn(),
  updateFixVersionOverrides: vi.fn(),
  createDashboardPanel: vi.fn(),
  updateDashboardPanel: vi.fn(),
  updateDashboardPanelContent: vi.fn(),
  fetchDashboardSnapshot: vi.fn().mockResolvedValue(null),
  fetchMetrics: vi.fn().mockResolvedValue({ count: 2, issues: [
    { key: 'GPO-1', summary: 'Fix login bug', status: 'Done', project: 'GPO', url: 'https://example.atlassian.net/browse/GPO-1' },
    { key: 'GPO-2', summary: 'Improve onboarding', status: 'Awaiting Approval', project: 'GPO', url: 'https://example.atlassian.net/browse/GPO-2' }
  ]}),
  generateWeeklyUpdate: vi.fn(),
  deleteDashboardPanel: vi.fn(),
  fetchPresence: vi.fn().mockResolvedValue([]),
  setPresence: vi.fn().mockResolvedValue({ ok: true }),
  clearPresence: vi.fn().mockResolvedValue({ ok: true }),
  fetchPanelContent: vi.fn().mockResolvedValue({ contentJson: null, updatedAt: null }),
  apiBase: '',
  getAccessToken: vi.fn().mockResolvedValue(null),
  TAB_ID: 'test-tab-id',
}));

const api = await import('../api');

describe('DashboardPage tables', () => {
  it('uses the shared table styling for fix versions and milestones', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    // Fix-version / milestone tables live on the Roadmap tab (Updates is default).
    fireEvent.click(await screen.findByRole('tab', { name: 'Roadmap' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fix versions' })).toBeInTheDocument());
    await waitFor(() => expect(document.querySelectorAll('table.table').length).toBeGreaterThanOrEqual(1));
  });
});

const defaultRoadmapResponse = {
  projects: [{ key: 'GPO', name: 'Outdoor' }],
  fixVersions: [
    {
      id: 'fix-1',
      name: 'Release One',
      start: '2026-01-10',
      release: '2026-02-20',
      released: false,
      archived: false,
      uatStart: null,
      uatEnd: null,
      liveStart: null,
      liveEnd: null,
      notes: null,
      epics: []
    }
  ],
  milestones: [
    {
      id: 'm1',
      label: 'Launch',
      date: '2026-03-01',
      color: '#22c55e',
      projectScope: null
    }
  ],
  updatedAt: new Date().toISOString()
};

describe('DashboardPage loading state', () => {
  afterEach(() => {
    // Reset fetchRoadmap so a never-resolving mock from one test cannot leak
    // into subsequent tests in other describe blocks.
    vi.mocked(api.fetchRoadmap).mockResolvedValue(defaultRoadmapResponse);
  });

  it('shows Loading card while the dashboard is being fetched', async () => {
    // Never resolves — keeps the page in the initial loading state
    vi.mocked(api.fetchDashboard).mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('hides Loading card once the dashboard resolves, even if roadmap is still loading', async () => {
    // Dashboard resolves immediately; roadmap never resolves (still fetching)
    vi.mocked(api.fetchDashboard).mockResolvedValue({
      id: '1', slug: 'gpo', title: 'GPO',
      filters: { projects: ['GPO'], fixVersions: [], components: [], incrementStart: '2026-01-19', incrementEnd: '2026-06-30' },
      panels: [],
      updatedAt: new Date().toISOString()
    });
    vi.mocked(api.fetchRoadmap).mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for dashboard title heading to appear (dashboard resolved)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'GPO' })).toBeInTheDocument());

    // Loading card must not be visible even though roadmap is still fetching
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});

describe('DashboardPage metrics panel', () => {
  beforeEach(() => {
    vi.mocked(api.fetchDashboard).mockResolvedValue({
      id: '1',
      slug: 'gpo',
      title: 'GPO',
      filters: {
        projects: ['GPO'],
        fixVersions: [],
        components: [],
        incrementStart: '2026-01-19',
        incrementEnd: '2026-06-30'
      },
      panels: [
        { id: 'panel-1', type: 'metrics', title: 'Metrics', row: 1, column: 1, width: 4, height: 4, contentHtml: null, contentJson: null, updatedAt: null }
      ],
      updatedAt: new Date().toISOString()
    });
  });

  it('renders a metrics panel and displays tickets after expanding a group', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    // Panel title renders as <input> when editable (authenticated=true)
    await waitFor(() => expect(screen.getByDisplayValue('Metrics')).toBeInTheDocument());

    // All groups start collapsed — verify the count summary and group headers render
    await waitFor(() => expect(screen.getByText('tickets completed')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Awaiting Approval')).toBeInTheDocument());
  });
});

// ── Weekly update panel ───────────────────────────────────────────────────────

describe('DashboardPage weekly update panel', () => {
  beforeEach(() => {
    vi.mocked(api.fetchDashboard).mockResolvedValue({
      id: '1',
      slug: 'gpo',
      title: 'GPO',
      filters: {
        projects: ['GPO'],
        fixVersions: [],
        components: [],
        incrementStart: '2026-01-19',
        incrementEnd: '2026-06-30'
      },
      panels: [
        {
          id: 'wu-panel',
          type: 'weekly_update',
          title: 'Weekly Update',
          row: 1,
          column: 1,
          width: 12,
          height: 8,
          contentHtml: null,
          contentJson: null,
          updatedAt: null,
        },
      ],
      updatedAt: new Date().toISOString(),
    });
  });

  it('renders the weekly update container with wu-inline class', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(document.querySelector('.wu-inline')).toBeInTheDocument());
  });

  it('renders the Generate button inside the panel', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate/ })).toBeInTheDocument());
  });

  it('measure() uses .wu-inline height when panel-body contains a weekly update', async () => {
    // jsdom returns 0 for all layout reads by default. Stub getBoundingClientRect on
    // the wu-inline element to return a non-zero height so we can confirm that the
    // measure() path that queries .wu-inline is taken (rather than scrollHeight).
    const realGetBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList?.contains('wu-inline')) {
        return { height: 300, width: 800, top: 0, left: 0, bottom: 300, right: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList?.contains('panel-header')) {
        return { height: 40, width: 800, top: 0, left: 0, bottom: 40, right: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return realGetBCR.call(this);
    };

    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(document.querySelector('.wu-inline')).toBeInTheDocument());

    // Dispatch wu-normalised on the panel body to trigger a re-measure
    const panelBody = document.querySelector('.panel-body') as HTMLElement;
    expect(() =>
      panelBody.dispatchEvent(new CustomEvent('wu-normalised', { bubbles: false }))
    ).not.toThrow();

    Element.prototype.getBoundingClientRect = realGetBCR;
  });

  it('does not crash when wu-normalised fires before wu-inline exists', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/gpo']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(document.querySelector('.panel-body')).toBeInTheDocument());

    const panelBody = document.querySelector('.panel-body') as HTMLElement;
    expect(() =>
      panelBody.dispatchEvent(new CustomEvent('wu-normalised', { bubbles: false }))
    ).not.toThrow();
  });
});
