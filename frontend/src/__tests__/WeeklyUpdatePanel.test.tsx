import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { vi } from 'vitest';
import WeeklyUpdatePanel from '../pages/WeeklyUpdatePanel';
import { WeeklyUpdateResponse, WeeklyUpdateSection } from '../types';

vi.mock('../api', () => ({
  generateWeeklyUpdate: vi.fn(),
}));

const api = await import('../api');

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeSection = (overrides: Partial<WeeklyUpdateSection> = {}): WeeklyUpdateSection => ({
  id: 'section-1',
  name: 'OTS Packs & Tech Debt',
  href: 'https://example.atlassian.net/projects/GPO',
  increment: 'IP11',
  statusLabel: 'IN PROGRESS',
  statusClass: 'wu-badge--in-progress',
  ticketTodo: 3,
  ticketTotal: 5,
  summary: 'Progress is ongoing with planned tasks in the backlog.',
  subSections: [],
  ...overrides,
});

const sampleResponse = (): WeeklyUpdateResponse => ({
  generatedAt: '2026-04-16T10:00:00Z',
  dateRange: '2 Apr – 16 Apr 2026',
  project: 'GPO',
  released: [],
  active: [makeSection()],
});

const asContent = (r: WeeklyUpdateResponse) => r as unknown as Record<string, unknown>;

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('WeeklyUpdatePanel rendering', () => {
  it('renders the Generate button', () => {
    render(<WeeklyUpdatePanel slug="gpo" />);
    expect(screen.getByRole('button', { name: /Generate/ })).toBeInTheDocument();
  });

  it('shows the empty-state prompt before generating', () => {
    render(<WeeklyUpdatePanel slug="gpo" />);
    expect(screen.getByText(/No update generated yet/)).toBeInTheDocument();
  });

  it('restores section name and summary from initialContent on mount', () => {
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent(sampleResponse())}
      />
    );
    expect(screen.getByText('OTS Packs & Tech Debt')).toBeInTheDocument();
    expect(screen.getByText(/Progress is ongoing/)).toBeInTheDocument();
  });

  it('restores date range label from initialContent', () => {
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent(sampleResponse())}
      />
    );
    expect(screen.getByText('2 Apr – 16 Apr 2026')).toBeInTheDocument();
  });

  it('renders summary as a contentEditable element', () => {
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent(sampleResponse())}
      />
    );
    const summary = document.querySelector('[data-summary-for="section-1"]');
    expect(summary).not.toBeNull();
    expect(summary?.getAttribute('contenteditable')).toBe('true');
  });
});

// ── Badge logic ───────────────────────────────────────────────────────────────

describe('WeeklyUpdatePanel badge logic', () => {
  it('shows IN PROGRESS badge when ticketTodo > 0', () => {
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent({
          ...sampleResponse(),
          active: [makeSection({ ticketTodo: 3, ticketTotal: 5, statusLabel: 'IN PROGRESS' })],
        })}
      />
    );
    expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    expect(screen.queryByText('Pending release')).not.toBeInTheDocument();
  });

  it('shows Pending release badge when all tickets are done (replaces status)', () => {
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent({
          ...sampleResponse(),
          active: [makeSection({ ticketTodo: 0, ticketTotal: 5, statusLabel: 'IN PROGRESS' })],
        })}
      />
    );
    expect(screen.getByText('Pending release')).toBeInTheDocument();
    expect(screen.queryByText('IN PROGRESS')).not.toBeInTheDocument();
  });

  it('shows status badge (not Pending release) when ticketTotal is 0', () => {
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent({
          ...sampleResponse(),
          active: [makeSection({ ticketTodo: 0, ticketTotal: 0, statusLabel: 'IN PROGRESS' })],
        })}
      />
    );
    expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    expect(screen.queryByText('Pending release')).not.toBeInTheDocument();
  });

  it('shows Released badge on items in the released section', () => {
    const releasedSection: WeeklyUpdateSection = {
      ...makeSection({ id: 'rel-1', name: 'IP10 – Global Releases', summary: 'Released last week.' }),
      releasedDate: '14 Apr 2026',
    };
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent({ ...sampleResponse(), released: [releasedSection], active: [] })}
      />
    );
    expect(screen.getByText('Released')).toBeInTheDocument();
    expect(screen.getByText('Released 14 Apr 2026')).toBeInTheDocument();
  });
});

