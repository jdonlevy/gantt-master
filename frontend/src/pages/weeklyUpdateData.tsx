/**
 * weeklyUpdateData.tsx
 * Shared types, static data, and small sub-components used by both
 * WeeklyUpdatePage (standalone route) and WeeklyUpdatePanel (dashboard inline).
 *
 * NOTE: Static data is a POC placeholder — will be replaced by a live
 * POST /api/dashboards/{slug}/generate-update call in the next iteration.
 */
import React, { useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Item {
  text: string;
  badge?: string;
  badgeClass?: string;
}

export interface SubSectionData {
  id: string;
  label: string;
  items: Item[];
}

export interface SectionData {
  id: string;
  name: string;
  href: string;
  increment: string;
  statusLabel: string;
  statusClass: string;
  ticketTodo: number;
  ticketTotal: number;
  uatStart?: string;
  targetEnd?: string;
  targetEndUrgent?: boolean;
  versionNote?: string;
  summary: string;
  subSections: SubSectionData[];
}

export interface ReleasedData {
  name: string;
  href: string;
  releasedDate: string;
  summary: string;
  subSections: SubSectionData[];
}

// ── Shared tiny components ─────────────────────────────────────────────────────

export const LinkIcon: React.FC = () => (
  <svg
    className="wu-link-icon"
    viewBox="0 0 12 12"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M3.5 3H2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.5M7 1h4m0 0v4m0-4L5 7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const TicketCount: React.FC<{ todo: number; total: number }> = ({ todo, total }) => {
  return (
    <div className="wu-ticket-count wu-ticket-count--blue">
      <span className="wu-ticket-todo">
        {todo} {todo === 1 ? 'ticket' : 'tickets'} in to do
      </span>
      <span className="wu-ticket-sep">|</span>
      <span className="wu-ticket-total">{total} total</span>
    </div>
  );
};

// Collapsible sub-section — item text is rendered as a plain text node so that
// any HTML characters in ticket names are automatically entity-escaped by React.
// The badge is a separate, non-editable sibling element.
export const SubSection: React.FC<{
  data: SubSectionData;
  open: boolean;
  onToggle: () => void;
}> = ({ data, open, onToggle }) => (
  <div className={`wu-sub-section${open ? ' wu-sub-section--open' : ''}`} data-subsection-id={data.id}>
    <button
      className="wu-sub-section-label"
      onClick={onToggle}
      type="button"
      aria-expanded={open}
    >
      {data.label}
    </button>
    <div className="wu-items">
      {data.items.map((item, i) => {
        const isRollup = /^\s*\+\s*\d+\s+more\b/i.test(item.text);
        return (
          <div key={i} className="wu-item">
            <span className="wu-item-text">
              {item.text}
            </span>
            {!isRollup && item.badge && item.badgeClass && (
              <span className={`wu-ibadge ${item.badgeClass}`}>{item.badge}</span>
            )}
          </div>
        );
      })}
    </div>
  </div>
);

// Hook: manages which sub-sections are open.
export const useOpenSections = () => {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return { openSections, toggle };
};

// ── Larger shared render helpers ───────────────────────────────────────────────

export const SectionMeta: React.FC<{
  uatStart?: string;
  targetEnd?: string;
  targetEndUrgent?: boolean;
  versionNote?: string;
}> = ({ uatStart, targetEnd, targetEndUrgent, versionNote }) => {
  if (!uatStart && !targetEnd && !versionNote) return null;
  return (
    <div className="wu-section-meta">
      <div className="wu-section-dates">
        {uatStart && (
          <div className="wu-date-item">
            <div className="wu-date-dot wu-dot-uat" />
            <span className="wu-date-label">UAT Start</span>
            <span className="wu-date-value">{uatStart}</span>
          </div>
        )}
        {targetEnd && (
          <div className="wu-date-item">
            <div className="wu-date-dot wu-dot-target" />
            <span className="wu-date-label">Target End</span>
            <span className={`wu-date-value${targetEndUrgent ? ' wu-date-value--urgent' : ''}`}>
              {targetEnd}
            </span>
          </div>
        )}
      </div>
      {versionNote && (
        <div className="wu-version-note">
          <strong>Jira note —</strong> {versionNote}
        </div>
      )}
    </div>
  );
};

// ── Static data ────────────────────────────────────────────────────────────────

export const RELEASED: ReleasedData = {
  name: 'IP11 · Site list · Spain',
  href: 'https://globalradio.atlassian.net/projects/GPO/versions/20103',
  releasedDate: '8 Apr 2026',
  summary:
    'Site List for Spain shipped on 8 April — both stories are now live. The release enables the site list product type for Spanish markets within gPO, completing this deliverable ahead of schedule.',
  subSections: [
    {
      id: 'rel-delivered',
      label: 'Delivered',
      items: [
        { text: 'Site list — gPO', badge: 'Done · Released', badgeClass: 'wu-ibadge--released' },
        { text: 'Enable Site List Spain — gPO', badge: 'Done · Released', badgeClass: 'wu-ibadge--released' },
      ],
    },
  ],
};

export const ACTIVE_SECTIONS: SectionData[] = [
  {
    id: 'sweep-immediate',
    name: 'Sweep — Immediate Post Release',
    href: 'https://globalradio.atlassian.net/projects/GPO/versions/21358',
    increment: 'IP11',
    statusLabel: 'Releasing today',
    statusClass: 'wu-badge--today',
    ticketTodo: 0,
    ticketTotal: 13,
    uatStart: '7 Apr 2026',
    targetEnd: '15 Apr 2026',
    targetEndUrgent: true,
    summary:
      'Release day for this batch — all 13 stories are in active test, review, or pending approval with nothing left in to-do. Four stories (pricing, approval fixes, revenue discrepancy, pack value differences) are in QA. DWH Kafka publishing and the booked OL sync bug are still in active dev which could push past today. Two items remain with stakeholders for approval.',
    subSections: [
      {
        id: 'si-qa',
        label: 'In QA (4)',
        items: [
          { text: 'Digital sweep: pricing approval', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Digital sweep: pricing approval fixes', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Discrepancy in revenue and value', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Pack value difference before/after SWEEP creation', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
        ],
      },
      {
        id: 'si-devdone',
        label: 'Dev done / code review (3)',
        items: [
          { text: 'Plan summary card on OL Overview tab', badge: 'Dev Done', badgeClass: 'wu-ibadge--devdone' },
          { text: 'Plan summary card on BYO Sweep screen', badge: 'Dev Done', badgeClass: 'wu-ibadge--devdone' },
          { text: 'Avail popup — individual records per day part for sweep', badge: 'Code Review', badgeClass: 'wu-ibadge--review' },
        ],
      },
      {
        id: 'si-inprogress',
        label: 'In progress / awaiting (4)',
        items: [
          { text: 'Booked OL showing as out of sync when sweep on order', badge: 'In Progress', badgeClass: 'wu-ibadge--prog' },
          { text: 'DWH sweep order line events — Kafka publishing', badge: 'In Progress', badgeClass: 'wu-ibadge--prog' },
          { text: 'SF opportunity revenue on sweep OL create/update', badge: 'Awaiting Approval', badgeClass: 'wu-ibadge--await' },
          { text: 'Media outstanding amount not £0.00 in booked sweep', badge: 'Awaiting Approval', badgeClass: 'wu-ibadge--await' },
        ],
      },
      {
        id: 'si-closed',
        label: 'Closed (2)',
        items: [
          { text: 'Draft sweep OLs not optioning', badge: 'Closed', badgeClass: 'wu-ibadge--closed' },
          { text: 'DWH sweep order line events Kafka (order)', badge: 'Closed', badgeClass: 'wu-ibadge--closed' },
        ],
      },
    ],
  },
  {
    id: 'prod-only-2',
    name: 'Production Only Phase 2',
    href: 'https://globalradio.atlassian.net/projects/GPO/versions/13562',
    increment: 'IP11',
    statusLabel: 'In Progress',
    statusClass: 'wu-badge--in-progress',
    ticketTodo: 9,
    ticketTotal: 22,
    targetEnd: '20 Apr 2026',
    summary:
      'Good progress in QA — 6 stories covering Kafka event publishing, POOL production jobs, and fulfilment flows are all under test. The data fetching story is the only one still in active dev. 3 stories are blocked on subtype config and design quantity work, and 9 remain in backlog or ready for dev which is a risk given the 20 April target. 3 stories are already done.',
    subSections: [
      {
        id: 'po-qa',
        label: 'In QA (6)',
        items: [
          { text: 'Publish Kafka event to Data Platform for prod-only OLs', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Return POOL production jobs from Fulfilment v2 endpoint', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Create Production jobs in order service for prod-only OL', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: "CAS POOLs — pass 'has_automated_print' flag", badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Emit event to fulfilment Kafka when prod-only line changes', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Surface list of assets not supporting production in OL', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
        ],
      },
      {
        id: 'po-inprogress',
        label: 'In progress (1)',
        items: [
          { text: 'Production Only Report — Data fetching', badge: 'In Progress', badgeClass: 'wu-ibadge--prog' },
        ],
      },
      {
        id: 'po-blocked',
        label: 'Blocked (3)',
        items: [
          { text: 'Configure subtype and design quantity in v2 endpoint', badge: 'Blocked', badgeClass: 'wu-ibadge--blocked' },
          { text: 'Add new field in POOL for reason for production-only order', badge: 'Blocked', badgeClass: 'wu-ibadge--blocked' },
          { text: 'Add design quantity to POOL', badge: 'Blocked', badgeClass: 'wu-ibadge--blocked' },
        ],
      },
      {
        id: 'po-rest',
        label: 'Not yet started (9) · Done (3)',
        items: [
          { text: 'Report tests, Excel export, schema driven model, COD POOLs, invalid OL status bug + 4 more' },
          { text: 'Fusion barter campaign creation, POOL panel spares, gPlan fulfilment endpoint', badge: 'Done', badgeClass: 'wu-ibadge--closed' },
        ],
      },
    ],
  },
  {
    id: 'digital-fillers',
    name: 'Digital Fillers — BE & Fulfilment',
    href: 'https://globalradio.atlassian.net/projects/GPO/versions/13873',
    increment: 'IP10',
    statusLabel: 'In Progress',
    statusClass: 'wu-badge--in-progress',
    ticketTodo: 3,
    ticketTotal: 26,
    targetEnd: '29 Apr 2026',
    versionNote: 'MVP backend e2e and gpo to fulfilment',
    summary:
      'The backend and fulfilment layer for Digital Fillers is heavily in QA this week — 18 of 26 stories are under test, covering everything from MariaDB tables and order creation through to lifecycle transitions and fulfilment event publishing. The GraphQL query support story is still in active dev, and 1 story is dev done awaiting sign-off. 3 stories (search model migration and 2 backlog items) are yet to start. Target is 29 April.',
    subSections: [
      {
        id: 'df-qa',
        label: 'In QA (18)',
        items: [
          { text: 'Support editing while booked', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Fillers to use zero Share of Time', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Implement transitions from BOOKED to CANCELLED', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Allow assets to be added/removed from existing filler line', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Publish Digital Filler OL events to Fulfilment', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Implement initial transition from DRAFT to BOOKED', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Implement creation of a DRAFT Digital Filler Order Line', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: 'Create underlying Digital Filler MariaDB tables', badge: 'QA In Progress', badgeClass: 'wu-ibadge--uat' },
          { text: '+ 10 more stories in QA' },
        ],
      },
      {
        id: 'df-inprogress',
        label: 'In progress / dev done (2)',
        items: [
          { text: 'Support Digital Filler OLs in getOrderLineDetails GraphQL', badge: 'In Progress', badgeClass: 'wu-ibadge--prog' },
          { text: 'Publish UI filters for DIGITAL_FILLER product type', badge: 'Dev Done', badgeClass: 'wu-ibadge--devdone' },
        ],
      },
      {
        id: 'df-notstarted',
        label: 'Not yet started (3)',
        items: [
          { text: 'Changes in search to move fillers into new search model', badge: 'Ready for Dev', badgeClass: 'wu-ibadge--await' },
          { text: 'Populate subsystems table in Order Management', badge: 'Backlog', badgeClass: 'wu-ibadge--backlog' },
          { text: 'Retrieve Digital Filler status from Salesforce Opportunity', badge: 'Backlog', badgeClass: 'wu-ibadge--backlog' },
        ],
      },
    ],
  },
  {
    id: 'post-digital-spain',
    name: 'Post Digital MVP · Spain',
    href: 'https://globalradio.atlassian.net/projects/GPO/versions/18970',
    increment: 'IP11',
    statusLabel: 'In Progress',
    statusClass: 'wu-badge--in-progress',
    ticketTodo: 0,
    ticketTotal: 21,
    uatStart: '22 Apr 2026',
    targetEnd: '31 May 2026',
    summary:
      "Good shape overall — 14 of 21 stories are done, with nothing in backlog. 7 remain active across filter/accent fixes, day-part ordering, and reporting updates. With a May 31 target there's comfortable runway, but the team should aim to move all active items into QA before UAT starts on 22 April.",
    subSections: [
      {
        id: 'sp-inprogress',
        label: 'In progress / review (7)',
        items: [
          { text: 'Remove accents from Stations/Provinces filter', badge: 'In Progress', badgeClass: 'wu-ibadge--prog' },
          { text: 'Arrange day parts in alphabetical order', badge: 'Code Review', badgeClass: 'wu-ibadge--review' },
          { text: 'ID Pedido updated in option expiry report', badge: 'Dev Done', badgeClass: 'wu-ibadge--devdone' },
          { text: '+ 4 more stories active across reports and filter improvements' },
        ],
      },
      {
        id: 'sp-completed',
        label: 'Completed (14 of 21)',
        items: [
          { text: 'Sellable Asset Status close date logic', badge: 'Done ✓', badgeClass: 'wu-ibadge--done' },
          { text: 'Hide TOC / dead assets in edit order line dialog', badge: 'Done ✓', badgeClass: 'wu-ibadge--done' },
          { text: '+ 12 more stories completed' },
        ],
      },
    ],
  },
];
