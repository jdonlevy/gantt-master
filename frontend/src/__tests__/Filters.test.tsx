import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage';

vi.mock('../api', () => ({
  fetchSession: vi.fn().mockResolvedValue({ authenticated: true }),
  fetchDashboards: vi.fn().mockResolvedValue([]),
  fetchDashboard: vi.fn().mockResolvedValue({
    id: '1',
    slug: 'outdoor-weekly-update',
    title: 'Outdoor Weekly Update',
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
  updateDashboard: vi.fn().mockResolvedValue({
    id: '1',
    slug: 'outdoor-weekly-update',
    title: 'Outdoor Weekly Update',
    filters: {
      projects: ['GPO'],
      fixVersions: ['fix-1'],
      components: [],
      incrementStart: '2026-01-19',
      incrementEnd: '2026-06-30'
    },
    panels: [],
    updatedAt: new Date().toISOString()
  }),
  fetchProjects: vi.fn().mockResolvedValue([{ key: 'GPO', name: 'Outdoor' }]),
  fetchFixVersions: vi.fn().mockResolvedValue([
    { id: 'fix-1', name: 'Release One', projectKey: 'GPO', release: '2026-02-01', released: false, archived: false }
  ]),
  fetchComponents: vi.fn().mockResolvedValue([{ id: 'comp-1', name: 'Core' }]),
  fetchRoadmap: vi.fn().mockResolvedValue({
    projects: [{ key: 'GPO', name: 'Outdoor' }],
    fixVersions: [],
    milestones: [],
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
  fetchMetrics: vi.fn().mockResolvedValue({ count: 0, issues: [] }),
  fetchPresence: vi.fn().mockResolvedValue([]),
  setPresence: vi.fn().mockResolvedValue({ ok: true }),
  clearPresence: vi.fn().mockResolvedValue({ ok: true }),
  fetchPanelContent: vi.fn().mockResolvedValue({ contentJson: null, updatedAt: null }),
  apiBase: '',
  getAccessToken: vi.fn().mockResolvedValue(null),
  TAB_ID: 'test-tab-id',
}));

const { fetchRoadmap, updateDashboard } = await import('../api');

// The filters bar, date inputs and fix-version table now live on the Roadmap
// tab (Updates is the default tab), so switch to it before asserting on them.
const goToRoadmap = () => fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }));

describe('Filters', () => {
  it('adds fix version filters to roadmap query', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchRoadmap).toHaveBeenCalled());

    goToRoadmap();

    const fixVersionTrigger = screen.getByRole('button', { name: /^fix versions$/i });
    await user.click(fixVersionTrigger);
    await user.click(screen.getByLabelText('GPO > Release One'));

    await waitFor(() =>
      expect(fetchRoadmap).toHaveBeenLastCalledWith(
        ['GPO'],
        '2026-01-19',
        '2026-06-30',
        ['fix-1'],
        [],
        '1',
        expect.any(AbortSignal)
      )
    );
  });

  it('shows error message when increment start is after increment end', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchRoadmap).toHaveBeenCalled());

    goToRoadmap();

    const startInput = screen.getByDisplayValue('2026-01-19');
    fireEvent.change(startInput, { target: { value: '2026-12-01' } });

    expect(screen.getByText('Start date must be before end date')).toBeInTheDocument();
  });

  it('hides error message when date range is corrected', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchRoadmap).toHaveBeenCalled());

    goToRoadmap();

    const startInput = screen.getByDisplayValue('2026-01-19');
    fireEvent.change(startInput, { target: { value: '2026-12-01' } });
    expect(screen.getByText('Start date must be before end date')).toBeInTheDocument();

    fireEvent.change(startInput, { target: { value: '2026-01-19' } });
    expect(screen.queryByText('Start date must be before end date')).not.toBeInTheDocument();
  });

  it('disables the Save filters button when date range is invalid', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchRoadmap).toHaveBeenCalled());

    goToRoadmap();

    const startInput = screen.getByDisplayValue('2026-01-19');
    fireEvent.change(startInput, { target: { value: '2026-12-01' } });

    expect(screen.getByRole('button', { name: /save as default/i })).toBeDisabled();
  });

  it('does not disable the Save filters button when date range is valid', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchRoadmap).toHaveBeenCalled());

    goToRoadmap();

    // Dirty the filters with a valid date change (start before end) to enable the button
    const startInput = screen.getByDisplayValue('2026-01-19');
    fireEvent.change(startInput, { target: { value: '2026-01-20' } });

    expect(screen.getByRole('button', { name: /save as default/i })).not.toBeDisabled();
  });

  it('does not call updateDashboard when date range is invalid', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetchRoadmap).toHaveBeenCalled());

    goToRoadmap();

    const startInput = screen.getByDisplayValue('2026-01-19');
    fireEvent.change(startInput, { target: { value: '2026-12-01' } });

    await user.click(screen.getByRole('button', { name: /save as default/i }));

    expect(updateDashboard).not.toHaveBeenCalled();
  });

  it('collapses fix versions by default', async () => {
    const mockRoadmap = {
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
          epics: [
            {
              id: 'epic-1',
              key: 'GPO-1',
              summary: 'Epic One',
              start: '2026-01-12',
              end: '2026-02-01',
              stories: []
            }
          ]
        }
      ],
      milestones: [],
      updatedAt: new Date().toISOString()
    };

    (fetchRoadmap as any).mockResolvedValueOnce(mockRoadmap);

    render(
      <MemoryRouter initialEntries={['/dashboards/outdoor-weekly-update']}>
        <Routes>
          <Route path="/dashboards/:slug" element={<DashboardPage authenticated={true} />} />
        </Routes>
      </MemoryRouter>
    );

    goToRoadmap();

    await waitFor(() => expect(screen.getAllByText('Release One').length).toBeGreaterThan(0));
    expect(screen.queryByText('GPO-1 — Epic One')).toBeNull();
  });
});