// ── Generate & autosave ───────────────────────────────────────────────────────

describe('WeeklyUpdatePanel generate and autosave', () => {
  beforeEach(() => {
    vi.mocked(api.generateWeeklyUpdate).mockReset();
  });

  it('shows loading spinner while generate is in flight', async () => {
    vi.mocked(api.generateWeeklyUpdate).mockReturnValue(new Promise(() => {}));
    render(<WeeklyUpdatePanel slug="gpo" />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(screen.getByText('⏳ Generating…')).toBeInTheDocument();
  });

  it('renders sections after generate resolves', async () => {
    vi.mocked(api.generateWeeklyUpdate).mockResolvedValue(sampleResponse());
    render(<WeeklyUpdatePanel slug="gpo" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    await waitFor(() => expect(screen.getByText('OTS Packs & Tech Debt')).toBeInTheDocument());
  });

  it('calls onSave with generated data after generate completes', async () => {
    const response = sampleResponse();
    vi.mocked(api.generateWeeklyUpdate).mockResolvedValue(response);
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<WeeklyUpdatePanel slug="gpo" panelId="panel-1" onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        'panel-1',
        expect.objectContaining({ contentJson: response })
      )
    );
  });

  it('shows error banner when generate fails', async () => {
    vi.mocked(api.generateWeeklyUpdate).mockRejectedValue(new Error('API error'));
    render(<WeeklyUpdatePanel slug="gpo" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    await waitFor(() => expect(screen.getByText('API error')).toBeInTheDocument());
  });

  it('shows a confirm modal before overwriting manual edits', async () => {
    vi.mocked(api.generateWeeklyUpdate).mockResolvedValue(sampleResponse());
    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={asContent(sampleResponse())}
      />
    );

    // Make a manual edit to mark the panel as dirty
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;
    fireEvent.input(summary, { target: { innerHTML: 'Edited summary' } });

    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    await waitFor(() =>
      expect(screen.getByText('Refresh from live Jira?')).toBeInTheDocument()
    );
  });
});

// ── Released-window payload ────────────────────────────────────────────────────

