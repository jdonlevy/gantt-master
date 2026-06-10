import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { vi } from 'vitest';
import { Gantt } from '../Gantt';
import { Dependency, FixVersion, Milestone } from '../types';

const fixVersions: FixVersion[] = [
  {
    id: 'fix-1',
    name: 'Release One',
    projectKey: 'GPO',
    url: 'https://example.atlassian.net/projects/GPO/versions/fix-1/tab/release-report-all-issues',
    start: '2026-01-10',
    release: '2026-02-20',
    uatStart: null,
    uatEnd: null,
    liveStart: null,
    liveEnd: null,
    notes: null,
    progressDone: 5,
    progressTotal: 10,
    epics: [
      {
        id: 'epic-1',
        key: 'GPO-1',
        summary: 'Epic One',
        url: 'https://example.atlassian.net/browse/GPO-1',
        start: '2026-01-12',
        end: '2026-02-01',
        stories: []
      }
    ]
  }
];

const milestones: Milestone[] = [];

describe('Gantt', () => {
  it('hides epics when fix version is collapsed', () => {
    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        jiraBaseUrl="https://example.atlassian.net"
        collapsedFixVersions={new Set(['fix-1'])}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(screen.getByText('Release One')).toBeInTheDocument();
    expect(screen.queryByText('GPO-1 — Epic One')).toBeNull();
  });

  it('hides released fix versions when hideReleasedFixVersions is set', () => {
    const mixed: FixVersion[] = [
      { id: 'fix-open', name: 'Open Release', projectKey: 'GPO', start: '2026-01-10', release: '2026-02-20', released: false, progressDone: 0, progressTotal: 10, epics: [] },
      { id: 'fix-done', name: 'Shipped Release', projectKey: 'GPO', start: '2026-01-01', release: '2026-01-20', released: true, progressDone: 10, progressTotal: 10, epics: [] }
    ];

    const { rerender } = render(
      <Gantt
        fixVersions={mixed}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // Default: both shown.
    expect(screen.getByText('Open Release')).toBeInTheDocument();
    expect(screen.getByText('Shipped Release')).toBeInTheDocument();

    rerender(
      <Gantt
        fixVersions={mixed}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        hideReleasedFixVersions
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // The released version is filtered out; the unreleased one remains.
    expect(screen.getByText('Open Release')).toBeInTheDocument();
    expect(screen.queryByText('Shipped Release')).toBeNull();
  });

  it('renders a Released shown/hidden toolbar toggle when the handler is provided', () => {
    const onChange = vi.fn();
    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        hideReleasedFixVersions={false}
        onHideReleasedFixVersionsChange={onChange}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Hide Released'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders month labels with day ticks in the default (month) time scale', () => {
    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        jiraBaseUrl="https://example.atlassian.net"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // Month scale: top labels are months, and there are no quarter labels.
    const monthNames = Array.from(document.querySelectorAll('.gantt-months .gantt-month-name')).map(
      (el) => el.textContent
    );
    expect(monthNames).toContain('Jan');
    expect(monthNames).toContain('Feb');
    expect(monthNames.some((name) => /^Q[1-4]$/.test(name || ''))).toBe(false);

    // Sub-scale ticks are weekly (Monday-aligned) day-of-month labels. For the
    // 2026-01-01 → 2026-03-01 range that's Jan 5/12/19/26 and Feb 2/9/16/23 —
    // eight two-digit day ticks, none of them month or quarter labels.
    const tickLabels = Array.from(document.querySelectorAll('.gantt-ticks .gantt-tick span')).map(
      (el) => el.textContent
    );
    expect(tickLabels.length).toBe(8);
    expect(tickLabels.every((label) => /^\d{2}$/.test(label || ''))).toBe(true);
    expect(tickLabels).toContain('05');
    expect(tickLabels).toContain('23');
  });

  it('renders quarter labels with month subdivisions when timeScale is "quarter"', () => {
    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-09-01"
        jiraBaseUrl="https://example.atlassian.net"
        timeScale="quarter"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // Top header shows quarter bands (Q1/Q2/Q3) instead of month names.
    const headerLabels = Array.from(
      document.querySelectorAll('.gantt-months .gantt-month-name')
    ).map((el) => el.textContent);
    expect(headerLabels).toContain('Q1');
    expect(headerLabels).toContain('Q2');
    expect(headerLabels).toContain('Q3');

    // The year is stamped on the first quarter of each year.
    const years = Array.from(document.querySelectorAll('.gantt-months .gantt-month-year')).map(
      (el) => el.textContent?.trim()
    );
    expect(years).toContain('2026');

    // Month names drop to the sub-scale ticks beneath the quarter bands.
    const tickLabels = Array.from(document.querySelectorAll('.gantt-ticks .gantt-tick span')).map(
      (el) => el.textContent
    );
    expect(tickLabels).toContain('Jan');
    expect(tickLabels).toContain('Apr');

    // Each quarter draws a boundary marker.
    expect(document.querySelectorAll('.gantt-ticks .gantt-tick-boundary').length).toBeGreaterThan(0);
  });

  it('renders Jira links for fix versions and epics', () => {
    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        jiraBaseUrl="https://example.atlassian.net"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    const fixLink = screen.getByRole('link', { name: 'Release One' });
    expect(fixLink).toHaveAttribute(
      'href',
      'https://example.atlassian.net/projects/GPO/versions/fix-1/tab/release-report-all-issues'
    );

    const epicLink = screen.getByRole('link', { name: 'GPO-1 — Epic One' });
    expect(epicLink).toHaveAttribute('href', 'https://example.atlassian.net/browse/GPO-1');
  });

  it('renders fixed progress percentage for fix versions', () => {
    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        jiraBaseUrl="https://example.atlassian.net"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(screen.getByText('50% completed')).toBeInTheDocument();
    const fill = document.querySelector('.gantt-progress-fill') as HTMLElement;
    expect(fill).toBeInTheDocument();
    expect(fill.style.width).toBe('50%');
  });

  it('renders swimlane bars and stacks overlaps', () => {
    const swimlaneFixVersions: FixVersion[] = [
      {
        id: 'fix-a',
        name: 'Lane A - Release',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-02-20',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-b',
        name: 'Lane A - Overlap',
        projectKey: 'GPO',
        start: '2026-01-15',
        release: '2026-02-10',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-c',
        name: 'Unassigned',
        projectKey: 'GPO',
        start: '2026-03-01',
        release: '2026-03-10',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    render(
      <Gantt
        fixVersions={swimlaneFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        jiraBaseUrl="https://example.atlassian.net"
        mode="swimlane"
        swimlanes={[
          { id: 'lane-1', name: 'BAU', fixVersionIds: ['fix-a', 'fix-b'] }
        ]}
        activeFixVersionIds={['fix-a', 'fix-b']}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(screen.getByText('BAU')).toBeInTheDocument();
    expect(screen.getByText('Lane A - Release')).toBeInTheDocument();
    expect(screen.getByText('Lane A - Overlap')).toBeInTheDocument();
    expect(screen.queryByText('Unassigned')).toBeNull();

    const bars = document.querySelectorAll('.gantt-lane-bar');
    expect(bars.length).toBe(2);
  });

  it('filters swimlane bars by active fix version filter', () => {
    const swimlaneFixVersions: FixVersion[] = [
      {
        id: 'fix-a',
        name: 'Lane A - Release',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-02-20',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-b',
        name: 'Lane A - Overlap',
        projectKey: 'GPO',
        start: '2026-01-15',
        release: '2026-02-10',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    render(
      <Gantt
        fixVersions={swimlaneFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        jiraBaseUrl="https://example.atlassian.net"
        mode="swimlane"
        swimlanes={[
          { id: 'lane-1', name: 'BAU', fixVersionIds: ['fix-a', 'fix-b'] }
        ]}
        activeFixVersionIds={['fix-a']}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(screen.getByText('Lane A - Release')).toBeInTheDocument();
    expect(screen.queryByText('Lane A - Overlap')).toBeNull();
    expect(document.querySelectorAll('.gantt-lane-bar').length).toBe(1);
  });

  it('renders an aggregated span for a collapsed initiative', () => {
    const swimlaneFixVersions: FixVersion[] = [
      {
        id: 'fix-a',
        name: 'Lane A - Release',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-02-20',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-b',
        name: 'Lane B - Late',
        projectKey: 'GPO',
        start: '2026-02-05',
        release: '2026-03-15',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    render(
      <Gantt
        fixVersions={swimlaneFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        jiraBaseUrl="https://example.atlassian.net"
        mode="swimlane"
        swimlanes={[
          { id: 'lane-1', name: 'Lane One', fixVersionIds: ['fix-a'] },
          { id: 'lane-2', name: 'Lane Two', fixVersionIds: ['fix-b'] }
        ]}
        initiatives={[
          { id: 'init-1', name: 'Alpha', colour: '#123456', swimlaneIds: ['lane-1', 'lane-2'], fixVersionIds: [] }
        ]}
        showInitiatives
        collapsedInitiatives={new Set(['init-1'])}
        onToggleInitiative={() => {}}
        activeFixVersionIds={['fix-a', 'fix-b']}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // Member lanes are hidden while collapsed; their bars don't render.
    expect(screen.queryByText('Lane A - Release')).toBeNull();
    expect(screen.queryByText('Lane B - Late')).toBeNull();

    // A single aggregated bar replaces the two lanes, tinted to match the
    // initiative colour, and spans from the earliest start to the latest end.
    const aggBar = document.querySelector('.gantt-init-agg-bar') as HTMLElement;
    expect(aggBar).toBeInTheDocument();
    expect(aggBar.style.outlineColor).toBe('rgb(18, 52, 86)');
    expect(aggBar.title).toContain('Alpha');
    const left = parseFloat(aggBar.style.left);
    const width = parseFloat(aggBar.style.width);
    expect(left).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(0);
    expect(aggBar).toHaveTextContent('2 lanes');
  });

  it('renders an aggregated span for a collapsed initiative in standard mode', () => {
    const standardFixVersions: FixVersion[] = [
      {
        id: 'fix-a',
        name: 'Release A',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-02-20',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-b',
        name: 'Release B',
        projectKey: 'GPO',
        start: '2026-02-05',
        release: '2026-03-15',
        uatStart: null,
        uatEnd: null,
        liveStart: null,
        liveEnd: null,
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    render(
      <Gantt
        fixVersions={standardFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        jiraBaseUrl="https://example.atlassian.net"
        initiatives={[
          { id: 'init-1', name: 'Alpha', colour: '#123456', swimlaneIds: [], fixVersionIds: ['fix-a', 'fix-b'] }
        ]}
        showInitiatives
        collapsedInitiatives={new Set(['init-1'])}
        onToggleInitiative={() => {}}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // Member fix-version rows are hidden while collapsed.
    expect(screen.queryByText('Release A')).toBeNull();
    expect(screen.queryByText('Release B')).toBeNull();

    // A single aggregated bar replaces them, tinted to the initiative colour,
    // spanning earliest start → latest end, labelled with the version count.
    const aggBar = document.querySelector('.gantt-init-agg-bar') as HTMLElement;
    expect(aggBar).toBeInTheDocument();
    expect(aggBar.style.outlineColor).toBe('rgb(18, 52, 86)');
    expect(aggBar.title).toContain('Alpha');
    expect(parseFloat(aggBar.style.left)).toBeGreaterThan(0);
    expect(parseFloat(aggBar.style.width)).toBeGreaterThan(0);
    expect(aggBar).toHaveTextContent('2 versions');
  });

  it('renders the empty note for a collapsed standard initiative with no dated work', () => {
    const undatedFixVersions: FixVersion[] = [
      { id: 'fix-a', name: 'Release A', projectKey: 'GPO', start: null, release: null, progressDone: 0, progressTotal: 0, epics: [] },
      { id: 'fix-b', name: 'Release B', projectKey: 'GPO', start: null, release: null, progressDone: 0, progressTotal: 0, epics: [] }
    ];

    render(
      <Gantt
        fixVersions={undatedFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        initiatives={[
          { id: 'init-1', name: 'Alpha', colour: '#123456', swimlaneIds: [], fixVersionIds: ['fix-a', 'fix-b'] }
        ]}
        showInitiatives
        collapsedInitiatives={new Set(['init-1'])}
        onToggleInitiative={() => {}}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    // No clampable dates → no aggregated bar, just the empty note.
    expect(document.querySelector('.gantt-init-agg-bar')).toBeNull();
    const empty = document.querySelector('.gantt-init-collapsed-empty');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent('2 versions');
  });

  it('renders the today line when today falls inside the date range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'));

    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(document.querySelector('.gantt-today-overlay-line')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('does not render the today line when today is outside the date range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));

    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(document.querySelector('.gantt-today-overlay-line')).toBeNull();
    vi.useRealTimers();
  });

  it('renders the "Today" marker as a legend entry rather than an inline chip on the overlay line', () => {
    // The TODAY text chip used to sit on the overlay line itself; it's now
    // surfaced via the legend instead. This test guards both halves of that
    // move — the legend entry is present AND the inline chip is gone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'));

    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    const line = document.querySelector('.gantt-today-overlay-line');
    expect(line).toBeInTheDocument();
    expect(line?.querySelector('.gantt-today-chip-label')).toBeNull();
    expect(screen.getByText('Today').closest('.legend-item')).not.toBeNull();
    vi.useRealTimers();
  });

  it('positions the today line at the correct percentage within the range', () => {
    vi.useFakeTimers();
    // Feb 1 is exactly halfway through a Jan 1 – Mar 4 range (31 days in, 31 remaining)
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));

    render(
      <Gantt
        fixVersions={fixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-04"
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    const line = document.querySelector('.gantt-today-overlay-line') as HTMLElement;
    expect(line).toBeInTheDocument();
    const left = parseFloat(line.style.left);
    expect(left).toBeGreaterThan(40);
    expect(left).toBeLessThan(60);
    vi.useRealTimers();
  });

  it('marks swimlane items as at-risk or blocked based on schedule', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
    const swimlaneFixVersions: FixVersion[] = [
      {
        id: 'fix-risk',
        name: 'Risk Item',
        projectKey: 'GPO',
        start: '2026-02-01',
        release: '2026-03-01',
        progressDone: 20,
        progressTotal: 100,
        epics: []
      },
      {
        id: 'fix-blocked',
        name: 'Blocked Item',
        projectKey: 'GPO',
        start: '2026-01-01',
        release: '2026-02-01',
        progressDone: 100,
        progressTotal: 100,
        released: false,
        epics: []
      }
    ];

    render(
      <Gantt
        fixVersions={swimlaneFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        mode="swimlane"
        swimlanes={[
          { id: 'lane-1', name: 'BAU', fixVersionIds: ['fix-risk', 'fix-blocked'] }
        ]}
        activeFixVersionIds={['fix-risk', 'fix-blocked']}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(document.querySelector('.gantt-lane-bar.status-at-risk')).toBeInTheDocument();
    expect(document.querySelector('.gantt-lane-bar.status-overdue')).toBeInTheDocument();
    vi.useRealTimers();
  });

  // ─── Manual dependencies ─────────────────────────────────────────────────

  const twoFixVersions: FixVersion[] = [
    {
      id: 'fix-1',
      name: 'Release One',
      projectKey: 'GPO',
      start: '2026-01-10',
      release: '2026-01-25',
      progressDone: 0,
      progressTotal: 0,
      epics: []
    },
    {
      id: 'fix-2',
      name: 'Release Two',
      projectKey: 'GPO',
      start: '2026-02-05',
      release: '2026-02-20',
      progressDone: 0,
      progressTotal: 0,
      epics: []
    }
  ];

  it('does not render the drag handle when onCreateDependency is omitted', () => {
    render(
      <Gantt
        fixVersions={twoFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        showDependencies
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(document.querySelector('.gantt-dependency-handle')).toBeNull();
  });

  it('renders a drag handle on each fix/epic bar when onCreateDependency is provided', () => {
    render(
      <Gantt
        fixVersions={twoFixVersions}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        showDependencies
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
        onCreateDependency={() => {}}
      />
    );

    const handles = document.querySelectorAll('.gantt-dependency-handle');
    expect(handles.length).toBe(2);
    const bars = document.querySelectorAll('.gantt-bar.fix');
    bars.forEach((bar) => {
      expect(bar.getAttribute('data-dep-row-id')).toBeTruthy();
      expect(bar.getAttribute('data-dep-row-type')).toBe('fix');
    });
  });

  it('renders a manual dependency with the is-manual class and an arrow marker', () => {
    const dependencies: Dependency[] = [
      {
        fromId: 'fix-1',
        toId: 'fix-2',
        type: 'blocks',
        source: 'manual',
        id: '00000000-0000-0000-0000-000000000001'
      }
    ];

    render(
      <Gantt
        fixVersions={twoFixVersions}
        milestones={milestones}
        dependencies={dependencies}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        showDependencies
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
        onCreateDependency={() => {}}
        onRemoveDependency={() => {}}
      />
    );

    const manualPath = document.querySelector('.gantt-dependency-path.is-manual');
    expect(manualPath).toBeInTheDocument();
    expect(manualPath?.getAttribute('d')).toMatch(/^M [\d.-]+ [\d.-]+/);
    expect(manualPath?.getAttribute('marker-end')).toBe('url(#gantt-dep-arrow-manual)');
  });

  it('shows the remove dot on a manual dep when the hit area is hovered and calls onRemoveDependency on click', () => {
    const onRemove = vi.fn();
    const dependencies: Dependency[] = [
      {
        fromId: 'fix-1',
        toId: 'fix-2',
        type: 'blocks',
        source: 'manual',
        id: '00000000-0000-0000-0000-000000000001'
      }
    ];

    render(
      <Gantt
        fixVersions={twoFixVersions}
        milestones={milestones}
        dependencies={dependencies}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        showDependencies
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
        onCreateDependency={() => {}}
        onRemoveDependency={onRemove}
      />
    );

    const hit = document.querySelector('.gantt-dependency-hit') as SVGElement | null;
    expect(hit).toBeInTheDocument();

    // The remove group is the nearest ancestor <g> carrying the pointer handlers.
    const group = hit!.closest('.gantt-dependency-remove-group') as SVGGElement;
    expect(group).toBeTruthy();
    fireEvent.pointerEnter(group);

    const dot = document.querySelector('.gantt-dependency-remove-dot');
    expect(dot).toBeInTheDocument();

    // Clicking the remove <g> should invoke onRemoveDependency with the id.
    const removeGroup = document.querySelector('.gantt-dependency-remove') as SVGGElement;
    fireEvent.click(removeGroup);
    expect(onRemove).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
  });

  it('hides Jira-sourced dependencies when dependenciesManualOnly is enabled', () => {
    // Three fix versions so we can wire up two distinct dep pairs:
    //   fix-1 -> fix-2  (sourced from Jira)
    //   fix-2 -> fix-3  (manual override)
    const threeFixVersions: FixVersion[] = [
      {
        id: 'fix-1',
        name: 'Release One',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-01-25',
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-2',
        name: 'Release Two',
        projectKey: 'GPO',
        start: '2026-02-05',
        release: '2026-02-20',
        progressDone: 0,
        progressTotal: 0,
        epics: []
      },
      {
        id: 'fix-3',
        name: 'Release Three',
        projectKey: 'GPO',
        start: '2026-03-01',
        release: '2026-03-15',
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    const dependencies: Dependency[] = [
      {
        fromId: 'fix-1',
        toId: 'fix-2',
        type: 'blocks',
        source: 'jira',
        fromKey: 'GPO-100',
        toKey: 'GPO-101'
      },
      {
        fromId: 'fix-2',
        toId: 'fix-3',
        type: 'blocks',
        source: 'manual',
        id: '00000000-0000-0000-0000-0000000000aa'
      }
    ];

    // 1. Both dep paths render when the manual-only filter is OFF.
    const { rerender } = render(
      <Gantt
        fixVersions={threeFixVersions}
        milestones={milestones}
        dependencies={dependencies}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        showDependencies
        dependenciesManualOnly={false}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
        onCreateDependency={() => {}}
        onRemoveDependency={() => {}}
      />
    );

    let paths = document.querySelectorAll('.gantt-dependency-path');
    expect(paths.length).toBe(2);
    // One Jira (no .is-manual) + one manual (.is-manual)
    expect(document.querySelectorAll('.gantt-dependency-path.is-manual').length).toBe(1);

    // 2. Toggle the filter on — only the manual edge should remain.
    rerender(
      <Gantt
        fixVersions={threeFixVersions}
        milestones={milestones}
        dependencies={dependencies}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-31"
        showDependencies
        dependenciesManualOnly
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
        onCreateDependency={() => {}}
        onRemoveDependency={() => {}}
      />
    );

    paths = document.querySelectorAll('.gantt-dependency-path');
    expect(paths.length).toBe(1);
    expect(paths[0].classList.contains('is-manual')).toBe(true);
    expect(paths[0].getAttribute('marker-end')).toBe('url(#gantt-dep-arrow-manual)');
  });

  it('swimlane milestone view renders diamonds and suppresses bars + UAT/Live markers', () => {
    // A fix with both UAT and Live windows so we can assert that both
    // markers render in bar mode and disappear in milestone mode (the
    // milestone row is too short to host them — see Gantt.tsx milestone
    // marker guards).
    const fixWithUatLive: FixVersion[] = [
      {
        id: 'fix-1',
        name: 'Release One',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-02-01',
        uatStart: '2026-02-02',
        uatEnd: '2026-02-05',
        liveStart: '2026-02-10',
        liveEnd: '2026-02-12',
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    // Bar mode (default): expect a lane bar and both UAT/Live markers.
    const { rerender } = render(
      <Gantt
        fixVersions={fixWithUatLive}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        mode="swimlane"
        swimlanes={[{ id: 'lane-1', name: 'BAU', fixVersionIds: ['fix-1'] }]}
        activeFixVersionIds={['fix-1']}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(document.querySelector('.gantt-lane-bar')).toBeInTheDocument();
    expect(document.querySelector('.gantt-marker-point.uat')).toBeInTheDocument();
    expect(document.querySelector('.gantt-marker-point.live')).toBeInTheDocument();
    expect(document.querySelector('.gantt-lane-milestone')).toBeNull();

    // Milestone mode: bar disappears, diamond appears, UAT/Live suppressed.
    rerender(
      <Gantt
        fixVersions={fixWithUatLive}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        mode="swimlane"
        swimlaneMilestoneView
        swimlanes={[{ id: 'lane-1', name: 'BAU', fixVersionIds: ['fix-1'] }]}
        activeFixVersionIds={['fix-1']}
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
      />
    );

    expect(document.querySelector('.gantt-lane-milestone')).toBeInTheDocument();
    expect(document.querySelector('.gantt-lane-bar')).toBeNull();
    expect(document.querySelector('.gantt-marker-point.uat')).toBeNull();
    expect(document.querySelector('.gantt-marker-point.live')).toBeNull();
  });

  it('does not render a drag handle on story rows', () => {
    const fixWithStories: FixVersion[] = [
      {
        id: 'fix-1',
        name: 'Release One',
        projectKey: 'GPO',
        start: '2026-01-10',
        release: '2026-02-01',
        progressDone: 0,
        progressTotal: 0,
        epics: [
          {
            id: 'epic-1',
            key: 'GPO-1',
            summary: 'Epic One',
            start: '2026-01-12',
            end: '2026-01-25',
            stories: [
              {
                id: 'story-1',
                key: 'GPO-10',
                summary: 'Story One',
                start: '2026-01-13',
                end: '2026-01-18'
              }
            ]
          }
        ]
      }
    ];

    render(
      <Gantt
        fixVersions={fixWithStories}
        milestones={milestones}
        incrementStart="2026-01-01"
        incrementEnd="2026-03-01"
        showDependencies
        collapsedFixVersions={new Set()}
        collapsedEpics={new Set()}
        onToggleFixVersion={() => {}}
        onToggleEpic={() => {}}
        onCreateDependency={() => {}}
      />
    );

    // Fix + Epic bars should have handles; story bar should not.
    const fixBar = document.querySelector('.gantt-bar.fix');
    const epicBar = document.querySelector('.gantt-bar.epic');
    const storyBar = document.querySelector('.gantt-bar.story');
    expect(fixBar?.querySelector('.gantt-dependency-handle')).toBeInTheDocument();
    expect(epicBar?.querySelector('.gantt-dependency-handle')).toBeInTheDocument();
    expect(storyBar?.querySelector('.gantt-dependency-handle')).toBeNull();
  });

  // --- Milestone overlay ---------------------------------------------------
  // The milestone chip, arrow and dotted line render via a single overlay
  // inside .gantt-chart-area (mirroring .gantt-today-overlay) so the line
  // runs continuously through the 12px gap between header and body without
  // breaking. These tests guard that structure.
  describe('milestones overlay', () => {
    const singleMilestone: Milestone[] = [
      {
        id: 'ms-1',
        label: 'Go-live',
        date: '2026-02-01',
        color: '#ff5d2f'
      }
    ];

    it('renders a milestone overlay with the day-number circle, arrow and dotted line when the milestone is in range', () => {
      render(
        <Gantt
          fixVersions={fixVersions}
          milestones={singleMilestone}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-01"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
        />
      );

      const overlay = document.querySelector('.gantt-milestones-overlay');
      expect(overlay).toBeInTheDocument();

      const item = overlay?.querySelector('.gantt-milestone-overlay[data-milestone-id="ms-1"]');
      expect(item).toBeInTheDocument();
      expect(item?.querySelector('.gantt-milestone-overlay-date')).toBeInTheDocument();
      expect(item?.querySelector('.gantt-milestone-overlay-arrow')).toBeInTheDocument();
      expect(item?.querySelector('.gantt-milestone-overlay-line')).toBeInTheDocument();
    });

    it('positions the milestone overlay at the correct percentage within the range', () => {
      // Feb 1 is exactly halfway through a Jan 1 – Mar 4 range.
      render(
        <Gantt
          fixVersions={fixVersions}
          milestones={singleMilestone}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-04"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
        />
      );

      const item = document.querySelector('.gantt-milestone-overlay[data-milestone-id="ms-1"]') as HTMLElement;
      expect(item).toBeInTheDocument();
      const left = parseFloat(item.style.left);
      expect(left).toBeGreaterThan(40);
      expect(left).toBeLessThan(60);
    });

    it('does not render a milestone overlay when the milestone is outside the date range', () => {
      const outOfRange: Milestone[] = [
        { id: 'ms-out', label: 'Before', date: '2025-12-01', color: '#ff5d2f' }
      ];

      render(
        <Gantt
          fixVersions={fixVersions}
          milestones={outOfRange}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-01"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
        />
      );

      expect(document.querySelector('.gantt-milestone-overlay')).toBeNull();
    });

    it('renders milestones through the chart-area overlay and not via the legacy header/body line architecture', () => {
      // Regression guard: the old rendering used .gantt-milestone-track in
      // the header and .gantt-body-lines / .gantt-body-line in the body,
      // which caused a visible gap at the header↔body seam. If any of these
      // classes come back we want the test suite to shout.
      render(
        <Gantt
          fixVersions={fixVersions}
          milestones={singleMilestone}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-01"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
        />
      );

      expect(document.querySelector('.gantt-milestone-track')).toBeNull();
      expect(document.querySelector('.gantt-body-lines')).toBeNull();
      expect(document.querySelector('.gantt-body-line')).toBeNull();
      expect(document.querySelector('.gantt-milestone-label')).toBeNull();
    });
  });

  // --- Legend --------------------------------------------------------------
  describe('legend markers', () => {
    it('renders the Today legend entry using the arrow indicator class (not a circle)', () => {
      render(
        <Gantt
          fixVersions={fixVersions}
          milestones={milestones}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-01"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
        />
      );

      // The Today entry pairs the .legend-today glyph with the text "Today".
      const todayEntry = screen.getByText('Today').closest('.legend-item');
      expect(todayEntry).not.toBeNull();
      expect(todayEntry?.querySelector('.legend-today')).toBeInTheDocument();
    });

    it('renders the dependency legend indicator without the word "Dependency" (the section title already labels it)', () => {
      render(
        <Gantt
          fixVersions={fixVersions}
          milestones={milestones}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-01"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
          showDependencies
          onCreateDependency={() => {}}
        />
      );

      const depIndicator = document.querySelector('.legend-line.dependency-warning');
      expect(depIndicator).toBeInTheDocument();

      // Its parent .legend-item should contain no visible text — only the
      // indicator icon. This guards against re-adding the " Dependency"
      // string that used to sit next to the red line.
      const item = depIndicator?.closest('.legend-item');
      expect(item?.textContent?.trim()).toBe('');
    });
  });

  // --- UAT / Live markers --------------------------------------------------
  describe('lane markers', () => {
    const fixWithUatAndLive: FixVersion[] = [
      {
        id: 'fix-uat',
        name: 'Release With UAT',
        projectKey: 'GPO',
        url: null,
        start: '2026-01-10',
        release: '2026-02-20',
        uatStart: '2026-02-05',
        uatEnd: '2026-02-12',
        liveStart: '2026-02-18',
        liveEnd: '2026-02-22',
        notes: null,
        progressDone: 0,
        progressTotal: 0,
        epics: []
      }
    ];

    it('renders UAT and Live markers as diamonds on the version row', () => {
      // In the default (non-swimlane) mode, UAT/Live windows render as
      // diamond markers: .gantt-marker-point.uat / .gantt-marker-point.live
      // wrappers containing a .gantt-marker-point-diamond child.
      render(
        <Gantt
          fixVersions={fixWithUatAndLive}
          milestones={milestones}
          incrementStart="2026-01-01"
          incrementEnd="2026-03-01"
          collapsedFixVersions={new Set()}
          collapsedEpics={new Set()}
          onToggleFixVersion={() => {}}
          onToggleEpic={() => {}}
        />
      );

      expect(
        document.querySelector('.gantt-marker-point.uat .gantt-marker-point-diamond')
      ).toBeInTheDocument();
      expect(
        document.querySelector('.gantt-marker-point.live .gantt-marker-point-diamond')
      ).toBeInTheDocument();
    });
  });

});
