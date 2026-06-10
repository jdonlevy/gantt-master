import { useEffect, useState } from 'react';
import { fetchMetrics } from '../api';
import { MetricsIssue, MetricsResponse } from '../types';

const STATUS_ORDER = ['Awaiting Approval', 'Done - Released', 'Done - Unreleased', 'Done'];

const STATUS_COLOURS: Record<string, string> = {
  'Awaiting Approval': '#F59E0B',
  'Done - Released': '#3B82F6',
  'Done - Unreleased': '#8B5CF6',
  'Done': '#10B981',
};

// Accessible labels for the coloured status dots — WCAG 1.4.1 (use of colour).
// Screen readers read these via aria-label on the dot; the visible coloured
// circle alone is not enough information for non-sighted users.
const STATUS_DOT_LABELS: Record<string, string> = {
  'Awaiting Approval': 'Amber',
  'Done - Released': 'Blue',
  'Done - Unreleased': 'Purple',
  'Done': 'Green',
};

function groupByStatus(issues: MetricsIssue[]): { status: string; issues: MetricsIssue[] }[] {
  const map: Record<string, MetricsIssue[]> = {};
  for (const issue of issues) {
    if (!map[issue.status]) map[issue.status] = [];
    map[issue.status].push(issue);
  }
  const ordered = STATUS_ORDER.filter((s) => map[s]);
  const rest = Object.keys(map).filter((s) => !STATUS_ORDER.includes(s));
  return [...ordered, ...rest].map((status) => ({ status, issues: map[status] }));
}

interface MetricsPanelProps {
  projects: string[];
  panelId: string;
  dashboardSlug: string;
  activeFixVersionIds?: string[];
  initialNotes?: string | null;
  onSaveNotes: (notes: string) => void;
}

export default function MetricsPanel({
  projects,
  panelId: _panelId,
  dashboardSlug: _dashboardSlug,
  activeFixVersionIds,
  initialNotes,
  onSaveNotes,
}: MetricsPanelProps) {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ Done: true });
  const [notes, setNotes] = useState(initialNotes ?? '');

  useEffect(() => {
    if (!projects.length) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMetrics(projects, undefined, undefined, activeFixVersionIds)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Failed to load metrics from Jira.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projects.join(','), (activeFixVersionIds ?? []).join(',')]);

  // `prev[status]` is undefined until the user toggles a group for the first
  // time. Without the `?? true` fallback, `!undefined` is `true`, which matches
  // the default rendering — so the first click would appear to do nothing and
  // a second click would be required to actually expand the group.
  const toggleGroup = (status: string) =>
    setCollapsed((prev) => ({ ...prev, [status]: !(prev[status] ?? true) }));

  if (loading) {
    return (
      <div style={{ padding: 24, color: '#6B7280', fontSize: 13, textAlign: 'center' }}>
        Loading metrics from Jira…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: '#EF4444', fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!projects.length) {
    return (
      <div style={{ padding: 24, color: '#6B7280', fontSize: 13 }}>
        Select projects in the dashboard filters to see metrics.
      </div>
    );
  }

  // Use all issues returned by the backend — don't re-filter to STATUS_ORDER here.
  // The API already applies the "completed / near-done" filter; a hard-coded frontend
  // whitelist would silently drop any new statuses the backend starts returning,
  // causing the count summary to undercount real Jira results.
  const allIssues = data?.issues ?? [];
  const groups = groupByStatus(allIssues);

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Count summary */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 16px', borderRadius: 8,
        background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
      }}>
        <span style={{ fontSize: 36, fontWeight: 700, color: '#10B981', lineHeight: 1 }}>
          {allIssues.length}
        </span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>tickets completed</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
            moved to dev done or beyond in the last 14 days
          </div>
        </div>
      </div>

      {/* Grouped ticket list */}
      {allIssues.length === 0 ? (
        <div style={{ fontSize: 13, color: '#6B7280' }}>No tickets found for this period.</div>
      ) : (
        groups.map(({ status, issues }) => {
          const colour = STATUS_COLOURS[status] ?? '#9CA3AF';
          const isCollapsed = collapsed[status] ?? true;
          return (
            <div key={status} style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
              <button
                type="button"
                onClick={() => toggleGroup(status)}
                style={{
                  width: '100%', background: 'rgba(255,255,255,0.04)',
                  border: 'none', cursor: 'pointer',
                  padding: '8px 12px', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    role="img"
                    aria-label={STATUS_DOT_LABELS[status] ?? 'Status'}
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: colour, display: 'inline-block', flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 600, fontSize: 12, color: colour }}>{status}</span>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>{issues.length}</span>
                </span>
                <span style={{ color: '#6B7280', fontSize: 11 }}>{isCollapsed ? '◀' : '▼'}</span>
              </button>

              {!isCollapsed && (
                <div style={{ padding: '4px 12px 8px' }}>
                  {issues.map((issue) => (
                    <div
                      key={issue.key}
                      style={{
                        display: 'flex', gap: 10, padding: '6px 0',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        alignItems: 'flex-start',
                      }}
                    >
                      <a
                        href={issue.url ?? '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: colour, fontSize: 11, fontWeight: 600,
                          fontFamily: 'monospace', whiteSpace: 'nowrap',
                          textDecoration: 'none', marginTop: 1,
                        }}
                      >
                        {issue.key}
                      </a>
                      <div>
                        <div style={{ fontSize: 13 }}>{issue.summary}</div>
                        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 1 }}>{issue.project}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Optional notes */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
        <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Notes (optional)</div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => onSaveNotes(notes)}
          placeholder="Add any commentary on this week's output…"
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, color: 'inherit', fontSize: 13,
            padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      </div>
    </div>
  );
}