describe('WeeklyUpdatePanel released-window payload', () => {
  beforeEach(() => {
    vi.mocked(api.generateWeeklyUpdate).mockReset();
  });

  it('sends the custom released-date range when generating', async () => {
    vi.mocked(api.generateWeeklyUpdate).mockResolvedValue(sampleResponse());
    render(<WeeklyUpdatePanel slug="gpo" updateStart="2026-04-01" updateEnd="2026-04-16" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    await waitFor(() => expect(api.generateWeeklyUpdate).toHaveBeenCalled());
    const lastCall = vi.mocked(api.generateWeeklyUpdate).mock.calls[vi.mocked(api.generateWeeklyUpdate).mock.calls.length - 1];
    expect(lastCall[0]).toBe('gpo');
    expect(lastCall[3]).toEqual({ from: '2026-04-01', to: '2026-04-16' });
  });

  it('passes an undefined range when no custom dates are set', async () => {
    vi.mocked(api.generateWeeklyUpdate).mockResolvedValue(sampleResponse());
    render(<WeeklyUpdatePanel slug="gpo" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    await waitFor(() => expect(api.generateWeeklyUpdate).toHaveBeenCalled());
    const lastCall = vi.mocked(api.generateWeeklyUpdate).mock.calls[vi.mocked(api.generateWeeklyUpdate).mock.calls.length - 1];
    expect(lastCall[0]).toBe('gpo');
    expect(lastCall[3]).toEqual({ from: undefined, to: undefined });
  });

  it('forwards the custom released-date range when regenerating a single section', async () => {
    const releasedSection: WeeklyUpdateSection = {
      ...makeSection({ id: 'rel-1', name: 'IP10 – Global Releases', summary: 'Released last week.' }),
      releasedDate: '14 Apr 2026',
    };
    const withReleased = asContent({ ...sampleResponse(), released: [releasedSection], active: [] });
    // The regen response must still contain the section or the panel treats it
    // as no-longer-qualifying; the call args we assert fire regardless.
    vi.mocked(api.generateWeeklyUpdate).mockResolvedValue({
      ...sampleResponse(),
      released: [releasedSection],
      active: [],
    });

    render(
      <WeeklyUpdatePanel
        slug="gpo"
        initialContent={withReleased}
        updateStart="2026-04-01"
        updateEnd="2026-04-16"
      />
    );

    // Open the per-section regen confirm, then confirm it — this exercises the
    // regenerateSection path (distinct from the full Generate button).
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate IP10 – Global Releases' }));
    await waitFor(() => expect(screen.getByText(/Regenerate "IP10/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(api.generateWeeklyUpdate).toHaveBeenCalled());
    const lastCall = vi.mocked(api.generateWeeklyUpdate).mock.calls[vi.mocked(api.generateWeeklyUpdate).mock.calls.length - 1];
    expect(lastCall[0]).toBe('gpo');
    expect(lastCall[1]).toEqual(['rel-1']);
    expect(lastCall[3]).toEqual({ from: '2026-04-01', to: '2026-04-16' });
  });
});

// ── Summary normalisation ─────────────────────────────────────────────────────

describe('WeeklyUpdatePanel summary normalisation on blur', () => {
  const content = asContent({
    ...sampleResponse(),
    active: [makeSection({ summary: 'Original summary text' })],
  });

  it('strips empty <div> children Chrome inserts on blur', () => {
    render(<WeeklyUpdatePanel slug="gpo" initialContent={content} />);
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;

    // Simulate Chrome inserting an empty div
    summary.appendChild(document.createElement('div'));
    expect(summary.querySelectorAll('div').length).toBe(1);

    fireEvent.blur(summary);

    expect(summary.querySelectorAll('div').length).toBe(0);
  });

  it('strips <div> children that contain only a <br>', () => {
    render(<WeeklyUpdatePanel slug="gpo" initialContent={content} />);
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;

    const brDiv = document.createElement('div');
    brDiv.appendChild(document.createElement('br'));
    summary.appendChild(brDiv);

    fireEvent.blur(summary);

    expect(summary.querySelectorAll('div').length).toBe(0);
  });

  it('strips trailing bare <br> nodes on blur', () => {
    render(<WeeklyUpdatePanel slug="gpo" initialContent={content} />);
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;

    summary.appendChild(document.createElement('br'));
    summary.appendChild(document.createElement('br'));

    fireEvent.blur(summary);

    expect(summary.querySelector('br')).toBeNull();
  });

  it('preserves non-empty <div> children (intentional newlines) on blur', () => {
    render(<WeeklyUpdatePanel slug="gpo" initialContent={content} />);
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;

    const lineDiv = document.createElement('div');
    lineDiv.textContent = 'Second line of text';
    summary.appendChild(lineDiv);

    fireEvent.blur(summary);

    const remainingDivs = summary.querySelectorAll('div');
    expect(remainingDivs.length).toBe(1);
    expect(remainingDivs[0].textContent).toBe('Second line of text');
  });

  it('dispatches a bubbling wu-normalised event on blur', () => {
    render(<WeeklyUpdatePanel slug="gpo" initialContent={content} />);
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;

    // Add an empty div so normalisation actually runs a mutation
    summary.appendChild(document.createElement('div'));

    const listener = vi.fn();
    // Listen on the parent to confirm bubbling
    (summary.parentElement ?? summary).addEventListener('wu-normalised', listener);

    fireEvent.blur(summary);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatches wu-normalised even when there are no Chrome artifacts', () => {
    render(<WeeklyUpdatePanel slug="gpo" initialContent={content} />);
    const summary = document.querySelector('[data-summary-for="section-1"]') as HTMLElement;

    const listener = vi.fn();
    (summary.parentElement ?? summary).addEventListener('wu-normalised', listener);

    fireEvent.blur(summary);

    // Always fires so the panel can re-measure after any blur
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
