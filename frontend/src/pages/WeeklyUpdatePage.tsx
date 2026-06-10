import React from 'react';
import { Link, useParams } from 'react-router-dom';
import './WeeklyUpdatePage.css';
import {
  ACTIVE_SECTIONS,
  LinkIcon,
  RELEASED,
  SectionMeta,
  SubSection,
  TicketCount,
  useOpenSections,
} from './weeklyUpdateData';

interface WeeklyUpdatePageProps {
  authenticated?: boolean;
}

const WeeklyUpdatePage: React.FC<WeeklyUpdatePageProps> = ({ authenticated = false }) => {
  const { slug } = useParams<{ slug: string }>();
  const { openSections, toggle } = useOpenSections();

  return (
    <div className="wu-page">
      <div className="wu-back-bar">
        <Link to={`/dashboards/${slug}`} className="wu-back-link">
          ← Back to dashboard
        </Link>
      </div>

      <div className="wu-shell">
        {/* ── Header bar ── */}
        <div className="wu-panel-header">
          <span className="wu-panel-title">Fortnightly update</span>
          <div className="wu-panel-actions">
            {authenticated && (
              <>
                <button className="wu-btn-generate" disabled>✦ Generate</button>
                <button className="wu-btn-save" disabled>Save</button>
              </>
            )}
          </div>
        </div>

        <div className="wu-label-bar">
          ⬇ Generated content — last 2 weeks (1 Apr – 15 Apr 2026) · GPO project · active fix versions only
        </div>

        <div className="wu-panel-body">
          <div className="wu-meta-row">
            <span className="wu-meta-title">gPO Fortnightly Update</span>
            <span className="wu-meta-date">Week ending 15 April 2026</span>
          </div>
          <div className="wu-edit-hint">✦ Generated — click summaries to edit before saving</div>

          {/* ── Released this fortnight ── */}
          <div className="wu-released-section">
            <div className="wu-released-label">
              <div className="wu-released-dot" />
              Released this fortnight
            </div>
            <div className="wu-section-header">
              <a
                className="wu-section-name wu-section-name--released"
                href={RELEASED.href}
                target="_blank"
                rel="noreferrer"
              >
                {RELEASED.name}
                <LinkIcon />
              </a>
              <span className="wu-badge wu-badge--released">Released</span>
              <TicketCount todo={0} total={2} />
              <div className="wu-divider-line" />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#4ade80', whiteSpace: 'nowrap' }}>
                Released {RELEASED.releasedDate}
              </span>
            </div>
            <p
              className="wu-section-summary"
              contentEditable
              suppressContentEditableWarning
              dangerouslySetInnerHTML={{ __html: RELEASED.summary }}
            />
            {RELEASED.subSections.map((ss) => (
              <SubSection
                key={ss.id}
                data={ss}
                open={openSections.has(ss.id)}
                onToggle={() => toggle(ss.id)}
              />
            ))}
          </div>

          {/* ── Active fix versions (2-col grid) ── */}
          <div className="wu-columns">
            {ACTIVE_SECTIONS.map((section) => (
              <div key={section.id} className="wu-section">
                <div className="wu-section-header">
                  <a
                    className="wu-section-name"
                    href={section.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {section.name}
                    <LinkIcon />
                  </a>
                  <span className="wu-badge wu-badge--increment">{section.increment}</span>
                  <span className={`wu-badge ${section.statusClass}`}>{section.statusLabel}</span>
                  <TicketCount todo={section.ticketTodo} total={section.ticketTotal} />
                </div>
                <SectionMeta
                  uatStart={section.uatStart}
                  targetEnd={section.targetEnd}
                  targetEndUrgent={section.targetEndUrgent}
                  versionNote={section.versionNote}
                />
                <p
                  className="wu-section-summary"
                  contentEditable
                  suppressContentEditableWarning
                  dangerouslySetInnerHTML={{ __html: section.summary }}
                />
                {section.subSections.map((ss) => (
                  <SubSection
                    key={ss.id}
                    data={ss}
                    open={openSections.has(ss.id)}
                    onToggle={() => toggle(ss.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WeeklyUpdatePage;
