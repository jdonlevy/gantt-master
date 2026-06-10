/**
 * PresentationView
 * Full-screen slide view for the fortnightly update. Renders a title slide
 * followed by one slide per deck entry, in the order given by `slides`. The
 * deck is heterogeneous: each entry is either a weekly-update *section* or a
 * dashboard *rich-text panel*. The Overview pane lets the user drag slides to
 * resequence them; the new id order is handed back via `onReorder` for the
 * dashboard to persist.
 *
 * Rendered through a portal onto document.body so the fixed overlay escapes
 * the dashboard grid's overflow/transform stacking context.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WeeklyUpdateSection } from '../types';
import './PresentationView.css';

/** A single deck entry. Section slides come from the weekly-update panel;
 *  rich-text slides come from each rich-text panel on the dashboard. */
export type PresentationSlide =
  | { kind: 'section'; id: string; section: WeeklyUpdateSection; released: boolean }
  | { kind: 'richText'; id: string; title: string; html: string }
  // REVERT: drop this variant + the roadmapNode prop to remove the roadmap slide.
  | { kind: 'roadmap'; id: string; title: string };

interface PresentationViewProps {
  project: string;
  /** Dashboard name — drives the title-slide headline ("<name> Update"). */
  deckTitle: string;
  dateRange: string | null;
  /** Deck entries already reconciled into presentation order. Includes hidden
   *  slides — the Overview shows them so they can be unhidden, but they are
   *  skipped while presenting. */
  slides: PresentationSlide[];
  /** Ids of slides hidden from the presentation (still shown on the Overview). */
  hiddenIds: string[];
  /** Rendered roadmap (Gantt) shown on the roadmap slide. REVERT: remove. */
  roadmapNode?: React.ReactNode;
  releasedCount: number;
  activeCount: number;
  /** Persist a new slide-id sequence after a drag-reorder. */
  onReorder: (ids: string[]) => void;
  /** Toggle a slide's hidden state, persisted by the dashboard. */
  onToggleHidden: (id: string) => void;
  onClose: () => void;
}

const LinkGlyph: React.FC = () => (
  <svg className="pv-link-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path
      d="M3.5 3H2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.5M7 1h4m0 0v4m0-4L5 7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Flatten HTML to a single line of plain text for the reorder-card excerpts. */
const stripHtml = (html: string): string => {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
};

const excerpt = (text: string, max = 150): string =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

/** Split a rich-text body into its prose and any images. When a note carries
 *  images we lift them out of the flow and onto the right-hand rail (where
 *  section slides show their pie), leaving the text to fill the main column. */
const splitRichMedia = (html: string): { textHtml: string; images: { src: string; alt: string }[] } => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgEls = Array.from(doc.querySelectorAll('img'));
  const images = imgEls
    .map((img) => ({ src: img.getAttribute('src') || '', alt: img.getAttribute('alt') || '' }))
    .filter((img) => img.src);
  imgEls.forEach((img) => img.remove());
  return { textHtml: doc.body.innerHTML, images };
};

/** Sub-section labels arrive with a trailing count e.g. "In QA (1)"; strip it
 *  so the pie legend can show the swatch + label + count without doubling up. */
const cleanLabel = (label: string): string => label.replace(/\s*\(\d+\)\s*$/, '').trim();

/** Slide hrefs come from stored weekly-update content, so guard against unsafe
 *  schemes (e.g. `javascript:`) before rendering them as clickable links. Only
 *  http(s) and protocol-relative URLs are allowed; anything else returns null
 *  so the caller can fall back to plain text. */
