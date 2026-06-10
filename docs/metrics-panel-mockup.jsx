import { useState } from "react";

const mockData = {
  count: 14,
  breakdown: [
    {
      status: "Awaiting Approval",
      color: "#F59E0B",
      issues: [
        { key: "GFIX-641", summary: "Add thumbnail of creative against worklist item", project: "gFix" },
        { key: "GPO-6749", summary: "Update SF opportunity revenue when sweep orderline is created", project: "gPlan Outdoor" },
        { key: "ODA-1117", summary: "Integrate 3 major endpoints for create order and radio orderline", project: "Open Direct API" },
      ],
    },
    {
      status: "Ready for Release",
      color: "#3B82F6",
      issues: [
        { key: "GLOB-2341", summary: "Player auth refresh token handling", project: "Global Player" },
        { key: "GLOB-2356", summary: "Podcast feed pagination fix", project: "Global Player" },
        { key: "A2-1481", summary: "Rev share calculation fixes", project: "Lembas Data Squad" },
        { key: "RADIO-889", summary: "Schedule export performance improvement", project: "Radio" },
      ],
    },
    {
      status: "Done",
      color: "#10B981",
      issues: [
        { key: "GFIX-475", summary: "Background sync for failed requests", project: "gFix" },
        { key: "GLOB-2298", summary: "Dark mode persistence across sessions", project: "Global Player" },
        { key: "ODA-986", summary: "Replace manual error handling with Kafka native retry & DLQ", project: "Open Direct API" },
        { key: "A2-1455", summary: "Fix daily aggregation pipeline timezone offset", project: "Lembas Data Squad" },
        { key: "RADIO-901", summary: "Station metadata cache invalidation", project: "Radio" },
        { key: "GPO-6701", summary: "Orderline status sync with external booking system", project: "gPlan Outdoor" },
        { key: "GLOB-2317", summary: "Improve error messaging for expired sessions", project: "Global Player" },
      ],
    },
  ],
};

function StatusBadge({ status, color }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
      padding: "2px 8px", borderRadius: 999,
      backgroundColor: color + "22", color: color,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color, display: "inline-block" }} />
      {status}
    </span>
  );
}

export default function MetricsPanelMockup() {
  const [notes, setNotes] = useState("");
  const [expanded, setExpanded] = useState({ "Awaiting Approval": true, "Ready for Release": true, "Done": false });

  const toggle = (status) => setExpanded(e => ({ ...e, [status]: !e[status] }));

  return (
    <div style={{
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      background: "#0f1117", minHeight: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 32,
    }}>
      <div style={{ width: "100%", maxWidth: 680 }}>

        {/* Header */}
        <div style={{ marginBottom: 16, color: "#9CA3AF", fontSize: 12 }}>
          Dashboard → Weekly Update → Metrics panel
        </div>

        {/* Panel */}
        <div style={{
          background: "#1a1d27", border: "1px solid #2d3148",
          borderRadius: 12, overflow: "hidden",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}>

          {/* Panel header */}
          <div style={{
            padding: "14px 20px", borderBottom: "1px solid #2d3148",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span style={{ color: "#E5E7EB", fontWeight: 600, fontSize: 14 }}>Metrics</span>
            <span style={{ color: "#6B7280", fontSize: 11 }}>Auto-updated · past 2 weeks</span>
          </div>

          <div style={{ padding: 20 }}>

            {/* Big count */}
            <div style={{
              display: "flex", alignItems: "center", gap: 16,
              padding: "16px 20px", marginBottom: 20,
              background: "#10B98115", border: "1px solid #10B98130", borderRadius: 10,
            }}>
              <div style={{ fontSize: 42, fontWeight: 700, color: "#10B981", lineHeight: 1 }}>
                {mockData.count}
              </div>
              <div>
                <div style={{ color: "#E5E7EB", fontWeight: 600, fontSize: 15 }}>
                  tickets completed
                </div>
                <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>
                  moved to dev done or beyond in the last 14 days
                </div>
              </div>
            </div>

            {/* Breakdown by status */}
            {mockData.breakdown.map(({ status, color, issues }) => (
              <div key={status} style={{ marginBottom: 8 }}>
                <button
                  onClick={() => toggle(status)}
                  style={{
                    width: "100%", background: "none", border: "none",
                    padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    backgroundColor: expanded[status] ? "#ffffff08" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <StatusBadge status={status} color={color} />
                    <span style={{ color: "#9CA3AF", fontSize: 12 }}>{issues.length} tickets</span>
                  </div>
                  <span style={{ color: "#6B7280", fontSize: 12 }}>
                    {expanded[status] ? "▲" : "▼"}
                  </span>
                </button>

                {expanded[status] && (
                  <div style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 8 }}>
                    {issues.map(issue => (
                      <div key={issue.key} style={{
                        display: "flex", alignItems: "flex-start", gap: 10,
                        padding: "7px 0", borderBottom: "1px solid #2d314820",
                      }}>
                        <span style={{
                          color: color, fontSize: 11, fontWeight: 600,
                          fontFamily: "monospace", whiteSpace: "nowrap", marginTop: 1,
                        }}>
                          {issue.key}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ color: "#D1D5DB", fontSize: 13 }}>{issue.summary}</div>
                          <div style={{ color: "#6B7280", fontSize: 11, marginTop: 2 }}>{issue.project}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Optional notes */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #2d3148" }}>
              <div style={{ color: "#6B7280", fontSize: 11, marginBottom: 6 }}>Notes (optional)</div>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add any commentary on this week's output..."
                style={{
                  width: "100%", minHeight: 72, background: "#0f1117",
                  border: "1px solid #2d3148", borderRadius: 8,
                  color: "#D1D5DB", fontSize: 13, padding: "10px 12px",
                  resize: "vertical", boxSizing: "border-box", outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, color: "#4B5563", fontSize: 11, textAlign: "center" }}>
          Click status rows to expand/collapse · "Done" collapsed by default
        </div>
      </div>
    </div>
  );
}