const safeHref = (href: string | null | undefined): string | null => {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/')) return trimmed;
  try {
    const url = new URL(trimmed, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Animate a whole number from 0 → target on mount (easeOutCubic). Because the
 *  slides remount on navigation, this re-runs each time a slide enters. */
const useCountUp = (target: number, durationMs = 760): number => {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target <= 0 || prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
};

const CountUp: React.FC<{ value: number; duration?: number }> = ({ value, duration }) => (
  <>{useCountUp(value, duration)}</>
);

type PieSlice = { label: string; value: number; color: string };

// "In review / In QA / Dev done" etc. read as work-in-flight, not completed —
// they must NOT match the done→blue rule (and remainder must not fold into them).
const isMidFlowLabel = (l: string): boolean =>
  l.includes('review') || l.includes('qa') || l.includes('test') || l.includes('await') || l.includes('dev ');

// Fixed semantic colours for the well-known status buckets. Returns null for
// anything unrecognised so those slices fall back to the distinct extra palette.
const semanticColor = (label: string): string | null => {
  const l = label.toLowerCase();
  if (l.includes('block') || l.includes('on hold')) return 'var(--pv-pink)'; // blocked → red
  if (l.includes('in progress') || l.includes('doing') || /\bwip\b/.test(l)) return 'var(--pv-green)'; // in progress → green
  if (
    l.includes('not started') || l.includes('not yet') ||
    l.includes('to do') || l.includes('todo') || l.includes('backlog')
  )
    return 'var(--pv-ink-3)'; // not started → grey
  if (isMidFlowLabel(l)) return null; // QA/review/etc. — distinct palette, never blue
  if (l.includes('done') || l.includes('released') || l.includes('complete')) return 'var(--pv-power)'; // done → blue
  return null;
};

// Distinct hues for buckets without a semantic colour, excluding the reserved
// blue/green/red/grey so they stay visually separable from the known statuses.
const EXTRA_PALETTE = ['var(--pv-led)', 'var(--pv-purple)', 'var(--pv-cyan)', 'var(--pv-amber)'];

/** Build the status breakdown for a section: one slice per sub-section, plus a
 *  "Done" slice for any tickets that have left every tracked bucket. */
const isDoneLabel = (label: string): boolean => {
  const l = label.toLowerCase();
  if (isMidFlowLabel(l)) return false; // "Dev done", "In QA review" etc. aren't the completed bucket
  return l.includes('done') || l.includes('released') || l.includes('complete');
};

const buildPieSlices = (section: WeeklyUpdateSection): PieSlice[] => {
  const slices: { label: string; value: number }[] = [];
  let accounted = 0;
  section.subSections.forEach((ss) => {
    const value = ss.items.length;
    accounted += value;
    if (value > 0) slices.push({ label: cleanLabel(ss.label), value });
  });
  // Tickets that have left every tracked bucket are "done". Fold them into an
  // existing Done/Released/Complete sub-section if one is present (otherwise
  // we'd render two separate Done arcs); only add a synthetic slice when no
  // done-style sub-section exists.
  const done = Math.max(0, section.ticketTotal - accounted);
  if (done > 0) {
    const existing = slices.find((s) => isDoneLabel(s.label));
    if (existing) existing.value += done;
    else slices.unshift({ label: 'Done', value: done });
  }
  // Known statuses get their fixed semantic colour; the rest cycle through the
  // extra palette so every slice stays visually distinct.
  let extra = 0;
  return slices.map((s) => ({
    ...s,
    color: semanticColor(s.label) ?? EXTRA_PALETTE[extra++ % EXTRA_PALETTE.length],
  }));
};

const StatusPie: React.FC<{ slices: PieSlice[] }> = ({ slices }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  // Hooks must run unconditionally — keep the count-up above the empty guard.
  const animatedTotal = useCountUp(total);
  if (total === 0) return null;
  const size = 184;
  const stroke = 32;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;
  const pctOf = (v: number) => Math.round((v / total) * 100);
  // Centre label tracks the hovered slice; falls back to the deck total, which
  // rolls up from 0 on enter (count-up freezes once a slice is hovered).
  const centreNum = hovered === null ? animatedTotal : slices[hovered].value;
  const centreCap = hovered === null ? 'tickets' : `${pctOf(slices[hovered].value)}%`;
  let offset = 0;
  return (
    <div className="pv-pie">
      <svg className="pv-pie-svg" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Ticket status breakdown">
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {slices.map((s, i) => {
            const dash = (s.value / total) * c;
            const dim = hovered !== null && hovered !== i;
            const el = (
              <circle
                key={i}
                className="pv-pie-arc"
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
                style={{ opacity: dim ? 0.3 : 1, '--c': c, animationDelay: `${i * 120}ms` } as React.CSSProperties}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>{`${s.label}: ${s.value} (${pctOf(s.value)}%)`}</title>
              </circle>
            );
            offset += dash;
            return el;
          })}
        </g>
        <text x={cx} y={cy - 8} className="pv-pie-num" textAnchor="middle">
          {centreNum}
        </text>
        <text x={cx} y={cy + 14} className="pv-pie-cap" textAnchor="middle">
          {centreCap}
        </text>
      </svg>
      <ul className="pv-pie-legend">
        {slices.map((s, i) => (
          <li
            className={`pv-pie-key${hovered === i ? ' is-active' : ''}`}
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="pv-pie-swatch" style={{ background: s.color }} />
            <span className="pv-pie-key-label">{s.label}</span>
            <span className="pv-pie-key-val">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const pillClass = (section: WeeklyUpdateSection, released: boolean): string => {
  const c = section.statusClass ?? '';
  if (released || c.includes('released')) return 'pv-pill--released';
  if (c.includes('today')) return 'pv-pill--today';
  return 'pv-pill--prog';
};

const pillLabel = (section: WeeklyUpdateSection, released: boolean): string => {
  if (released) return section.releasedDate ? `Released ${section.releasedDate}` : 'Released';
  return section.statusLabel || 'In progress';
};

const PresentationView: React.FC<PresentationViewProps> = ({
  project,
  deckTitle,
  dateRange,
  slides,
  hiddenIds,
  roadmapNode,
  releasedCount,
  activeCount,
  onReorder,
  onToggleHidden,
  onClose,
}) => {
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  // The deck presents only visible slides; hidden ones are skipped during
  // navigation but still listed on the Overview so they can be unhidden.
  const visibleSlides = useMemo(
    () => slides.filter((s) => !hiddenSet.has(s.id)),
    [slides, hiddenSet],
  );
  // Slide 0 is the title; slides 1..n map to visibleSlides[i-1].
  const totalSlides = visibleSlides.length + 1;
  const [current, setCurrent] = useState(0);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const dragFromRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  // Source of the rich-text image currently zoomed full-screen (null = none).
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  // Travel direction drives the slide-in transition (forward = enter from the
  // right, back = enter from the left). Derived from the previous index.
  const prevCurrentRef = useRef(0);
  const [dir, setDir] = useState<1 | -1>(1);
  useEffect(() => {
    if (current !== prevCurrentRef.current) {
      setDir(current >= prevCurrentRef.current ? 1 : -1);
      prevCurrentRef.current = current;
    }
  }, [current]);

  const go = useCallback(
    (i: number) => setCurrent((prev) => Math.max(0, Math.min(totalSlides - 1, i))),
    [totalSlides],
  );

  // Clamp the active slide if the deck shrinks (e.g. fewer sections after a regen).
  useEffect(() => {
    setCurrent((prev) => Math.min(prev, totalSlides - 1));
  }, [totalSlides]);

  // Keyboard: arrows navigate; Esc closes the zoom, then the overview, then the deck.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (zoomSrc) {
          setZoomSrc(null);
          return;
        }
        setOverviewOpen((open) => {
          if (open) return false;
          onClose();
          return false;
        });
        return;
      }
      if (overviewOpen || zoomSrc) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(current + 1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(current - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [current, overviewOpen, zoomSrc, go, onClose]);

  // Prevent the dashboard behind the overlay from scrolling. Also flag the body
  // while presenting so body-portalled chrome (e.g. the Gantt's hover tooltip,
  // which renders as a sibling of this overlay) can lift above it. REVERT: the
  // data-pv-presenting flag is only needed for the roadmap-slide tooltip.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.dataset.pvPresenting = 'true';
    return () => {
      document.body.style.overflow = prev;
      delete document.body.dataset.pvPresenting;
    };
  }, []);

  // Delegated zoom for images rendered via dangerouslySetInnerHTML (section
  // summaries and inline rich text) — click any of them to view full-screen.
  const handleMediaClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      const src = target.getAttribute('src');
      if (src) setZoomSrc(src);
    }
  };

  const handleDrop = (to: number) => {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    setDragOver(null);
    if (from === null || from === to) return;
    const ids = slides.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    onReorder(ids);
    setCurrent(to + 1); // jump the deck to the slide the user just placed
  };

  const renderSection = (section: WeeklyUpdateSection, released: boolean) => {
    const showDates = Boolean(section.uatStart || section.targetEnd);
    // Completion is derived from the ticket counts already shown in the kicker:
    // "done" is everything that has left the to-do column.
    const total = Math.max(0, section.ticketTotal);
    const todo = Math.max(0, Math.min(section.ticketTodo, total));
    const done = total - todo;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <div className="pv-slide" key={section.id}>
        <div className="pv-slide-inner">
          <div className="pv-kicker">
            {section.increment && <span className="pv-chip">{section.increment}</span>}
            <span className={`pv-pill ${pillClass(section, released)}`}>
              <span className="pv-led" />
              {pillLabel(section, released)}
            </span>
            <span className="pv-ticket">
              <b>{section.ticketTodo}</b> in to-do · <b>{section.ticketTotal}</b> total
            </span>
          </div>

          <h2 className="pv-slide-title">
            {safeHref(section.href) ? (
              <a href={safeHref(section.href)!} target="_blank" rel="noreferrer">
                {section.name}
                <LinkGlyph />
              </a>
            ) : (
              section.name
            )}
          </h2>

          <div className="pv-section-body">
            <div className="pv-section-main">
          {total > 0 && (
            <div className="pv-progress">
              <div className="pv-progress-head">
                <span className="pv-progress-label">Delivery progress</span>
                <span className="pv-progress-stat">{pct}% complete</span>
              </div>
              <div
                className="pv-progress-track"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="pv-progress-fill"
                  style={{ '--w': `${pct}%` } as React.CSSProperties}
                />
              </div>
            </div>
          )}

          {showDates && (
            <div className="pv-dates">
              {section.uatStart && (
                <div className="pv-date-item">
                  <span className="pv-date-dot pv-date-dot--uat" />
                  <span className="pv-date-k">UAT start</span>
                  <span className="pv-date-v">{section.uatStart}</span>
                </div>
              )}
              {section.targetEnd && (
                <div className="pv-date-item">
                  <span className="pv-date-dot pv-date-dot--target" />
                  <span className="pv-date-k">Target end</span>
                  <span className={`pv-date-v${section.targetEndUrgent ? ' is-urgent' : ''}`}>
                    {section.targetEnd}
                  </span>
                </div>
              )}
            </div>
          )}

          {section.versionNote && (
            <div className="pv-note">
              <strong>Jira note —</strong> {section.versionNote}
            </div>
          )}

          {/* Summary HTML is sanitised by WeeklyUpdatePanel before it reaches
              state (parseStoredPanelContent / captureEdits run sanitizeSummaryHtml),
              so it is safe to render here. */}
          <div className="pv-summary" onClick={handleMediaClick} dangerouslySetInnerHTML={{ __html: section.summary }} />
            </div>

            <aside className="pv-section-side">
              <StatusPie slices={buildPieSlices(section)} />
            </aside>
          </div>
        </div>
      </div>
    );
  };

  const renderRichText = (slide: Extract<PresentationSlide, { kind: 'richText' }>) => {
    // Rich-text HTML is DOMPurify-sanitised by RichTextPanel before it is
    // persisted to panel.contentHtml, so it is safe to render here.
    const { textHtml, images } = splitRichMedia(slide.html);
    return (
      <div className="pv-slide pv-slide--rich" key={slide.id}>
        <div className="pv-slide-inner">
          <div className="pv-kicker">
            <span className="pv-chip">Note</span>
          </div>
          <h2 className="pv-slide-title">{slide.title}</h2>
          {images.length > 0 ? (
            <div className="pv-section-body">
              <div className="pv-section-main">
                <div className="pv-rich" dangerouslySetInnerHTML={{ __html: textHtml }} />
              </div>
              <aside className="pv-section-side">
                <div className="pv-rich-media">
                  {images.map((img, i) => (
                    <button
                      type="button"
                      className="pv-rich-media-btn"
                      key={i}
                      onClick={() => setZoomSrc(img.src)}
                      title="Click to enlarge"
                    >
                      <img src={img.src} alt={img.alt} />
                    </button>
                  ))}
                </div>
              </aside>
            </div>
          ) : (
            <div className="pv-rich" onClick={handleMediaClick} dangerouslySetInnerHTML={{ __html: slide.html }} />
          )}
        </div>
      </div>
    );
  };

  // REVERT: remove renderRoadmap + its renderSlide branch to drop the slide.
  const renderRoadmap = (slide: Extract<PresentationSlide, { kind: 'roadmap' }>) => (
    <div className="pv-slide pv-slide--roadmap" key={slide.id}>
      <div className="pv-slide-inner">
        <h2 className="pv-slide-title">{slide.title}</h2>
        <div className="pv-roadmap">{roadmapNode}</div>
      </div>
    </div>
  );

  const renderSlide = (slide: PresentationSlide) =>
    slide.kind === 'section'
      ? renderSection(slide.section, slide.released)
      : slide.kind === 'roadmap'
        ? renderRoadmap(slide)
        : renderRichText(slide);

  const headline = deckTitle.trim() || project || 'gPO';
  const titleSlide = (
    <div className="pv-slide pv-title-slide">
      <div className="pv-title-wash" aria-hidden="true" />
      <div className="pv-title-mark" aria-hidden="true">{(project || 'gPO').slice(0, 3)}</div>
      <div className="pv-slide-inner">
        <div className="pv-eyebrow pv-title-eyebrow">
          <span className="pv-eyebrow-rule" />
          Fortnightly update
        </div>
        <h1 className="pv-title">
          {headline} <span className="pv-title-accent">Update</span>
        </h1>
        <p className="pv-title-sub">
          Generated summary of delivery progress across active and recently released fix versions.
        </p>
        <div className="pv-title-meta">
          {dateRange && (
            <div className="pv-meta-item">
              <div className="pv-meta-k">Period</div>
              <div className="pv-meta-v">{dateRange}</div>
            </div>
          )}
          <div className="pv-meta-item">
            <div className="pv-meta-k"><span className="pv-meta-dot pv-meta-dot--released" />Released</div>
            <div className="pv-meta-v"><CountUp value={releasedCount} /></div>
          </div>
          <div className="pv-meta-item">
            <div className="pv-meta-k"><span className="pv-meta-dot pv-meta-dot--active" />Active</div>
            <div className="pv-meta-v"><CountUp value={activeCount} /></div>
          </div>
        </div>
      </div>
    </div>
  );

  const activeSlideEl =
    current === 0 ? titleSlide : (() => {
      const slide = visibleSlides[current - 1];
      return slide ? renderSlide(slide) : (
        <div className="pv-slide">
          <div className="pv-slide-inner">
            <p className="pv-empty">No sections to present yet.</p>
          </div>
        </div>
      );
    })();
  // Tag the mounted slide with the travel direction so the CSS picks the right
  // enter animation. Keyed by `current` so React remounts (re-runs) on each move.
  const activeSlide = React.cloneElement(activeSlideEl, {
    key: `slide-${current}`,
    'data-dir': dir > 0 ? 'fwd' : 'back',
  });

  const eyebrowFor = (slide: PresentationSlide) =>
    slide.kind === 'richText'
      ? 'Note'
      : slide.kind === 'roadmap'
        ? 'Roadmap'
        : slide.released
          ? 'Released'
          : slide.section.increment || 'Active';

  const nameFor = (slide: PresentationSlide) =>
    slide.kind === 'section' ? slide.section.name : slide.title;

  const excerptFor = (slide: PresentationSlide) =>
    slide.kind === 'section'
      ? excerpt(stripHtml(slide.section.summary))
      : slide.kind === 'richText'
        ? excerpt(stripHtml(slide.html))
        : '';

  return createPortal(
    <div className="pv-root" role="dialog" aria-modal="true" aria-label="Update presentation">
      <div className="pv-topbar">
        <div className="pv-brand">
          <span className="pv-dot" />
          {deckTitle.trim() || project || 'gPO'} · Fortnightly Update
        </div>
        <div className="pv-topbar-right">
          <span className="pv-counter">
            Slide <b>{current + 1}</b> / {totalSlides}
          </span>
          <button
            type="button"
            className={`pv-btn pv-btn--ghost${overviewOpen ? ' is-active' : ''}`}
            onClick={() => setOverviewOpen((o) => !o)}
          >
            Overview &amp; reorder
          </button>
          <button type="button" className="pv-btn" onClick={onClose}>
            Exit
          </button>
        </div>
      </div>

      <div className="pv-viewport">
        {activeSlide}

        {overviewOpen && (
          <div className="pv-overview">
            <div className="pv-overview-head">
              <h2 className="pv-overview-title">Slide sequence</h2>
              <button type="button" className="pv-btn pv-btn--ghost" onClick={() => setOverviewOpen(false)}>
                Done
              </button>
            </div>
            <p className="pv-overview-hint">
              Drag slides to set the order they present in. The sequence is saved with the dashboard.
            </p>
            <div className="pv-grid">
              {slides.map((slide, i) => {
                const hidden = hiddenSet.has(slide.id);
                // Position within the slides the audience actually sees.
                const visibleIndex = visibleSlides.findIndex((s) => s.id === slide.id);
                return (
                  <div
                    key={slide.id}
                    className={`pv-card${dragOver === i ? ' is-drop-target' : ''}${hidden ? ' is-hidden' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      dragFromRef.current = i;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      dragFromRef.current = null;
                      setDragOver(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDrop(i);
                    }}
                    onClick={() => {
                      if (hidden) return; // hidden slides aren't in the deck to jump to
                      setOverviewOpen(false);
                      go(visibleIndex + 1);
                    }}
                  >
                    <div className="pv-card-thumb">
                      <span className="pv-card-num">
                        {hidden ? '—' : String(visibleIndex + 1).padStart(2, '0')}
                      </span>
                      <span className="pv-card-eyebrow">{eyebrowFor(slide)}</span>
                      <span className="pv-card-name">{nameFor(slide)}</span>
                      {excerptFor(slide) && (
                        <span className="pv-card-excerpt">{excerptFor(slide)}</span>
                      )}
                    </div>
                    <div className="pv-card-foot">
                      <span className="pv-card-foot-drag">
                        <span className="pv-card-handle">⠿</span> drag to reorder
                      </span>
                      <button
                        type="button"
                        className="pv-card-hide"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleHidden(slide.id);
                        }}
                        title={hidden ? 'Show this slide in the deck' : 'Hide this slide from the deck'}
                      >
                        {hidden ? 'Show' : 'Hide'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {!overviewOpen && (
      <div className="pv-footnav">
        <span className="pv-hint">← → navigate · Esc to exit</span>
        <div className="pv-dots">
          {Array.from({ length: totalSlides }).map((_, i) => (
            <button
              key={i}
              type="button"
              className={`pv-dot${i === current ? ' is-active' : ''}`}
              aria-label={`Go to slide ${i + 1}`}
              onClick={() => go(i)}
            />
          ))}
        </div>
        <div className="pv-nav-pair">
          <button
            type="button"
            className="pv-btn--round"
            aria-label="Previous slide"
            disabled={current === 0}
            onClick={() => go(current - 1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="pv-btn--round"
            aria-label="Next slide"
            disabled={current >= totalSlides - 1}
            onClick={() => go(current + 1)}
          >
            ›
          </button>
        </div>
      </div>
      )}

      <div className="pv-ribbon" aria-hidden="true">
        <div
          className="pv-ribbon-fill"
          style={{ width: `${(((current + 1) / totalSlides) * 100).toFixed(2)}%` }}
        />
      </div>

      {zoomSrc && (
        <div className="pv-zoom" role="dialog" aria-modal="true" onClick={() => setZoomSrc(null)}>
          <button type="button" className="pv-zoom-close" aria-label="Close image" onClick={() => setZoomSrc(null)}>
            ×
          </button>
          <img className="pv-zoom-img" src={zoomSrc} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>,
    document.body,
  );
};

export default PresentationView;
