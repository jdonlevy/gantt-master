import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarColourCategory, BarColourMode, CustomBar, Dependency, DependencyNodeType, Epic, FixVersion, Initiative, Milestone, Project, Story, Swimlane } from './types';
import { JiraTypeIcon } from './JiraIcons';
import { ColourPicker } from './components/ColourPicker';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Swimlane layout constants. We used to render a separate label pill
// above each bar (LANE_LABEL_HEIGHT); the label now lives inside the bar,
// so the old above-the-bar spacing is gone and bars can sit directly at
// the top of each row. Bar height was bumped up from 18 → 26 to leave
// enough vertical room for a readable label + progress inside the bar.
const LANE_LABEL_HEIGHT = 0;
const LANE_BAR_HEIGHT = 26;
const LANE_MARKER_HEIGHT = 6;
const LANE_MARKER_GAP = 4;
const LANE_MARKER_OFFSET = 6;
const LANE_ROW_HEIGHT =
  LANE_LABEL_HEIGHT + LANE_BAR_HEIGHT + LANE_MARKER_OFFSET + LANE_MARKER_HEIGHT * 2 + LANE_MARKER_GAP;
// Milestone swimlane view: diamonds are single points rather than bars,
// so there's no need to reserve the marker rows (UAT/Live are bar-only
// concepts) or a full 26px bar height. A 12x12 diamond rotated 45° has
// a ~17px visual bounding box; 20px leaves just enough vertical room
// for the diamond (plus a hair of padding) and roughly halves the
// per-row footprint vs bars view (48px → 20px, ~60% shorter).
const LANE_MILESTONE_ROW_HEIGHT = 20;
// In milestone view the caption (release name) floats ABOVE its diamond by
// ~14px (font-size 11 + 2px gap). Without extra room at the top of each
// lane track, that caption extends above the track's top border and gets
// visually clipped by the lane above (or by the lane's own border).
// Reserve a 14px "caption gutter" on top of the row-0 diamond's natural
// position in milestone view, so every caption sits cleanly inside the
// lane track. Extends the lane's `trackHeight` by the same amount so the
// last row's vertical space isn't squeezed.
const LANE_MILESTONE_CAPTION_GUTTER = 14;
// Minimum gap between two bars before they're allowed to share a row in
// swimlane bars view. Without this, bars whose date ranges don't overlap
// (e.g. one ends Apr 10, the next starts Apr 11) end up pressed up against
// each other on the same row, which reads as a single fused bar at glance.
// 3 days of breathing room means anything tighter than that gets bumped to
// the next row — including back-to-back releases (gap of 0 days). Tuned
// from user feedback ("if they are less than 3 days").
const SWIMLANE_BAR_MIN_GAP_MS = 3 * MS_PER_DAY;
const LANE_ROW_GAP = 10;
const LANE_TRACK_PADDING = 8;
const AT_RISK_THRESHOLD = 0.15;
const ROW_HEIGHT = 44;
const ROW_GAP = 10;
const TRACK_HEIGHT = 28;
const BAR_HEIGHT = 18;
const BAR_TOP = 5;

type FixStatus = 'not-started' | 'in-progress' | 'completed' | 'at-risk' | 'overdue';

// Date-only strings (YYYY-MM-DD) without a time component are parsed by the
// JS engine as UTC midnight, but `toLocaleDateString()` and friends render in
// the user's local TZ — so in negative-UTC zones the displayed day slips back
// by one. Detect that shape and construct a local-midnight Date instead.
// Full ISO timestamps (with `T` and offset) are left to native parsing.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseDate = (value?: string | null) => {
  if (!value) return null;
  let date: Date;
  if (DATE_ONLY_RE.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    date = new Date(y, m - 1, d);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
};

const daysBetween = (start: Date, end: Date) => {
  const diff = end.getTime() - start.getTime();
  return Math.max(0, Math.round(diff / MS_PER_DAY));
};

const formatDay = (date: Date) => {
  const day = date.getDate().toString().padStart(2, '0');
  return day;
};

const formatMonth = (date: Date) =>
  date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

const formatMilestoneDate = (date: Date) =>
  date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });

const formatFullDate = (value?: string | null) => {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-GB');
};

type Range = {
  start: Date;
  end: Date;
};

type RowItem = {
  id: string;
  label: string;
  level: number;
  jiraKey?: string;
  projectKey?: string;
  start?: string | null;
  end?: string | null;
  uatStart?: string | null;
  uatEnd?: string | null;
  liveStart?: string | null;
  liveEnd?: string | null;
  released?: boolean | null;
  archived?: boolean | null;
  url?: string | null;
  progressDone?: number | null;
  progressInProgress?: number | null;
  progressTotal?: number | null;
  // For epics: Jira statusCategory key ("new" | "indeterminate" | "done").
  // Used to force a "Done" epic to render with the completed colour.
  epicStatusCategory?: string | null;
  // For stories: Jira statusCategory key. Drives the bar colour: new = grey,
  // indeterminate = green, done = blue.
  storyStatusCategory?: string | null;
  // For stories: the full Jira status name (e.g. "In Progress",
  // "Done - Released"). Displayed in the bar hover tooltip.
  storyStatusName?: string | null;
  type: 'fix' | 'epic' | 'story';
  parentFixId?: string;
  parentEpicId?: string;
  /**
   * Fix rows only — keys of tickets in OTHER projects that any epic/story in
   * this fix version is linked to. When non-empty, a purple "!" badge is
   * drawn at the top-left of the bar, with the keys surfaced on hover.
   */
  externalLinks?: string[];
  children?: RowItem[];
};

type VisibleRow = {
  row: RowItem;
  parentFixId?: string;
  parentEpicId?: string;
  clamped: Range | null;
  index: number;
};

type DependencyEdge = {
  fromId: string;
  toId: string;
  /** Resolved row id the source issue rolled up into (may differ from fromId
   *  when the source is a story that's displayed under its parent fix/epic). */
  fromRowId: string;
  /** Resolved row id the target issue rolled up into. Use this (not toId) for
   *  any per-row bookkeeping like badge counts. */
  toRowId: string;
  fromX: number;
  toX: number;
  /** Left edge of the source bar in percent — used to clamp the outgoing
   *  dependency chip so it can never overhang the back of the source bar. */
  fromStartX: number;
  fromY: number;
  toY: number;
  warning: boolean;
  source: 'jira' | 'manual';
  overrideId: string | null;
  /** Index of the source row in visibleRows — used for bar-avoidance routing. */
  fromRowIdx: number;
  /** Index of the target row in visibleRows — used for bar-avoidance routing. */
  toRowIdx: number;
};

type RowBarMeta = {
  /** Viewbox top edge of the bar (not the row centre line). */
  barTop: number;
  /** Viewbox bottom edge of the bar. */
  barBottom: number;
  /** Left edge of the bar, in percent (0–100). */
  leftPct: number;
  /** Right edge of the bar, in percent (0–100). */
  rightPct: number;
};

/**
 * Ortho routing constants — locked in during the mockup. OUT/IN offsets are
 * the horizontal "hook" length leaving the source and approaching the target
 * bar; CORNER_R is the radius of the rounded corners at each bend.
 */
const ORTHO_OUT_OFFSET = 14;
const ORTHO_IN_OFFSET = 28;
const ORTHO_CORNER_R = 6;
// The markers use markerUnits="userSpaceOnUse" with a triangle that's 12
// user units wide, and refX=0 so the triangle's BACK (base) is anchored to
// the path endpoint — meaning the visible line stops at the base and the
// triangle sits on the end as a cap. That leaves the triangle's TIP 12
// user units forward of the endpoint, so we shorten the path by that same
// amount (12 user units = 1.2% of the 1000-unit viewBox width) so the tip
// lands right on the target bar's left edge.
const ARROW_TIP_MARGIN_PCT = 1.2;

// When multiple edges target the same row, they all route through a shared
// vertical spine so the visual bundle reads as one converging stream rather
// than N parallel arrows. The spine is placed just past the rightmost source
// bar (APPROACH_SPINE_SOURCE_BUFFER_PCT after its right edge) so every source
// does a short horizontal run out to the spine, then shares a long vertical
// trunk down to the target row, then shares the final hook into the target.
// APPROACH_SPINE_MIN_GAP_PCT is the minimum clearance between the spine and
// the target bar — if the rightmost source is too close to the target for
// the dynamic position, we fall back to this clamp so the spine never lands
// on top of (or past) the target.
const APPROACH_SPINE_SOURCE_BUFFER_PCT = 1.0;
const APPROACH_SPINE_MIN_GAP_PCT = 1.5;

/**
 * The SVG viewbox is 1000 units wide (matches the existing dependency layer).
 * We compute positions in percent for parity with the rest of the Gantt
 * geometry and scale X to viewbox units only when emitting path commands.
 */
const VIEWBOX_WIDTH = 1000;
const toViewboxX = (pct: number): number => (pct / 100) * VIEWBOX_WIDTH;

/**
 * Build an orthogonal SVG path string from a polyline (X in percent, Y in
 * viewbox units) with rounded corners at each bend. Uses quadratic Béziers so
 * the corner is tangent to both adjoining segments — matches the mockup.
 */
const roundedOrtho = (
  points: ReadonlyArray<readonly [number, number]>,
  radius: number
): string => {
  if (points.length === 0) return '';
  const toVB = (x: number, y: number): [number, number] => [toViewboxX(x), y];

  if (points.length === 1) {
    const [x, y] = toVB(points[0][0], points[0][1]);
    return `M ${x} ${y}`;
  }

  const vb = points.map(([x, y]) => toVB(x, y));
  const parts: string[] = [`M ${vb[0][0]} ${vb[0][1]}`];

  for (let i = 1; i < vb.length - 1; i += 1) {
    const [px, py] = vb[i - 1];
    const [cx, cy] = vb[i];
    const [nx, ny] = vb[i + 1];

    // Keep the corner radius within half the length of the shorter adjoining
    // segment to avoid overshoot when bars are close together.
    const prevDist = Math.hypot(cx - px, cy - py);
    const nextDist = Math.hypot(nx - cx, ny - cy);
    const r = Math.max(0, Math.min(radius, prevDist / 2, nextDist / 2));

    const prevDirX = prevDist === 0 ? 0 : (cx - px) / prevDist;
    const prevDirY = prevDist === 0 ? 0 : (cy - py) / prevDist;
    const nextDirX = nextDist === 0 ? 0 : (nx - cx) / nextDist;
    const nextDirY = nextDist === 0 ? 0 : (ny - cy) / nextDist;

    const entryX = cx - prevDirX * r;
    const entryY = cy - prevDirY * r;
    const exitX = cx + nextDirX * r;
    const exitY = cy + nextDirY * r;

    parts.push(`L ${entryX} ${entryY}`);
    if (r > 0) {
      parts.push(`Q ${cx} ${cy} ${exitX} ${exitY}`);
    }
  }

  const last = vb[vb.length - 1];
  parts.push(`L ${last[0]} ${last[1]}`);
  return parts.join(' ');
};

/**
 * Pick a horizontal "channel" Y between the source and target rows.
 *
 * Strategy: score every candidate channel (the gap between each pair of
 * adjacent rows in [lo..hi]) by how many bars it would clip, then pick the
 * one with the fewest clips, tie-breaking by proximity to the target row.
 *
 * - A perfectly clean channel (zero clips) always wins — sparse layouts
 *   behave exactly as before.
 * - When every channel clips at least one bar, we pick the LEAST-clipping
 *   one rather than defaulting to the midpoint. This avoids cutting
 *   across bars unless it's genuinely necessary.
 * - Only if no candidate channels exist at all (e.g. missing bar metadata)
 *   do we fall back to the midpoint between source/target bar centres.
 */
const pickChannelY = (
  fromRowIdx: number,
  toRowIdx: number,
  horizontalX1: number,
  horizontalX2: number,
  rowBars: ReadonlyArray<RowBarMeta | null>
): number => {
  if (fromRowIdx === toRowIdx) {
    // Same row — no channel needed; caller shouldn't be routing through a
    // channel. Return the row centre as a safe default.
    const bar = rowBars[fromRowIdx];
    return bar ? (bar.barTop + bar.barBottom) / 2 : 0;
  }

  const lo = Math.min(fromRowIdx, toRowIdx);
  const hi = Math.max(fromRowIdx, toRowIdx);

  const left = Math.min(horizontalX1, horizontalX2);
  const right = Math.max(horizontalX1, horizontalX2);

  // Helper: does a horizontal segment at `y` overlap the bar of row `idx`?
  const clipsRow = (y: number, idx: number): boolean => {
    const bar = rowBars[idx];
    if (!bar) return false;
    if (y < bar.barTop || y > bar.barBottom) return false;
    return !(right < bar.leftPct || left > bar.rightPct);
  };

  const candidates: Array<{ y: number; adjToTarget: number; clipCount: number }> = [];
  for (let i = lo; i < hi; i += 1) {
    const upper = rowBars[i];
    const lower = rowBars[i + 1];
    if (!upper || !lower) continue;
    const gapMid = (upper.barBottom + lower.barTop) / 2;
    const adjToTarget = Math.abs(i + 0.5 - (toRowIdx - 0.5));
    // Count how many bars this channel would clip — used as the primary
    // ranking key so we only cross bars when no cleaner option exists.
    let clipCount = 0;
    for (let idx = lo; idx <= hi; idx += 1) {
      if (clipsRow(gapMid, idx)) clipCount += 1;
    }
    candidates.push({ y: gapMid, adjToTarget, clipCount });
  }

  // Fewest clips wins; among equally-clean candidates, prefer the one
  // closest to the target row (matches the prior "target-adjacent first"
  // behaviour in sparse layouts).
  candidates.sort(
    (a, b) => a.clipCount - b.clipCount || a.adjToTarget - b.adjToTarget
  );

  if (candidates.length > 0) return candidates[0].y;

  // No inter-row gaps at all (e.g. adjacent rows with missing bar metrics).
  // Fall back to the midpoint between source and target bar centres.
  const fromBar = rowBars[fromRowIdx];
  const toBar = rowBars[toRowIdx];
  if (fromBar && toBar) {
    const fromMid = (fromBar.barTop + fromBar.barBottom) / 2;
    const toMid = (toBar.barTop + toBar.barBottom) / 2;
    return (fromMid + toMid) / 2;
  }
  return 0;
};

/**
 * Build the final orthogonal path for a dependency edge, including the
 * horizontal hooks, channel traversal, and the final hook into the target
 * bar's left vertical edge.
 *
 * When `approachX` is supplied, the edge uses SHARED-SPINE routing: the
 * path goes from the source straight across to `approachX`, drops
 * vertically to the target's row at the same x, and lands on the target.
 * All edges passed the same `approachX` for a given target overlap
 * perfectly on the spine, producing one merged arrow at the target bar.
 */
const buildOrthoPath = (
  edge: DependencyEdge,
  rowBars: ReadonlyArray<RowBarMeta | null>,
  approachX?: number
): string => {
  const outX = Math.min(100, edge.fromX + ORTHO_OUT_OFFSET / 10);
  const inX = Math.max(0, edge.toX - ORTHO_IN_OFFSET / 10);
  // End the path just short of the bar edge so the arrowhead touches but
  // doesn't overlap it.
  const endX = Math.max(inX + 0.01, edge.toX - ARROW_TIP_MARGIN_PCT);

  if (edge.fromRowIdx === edge.toRowIdx) {
    // Same row — straight horizontal with a little dip for visual distinction.
    return roundedOrtho(
      [
        [edge.fromX, edge.fromY],
        [endX, edge.toY]
      ],
      ORTHO_CORNER_R
    );
  }

  // Shared-spine routing: only applied when caller has determined this
  // edge's target is a hub (multiple incoming) and the spine sits safely
  // between source and target. The caller clamps approachX so we can
  // trust it here.
  if (approachX !== undefined) {
    const spineEndX = Math.max(approachX + 0.01, edge.toX - ARROW_TIP_MARGIN_PCT);
    const waypoints: ReadonlyArray<readonly [number, number]> = [
      [edge.fromX, edge.fromY],
      [approachX, edge.fromY],
      [approachX, edge.toY],
      [spineEndX, edge.toY]
    ];
    return roundedOrtho(waypoints, ORTHO_CORNER_R);
  }

  const channelY = pickChannelY(edge.fromRowIdx, edge.toRowIdx, outX, inX, rowBars);

  const waypoints: ReadonlyArray<readonly [number, number]> = [
    [edge.fromX, edge.fromY],
    [outX, edge.fromY],
    [outX, channelY],
    [inX, channelY],
    [inX, edge.toY],
    [endX, edge.toY]
  ];

  return roundedOrtho(waypoints, ORTHO_CORNER_R);
};

type DependencyLink = {
  key?: string | null;
  label?: string | null;
  url?: string | null;
  rowId: string;
};

const buildRows = (fixVersions: FixVersion[], collapsedFixVersions: Set<string>, collapsedEpics: Set<string>) => {
  const rows: RowItem[] = [];

  // Order fix-version rows top-to-bottom by release date (ascending). Fix
  // versions missing a release date sink to the bottom. When two releases
  // share the same date (or both are missing one), fall back to start date —
  // earlier starts win. Array.prototype.sort is stable in modern JS engines,
  // so anything still tied keeps the backend-provided order.
  const sortedFixVersions = [...fixVersions].sort((a, b) => {
    const aRelease = parseDate(a.release)?.getTime();
    const bRelease = parseDate(b.release)?.getTime();
    if (aRelease != null && bRelease != null) {
      if (aRelease !== bRelease) return aRelease - bRelease;
    } else if (aRelease != null) {
      return -1;
    } else if (bRelease != null) {
      return 1;
    }
    const aStart = parseDate(a.start)?.getTime();
    const bStart = parseDate(b.start)?.getTime();
    if (aStart != null && bStart != null) return aStart - bStart;
    if (aStart != null) return -1;
    if (bStart != null) return 1;
    return 0;
  });

  for (const fix of sortedFixVersions) {
    const fixRow: RowItem = {
      id: fix.id,
      label: fix.name,
      level: 0,
      projectKey: fix.projectKey ?? undefined,
      start: fix.start,
      end: fix.release,
      uatStart: fix.uatStart,
      uatEnd: fix.uatEnd,
      liveStart: fix.liveStart,
      liveEnd: fix.liveEnd,
      released: fix.released,
      archived: fix.archived,
      url: fix.url,
      progressDone: fix.progressDone,
      progressInProgress: fix.progressInProgress,
      progressTotal: fix.progressTotal,
      externalLinks: fix.externalLinks,
      type: 'fix'
    };

    rows.push(fixRow);

    if (collapsedFixVersions.has(fix.id)) {
      continue;
    }

    const seenEpics = new Set<string>();
    for (const epic of fix.epics) {
      if (seenEpics.has(epic.id)) {
        continue;
      }
      seenEpics.add(epic.id);

      const epicRow: RowItem = {
        id: epic.id,
        label: `${epic.key} — ${epic.summary}`,
        level: 1,
        jiraKey: epic.key,
        start: epic.start,
        end: epic.end,
        url: epic.url,
        progressDone: epic.progressDone,
        progressTotal: epic.progressTotal,
        epicStatusCategory: epic.status,
        type: 'epic',
        parentFixId: fix.id
      };

      rows.push(epicRow);

      if (collapsedEpics.has(epic.id)) {
        continue;
      }

      const seenStories = new Set<string>();
      for (const story of epic.stories || []) {
        if (seenStories.has(story.id)) {
          continue;
        }
        seenStories.add(story.id);

        const storyRow: RowItem = {
          id: story.id,
          label: `${story.key} — ${story.summary}`,
          level: 2,
          jiraKey: story.key,
          start: story.start,
          end: story.end,
          url: story.url,
          storyStatusCategory: story.status,
          storyStatusName: story.statusName,
          type: 'story',
          parentFixId: fix.id,
          parentEpicId: epic.id
        };

        rows.push(storyRow);
      }
    }
  }

  const seenRows = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.type}-${row.id}-${row.parentFixId ?? ''}-${row.parentEpicId ?? ''}`;
    if (seenRows.has(key)) {
      return false;
    }
    seenRows.add(key);
    return true;
  });
};

type SwimlaneBar = {
  fix: FixVersion;
  start: Date;
  end: Date;
  clamped: Range;
  rowIndex: number;
  progressPercent: number;
  // Combined done+in-flight progress. Stored alongside progressPercent so
  // the swimlane bar's 3-way progress shading (done → in-flight → not
  // started) can render without recomputing it at render time.
  progressInFlightPercent: number;
  status: FixStatus;
  /** True when this bar was synthesised from a CustomBar rather than a real
   *  FixVersion. Rendering skips UAT/Live markers, progress shading, and
   *  external-dep badge; applies the dashed custom-bar style instead. */
  isCustomBar?: boolean;
  /** Hex colour for the custom bar (only set when isCustomBar is true). */
  customBarColor?: string;
  /** Whether to render the custom bar's name label (only meaningful when isCustomBar). */
  customBarShowName?: boolean;
};

type SwimlaneRow = {
  id: string;
  name: string;
  bars: SwimlaneBar[];
  rowCount: number;
};

const clampRange = (range: Range, start?: string | null, end?: string | null) => {
  const startDate = parseDate(start);
  const endDate = parseDate(end) || startDate;

  if (!startDate || !endDate) return null;

  const clampedStart = startDate < range.start ? range.start : startDate;
  const clampedEnd = endDate > range.end ? range.end : endDate;

  if (clampedEnd < range.start || clampedStart > range.end) return null;

  return { start: clampedStart, end: clampedEnd };
};

export const getScheduleStatus = (
  start: string | null | undefined,
  end: string | null | undefined,
  released: boolean | null | undefined,
  progressPercent: number,
  today: Date
): FixStatus => {
  if (released) return 'completed';
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  // Neither start nor end: surface any active work as in-progress rather than
  // reporting "not started" — only go grey when there's literally no activity.
  if (!startDate && !endDate) {
    return progressPercent > 0 ? 'in-progress' : 'not-started';
  }
  // Start-only (no end): we can't compute expected-vs-actual progress without
  // a target end date, and collapsing end → start would wrongly flip every
  // such fix version to overdue/at-risk on day two. Fall back to a purely
  // activity-based view: before startDate → not-started (unless work has
  // already begun), on/after startDate → in-progress.
  if (startDate && !endDate) {
    if (today < startDate) return progressPercent > 0 ? 'in-progress' : 'not-started';
    return 'in-progress';
  }
  // End-only (no start): without a start date we can only check for overdue.
  // If today is past the end date treat as overdue; otherwise reflect any
  // in-flight work as in-progress so the bar doesn't look untouched.
  if (!startDate && endDate) {
    if (today > endDate) return 'overdue';
    return progressPercent > 0 ? 'in-progress' : 'not-started';
  }
  // Both dates set — the standard schedule-driven path.
  // TS still sees these as possibly-null; the branches above exclude that.
  const s = startDate as Date;
  const e = endDate as Date;

  if (today > e) return 'overdue';

  const totalMs = e.getTime() - s.getTime();
  const expectedProgress = (() => {
    // Order matters: check pre-start first so a zero-length span (start === end)
    // scheduled in the future doesn't get reported as 100% expected before it
    // has even begun. A same-day fix version should be 0% expected on day -1,
    // 100% expected on day 0 onwards.
    if (today <= s) return 0;
    if (totalMs <= 0) return 1;
    if (today >= e) return 1;
    return Math.min(1, Math.max(0, (today.getTime() - s.getTime()) / totalMs));
  })();
  const actualProgress = progressPercent / 100;
  if (actualProgress < expectedProgress - AT_RISK_THRESHOLD) return 'at-risk';
  if (s <= today) return 'in-progress';
  // Pre-start (today < startDate): if any work is already underway, reflect
  // that in the colour rather than leaving the bar grey. Caller decides
  // what "progressPercent" means — fix bars pass done+in-flight, epic bars
  // pass done — so this rule applies uniformly.
  if (progressPercent > 0) return 'in-progress';
  return 'not-started';
};

/**
 * Compute the "in-flight" progress percentage — the share of stories that are
 * either done or currently in progress — rounded to the nearest integer and
 * clamped to the 0..100 range. This is the signal that drives bar-colour
 * selection on fix-version rows and the RAG calculation below, so all three
 * consumers (computeFixVersionRag, swimlane rows, standard rows) must agree
 * on the same rounding/clamping rules — hence the shared helper.
 */
export const getInFlightProgressPercent = (
  progressDone: number | null | undefined,
  progressInProgress: number | null | undefined,
  progressTotal: number | null | undefined
): number => {
  const safeDone = progressDone || 0;
  const safeInProgress = progressInProgress || 0;
  const safeTotal = progressTotal || 0;
  if (!safeTotal) return 0;
  return Math.min(100, Math.max(0, Math.round(((safeDone + safeInProgress) / safeTotal) * 100)));
};

/**
 * Compute a RAG (red/amber/green) status for a fix version using the same
 * schedule logic that drives the Gantt bar colour. The mapping is:
 *   overdue  → red    (target end date has already passed)
 *   at-risk  → amber  (actual progress noticeably behind expected)
 *   anything else → green  (on track, not started, in-progress, or completed)
 *
 * Shared between the Gantt and the Weekly Update panel so the two surfaces
 * agree on a single view of each fix version's health.
 */
export const computeFixVersionRag = (
  fix: FixVersion,
  today: Date = new Date()
): 'red' | 'amber' | 'green' => {
  const progressInFlightPercent = getInFlightProgressPercent(
    fix.progressDone,
    fix.progressInProgress,
    fix.progressTotal
  );
  const status = getScheduleStatus(
    fix.start,
    fix.release,
    fix.released,
    progressInFlightPercent,
    today
  );
  if (status === 'overdue') return 'red';
  if (status === 'at-risk') return 'amber';
  return 'green';
};

const buildSwimlaneRows = (
  fixVersions: FixVersion[],
  swimlanes: Swimlane[],
  range: Range,
  customBars: CustomBar[] = []
): SwimlaneRow[] => {
  const fixById = new Map(fixVersions.map((fix) => [fix.id, fix]));
  // Group custom bars by swimlaneId once so per-lane lookup is O(1) rather
  // than rescanning the full array for every swimlane.
  const customBarsByLane = new Map<string, CustomBar[]>();
  for (const cb of customBars) {
    if (!cb.swimlaneId) continue;
    const arr = customBarsByLane.get(cb.swimlaneId);
    if (arr) arr.push(cb);
    else customBarsByLane.set(cb.swimlaneId, [cb]);
  }
  const today = new Date();

  const laneRows = swimlanes.map((lane) => {
    const fixes = lane.fixVersionIds.map((id) => fixById.get(id)).filter(Boolean) as FixVersion[];
    type ItemShape = { fix: FixVersion; start: Date; end: Date; clamped: Range; isCustomBar: boolean; customBarColor?: string; customBarShowName?: boolean };
    const fixItems: ItemShape[] = fixes
      .map((fix): ItemShape | null => {
        const startDate = parseDate(fix.start);
        const endDate = parseDate(fix.release) || startDate;
        if (!startDate || !endDate) return null;
        const clamped = clampRange(range, fix.start, fix.release);
        if (!clamped) return null;
        return { fix, start: startDate, end: endDate, clamped, isCustomBar: false };
      })
      .filter((item): item is ItemShape => item !== null);

    // Custom bars scoped to this specific lane are packed alongside fix
    // versions so they occupy real rows and don't overlap other bars.
    const customItems: ItemShape[] = (customBarsByLane.get(lane.id) ?? [])
      .map((cb): ItemShape | null => {
        const startDate = parseDate(cb.start);
        const endDate = parseDate(cb.end) || startDate;
        if (!startDate || !endDate) return null;
        const clamped = clampRange(range, cb.start, cb.end);
        if (!clamped) return null;
        // Synthesise a FixVersion so the rest of the code treats it uniformly.
        const syntheticFix: FixVersion = {
          id: cb.id,
          name: cb.name,
          start: cb.start,
          release: cb.end,
          released: false,
          archived: false,
          epics: [],
          progressDone: 0,
          progressInProgress: 0,
          progressTotal: 0,
        };
        return { fix: syntheticFix, start: startDate, end: endDate, clamped, isCustomBar: true, customBarColor: cb.color, customBarShowName: cb.showName };
      })
      .filter((item): item is ItemShape => item !== null);

    const items = [...fixItems, ...customItems];

    items.sort((a, b) => a.start.getTime() - b.start.getTime());

    const bars: SwimlaneBar[] = [];
    // Row-packing (interval graph colouring):
    //   For each item, reuse the row that becomes free earliest if its
    //   end time is <= the item's start; otherwise open a new row.
    // A min-heap keyed on row end time gives O(log r) per item instead of
    // the O(r) linear scan the previous `rowEndTimes.findIndex(...)` loop
    // performed, so dense lanes no longer degrade to O(n^2) packing on
    // every dashboard render.
    let rowCount = 0;
    // Heap entries: [endMs, rowIndex]. Smallest endMs at index 0.
    const freeHeap: Array<[number, number]> = [];
    const heapSwap = (a: number, b: number) => {
      const t = freeHeap[a];
      freeHeap[a] = freeHeap[b];
      freeHeap[b] = t;
    };
    const heapPush = (entry: [number, number]) => {
      freeHeap.push(entry);
      let i = freeHeap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (freeHeap[p][0] <= freeHeap[i][0]) break;
        heapSwap(p, i);
        i = p;
      }
    };
    const heapPop = (): [number, number] => {
      const top = freeHeap[0];
      const last = freeHeap.pop()!;
      if (freeHeap.length > 0) {
        freeHeap[0] = last;
        let i = 0;
        const n = freeHeap.length;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let smallest = i;
          if (l < n && freeHeap[l][0] < freeHeap[smallest][0]) smallest = l;
          if (r < n && freeHeap[r][0] < freeHeap[smallest][0]) smallest = r;
          if (smallest === i) break;
          heapSwap(i, smallest);
          i = smallest;
        }
      }
      return top;
    };

    for (const item of items) {
      const startMs = item.start.getTime();
      let rowIndex: number;
      // Require a SWIMLANE_BAR_MIN_GAP_MS buffer between the previous bar's
      // end and this bar's start before they're allowed to share a row.
      // Without the buffer, back-to-back releases (e.g. one ending Apr 10,
      // next starting Apr 11) sit pressed up against each other and read
      // as one fused bar.
      if (freeHeap.length > 0 && freeHeap[0][0] + SWIMLANE_BAR_MIN_GAP_MS <= startMs) {
        // Reuse the row that became free earliest.
        const popped = heapPop();
        rowIndex = popped[1];
      } else {
        // No row is free (with enough gap) at this start — open a fresh one.
        rowIndex = rowCount;
        rowCount += 1;
      }
      heapPush([item.end.getTime(), rowIndex]);
      // Custom bars have no Jira progress data — skip schedule/status logic.
      const progressPercent = item.isCustomBar ? 0 : (() => {
        const total = item.fix.progressTotal || 0;
        const done = item.fix.progressDone || 0;
        return total ? Math.round((done / total) * 100) : 0;
      })();
      const progressInFlightPercent = item.isCustomBar ? 0 : getInFlightProgressPercent(
        item.fix.progressDone,
        item.fix.progressInProgress,
        item.fix.progressTotal
      );
      const status: FixStatus = item.isCustomBar ? 'not-started' : getScheduleStatus(
        item.fix.start,
        item.fix.release,
        item.fix.released,
        progressInFlightPercent,
        today
      );

      bars.push({ ...item, rowIndex, progressPercent, progressInFlightPercent, status, isCustomBar: item.isCustomBar, customBarColor: item.customBarColor, customBarShowName: item.customBarShowName });
    }

    return {
      id: lane.id,
      name: lane.name,
      bars,
      rowCount: Math.max(1, rowCount)
    };
  });

  // Preserve the user-authored lane order from the Swimlanes config panel.
  // Previously re-sorted by earliest-bar start date, which made the chart
  // order disagree with the UI above it (e.g. config said MGA → OFF → GPO
  // but the chart rendered OFF → MGA → GPO). The user's ordering intent wins.
  return laneRows;
};

// In milestone-view, fix versions render as a single diamond at their end
// date with a caption that floats above (or below) the diamond. Two
// milestones whose date ranges don't overlap can still visually collide:
// fix A's caption text extends rightward and crashes into fix B's diamond
// + caption. The standard `buildSwimlaneRows` packing only checks date-range
// overlap, so it leaves both on row 0 even though their visual footprints
// overlap.
//
// `repackSwimlaneForMilestoneView` re-runs the row-packing using each bar's
// **visual** footprint instead of its date range:
//   visualLeft  = diamondCenterPx - DIAMOND_HALF_WIDTH_PX
//   visualRight = max(diamondCenterPx + DIAMOND_HALF_WIDTH_PX,
//                     visualLeft + estimatedCaptionPxWidth)
// Bars are placed on the lowest row whose previous bar's visualRight is
// already past this bar's visualLeft (with a small safety gap).
//
// `chartWidthPx` comes from the dep-layer measurement (after first layout).
// Before measurement we fall back to a 1500px estimate — that's the typical
// desktop width and produces near-identical row assignments to the measured
// case for the vast majority of dashboards, which keeps first-frame packing
// close to the final packing and avoids a visible re-flow.
const repackSwimlaneForMilestoneView = (
  laneRows: SwimlaneRow[],
  range: Range,
  chartWidthPx: number
): SwimlaneRow[] => {
  const rangeMs = range.end.getTime() - range.start.getTime();
  if (rangeMs <= 0) return laneRows;

  // Visual constants (kept in sync with .gantt-lane-milestone-* CSS):
  //   - 12x12 diamond rotated 45° has a ~17px visual bounding box; half-width ≈ 8.5px.
  //   - Caption is 11px / 600 weight; ~6.5px per char is a good average for
  //     mixed-case sans-serif at that weight. Rounded up to 6.6 to stay
  //     conservative (better to over-bump than overlap).
  //   - The "!" external-deps badge prepended to the caption is ~12px wide
  //     plus a ~4px gap, so add 16px when present.
  //   - 4px safety gap so adjacent milestones never look glued together.
  const DIAMOND_HALF_WIDTH_PX = 8.5;
  const CHAR_WIDTH_PX = 6.6;
  const EXT_BADGE_PX = 16;
  const SAFETY_GAP_PX = 4;
  const effectiveChartPx = chartWidthPx > 0 ? chartWidthPx : 1500;
  const pxPerMs = effectiveChartPx / rangeMs;

  return laneRows.map((lane) => {
    if (lane.bars.length <= 1) return lane;

    // Sort bars by diamond x-position (end date). The original packing
    // sorted by start; in milestone view only the end date is visually
    // meaningful, so resort to make the left-to-right pass stable.
    const sortedBars = [...lane.bars].sort(
      (a, b) => a.clamped.end.getTime() - b.clamped.end.getTime()
    );

    // Min-heap keyed by visualRightPx so we can find the earliest-free row
    // in O(log r) rather than scanning all open rows — same approach as the
    // bar-packing heap in buildSwimlaneRows.
    // Heap entries: [visualRightPx, rowIndex].
    const freeHeap: Array<[number, number]> = [];
    let rowCount = 0;
    const msHeapSwap = (a: number, b: number) => {
      const t = freeHeap[a]; freeHeap[a] = freeHeap[b]; freeHeap[b] = t;
    };
    const msHeapPush = (entry: [number, number]) => {
      freeHeap.push(entry);
      let i = freeHeap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (freeHeap[p][0] <= freeHeap[i][0]) break;
        msHeapSwap(p, i); i = p;
      }
    };
    const msHeapPop = (): [number, number] => {
      const top = freeHeap[0];
      const last = freeHeap.pop()!;
      if (freeHeap.length > 0) {
        freeHeap[0] = last;
        let i = 0;
        const n = freeHeap.length;
        for (;;) {
          const l = i * 2 + 1; const r = l + 1; let s = i;
          if (l < n && freeHeap[l][0] < freeHeap[s][0]) s = l;
          if (r < n && freeHeap[r][0] < freeHeap[s][0]) s = r;
          if (s === i) break;
          msHeapSwap(i, s); i = s;
        }
      }
      return top;
    };

    const repacked: SwimlaneBar[] = [];

    for (const bar of sortedBars) {
      const diamondCenterPx =
        (bar.clamped.end.getTime() - range.start.getTime()) * pxPerMs;
      const visualLeftPx = diamondCenterPx - DIAMOND_HALF_WIDTH_PX;
      const captionChars = bar.fix.name?.length ?? 0;
      const hasExtBadge =
        Array.isArray(bar.fix.externalLinks) && bar.fix.externalLinks.length > 0;
      const captionWidthPx =
        captionChars * CHAR_WIDTH_PX + (hasExtBadge ? EXT_BADGE_PX : 0);
      // Caption sits above the diamond, left-aligned with the diamond's
      // left edge — so caption-right = visualLeft + captionWidth.
      const visualRightPx = Math.max(
        diamondCenterPx + DIAMOND_HALF_WIDTH_PX,
        visualLeftPx + captionWidthPx
      );

      let rowIndex: number;
      if (freeHeap.length > 0 && freeHeap[0][0] + SAFETY_GAP_PX <= visualLeftPx) {
        const popped = msHeapPop();
        rowIndex = popped[1];
      } else {
        rowIndex = rowCount;
        rowCount += 1;
      }
      msHeapPush([visualRightPx, rowIndex]);

      repacked.push({ ...bar, rowIndex });
    }

    return {
      ...lane,
      bars: repacked,
      rowCount: Math.max(1, rowCount)
    };
  });
};

const resolveAllowedFixIds = (fixVersions: FixVersion[], activeFixVersionIds: string[]) => {
  if (!activeFixVersionIds.length) return null;
  const byId = new Map(fixVersions.map((fix) => [fix.id, fix]));
  const byName = new Map<string, string[]>();
  fixVersions.forEach((fix) => {
    const list = byName.get(fix.name) || [];
    list.push(fix.id);
    byName.set(fix.name, list);
  });

  const allowed = new Set<string>();
  activeFixVersionIds.forEach((value) => {
    if (byId.has(value)) {
      allowed.add(value);
    }
  });
  activeFixVersionIds.forEach((value) => {
    if (byId.has(value)) return;
    const ids = byName.get(value);
    ids?.forEach((id) => allowed.add(id));
  });

  return allowed;
};

// Small inset at the left (and right) of the plot area so bars that sit at
// range.start / range.end have room around them for incoming arrowheads,
// hover-X buttons, and outgoing arrow-exit offsets. Without this, a bar
// anchored at the earliest date on the chart would leave nowhere to render
// its incoming arrow tip or the X-to-remove control, and they'd be clipped
// by the SVG viewBox / outer container's overflow:hidden. All consumers of
// `getPercent` (bars, ticks, grid lines, milestones, today overlay, dep
// arrows) shift together so alignment is preserved.
const PLOT_LEFT_BUFFER_PCT = 3;
const PLOT_RIGHT_BUFFER_PCT = 3;

const getPercent = (range: Range, date: Date) => {
  const totalDays = daysBetween(range.start, range.end) || 1;
  const offsetDays = daysBetween(range.start, date);
  const usableWidth = 100 - PLOT_LEFT_BUFFER_PCT - PLOT_RIGHT_BUFFER_PCT;
  return PLOT_LEFT_BUFFER_PCT + (offsetDays / totalDays) * usableWidth;
};

// The aggregated span shown when a collapsed initiative rolls its members up
// into a single bar: left/width as track percentages plus pre-formatted
// start/end labels for the tooltip.
type AggSpan = { left: number; width: number; startLabel: string; endLabel: string };

// Compute the aggregated span (earliest start → latest end) across a set of
// already-clamped member ranges. Shared by the swimlane and standard collapsed
// initiative renderers so date clamping, label formatting and bar geometry
// stay identical across modes. Returns null when no member has a dated range.
const computeAggSpan = (
  range: Range,
  clampedRanges: Array<{ start: Date; end: Date }>
): AggSpan | null => {
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;
  for (const c of clampedRanges) {
    if (!minStart || c.start < minStart) minStart = c.start;
    if (!maxEnd || c.end > maxEnd) maxEnd = c.end;
  }
  if (!minStart || !maxEnd) return null;
  const left = getPercent(range, minStart);
  return {
    left,
    width: Math.max(1, getPercent(range, maxEnd) - left),
    // Format the clamped Date values directly. Going through toISOString()
    // first would convert the local date-only values to UTC and could shift
    // the displayed day in non-UTC timezones.
    startLabel: minStart.toLocaleDateString('en-GB'),
    endLabel: maxEnd.toLocaleDateString('en-GB')
  };
};

// Monday (1) matches the UK/European week convention used across the UI.
const WEEK_START = 1;

const buildTicks = (range: Range) => {
  // Weekly ticks aligned to the start of each week. Use weekday arithmetic
  // (getDay()) rather than day-of-month (getDate() % 7) — the latter drifts
  // off the real week boundary near month ends because months don't contain
  // a whole number of weeks.
  const ticks: Date[] = [];
  const cursor = new Date(range.start);
  const offset = (cursor.getDay() - WEEK_START + 7) % 7;
  cursor.setDate(cursor.getDate() - offset);
  if (cursor < range.start) {
    cursor.setDate(cursor.getDate() + 7);
  }
  while (cursor <= range.end) {
    ticks.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return ticks;
};

const buildMonths = (range: Range) => {
  const months: Date[] = [];
  const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
  while (cursor <= range.end) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
};

// Quarter band starts (Jan/Apr/Jul/Oct 1st) spanning the range. Used by the
// 'quarter' time scale to label the top header band; months render as the
// sub-scale beneath.
const buildQuarters = (range: Range) => {
  const quarters: Date[] = [];
  const startQuarterMonth = Math.floor(range.start.getMonth() / 3) * 3;
  const cursor = new Date(range.start.getFullYear(), startQuarterMonth, 1);
  while (cursor <= range.end) {
    quarters.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 3);
  }
  return quarters;
};

const quarterLabel = (date: Date) => `Q${Math.floor(date.getMonth() / 3) + 1}`;

export type GanttCreateDependencyArgs = {
  fromId: string;
  toId: string;
  fromType: DependencyNodeType;
  toType: DependencyNodeType;
};

export type GanttProps = {
  fixVersions: FixVersion[];
  milestones: Milestone[];
  dependencies?: Dependency[];
  incrementStart: string;
  incrementEnd: string;
  jiraBaseUrl?: string | null;
  mode?: 'standard' | 'swimlane';
  /**
   * Timeline header granularity. 'month' (default) shows month bands with
   * weekly ticks beneath; 'quarter' shows quarter bands with month
   * subdivisions beneath. Grid lines stay at month boundaries in both.
   */
  timeScale?: 'month' | 'quarter';
  /** Optional callback so the Gantt's toolbar can render a Month/Quarter toggle. */
  onTimeScaleChange?: (scale: 'month' | 'quarter') => void;
  swimlanes?: Swimlane[];
  /**
   * Optional top-level grouping. In swimlane mode each initiative renders a
   * coloured left spine spanning its member lanes. Ignored unless
   * `showInitiatives` is true.
   */
  initiatives?: Initiative[];
  /** Master switch for the initiative grouping layer. */
  showInitiatives?: boolean;
  /** Collapse state for initiative spines (mirrors collapsedFixVersions). */
  collapsedInitiatives?: Set<string>;
  onToggleInitiative?: (id: string) => void;
  /**
   * Optional callback so the Gantt's own toolbar can render an
   * Initiatives on/off toggle alongside the other toolbar toggles.
   */
  onShowInitiativesChange?: (value: boolean) => void;
  activeFixVersionIds?: string[];
  showDependencies?: boolean;
  /**
   * When true, dependency arrows only render for user-created (manual)
   * dependencies. Jira-sourced links are filtered out.
   */
  dependenciesManualOnly?: boolean;
  /**
   * When true, released fix versions are filtered out of the chart entirely
   * (same chokepoint as the archived filter), so all downstream views —
   * rows, swimlane packing, dep arrows — only see unreleased work.
   */
  hideReleasedFixVersions?: boolean;
  /**
   * Optional callback so the Gantt's own toolbar can render a
   * Released shown / hidden toggle alongside the other toolbar toggles.
   */
  onHideReleasedFixVersionsChange?: (value: boolean) => void;
  /**
   * Swimlane-only: when true, each bar is replaced with a single diamond
   * milestone icon at its end date. Dependency arrows still render but
   * UAT/Live markers are suppressed — milestone rows are too short to
   * accommodate them.
   */
  swimlaneMilestoneView?: boolean;
  /**
   * Optional callback so the Gantt's own toolbar can render a
   * Bars / Milestones toggle. When provided, the toggle shows inline
   * with the refresh button instead of relying on the page filters.
   */
  onSwimlaneMilestoneViewChange?: (value: boolean) => void;
  /**
   * Optional callback so the Gantt's own toolbar can render a
   * Dependencies on/off toggle alongside the Bars / Milestones toggle.
   */
  onShowDependenciesChange?: (value: boolean) => void;
  collapsedFixVersions: Set<string>;
  collapsedEpics: Set<string>;
  onToggleFixVersion: (id: string) => void;
  onToggleEpic: (id: string) => void;
  /**
   * If provided, enables the manual-dependency create flow: hovering a bar
   * reveals a drag handle that creates an "A blocks B" dependency when
   * released over another bar.
   */
  onCreateDependency?: (args: GanttCreateDependencyArgs) => Promise<void> | void;
  /**
   * If provided, enables the manual-dependency remove flow: hovering a
   * manual dep line reveals a dot near the arrow tip; clicking removes it.
   */
  onRemoveDependency?: (overrideId: string) => Promise<void> | void;
  loading?: boolean;
  /**
   * If provided, renders a refresh button in the Gantt's top-right toolbar
   * that forces a re-fetch of the roadmap data from Jira. The button hides
   * itself while `loading` is true so the existing "Timeline loading" bar
   * is the only indicator on screen during a refetch.
   */
  onRefresh?: () => void;
  /** Named colour categories that can be assigned to swimlane bars (manual mode). */
  barColourCategories?: BarColourCategory[];
  /** Maps fixVersionId → BarColourCategory id (manual mode). */
  fixVersionColours?: Record<string, string>;
  /** How swimlane bars are coloured. Defaults to 'rag' (status colour). */
  colourMode?: BarColourMode;
  onColourModeChange?: (mode: BarColourMode) => void;
  onBarColourCategoriesChange?: (categories: BarColourCategory[]) => void;
  onFixVersionColoursChange?: (colours: Record<string, string>) => void;
  /** Per-group colour overrides for the auto modes, keyed by auto category id. */
  autoBarColours?: Record<string, string>;
  onAutoBarColoursChange?: (colours: Record<string, string>) => void;
  /** Project list used to label bars in 'project' colour mode. */
  projects?: Project[];
  /** User-defined custom bars rendered in the swimlane view. */
  customBars?: CustomBar[];
};

// Stable empty-array sentinels so default-parameter destructuring doesn't
// produce a new reference on every render (which would bust the laneRows
// useMemo and trigger an infinite measure-effect loop in tests).
const _EMPTY_CUSTOM_BARS: CustomBar[] = [];
const _EMPTY_DEPENDENCIES: Dependency[] = [];
const _EMPTY_PROJECTS: Project[] = [];

// Distinct, reasonably accessible palette used to auto-assign colours to
// project/swimlane/initiative groups. Cycles if a chart has more groups than
// entries. Users can override any individual colour via the manage modal.
const AUTO_COLOUR_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7',
];

export const Gantt: React.FC<GanttProps> = ({
  fixVersions: fixVersionsRaw,
  milestones,
  dependencies = _EMPTY_DEPENDENCIES,
  incrementStart,
  incrementEnd,
  jiraBaseUrl,
  mode = 'standard',
  timeScale = 'month',
  onTimeScaleChange,
  swimlanes = [],
  initiatives = [],
  showInitiatives = false,
  collapsedInitiatives,
  onToggleInitiative,
  onShowInitiativesChange,
  activeFixVersionIds = [],
  showDependencies = false,
  dependenciesManualOnly = false,
  hideReleasedFixVersions = false,
  onHideReleasedFixVersionsChange,
  swimlaneMilestoneView = false,
  onSwimlaneMilestoneViewChange,
  onShowDependenciesChange,
  collapsedFixVersions,
  collapsedEpics,
  onToggleFixVersion,
  onToggleEpic,
  onCreateDependency,
  onRemoveDependency,
  loading = false,
  onRefresh,
  barColourCategories = [],
  fixVersionColours = {},
  colourMode = 'rag',
  onColourModeChange,
  onBarColourCategoriesChange,
  onFixVersionColoursChange,
  autoBarColours = {},
  onAutoBarColoursChange,
  projects = _EMPTY_PROJECTS,
  customBars = _EMPTY_CUSTOM_BARS,
}) => {
  const [hoveredDependencyRow, setHoveredDependencyRow] = useState<string | null>(null);
  const hoverHideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real per-row pixel positions measured from the DOM. We need these because
  // row heights aren't uniform: fix-version rows have a progress bar + "% completed"
  // label that makes them taller than epic/story rows. Computing Y from a fixed
  // ROW_HEIGHT constant puts arrows in the wrong spot once the SVG viewBox gets
  // stretched by preserveAspectRatio="none" to match the real body height.
  type RowMetric = { top: number; height: number };
  const [rowMetrics, setRowMetrics] = useState<Map<string, RowMetric>>(() => new Map());
  const [measuredBodyHeight, setMeasuredBodyHeight] = useState(0);
  // Per-swimlane-bar geometry measured from the DOM, keyed by fix-version id.
  // Viewbox Y maps 1:1 to pixels (preserveAspectRatio="none" + matching
  // dependencyLayerHeight) so these pixel measurements are usable directly
  // by the SVG dep layer. Separate from rowMetrics because swimlane bars
  // don't share the `.gantt-row[data-row-id]` structure the standard mode uses.
  type SwimlaneBarMetric = { centerY: number; top: number; bottom: number };
  const [swimlaneBarMetrics, setSwimlaneBarMetrics] = useState<Map<string, SwimlaneBarMetric>>(
    () => new Map()
  );
  const [measuredSwimlaneBodyHeight, setMeasuredSwimlaneBodyHeight] = useState(0);
  // Pixel width of the swimlane dep layer. Needed because milestone
  // diamonds have a fixed ~10.5px offset from the date point (CSS, not SVG)
  // and the arrow marker extends a fixed 1.2% of width past the path endpoint
  // — so the "right" gap between the diamond and the arrow is a pixel value,
  // not a percentage. We convert pixels → percent on demand.
  const [swimlaneDepLayerWidthPx, setSwimlaneDepLayerWidthPx] = useState(0);
  // Rectangles (in dep-layer viewbox coords: x in 0..VIEWBOX_WIDTH, y in
  // pixels matching dependencyLayerHeight) where bar/milestone TEXT is
  // rendered. These are baked into an SVG <mask> so the dep paths get
  // "cut out" wherever they would otherwise paint over text — visually
  // achieving the "arrow runs beneath the text" effect (mockup option 6).
  // Populated by a useLayoutEffect that walks every element tagged with
  // `data-text-mask="1"` and converts its getBoundingClientRect into
  // dep-layer-relative viewbox units.
  type TextMaskRect = { x: number; y: number; w: number; h: number };
  const [swimlaneTextMaskRects, setSwimlaneTextMaskRects] = useState<TextMaskRect[]>([]);
  const range = useMemo(() => {
    const start = parseDate(incrementStart) || new Date();
    const end = parseDate(incrementEnd) || new Date();
    return { start, end };
  }, [incrementStart, incrementEnd]);

  // Hide archived fix versions across the whole chart. Jira marks a fix
  // version as archived once it's been wound up; keeping them visible
  // clutters the roadmap with releases nobody is actively planning
  // against. Filtering once here means every downstream consumer
  // (buildRows, swimlane packing, parentMaps, tooltip lookups, etc.)
  // automatically sees the trimmed list.
  const fixVersions = useMemo(
    () =>
      fixVersionsRaw.filter(
        (fix) => !fix.archived && !(hideReleasedFixVersions && fix.released)
      ),
    [fixVersionsRaw, hideReleasedFixVersions]
  );

  const cancelDependencyHoverHide = () => {
    if (hoverHideTimeout.current) {
      clearTimeout(hoverHideTimeout.current);
      hoverHideTimeout.current = null;
    }
  };

  const scheduleDependencyHoverHide = () => {
    cancelDependencyHoverHide();
    hoverHideTimeout.current = setTimeout(() => {
      setHoveredDependencyRow(null);
      hoverHideTimeout.current = null;
    }, 300);
  };

  const tickStride = useMemo(() => {
    const totalDays = daysBetween(range.start, range.end) || 1;
    const totalWeeks = Math.ceil(totalDays / 7);
    if (totalWeeks <= 18) return 1;
    if (totalWeeks <= 26) return 2;
    return 3;
  }, [range]);

  const baseUrl = jiraBaseUrl || '';
  const jiraBrowseBase = useMemo(() => {
    if (!jiraBaseUrl) return null;
    return `${jiraBaseUrl.replace(/\/$/, '')}/browse/`;
  }, [jiraBaseUrl]);
  const rows = useMemo(
    () => buildRows(fixVersions, collapsedFixVersions, collapsedEpics),
    [fixVersions, collapsedFixVersions, collapsedEpics]
  );
  const issueRowMap = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const allowedFixIds = useMemo(
    () => resolveAllowedFixIds(fixVersions, activeFixVersionIds),
    [fixVersions, activeFixVersionIds]
  );

  const swimlaneFixVersions = useMemo(() => {
    if (!allowedFixIds) return fixVersions;
    return fixVersions.filter((fix) => allowedFixIds.has(fix.id));
  }, [fixVersions, allowedFixIds]);

  const filteredSwimlanes = useMemo(() => {
    if (!allowedFixIds) return swimlanes;
    return swimlanes.map((lane) => ({
      ...lane,
      fixVersionIds: lane.fixVersionIds.filter((id) => allowedFixIds.has(id))
    }));
  }, [swimlanes, allowedFixIds]);

  const laneRows = useMemo(() => {
    // Only pass single-lane custom bars (swimlaneId !== null) into the row
    // packer. All-lanes bars (swimlaneId === null) are rendered as a separate
    // full-height overlay and don't participate in per-lane stacking.
    const singleLaneCustomBars = customBars.filter((cb) => cb.swimlaneId !== null);
    const base = buildSwimlaneRows(swimlaneFixVersions, filteredSwimlanes, range, singleLaneCustomBars);
    if (mode !== 'swimlane' || !swimlaneMilestoneView) return base;
    // Milestone view: re-pack rows by visual footprint (diamond + caption
    // pixel width) so two milestones that visually collide get bumped onto
    // separate rows. Dep-layer width is the chart's measured pixel width;
    // 0 before first layout — repackSwimlaneForMilestoneView falls back to
    // a 1500px estimate in that case.
    return repackSwimlaneForMilestoneView(base, range, swimlaneDepLayerWidthPx);
  }, [
    swimlaneFixVersions,
    filteredSwimlanes,
    range,
    mode,
    swimlaneMilestoneView,
    swimlaneDepLayerWidthPx,
    customBars
  ]);

  // Group lanes under their initiative for the left-spine layout. Each lane
  // entry carries its global render index so the alternating row tint stays
  // continuous across initiative boundaries. Lanes not assigned to any
  // initiative collect into a trailing "Ungrouped" block. Only meaningful in
  // swimlane mode with the initiative layer switched on.
  type InitiativeGroup = {
    id: string;
    name: string;
    colour?: string;
    collapsed: boolean;
    isUngrouped: boolean;
    laneCount: number;
    lanes: Array<{ lane: SwimlaneRow; laneIdx: number }>;
  };
  const initiativeGroups = useMemo<InitiativeGroup[]>(() => {
    if (mode !== 'swimlane' || !showInitiatives) return [];
    const laneById = new Map(laneRows.map((lane) => [lane.id, lane]));
    const used = new Set<string>();
    const groups: InitiativeGroup[] = [];
    let idx = 0;
    for (const init of initiatives) {
      const collapsed = collapsedInitiatives?.has(init.id) ?? false;
      const lanes: Array<{ lane: SwimlaneRow; laneIdx: number }> = [];
      for (const sid of init.swimlaneIds) {
        const lane = laneById.get(sid);
        if (!lane || used.has(sid)) continue;
        used.add(sid);
        // Collapsed groups don't render their lanes, so don't consume a
        // render index for them (keeps the alt-tint sequence unbroken).
        lanes.push({ lane, laneIdx: collapsed ? -1 : idx++ });
      }
      if (lanes.length === 0) continue;
      groups.push({
        id: init.id,
        name: init.name,
        colour: init.colour,
        collapsed,
        isUngrouped: false,
        laneCount: lanes.length,
        lanes
      });
    }
    const ungrouped = laneRows.filter((lane) => !used.has(lane.id));
    if (ungrouped.length > 0) {
      groups.push({
        id: '__ungrouped__',
        name: 'Ungrouped',
        collapsed: false,
        isUngrouped: true,
        laneCount: ungrouped.length,
        lanes: ungrouped.map((lane) => ({ lane, laneIdx: idx++ }))
      });
    }
    return groups;
  }, [mode, showInitiatives, initiatives, laneRows, collapsedInitiatives]);

  const initiativesActive =
    mode === 'swimlane' && showInitiatives && initiativeGroups.length > 0;

  // Precompute each collapsed swimlane-initiative's aggregated span once per
  // groups/range change. Without this the span was recomputed during render —
  // i.e. on every hover/mouse-move repaint — doing work proportional to all
  // member lane bars. Keyed off the memoised groups + range so it only reruns
  // when the data actually changes.
  const initiativeAggBars = useMemo(() => {
    const m = new Map<string, AggSpan | null>();
    for (const group of initiativeGroups) {
      if (!group.collapsed || group.isUngrouped) continue;
      const clamped = group.lanes.flatMap(({ lane }) =>
        lane.bars.map((bar) => bar.clamped)
      );
      m.set(group.id, computeAggSpan(range, clamped));
    }
    return m;
  }, [initiativeGroups, range]);

  // Standard-mode initiative grouping. Initiatives carry both `swimlaneIds`
  // (swimlane mode) and `fixVersionIds` (standard mode); here we use the
  // latter to group top-level fix-version rows under an initiative header.
  //
  // The `initiatives` / `collapsedInitiatives` props arrive with a fresh
  // identity on most renders (parent does `filters.initiatives || []`; the
  // Gantt default param is a new `[]`). Deriving stable string keys lets the
  // memos below — and crucially `visibleRows`, which feeds the row-measurement
  // layout effect — keep a stable identity when the content is unchanged,
  // avoiding an infinite measure→setState→render loop.
  // Encodes everything about the initiatives that affects standard-mode
  // rendering: id, name, colour, and member fix list — all in array order so
  // a reorder also changes the key. `standardInitiativeGroups` renders the
  // name/colour/order straight from this, so omitting any of them would leave
  // the grouped spine stale after an edit that didn't touch fix assignments.
  const initiativeFixVersionKey = useMemo(
    () =>
      mode === 'swimlane'
        ? ''
        : initiatives
            .map(
              (init) =>
                `${init.id}:${init.name ?? ''}:${init.colour ?? ''}:${(init.fixVersionIds ?? []).join(',')}`
            )
            .join('|'),
    [mode, initiatives]
  );
  const collapsedInitiativeKey = useMemo(
    () => (collapsedInitiatives ? [...collapsedInitiatives].sort().join(',') : ''),
    [collapsedInitiatives]
  );

  // Map of fixVersionId → owning initiative id (first wins — a fix can only
  // belong to one initiative).
  const fixInitiativeId = useMemo(() => {
    const m = new Map<string, string>();
    if (mode === 'swimlane') return m;
    initiatives.forEach((init) =>
      (init.fixVersionIds ?? []).forEach((fid) => {
        if (!m.has(fid)) m.set(fid, init.id);
      })
    );
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initiativeFixVersionKey]);

  const standardInitiativesActive =
    mode !== 'swimlane' && showInitiatives && fixInitiativeId.size > 0;

  // Resolve the active bar-colouring scheme into a flat category list (shown in
  // the legend / manage modal) plus a fixVersionId → categoryId map used to
  // colour each bar. The auto modes (project/swimlane/initiative) synthesise
  // categories from the data and assign palette colours by order; any colour a
  // user has overridden lives in `autoBarColours`. Manual mode reuses the
  // user-defined categories + per-bar assignments. RAG mode yields no
  // categories (bars keep their status colour).
  const colourGroups = useMemo<{
    categories: BarColourCategory[];
    fixToGroup: Map<string, string>;
  }>(() => {
    const fixToGroup = new Map<string, string>();

    if (colourMode === 'manual') {
      Object.entries(fixVersionColours).forEach(([fixId, catId]) =>
        fixToGroup.set(fixId, catId)
      );
      return { categories: barColourCategories, fixToGroup };
    }

    if (colourMode === 'project') {
      const projectNameByKey = new Map(projects.map((p) => [p.key, p.name]));
      const order: string[] = [];
      const seen = new Set<string>();
      laneRows.forEach((lane) =>
        lane.bars.forEach((bar) => {
          if (bar.isCustomBar) return;
          const key = bar.fix.projectKey || 'unknown';
          if (!seen.has(key)) {
            seen.add(key);
            order.push(key);
          }
          fixToGroup.set(bar.fix.id, `proj:${key}`);
        })
      );
      const categories = order.map((key, i) => ({
        id: `proj:${key}`,
        name: projectNameByKey.get(key) || key,
        colour: autoBarColours[`proj:${key}`] || AUTO_COLOUR_PALETTE[i % AUTO_COLOUR_PALETTE.length],
      }));
      return { categories, fixToGroup };
    }

    if (colourMode === 'swimlane') {
      const categories = laneRows.map((lane, i) => ({
        id: `lane:${lane.id}`,
        name: lane.name,
        colour: autoBarColours[`lane:${lane.id}`] || AUTO_COLOUR_PALETTE[i % AUTO_COLOUR_PALETTE.length],
      }));
      laneRows.forEach((lane) =>
        lane.bars.forEach((bar) => {
          if (!bar.isCustomBar) fixToGroup.set(bar.fix.id, `lane:${lane.id}`);
        })
      );
      return { categories, fixToGroup };
    }

    if (colourMode === 'initiative') {
      const laneToInit = new Map<string, string>();
      initiatives.forEach((init) =>
        init.swimlaneIds.forEach((sid) => laneToInit.set(sid, init.id))
      );
      const usedInit = new Set<string>();
      let hasUngrouped = false;
      laneRows.forEach((lane) => {
        const initId = laneToInit.get(lane.id);
        lane.bars.forEach((bar) => {
          if (bar.isCustomBar) return;
          if (initId) {
            usedInit.add(initId);
            fixToGroup.set(bar.fix.id, `init:${initId}`);
          } else {
            hasUngrouped = true;
            fixToGroup.set(bar.fix.id, 'init:__ungrouped__');
          }
        });
      });
      const categories: BarColourCategory[] = [];
      let paletteIdx = 0;
      initiatives.forEach((init) => {
        if (!usedInit.has(init.id)) return;
        categories.push({
          id: `init:${init.id}`,
          name: init.name,
          colour:
            autoBarColours[`init:${init.id}`] ||
            init.colour ||
            AUTO_COLOUR_PALETTE[paletteIdx++ % AUTO_COLOUR_PALETTE.length],
        });
      });
      if (hasUngrouped) {
        categories.push({
          id: 'init:__ungrouped__',
          name: 'Ungrouped',
          colour: autoBarColours['init:__ungrouped__'] || '#9ca3af',
        });
      }
      return { categories, fixToGroup };
    }

    return { categories: [], fixToGroup };
  }, [colourMode, barColourCategories, fixVersionColours, laneRows, initiatives, projects, autoBarColours]);

  // O(1) colour lookup by category id for the bar render loop.
  const catColourById = useMemo(
    () => new Map(colourGroups.categories.map((c) => [c.id, c.colour])),
    [colourGroups]
  );

  const parentMaps = useMemo(() => {
    const fixByEpic = new Map<string, string>();
    const fixByStory = new Map<string, string>();
    const epicByStory = new Map<string, string>();

    for (const fix of fixVersions) {
      for (const epic of fix.epics) {
        fixByEpic.set(epic.id, fix.id);
        for (const story of epic.stories || []) {
          fixByStory.set(story.id, fix.id);
          epicByStory.set(story.id, epic.id);
        }
      }
    }

    return { fixByEpic, fixByStory, epicByStory };
  }, [fixVersions]);

  const visibleRows = useMemo(() => {
    const items: VisibleRow[] = [];

    rows.forEach((row) => {
      const parentFixId =
        row.parentFixId ||
        (row.type === 'epic'
          ? parentMaps.fixByEpic.get(row.id)
          : row.type === 'story'
          ? parentMaps.fixByStory.get(row.id)
          : undefined);
      const parentEpicId =
        row.parentEpicId || (row.type === 'story' ? parentMaps.epicByStory.get(row.id) : undefined);

      if (row.type !== 'fix' && parentFixId && collapsedFixVersions.has(parentFixId)) {
        return;
      }
      if (row.type === 'story' && parentEpicId && collapsedEpics.has(parentEpicId)) {
        return;
      }

      items.push({
        row,
        parentFixId,
        parentEpicId,
        clamped: clampRange(range, row.start, row.end),
        index: items.length
      });
    });

    if (standardInitiativesActive) {
      // Group each top-level fix version with its epic/story descendants into
      // contiguous blocks, then order the blocks by initiative so grouped rows
      // render under their initiative header. Fixes whose initiative is
      // collapsed are dropped entirely (the header still renders separately).
      // Ungrouped fixes trail in their original order. Re-indexing keeps every
      // downstream consumer (dep edges, bar metrics, row measurement) aligned
      // with the rendered order.
      const blocks: VisibleRow[][] = [];
      items.forEach((it) => {
        if (it.row.type === 'fix' || blocks.length === 0) blocks.push([it]);
        else blocks[blocks.length - 1].push(it);
      });
      const order = new Map<string, number>();
      initiatives.forEach((init, i) => order.set(init.id, i));
      const rankOf = (block: VisibleRow[]) => {
        const initId = fixInitiativeId.get(block[0].row.id);
        return initId !== undefined
          ? order.get(initId) ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER;
      };
      const reordered: VisibleRow[] = [];
      blocks
        .map((b, i) => ({ b, i }))
        .sort((a, z) => rankOf(a.b) - rankOf(z.b) || a.i - z.i)
        .forEach(({ b }) => {
          const initId = fixInitiativeId.get(b[0].row.id);
          if (initId && collapsedInitiatives?.has(initId)) return;
          reordered.push(...b);
        });
      return reordered.map((it, i) => ({ ...it, index: i }));
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    parentMaps,
    collapsedFixVersions,
    collapsedEpics,
    range,
    standardInitiativesActive,
    fixInitiativeId,
    collapsedInitiativeKey
  ]);

  // Standard-mode initiative groups (header + member fix ids). Built from the
  // full top-level fix list so collapsed initiatives still surface a header
  // even though their rows are absent from `visibleRows`.
  type StandardInitiativeGroup = {
    id: string;
    name: string;
    colour?: string;
    collapsed: boolean;
    isUngrouped: boolean;
    fixIds: string[];
  };
  const standardInitiativeGroups = useMemo<StandardInitiativeGroup[]>(() => {
    if (!standardInitiativesActive) return [];
    const fixIdsInOrder: string[] = [];
    rows.forEach((r) => {
      if (r.type === 'fix') fixIdsInOrder.push(r.id);
    });
    const fixSet = new Set(fixIdsInOrder);
    const groups: StandardInitiativeGroup[] = [];
    const used = new Set<string>();
    initiatives.forEach((init) => {
      const memberFixes = (init.fixVersionIds ?? []).filter(
        (fid) => fixSet.has(fid) && !used.has(fid)
      );
      if (memberFixes.length === 0) return;
      memberFixes.forEach((fid) => used.add(fid));
      groups.push({
        id: init.id,
        name: init.name,
        colour: init.colour,
        collapsed: collapsedInitiatives?.has(init.id) ?? false,
        isUngrouped: false,
        fixIds: memberFixes
      });
    });
    const ungrouped = fixIdsInOrder.filter((fid) => !used.has(fid));
    if (ungrouped.length > 0) {
      groups.push({
        id: '__ungrouped__',
        name: 'Ungrouped',
        collapsed: false,
        isUngrouped: true,
        fixIds: ungrouped
      });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standardInitiativesActive, rows, initiativeFixVersionKey, collapsedInitiativeKey]);

  // Precompute each collapsed standard-initiative's aggregated span. Same
  // motivation as `initiativeAggBars`: keep this off the render path so hover /
  // mouse-move repaints don't rescan every member fix version. Keyed off the
  // memoised groups + range + row lookup so it only reruns on real changes.
  const standardInitiativeAggBars = useMemo(() => {
    const m = new Map<string, AggSpan | null>();
    for (const group of standardInitiativeGroups) {
      if (!group.collapsed || group.isUngrouped) continue;
      const clamped: Array<{ start: Date; end: Date }> = [];
      for (const fid of group.fixIds) {
        const fixRow = issueRowMap.get(fid);
        if (!fixRow) continue;
        const c = clampRange(range, fixRow.start, fixRow.end);
        if (c) clamped.push(c);
      }
      m.set(group.id, computeAggSpan(range, clamped));
    }
    return m;
  }, [standardInitiativeGroups, range, issueRowMap]);

  // visibleRows keyed by their owning top-level fix version, so a group's rows
  // can be emitted in initiative order during render.
  const standardRowsByFix = useMemo(() => {
    const m = new Map<string, VisibleRow[]>();
    if (!standardInitiativesActive) return m;
    visibleRows.forEach((it) => {
      const fid = it.row.type === 'fix' ? it.row.id : it.parentFixId;
      if (!fid) return;
      const arr = m.get(fid);
      if (arr) arr.push(it);
      else m.set(fid, [it]);
    });
    return m;
  }, [standardInitiativesActive, visibleRows]);

  // Manual-only filter: when enabled, drop all Jira-sourced dependencies
  // and keep only the user-added overrides. Applied here (once) so every
  // downstream consumer — edges, line layout, dep list rendering — sees
  // the same filtered set without each needing its own check.
  const effectiveDependencies = useMemo(() => {
    if (!dependenciesManualOnly) return dependencies;
    return dependencies.filter((dep) => dep.source === 'manual');
  }, [dependencies, dependenciesManualOnly]);

  const dependencyEdges = useMemo(() => {
    if (!showDependencies || effectiveDependencies.length === 0) return [];
    const rowMap = new Map(visibleRows.map((item) => [item.row.id, item]));
    const edges: DependencyEdge[] = [];
    // Track the position of each row-pair's edge so we can upgrade the
    // warning flag if a later duplicate happens to be a warning.
    const seenIdx = new Map<string, number>();

    const resolveRow = (issueId: string): VisibleRow | null => {
      // Prefer the most specific visible row. If the issue's own row is
      // visible (e.g. expanded fix version → visible epic/story, or the
      // issue itself IS a fix version), draw on it. Only roll up to an
      // ancestor when the direct row isn't visible — then we still walk
      // epic → fix-version so collapsed views still render arrows.
      const direct = rowMap.get(issueId);
      if (direct) return direct;

      const epicId = parentMaps.epicByStory.get(issueId);
      if (epicId) {
        const epicRow = rowMap.get(epicId);
        if (epicRow) return epicRow;
      }

      const fixIdFromStory = parentMaps.fixByStory.get(issueId);
      if (fixIdFromStory) {
        const fixRow = rowMap.get(fixIdFromStory);
        if (fixRow) return fixRow;
      }

      const fixIdFromEpic = parentMaps.fixByEpic.get(issueId);
      if (fixIdFromEpic) {
        const fixRow = rowMap.get(fixIdFromEpic);
        if (fixRow) return fixRow;
      }

      return null;
    };

    effectiveDependencies.forEach((dep) => {
      const fromRow = resolveRow(dep.fromId);
      const toRow = resolveRow(dep.toId);
      if (!fromRow || !toRow) return;
      if (fromRow.row.id === toRow.row.id) return;

      const fromRowStart = parseDate(fromRow.row.start);
      const fromRowEnd = parseDate(fromRow.row.end) || fromRowStart;
      const toRowStart = parseDate(toRow.row.start);
      const toRowEnd = parseDate(toRow.row.end) || toRowStart;
      if (!fromRowStart || !fromRowEnd || !toRowStart || !toRowEnd) return;

      const fromIssue = issueRowMap.get(dep.fromId);
      const toIssue = issueRowMap.get(dep.toId);
      const fromIssueStart = parseDate(fromIssue?.start) || fromRowStart;
      const fromIssueEnd = parseDate(fromIssue?.end) || fromRowEnd;
      const toIssueStart = parseDate(toIssue?.start) || toRowStart;
      const toIssueEnd = parseDate(toIssue?.end) || toRowEnd;

      // A dependency is flagged when the successor starts before the
      // predecessor finishes (sequential overlap).
      const warning = toIssueStart < fromIssueEnd;

      // Collapse all deps between the same two rows into one arrow.
      // If any collapsed dep is a warning, the merged arrow keeps the
      // warning style so the signal isn't lost.
      const key = `${fromRow.row.id}-${toRow.row.id}`;
      const existingIdx = seenIdx.get(key);
      if (existingIdx !== undefined) {
        if (warning) edges[existingIdx].warning = true;
        // If either edge in the merge is manual, the collapsed arrow has to
        // carry the manual metadata — otherwise the merged arrow renders as
        // a Jira edge and the user can't remove the manual override from the
        // chart. Last-manual-wins for overrideId, which matches the
        // single-edge behaviour at the push site below.
        if (dep.source === 'manual' && edges[existingIdx].source !== 'manual') {
          edges[existingIdx].source = 'manual';
          edges[existingIdx].overrideId = dep.id ?? null;
        }
        return;
      }
      seenIdx.set(key, edges.length);

      // Use the row's CLAMPED dates so the arrow endpoints line up with the
      // actual rendered bar edges. If we used raw row.start/end here, a row
      // whose true start is before the visible window would have its arrow
      // anchored to a date that lies off-screen — and the corresponding bar
      // would have been clamped to range.start, leaving the arrow tip
      // floating inside the bar (visual: arrowhead clips into the bar).
      const fromBarEnd = fromRow.clamped ? fromRow.clamped.end : fromRowEnd;
      const fromBarStart = fromRow.clamped ? fromRow.clamped.start : fromRowStart;
      const toBarStart = toRow.clamped ? toRow.clamped.start : toRowStart;
      const fromX = getPercent(range, fromBarEnd);
      const toX = getPercent(range, toBarStart);
      const fromStartX = getPercent(range, fromBarStart);
      // Prefer measured row positions so we handle variable-height rows
      // (fix-version rows with progress bars are taller than epic/story rows).
      // The track is always centered within the row (`align-items: center`),
      // so row-center == bar-center regardless of row height.
      // Fallback to the constants-based estimate before the first measurement.
      const fromMetric = rowMetrics.get(fromRow.row.id);
      const toMetric = rowMetrics.get(toRow.row.id);
      const fromY = fromMetric
        ? fromMetric.top + fromMetric.height / 2
        : fromRow.index * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
      const toY = toMetric
        ? toMetric.top + toMetric.height / 2
        : toRow.index * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;

      edges.push({
        fromId: dep.fromId,
        toId: dep.toId,
        fromRowId: fromRow.row.id,
        toRowId: toRow.row.id,
        fromX,
        toX,
        fromStartX,
        fromY,
        toY,
        warning,
        source: dep.source === 'manual' ? 'manual' : 'jira',
        overrideId: dep.source === 'manual' ? dep.id ?? null : null,
        fromRowIdx: fromRow.index,
        toRowIdx: toRow.index
      });
    });

    return edges;
  }, [effectiveDependencies, visibleRows, showDependencies, mode, range, parentMaps, issueRowMap, rowMetrics]);

  // Per-row bar geometry in SVG viewbox coordinates — feeds the channel
  // picker so horizontal segments of the dep path avoid crossing other bars.
  const rowBars = useMemo<Array<RowBarMeta | null>>(() => {
    return visibleRows.map(({ clamped, index, row }) => {
      if (!clamped) return null;
      // The track (28px, fixed) is centered vertically inside the row via
      // `align-items: center`, and the bar sits at top:5 inside the track.
      // So barTop = row.top + (row.height - 28) / 2 + 5, regardless of the
      // row's overall height.
      const metric = rowMetrics.get(row.id);
      const barTop = metric
        ? metric.top + (metric.height - 28) / 2 + BAR_TOP
        : index * (ROW_HEIGHT + ROW_GAP) + BAR_TOP;
      const barBottom = barTop + BAR_HEIGHT;
      const leftPct = getPercent(range, clamped.start);
      const rightPct = Math.max(leftPct + 0.01, getPercent(range, clamped.end));
      return { barTop, barBottom, leftPct, rightPct } satisfies RowBarMeta;
    });
  }, [visibleRows, range, rowMetrics]);

  const dependencyLinks = useMemo(() => {
    if (!showDependencies || effectiveDependencies.length === 0) {
      return {
        byRow: new Map<string, { incoming: DependencyLink[]; outgoing: DependencyLink[] }>(),
        related: new Map<string, Set<string>>()
      };
    }

    const rowMap = new Map(visibleRows.map((item) => [item.row.id, item]));
    const resolveRowId = (issueId: string): string | null => {
      // Mirror resolveRow in dependencyEdges: prefer the direct row when
      // visible, then walk up epic → fix-version for collapsed ancestors.
      const direct = rowMap.get(issueId);
      if (direct) return direct.row.id;
      const epicId = parentMaps.epicByStory.get(issueId);
      if (epicId && rowMap.get(epicId)) return epicId;
      const fixIdFromStory = parentMaps.fixByStory.get(issueId);
      if (fixIdFromStory && rowMap.get(fixIdFromStory)) return fixIdFromStory;
      const fixIdFromEpic = parentMaps.fixByEpic.get(issueId);
      if (fixIdFromEpic && rowMap.get(fixIdFromEpic)) return fixIdFromEpic;
      return null;
    };

    const byRow = new Map<string, { incoming: DependencyLink[]; outgoing: DependencyLink[] }>();
    const related = new Map<string, Set<string>>();
    const seen = new Set<string>();

    const ensureRow = (rowId: string) => {
      if (!byRow.has(rowId)) {
        byRow.set(rowId, { incoming: [], outgoing: [] });
      }
      return byRow.get(rowId)!;
    };

    const addRelated = (rowId: string, otherId: string) => {
      const set = related.get(rowId) || new Set<string>();
      set.add(rowId);
      set.add(otherId);
      related.set(rowId, set);
    };

    effectiveDependencies.forEach((dep) => {
      const fromRowId = resolveRowId(dep.fromId);
      const toRowId = resolveRowId(dep.toId);
      if (!fromRowId || !toRowId || fromRowId === toRowId) return;

      const outgoingKey = dep.toKey || dep.toId;
      const incomingKey = dep.fromKey || dep.fromId;
      const outgoingUrl = dep.toKey && jiraBrowseBase ? `${jiraBrowseBase}${dep.toKey}` : null;
      const incomingUrl = dep.fromKey && jiraBrowseBase ? `${jiraBrowseBase}${dep.fromKey}` : null;
      // Prefer the row's display label (release / epic name) over the raw
      // Jira key so the popup reads naturally even for manual deps that
      // don't carry a ticket key.
      const fromLabel = rowMap.get(fromRowId)?.row.label ?? null;
      const toLabel = rowMap.get(toRowId)?.row.label ?? null;

      const outgoingId = `${fromRowId}->${toRowId}:${outgoingKey}`;
      if (!seen.has(outgoingId)) {
        ensureRow(fromRowId).outgoing.push({ key: outgoingKey, label: toLabel, url: outgoingUrl, rowId: toRowId });
        ensureRow(toRowId).incoming.push({ key: incomingKey, label: fromLabel, url: incomingUrl, rowId: fromRowId });
        seen.add(outgoingId);
      }

      addRelated(fromRowId, toRowId);
      addRelated(toRowId, fromRowId);
    });

    return { byRow, related };
  }, [effectiveDependencies, showDependencies, mode, visibleRows, parentMaps, jiraBrowseBase]);

  const highlightedRows = useMemo(() => {
    if (!hoveredDependencyRow) return null;
    return dependencyLinks.related.get(hoveredDependencyRow) || new Set([hoveredDependencyRow]);
  }, [hoveredDependencyRow, dependencyLinks]);

  const dependencyMeta = useMemo(() => {
    if (!showDependencies || dependencyEdges.length === 0) {
      return {
        incoming: new Map<string, number>(),
        outgoing: new Map<string, number>(),
        warnings: new Map<string, boolean>(),
        outgoingSegments: new Map<string, { left: number; width: number; warning: boolean }[]>()
      };
    }

    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    const warnings = new Map<string, boolean>();
    const outgoingSegments = new Map<string, { left: number; width: number; warning: boolean }[]>();

    dependencyEdges.forEach((edge) => {
      // Counts must be keyed by the resolved row id, not the raw issue id —
      // a dep's target issue may roll up into a parent fix/epic row, so
      // keying by issue id would leave the parent row with a count of zero
      // and the badge would never render even though the arrow draws in.
      incoming.set(edge.toRowId, (incoming.get(edge.toRowId) || 0) + 1);
      outgoing.set(edge.fromRowId, (outgoing.get(edge.fromRowId) || 0) + 1);
      if (edge.warning) {
        warnings.set(edge.fromRowId, true);
        warnings.set(edge.toRowId, true);
      }

      // Chip sits on the SOURCE row and marks the GAP between the source
      // bar's right edge and the target bar's left edge. We only draw it
      // for forward edges (target after source); for warning edges where
      // the target is earlier than the source (toX < fromX), the chip
      // would otherwise land UNDER the source bar, producing a visible
      // orange stub on the bar's left/underside — skip it entirely and
      // let the arrow itself carry the warning signal.
      if (edge.toX > edge.fromX) {
        const left = edge.fromX;
        const width = Math.max(0.5, edge.toX - edge.fromX);
        const segments = outgoingSegments.get(edge.fromRowId) || [];
        segments.push({ left, width, warning: edge.warning });
        outgoingSegments.set(edge.fromRowId, segments);
      }
    });

    return { incoming, outgoing, warnings, outgoingSegments };
  }, [dependencyEdges, showDependencies, mode]);

  // For any target row with two or more cross-row incoming edges, compute
  // a shared "approach" x where all those edges will join a common vertical
  // spine and merge into a single arrow on the target. Same-row edges are
  // excluded (they have their own straight-across routing). Backward edges
  // (target earlier than source) are excluded per-edge in the renderer —
  // their spine would sit behind the source bar and look wrong.
  const approachXByTarget = useMemo(() => {
    if (!showDependencies || dependencyEdges.length === 0) {
      return new Map<string, number>();
    }
    // Group cross-row edges by their target row. A "hub" is any target with
    // 2+ incoming cross-row edges — those are the ones that get a shared
    // vertical spine so the arrows visually merge on approach.
    const groupEdges = new Map<string, DependencyEdge[]>();
    for (const edge of dependencyEdges) {
      if (edge.fromRowIdx === edge.toRowIdx) continue;
      const bucket = groupEdges.get(edge.toRowId) || [];
      bucket.push(edge);
      groupEdges.set(edge.toRowId, bucket);
    }
    const hubs: Array<{ toRowId: string; toX: number; rightmostSourceX: number }> = [];
    for (const [toRowId, edges] of groupEdges) {
      if (edges.length < 2) continue;
      const toX = edges[0].toX;
      const rightmostSourceX = edges.reduce(
        (max, edge) => Math.max(max, edge.fromX),
        -Infinity
      );
      hubs.push({ toRowId, toX, rightmostSourceX });
    }
    const map = new Map<string, number>();
    if (hubs.length === 0) return map;

    // Global spine: a single X column every hub shares, so the vertical
    // trunks from every hub stack on the same line instead of each sitting
    // in its own column side-by-side. The column is placed just past the
    // rightmost source across all hubs, clamped so it doesn't overlap any
    // hub's target. If no column satisfies all hubs (e.g. one hub's target
    // sits to the left of another hub's rightmost source), we fall back to
    // per-hub spines so each hub still merges locally.
    const globalRightmostSource = hubs.reduce(
      (max, hub) => Math.max(max, hub.rightmostSourceX),
      -Infinity
    );
    const earliestTargetX = hubs.reduce(
      (min, hub) => Math.min(min, hub.toX),
      Infinity
    );
    const globalCandidate = globalRightmostSource + APPROACH_SPINE_SOURCE_BUFFER_PCT;
    const globalAllowed = earliestTargetX - APPROACH_SPINE_MIN_GAP_PCT;
    if (globalCandidate <= globalAllowed) {
      // One column works for every hub — use it for all of them.
      for (const hub of hubs) {
        map.set(hub.toRowId, globalCandidate);
      }
      return map;
    }

    // Fallback: per-hub spines (original per-target behaviour). Each hub's
    // spine hugs its own rightmost source, clamped to its own target tip.
    for (const hub of hubs) {
      const dynamic = hub.rightmostSourceX + APPROACH_SPINE_SOURCE_BUFFER_PCT;
      const nearTarget = hub.toX - APPROACH_SPINE_MIN_GAP_PCT;
      map.set(hub.toRowId, dynamic <= nearTarget ? dynamic : nearTarget);
    }
    return map;
  }, [dependencyEdges, showDependencies]);

  // Shared fix-id → bar lookup for swimlane mode. Lifted out of
  // swimlaneDependencyEdges so the drag-preview path can reuse it on every
  // pointer-move without re-scanning every lane × bar — that nested scan
  // used to be O(total bars) per move and made dependency creation choppy
  // on dense dashboards. Recomputed only when laneRows changes.
  type SwimlaneBarInfo = { fix: FixVersion; clamped: Range };
  const swimlaneBarById = useMemo(() => {
    const map = new Map<string, SwimlaneBarInfo>();
    if (mode !== 'swimlane') return map;
    laneRows.forEach((lane) => {
      lane.bars.forEach((bar) => {
        map.set(bar.fix.id, { fix: bar.fix, clamped: bar.clamped });
      });
    });
    return map;
  }, [mode, laneRows]);

  // Parallel dependency-edge list for swimlane mode. Swimlane bars don't
  // live in visibleRows (they live inside lane tracks) so we can't reuse the
  // standard `dependencyEdges` memo — rowMetrics has no entries for lane bars
  // and the edge routing helpers assume the standard row layout. Instead we
  // build a simpler edge list keyed on fix-version ids, using the measured
  // swimlane bar Y positions from `swimlaneBarMetrics` and X positions derived
  // from the clamped range the lane bars were drawn from.
  const swimlaneDependencyEdges = useMemo(() => {
    type SwimlaneEdge = {
      edgeKey: string;
      fromId: string;
      toId: string;
      fromX: number; // source bar right edge, in percent
      toX: number;   // target bar left edge, in percent
      fromY: number; // source bar centre, in viewbox/pixel units
      toY: number;   // target bar centre, in viewbox/pixel units
      warning: boolean;
      source: 'jira' | 'manual';
      overrideId: string | null;
    };
    if (mode !== 'swimlane' || !showDependencies || effectiveDependencies.length === 0) {
      return [] as SwimlaneEdge[];
    }
    const barById = swimlaneBarById;

    // Only fix versions render in swimlane. If a dep references an epic or
    // story, roll it up to its owning fix version if that fix is visible.
    const resolveFixId = (issueId: string): string | null => {
      if (barById.has(issueId)) return issueId;
      const fixFromEpic = parentMaps.fixByEpic.get(issueId);
      if (fixFromEpic && barById.has(fixFromEpic)) return fixFromEpic;
      const fixFromStory = parentMaps.fixByStory.get(issueId);
      if (fixFromStory && barById.has(fixFromStory)) return fixFromStory;
      return null;
    };

    const edges: SwimlaneEdge[] = [];
    const seenIdx = new Map<string, number>();

    effectiveDependencies.forEach((dep) => {
      const fromFixId = resolveFixId(dep.fromId);
      const toFixId = resolveFixId(dep.toId);
      if (!fromFixId || !toFixId || fromFixId === toFixId) return;
      const fromMetric = swimlaneBarMetrics.get(fromFixId);
      const toMetric = swimlaneBarMetrics.get(toFixId);
      // Before first measurement (or if a lane is empty) we skip — the
      // measurement effect will re-fire when the bars mount and trigger a
      // fresh memo pass.
      if (!fromMetric || !toMetric) return;
      const fromBar = barById.get(fromFixId)!;
      const toBar = barById.get(toFixId)!;

      // Milestone diamond geometry (pixels — fixed regardless of track
      // width because the diamond lives in HTML/CSS, not the SVG):
      //   `.gantt-lane-milestone` has display:flex; gap:6px;
      //   transform:translateX(-8px). The diamond is the first flex child
      //   (12x12, rotated 45°). That puts its layout box at [date-8,
      //   date+4], centre at date-2. Rotation gives visual vertices:
      //     right vertex ≈ date + 6.5px
      //     left  vertex ≈ date - 10.5px
      // For forward deps we want the path to:
      //   - START just past the source's right vertex (tiny clearance)
      //   - END at `toX`, which is treated by `buildSwimlanePath` as
      //     the position where the visible arrow TIP lands (the path
      //     itself is shortened internally by the marker length, so we
      //     must NOT compensate for the marker here — that would be
      //     double-counting and push the tip well before the diamond).
      const MILESTONE_RIGHT_VERTEX_PX = 6.5;
      const MILESTONE_LEFT_VERTEX_PX = 10.5;
      // Source-side: tiny clearance so the line emerges visibly past
      // the right vertex without floating. Target-side: small positive
      // clearance so the arrow's visible TIP stops just before the
      // diamond's left vertex — zero was reading as the tip clipping
      // INTO the diamond at typical track widths.
      const MILESTONE_SOURCE_CLEARANCE_PX = 2;
      const MILESTONE_TARGET_CLEARANCE_PX = 2;
      // The bar has a 4px border-radius on the right corners; a ~1.5px
      // clearance past the visual right edge lets the dep line visibly
      // emerge from OUTSIDE the bar rather than blending into the curve.
      const BAR_DEP_EXIT_PX = 1.5;
      // Same idea on the target side for bars: a small clearance so the
      // arrow head stops a few px BEFORE the bar's left edge instead of
      // intercepting the bar fill / in-bar text. 2px wasn't enough — the
      // bar's 1px outline + 4px border-radius eat into the visual gap so
      // the arrowhead still merged into the bar edge. 5px gives the tip
      // a clearly visible runway.
      const BAR_DEP_TARGET_PX = 5;
      // Convert px → layer-percent. Falls back to a small percent when we
      // haven't measured the layer yet (first paint before effect runs).
      const pxToPct = (px: number): number =>
        swimlaneDepLayerWidthPx > 0 ? (px / swimlaneDepLayerWidthPx) * 100 : px * 0.1;
      const milestoneSourceGapPct = pxToPct(MILESTONE_RIGHT_VERTEX_PX + MILESTONE_SOURCE_CLEARANCE_PX);
      const milestoneTargetGapPct = pxToPct(MILESTONE_LEFT_VERTEX_PX + MILESTONE_TARGET_CLEARANCE_PX);
      const barDepExitPct = pxToPct(BAR_DEP_EXIT_PX);
      const barDepTargetGapPct = pxToPct(BAR_DEP_TARGET_PX);
      // Mirror the render-side `Math.max(1, endPct - startPct)` clamp so
      // very short bars (< 1% of the range) start their dep line from the
      // bar's VISUAL right edge, not the raw end-date position.
      const fromStartPct = getPercent(range, fromBar.clamped.start);
      const fromEndPct = getPercent(range, fromBar.clamped.end);
      const fromVisualRightPct = Math.max(fromEndPct, fromStartPct + 1);
      const fromX = swimlaneMilestoneView
        ? fromEndPct + milestoneSourceGapPct
        : fromVisualRightPct + barDepExitPct;
      const toX = swimlaneMilestoneView
        ? getPercent(range, toBar.clamped.end) - milestoneTargetGapPct
        : getPercent(range, toBar.clamped.start) - barDepTargetGapPct;

      // Warning detection mirrors standard mode: flag when the successor
      // starts before the predecessor finishes (sequential overlap). Use the
      // fix-version raw dates since we don't roll down to the issue level here.
      const fromIssue = issueRowMap.get(dep.fromId);
      const toIssue = issueRowMap.get(dep.toId);
      const fromIssueEnd =
        parseDate(fromIssue?.end) || parseDate(fromBar.fix.release) || parseDate(fromBar.fix.start);
      const toIssueStart =
        parseDate(toIssue?.start) || parseDate(toBar.fix.start);
      const warning = Boolean(fromIssueEnd && toIssueStart && toIssueStart < fromIssueEnd);

      const key = `${fromFixId}-${toFixId}`;
      const existingIdx = seenIdx.get(key);
      if (existingIdx !== undefined) {
        if (warning) edges[existingIdx].warning = true;
        if (dep.source === 'manual' && edges[existingIdx].source !== 'manual') {
          edges[existingIdx].source = 'manual';
          edges[existingIdx].overrideId = dep.id ?? null;
        }
        return;
      }
      seenIdx.set(key, edges.length);

      edges.push({
        edgeKey: `sl-${fromFixId}-${toFixId}`,
        fromId: fromFixId,
        toId: toFixId,
        fromX,
        toX,
        fromY: fromMetric.centerY,
        toY: toMetric.centerY,
        warning,
        source: dep.source === 'manual' ? 'manual' : 'jira',
        overrideId: dep.source === 'manual' ? dep.id ?? null : null
      });
    });

    return edges;
  }, [
    mode,
    showDependencies,
    effectiveDependencies,
    laneRows,
    swimlaneBarById,
    swimlaneBarMetrics,
    parentMaps,
    range,
    issueRowMap,
    swimlaneMilestoneView,
    swimlaneDepLayerWidthPx
  ]);

  // Source-bundling for swimlane dep lines (Strategy B, see
  // dep-bundling-mockup.html): when one fix version blocks several others,
  // each outgoing arrow currently leaves the source independently, so a
  // release with 4 downstream deps fans out as 4 separate lines from the
  // bar's right edge. That stacks up visually fast.
  //
  // Bundling collapses those into one shared trunk: every forward edge from
  // the same source forks at the same X (a small "stub" past the source's
  // right edge). The trunk segment is drawn once per edge but lines overlap
  // perfectly, so it reads as a single outgoing line that branches at the
  // trunk. A junction dot at the fork makes the branching explicit.
  //
  // Backward edges (target sits to the LEFT of source) keep their existing
  // gutter routing — they already share gutter highways and bundling them
  // would conflict with that routing.
  //
  // Only sources with 2+ forward outgoing edges get bundled; singletons keep
  // the natural midpoint routing (no behaviour change).
  const SWIMLANE_DEP_TRUNK_STUB_PCT = 1.5;
  // Mirrors SWIMLANE_DEP_TRUNK_STUB_PCT but on the TARGET side: how far back
  // from the arrow tip the shared bus sits. 1.5% is wide enough to read as
  // a clear merge point on standard chart widths, narrow enough to not
  // overlap the source side.
  const SWIMLANE_DEP_BUS_BACK_PCT = 1.5;
  const swimlaneBundleByFromId = useMemo(() => {
    const out = new Map<string, { trunkX: number; fromY: number }>();
    if (mode !== 'swimlane' || swimlaneDependencyEdges.length === 0) return out;
    // Mirror buildSwimlanePath's marker compensation so we know the actual
    // fork-bound (the rightmost X the trunk can sit at without overshooting
    // the closest target's arrow tip).
    const ARROW_TIP_GAP_PCT = 1.2;
    type Group = {
      fromX: number;
      fromY: number;
      minEndX: number; // smallest target endX in the group — caps the trunk
      forwardCount: number;
    };
    const groups = new Map<string, Group>();
    for (const edge of swimlaneDependencyEdges) {
      const endX = Math.max(0, edge.toX - ARROW_TIP_GAP_PCT);
      const isForward = endX >= edge.fromX + 0.1;
      if (!isForward) continue;
      let g = groups.get(edge.fromId);
      if (!g) {
        g = {
          fromX: edge.fromX,
          fromY: edge.fromY,
          minEndX: endX,
          forwardCount: 0
        };
        groups.set(edge.fromId, g);
      }
      if (endX < g.minEndX) g.minEndX = endX;
      g.forwardCount += 1;
    }
    groups.forEach((g, fromId) => {
      if (g.forwardCount < 2) return;
      // Place the trunk a small stub past the source's right edge, but never
      // past the closest target's endX (with a 0.5% safety margin so the
      // final horizontal arm is always visible). If those bounds invert
      // (the closest target sits inside the trunk stub) we skip bundling
      // for this source — the natural midpoint will route fine.
      const desired = g.fromX + SWIMLANE_DEP_TRUNK_STUB_PCT;
      const cap = g.minEndX - 0.5;
      if (cap <= g.fromX + 0.5) return;
      const trunkX = Math.min(desired, cap);
      out.set(fromId, { trunkX, fromY: g.fromY });
    });
    return out;
  }, [mode, swimlaneDependencyEdges]);

  // Target-bundling (Strategy C add-on): mirror of swimlaneBundleByFromId but
  // on the receiving side. When several deps converge on the same target
  // (e.g. Config Change pulled in by 15.12 Broadsign, IP12 DAX Hold, and
  // IP12 DHTML), all of them merge onto a shared "bus" X just before the
  // target's left edge. Combined with source-bundling, an edge with a
  // multi-outgoing source AND a multi-incoming target becomes a 5-segment
  // path: short trunk out of source → cross-chart at midY → bus X → into
  // target. See buildSwimlanePath for the routing.
  //
  // The bus X must sit between the largest fromX in the group (so EVERY
  // edge can reach it without inverting into a backward route) and the
  // smallest endX (so the final horizontal arm into the arrow tip exists).
  // If those bounds invert (very crowded targets), we skip bundling for
  // that target and fall back to per-edge routing.
  const swimlaneBundleByToId = useMemo(() => {
    const out = new Map<string, { busX: number; toY: number }>();
    if (mode !== 'swimlane' || swimlaneDependencyEdges.length === 0) return out;
    const ARROW_TIP_GAP_PCT = 1.2;
    type Group = {
      toY: number;
      minEndX: number;
      maxFromX: number;
      forwardCount: number;
    };
    const groups = new Map<string, Group>();
    for (const edge of swimlaneDependencyEdges) {
      const endX = Math.max(0, edge.toX - ARROW_TIP_GAP_PCT);
      const isForward = endX >= edge.fromX + 0.1;
      if (!isForward) continue;
      let g = groups.get(edge.toId);
      if (!g) {
        g = {
          toY: edge.toY,
          minEndX: endX,
          maxFromX: edge.fromX,
          forwardCount: 0
        };
        groups.set(edge.toId, g);
      }
      if (endX < g.minEndX) g.minEndX = endX;
      if (edge.fromX > g.maxFromX) g.maxFromX = edge.fromX;
      g.forwardCount += 1;
    }
    groups.forEach((g, toId) => {
      if (g.forwardCount < 2) return;
      const desired = g.minEndX - SWIMLANE_DEP_BUS_BACK_PCT;
      const lowerBound = g.maxFromX + 0.5;
      if (desired <= lowerBound) return;
      out.set(toId, { busX: desired, toY: g.toY });
    });
    return out;
  }, [mode, swimlaneDependencyEdges]);

  // Swimlane-mode hover tooltip needs quick lookups by fix id:
  //   * the SwimlaneBar (to read name/dates/progress/status)
  //   * the incoming/outgoing dependency labels (rolled up to fix versions —
  //     epic/story deps are collapsed onto their owning fix).
  // `dependencyLinks.byRow` above is keyed on `visibleRows`, which is empty
  // in swimlane mode, so we build a parallel map here.
  const swimlaneTooltipData = useMemo(() => {
    const barByFixId = new Map<
      string,
      {
        bar: typeof laneRows[number]['bars'][number];
        laneName: string;
      }
    >();
    laneRows.forEach((lane) => {
      lane.bars.forEach((bar) => {
        barByFixId.set(bar.fix.id, { bar, laneName: lane.name });
      });
    });

    const depByFixId = new Map<
      string,
      { incoming: DependencyLink[]; outgoing: DependencyLink[] }
    >();
    if (showDependencies && effectiveDependencies.length > 0) {
      const resolveFixId = (issueId: string): string | null => {
        if (barByFixId.has(issueId)) return issueId;
        const fixFromEpic = parentMaps.fixByEpic.get(issueId);
        if (fixFromEpic && barByFixId.has(fixFromEpic)) return fixFromEpic;
        const fixFromStory = parentMaps.fixByStory.get(issueId);
        if (fixFromStory && barByFixId.has(fixFromStory)) return fixFromStory;
        return null;
      };
      const ensure = (fixId: string) => {
        if (!depByFixId.has(fixId)) {
          depByFixId.set(fixId, { incoming: [], outgoing: [] });
        }
        return depByFixId.get(fixId)!;
      };
      const seen = new Set<string>();
      effectiveDependencies.forEach((dep) => {
        const fromFixId = resolveFixId(dep.fromId);
        const toFixId = resolveFixId(dep.toId);
        if (!fromFixId || !toFixId || fromFixId === toFixId) return;
        const key = `${fromFixId}->${toFixId}`;
        if (seen.has(key)) return;
        seen.add(key);
        const fromLabel = barByFixId.get(fromFixId)?.bar.fix.name ?? null;
        const toLabel = barByFixId.get(toFixId)?.bar.fix.name ?? null;
        ensure(fromFixId).outgoing.push({
          key: dep.toKey || dep.toId,
          label: toLabel,
          url: dep.toKey && jiraBrowseBase ? `${jiraBrowseBase}${dep.toKey}` : null,
          rowId: toFixId
        });
        ensure(toFixId).incoming.push({
          key: dep.fromKey || dep.fromId,
          label: fromLabel,
          url: dep.fromKey && jiraBrowseBase ? `${jiraBrowseBase}${dep.fromKey}` : null,
          rowId: fromFixId
        });
      });
    }

    return { barByFixId, depByFixId };
  }, [laneRows, showDependencies, effectiveDependencies, parentMaps, jiraBrowseBase]);

  // Build a rounded-ortho path for a swimlane dep edge. The SVG uses
  // `preserveAspectRatio="none"` with viewBox [0, VIEWBOX_WIDTH] × [0, height],
  // so X percents are mapped to viewbox units by roundedOrtho and Y values are
  // already in pixel/viewbox units. Goes forward (right-vert-right) when the
  // target sits after the source and backward (left-vert-right) otherwise.
  //
  // For backward edges we previously routed the cross-chart horizontal at
  // `midY = (fromY + toY) / 2`. With evenly-spaced rows that average tends to
  // land directly on a bar centerY, slicing through it visually. When called
  // with a list of `gutterYs` (mid-points of bar-free Y bands measured from
  // the live DOM), we snap midY to the nearest gutter that lies between
  // source and target — this routes the line through inter-row / inter-lane
  // gaps so it never crosses a bar, and multiple edges with similar fromY/toY
  // naturally collapse onto the same gutter "highway" (see Option A mockup).
  const buildSwimlanePath = useCallback(
    (
      e: { fromX: number; toX: number; fromY: number; toY: number },
      gutterYs?: readonly number[],
      // Source-bundling: when multiple forward edges share a source, callers
      // pass a shared trunk X so all of those edges fork at the same vertical.
      // The trunk segment from (fromX, fromY) → (bundleTrunkX, fromY) is then
      // drawn N times (once per edge) but overlaps perfectly, so it reads as
      // a single outgoing line that branches at the trunk.
      bundleTrunkX?: number,
      // Target-bundling: when multiple forward edges converge on the same
      // target, callers pass a shared bus X so all of those edges merge at
      // the same vertical just before the arrow tip. When BOTH bundleTrunkX
      // and bundleBusX apply to an edge, the path becomes 5-segment:
      // out-stub at fromY → drop to midY → cross to busX at midY → drop to
      // toY → into arrow tip. When only one applies, the path stays
      // 3-segment, with the override picking that one as the midX.
      bundleBusX?: number
    ): string => {
      // Shorten the path by the marker-triangle length so the arrow TIP (not
      // the path end) lands exactly at `toX`. 1.2% == 12 viewbox units ==
      // the width of the triangle defined in the markerEnd defs — matches
      // the same constant (`ARROW_TIP_MARGIN_PCT`) used by standard mode.
      // With the previous 0.4% gap, the triangle overshot into the target
      // bar by ~0.8%.
      const ARROW_TIP_GAP_PCT = 1.2;
      const endX = Math.max(0, e.toX - ARROW_TIP_GAP_PCT);
      if (endX >= e.fromX + 0.1) {
        // Validate the optional bundle X values land inside the usable
        // (fromX, endX) span. Outside that, the bundle would invert the
        // route, so we ignore it for this edge.
        const haveSrc =
          bundleTrunkX != null
          && bundleTrunkX > e.fromX + 0.5
          && bundleTrunkX < endX - 0.5;
        const haveTgt =
          bundleBusX != null
          && bundleBusX > e.fromX + 0.5
          && bundleBusX < endX - 0.5;

        // Both source AND target bundle apply — 5-segment with two trunks.
        // Need at least ~1% gap between sourceForkX and busX so the cross-
        // chart leg has visible length and the corners render cleanly.
        if (haveSrc && haveTgt && (bundleBusX as number) - (bundleTrunkX as number) > 1) {
          // Snap the cross-chart Y to a gutter when one's available, so
          // the long horizontal at midY doesn't slice through a bar. Same
          // approach as the backward-edge gutter snap below — we just
          // re-search here in the (fromY, toY) band. If no usable gutter
          // exists, fall back to the natural midpoint.
          const naturalMidY = (e.fromY + e.toY) / 2;
          let midY = naturalMidY;
          if (gutterYs && gutterYs.length > 0 && e.fromY !== e.toY) {
            const minY = Math.min(e.fromY, e.toY);
            const maxY = Math.max(e.fromY, e.toY);
            let lo = 0;
            let hi = gutterYs.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (gutterYs[mid] < naturalMidY) lo = mid + 1;
              else hi = mid;
            }
            let best: number | null = null;
            let bestDist = Infinity;
            const consider = (idx: number) => {
              if (idx < 0 || idx >= gutterYs.length) return;
              const g = gutterYs[idx];
              if (g <= minY || g >= maxY) return;
              const d = Math.abs(g - naturalMidY);
              if (d < bestDist) {
                bestDist = d;
                best = g;
              }
            };
            consider(lo - 1);
            consider(lo);
            if (best !== null) midY = best;
          }
          return roundedOrtho(
            [
              [e.fromX, e.fromY],
              [bundleTrunkX as number, e.fromY],
              [bundleTrunkX as number, midY],
              [bundleBusX as number, midY],
              [bundleBusX as number, e.toY],
              [endX, e.toY]
            ],
            ORTHO_CORNER_R
          );
        }
        // Single trunk: prefer source trunk → fall back to target bus →
        // fall back to natural midpoint.
        const midX = haveSrc
          ? (bundleTrunkX as number)
          : haveTgt
          ? (bundleBusX as number)
          : e.fromX + (endX - e.fromX) / 2;
        return roundedOrtho(
          [
            [e.fromX, e.fromY],
            [midX, e.fromY],
            [midX, e.toY],
            [endX, e.toY]
          ],
          ORTHO_CORNER_R
        );
      }
      // Backward: drop to mid-Y then run across under/over to the target.
      const SIDE_OFFSET_PCT = 1.2;
      const outX = e.fromX + SIDE_OFFSET_PCT;
      const inX = Math.max(0, endX - SIDE_OFFSET_PCT);
      const naturalMidY = (e.fromY + e.toY) / 2;
      let midY = naturalMidY;
      if (gutterYs && gutterYs.length > 0) {
        // gutterYs is built from sorted bar bands (see swimlaneGutterYs)
        // so it is itself sorted ascending. We can find the gutter closest
        // to naturalMidY in O(log n) instead of scanning every entry —
        // important because this helper is called for every backward edge
        // on every render (including drag-preview pointer-moves), so the
        // old O(edges × gutters) scan made dense dashboards janky.
        const minY = Math.min(e.fromY, e.toY);
        const maxY = Math.max(e.fromY, e.toY);
        // lowerBound: first index where gutterYs[idx] >= naturalMidY.
        let lo = 0;
        let hi = gutterYs.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (gutterYs[mid] < naturalMidY) lo = mid + 1;
          else hi = mid;
        }
        // The closest gutter to naturalMidY is at lo or lo-1 (boundaries).
        // Keep it inside the open span (minY, maxY) so we never route the
        // horizontal beyond either endpoint.
        let best: number | null = null;
        let bestDist = Infinity;
        const consider = (idx: number) => {
          if (idx < 0 || idx >= gutterYs.length) return;
          const g = gutterYs[idx];
          if (g <= minY || g >= maxY) return;
          const d = Math.abs(g - naturalMidY);
          if (d < bestDist) {
            bestDist = d;
            best = g;
          }
        };
        consider(lo - 1);
        consider(lo);
        if (best !== null) midY = best;
      }
      return roundedOrtho(
        [
          [e.fromX, e.fromY],
          [outX, e.fromY],
          [outX, midY],
          [inX, midY],
          [inX, e.toY],
          [endX, e.toY]
        ],
        ORTHO_CORNER_R
      );
    },
    []
  );

  // Gutter Y-values for swimlane backward dep routing. Each entry is the
  // mid-Y of a "bar-free" horizontal band — i.e., the gap between two
  // adjacent bar Y bands when all bars (across all lanes) are sorted by top.
  // Used by buildSwimlanePath to snap the cross-chart horizontal so it lands
  // in a gutter instead of slicing through a bar, and so that several edges
  // with similar source/target Ys collapse onto a shared highway.
  const swimlaneGutterYs = useMemo<number[]>(() => {
    if (mode !== 'swimlane' || swimlaneBarMetrics.size === 0) return [];
    const bands = Array.from(swimlaneBarMetrics.values())
      .map((m) => ({ top: m.top, bottom: m.bottom }))
      .sort((a, b) => a.top - b.top);
    if (bands.length < 2) return [];
    const gutters: number[] = [];
    // Track the running "frontier" bottom — the deepest bar bottom seen so
    // far. This handles bars that overlap vertically (rare in swimlane but
    // possible with custom row sizing) without producing a phantom gap
    // inside an active band.
    let frontier = bands[0].bottom;
    for (let i = 1; i < bands.length; i++) {
      const b = bands[i];
      if (b.top > frontier) {
        gutters.push((frontier + b.top) / 2);
      }
      if (b.bottom > frontier) frontier = b.bottom;
    }
    return gutters;
  }, [mode, swimlaneBarMetrics]);

  const dependencyLayerHeight = useMemo(() => {
    // Prefer the real measured body height so SVG viewBox units map 1:1 to
    // pixels (with preserveAspectRatio="none", a mismatch stretches the Y
    // axis and puts arrows off-center). Fallback to the constants-based
    // estimate before the first measurement.
    // In swimlane mode, visibleRows isn't what fills the body — the lane
    // containers do — so use the measured swimlane body height instead.
    if (mode === 'swimlane') {
      if (measuredSwimlaneBodyHeight > 0) return measuredSwimlaneBodyHeight;
      return ROW_HEIGHT;
    }
    if (measuredBodyHeight > 0) return measuredBodyHeight;
    const total = visibleRows.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;
    return Math.max(ROW_HEIGHT, total);
  }, [visibleRows.length, measuredBodyHeight, mode, measuredSwimlaneBodyHeight]);

  const ticks = useMemo(() => buildTicks(range), [range]);
  const months = useMemo(() => buildMonths(range), [range]);
  const quarters = useMemo(() => buildQuarters(range), [range]);

  const todayPercent = useMemo(() => {
    const today = new Date();
    if (today < range.start || today > range.end) return null;
    return getPercent(range, today);
  }, [range]);

  // ─── Manual-dependency state ─────────────────────────────────────────────
  // Dep-edit is now enabled in both modes. The drag-handle is rendered on
  // the standard-mode bar *and* on each swimlane bar; the drag resolver
  // recognises both. Keeping the showDependencies gate — there's no point
  // letting someone create dep arrows that would immediately be hidden.
  const depEditEnabled = Boolean(onCreateDependency) && showDependencies;

  type DragState = {
    fromRowId: string;
    fromType: DependencyNodeType;
    fromX: number; // percent
    fromY: number; // viewbox Y
    // Pointer position expressed as pct/vbY so the in-flight preview path
    // renders with the same helpers as committed edges.
    cursorX: number;
    cursorY: number;
    overRowId: string | null;
  };

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [hoveredBarRowId, setHoveredBarRowId] = useState<string | null>(null);
  const [hoveredManualEdgeKey, setHoveredManualEdgeKey] = useState<string | null>(null);
  // Captured on bar hover so the portalled tooltip can position itself with
  // viewport-relative coordinates and escape every `overflow: hidden` ancestor
  // (.gantt-timeline in particular, which uses it for rounded-corner clipping).
  const [hoveredBarRect, setHoveredBarRect] = useState<{
    left: number;
    right: number;
    bottom: number;
    width: number;
  } | null>(null);
  // When true, fix bars show a translucent overlay on the outstanding portion
  // (left = done, right = lighter/outstanding). Toggled via the pill in the
  // timeline header. Defaults to on so the POC view stays informative.
  const [showProgressShading, setShowProgressShading] = useState<boolean>(true);
  // Per-milestone vertical stagger level (0 = closest to its circle). Computed
  // from the labels' real rendered rectangles so overlapping labels stack onto
  // separate rows. See the measuring layout effect below.
  const [msLabelLevels, setMsLabelLevels] = useState<Map<string, number>>(() => new Map());
  // Category manager modal open/close state.
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  // New-category form state inside the manager modal.
  const [newCatName, setNewCatName] = useState('');
  const [newCatColour, setNewCatColour] = useState('#6366f1');
  // Assignment popover: shown when the user right-clicks a swimlane bar.
  const [assignPopover, setAssignPopover] = useState<{
    fixVersionId: string;
    x: number;
    y: number;
  } | null>(null);
  // Marker (UAT/Live pill) hover state — used to render a styled portalled
  // tooltip instead of the native browser `title` attribute. We track the
  // kind, dates, and viewport rect so the tooltip can be positioned next to
  // the pill (and flip to the right edge if it would overflow).
  const [hoveredMarker, setHoveredMarker] = useState<
    | {
        kind: 'uat' | 'live';
        startLabel: string;
        endLabel: string;
        rect: { left: number; right: number; bottom: number; width: number };
      }
    | {
        kind: 'milestone';
        label: string;
        dateLabel: string;
        color: string;
        rect: { left: number; right: number; bottom: number; width: number };
      }
    | {
        // Cross-project external-dependencies badge. `keys` is the list of
        // linked ticket keys from other projects; the tooltip surfaces them
        // so a PM can spot external dependencies at a glance.
        kind: 'ext-links';
        keys: string[];
        rect: { left: number; right: number; bottom: number; width: number };
      }
    | null
  >(null);
  const ganttBodyRef = useRef<HTMLDivElement | null>(null);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  const milestonesOverlayRef = useRef<HTMLDivElement | null>(null);

  // Milestone hover detection lives on the chart area (not on the milestone
  // overlay itself) so the milestone band can stay pointer-events: none and
  // bars/dependency handles below remain interactive. We detect proximity to
  // each milestone's x-position on every mousemove and surface the same
  // hoveredMarker tooltip the chip already drives. Skipped during a drag so
  // the tooltip doesn't flicker while wiring dependencies.
  const handleChartAreaMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (dragState) return;
    const chart = chartAreaRef.current;
    if (!chart) return;
    const anchors = chart.querySelectorAll<HTMLElement>('.gantt-milestone-overlay');
    if (anchors.length === 0) return;
    const HOVER_RADIUS_PX = 6;
    let nearest: { id: string; rect: DOMRect; dist: number } | null = null;
    anchors.forEach((el) => {
      const r = el.getBoundingClientRect();
      // Anchor is zero-width — its left and right are the milestone's x.
      const dist = Math.abs(event.clientX - r.left);
      if (dist <= HOVER_RADIUS_PX && (nearest === null || dist < nearest.dist)) {
        const id = el.getAttribute('data-milestone-id');
        if (id) nearest = { id, rect: r, dist };
      }
    });
    if (nearest) {
      const n: { id: string; rect: DOMRect; dist: number } = nearest;
      const m = milestones.find((x) => x.id === n.id);
      if (!m) return;
      setHoveredMarker({
        kind: 'milestone',
        label: m.label,
        dateLabel: formatFullDate(m.date),
        color: m.color,
        rect: {
          left: n.rect.left,
          right: n.rect.right,
          bottom: event.clientY,
          width: n.rect.width
        }
      });
    } else {
      setHoveredMarker((prev) => (prev && prev.kind === 'milestone' ? null : prev));
    }
  };

  const handleChartAreaMouseLeave = () => {
    setHoveredMarker((prev) => (prev && prev.kind === 'milestone' ? null : prev));
  };

  // Assign each milestone label a vertical stagger level from its real rendered
  // rectangle. Labels are sorted left→right and greedily placed on the lowest
  // level whose previously-placed label doesn't horizontally overlap it; a
  // collision bumps the label to a higher row (drawn further above its circle).
  // Measuring actual rects (rather than estimating from character counts) means
  // a label is only ever raised when it genuinely overlaps another. The level
  // only affects vertical position, so re-rendering doesn't change the measured
  // widths/x-positions — no feedback loop.
  useLayoutEffect(() => {
    const overlay = milestonesOverlayRef.current;
    if (!overlay) return;
    const GAP_PX = 4; // horizontal breathing room between labels on a row
    // Cap the stagger at 2 rows. Growing the header to fit 3+ simultaneously
    // overlapping labels isn't worth it for how rarely it happens; beyond the
    // cap, extra labels share the top row (and may overlap there — the leader
    // lines + colours still disambiguate).
    const MAX_LEVEL = 1;
    const measure = () => {
      const labels = Array.from(
        overlay.querySelectorAll<HTMLElement>('[data-ms-label-id]')
      );
      const items = labels
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.msLabelId ?? '', left: r.left, right: r.right };
        })
        .filter((it) => it.id && it.right > it.left)
        .sort((a, b) => a.left - b.left);
      const levelRightEdge: number[] = [];
      const next = new Map<string, number>();
      items.forEach((it) => {
        let level = 0;
        while (level < levelRightEdge.length && levelRightEdge[level] > it.left - GAP_PX) {
          level += 1;
        }
        if (level > MAX_LEVEL) level = MAX_LEVEL;
        levelRightEdge[level] = Math.max(levelRightEdge[level] ?? 0, it.right);
        next.set(it.id, level);
      });
      setMsLabelLevels((prev) => {
        if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) {
          return prev;
        }
        return next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(overlay);
    overlay.querySelectorAll<HTMLElement>('[data-ms-label-id]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [milestones, range, mode]);

  useLayoutEffect(() => {
    const body = ganttBodyRef.current;
    if (!body) return;

    const measure = () => {
      const rows = body.querySelectorAll<HTMLElement>('.gantt-row[data-row-id]');
      const next = new Map<string, RowMetric>();
      let maxBottom = 0;
      rows.forEach((el) => {
        const id = el.dataset.rowId;
        if (!id) return;
        const top = el.offsetTop;
        const height = el.offsetHeight;
        next.set(id, { top, height });
        if (top + height > maxBottom) maxBottom = top + height;
      });
      setRowMetrics(next);
      setMeasuredBodyHeight(maxBottom);
    };

    measure();

    // Re-measure whenever the body or any row resizes (progress bar text wraps,
    // fonts load, window resizes, rows expand/collapse, etc).
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    body.querySelectorAll<HTMLElement>('.gantt-row[data-row-id]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [visibleRows]);

  // Swimlane-bar positions in body-local coordinates. Fed into the dep layer
  // so arrows can be routed between bars that live in different lanes. We
  // walk each .gantt-lane-bar[data-dep-row-id] element, grab its offsetTop
  // relative to the body, and record centre/top/bottom Ys. Body height is
  // tracked separately so the SVG viewbox maps 1:1 to pixels in swimlane
  // mode the same way it does in standard.
  useLayoutEffect(() => {
    if (mode !== 'swimlane') {
      if (swimlaneBarMetrics.size > 0) setSwimlaneBarMetrics(new Map());
      if (measuredSwimlaneBodyHeight !== 0) setMeasuredSwimlaneBodyHeight(0);
      if (swimlaneDepLayerWidthPx !== 0) setSwimlaneDepLayerWidthPx(0);
      if (swimlaneTextMaskRects.length > 0) setSwimlaneTextMaskRects([]);
      return;
    }
    const body = ganttBodyRef.current;
    if (!body) return;

    const relativeTop = (el: HTMLElement): number => {
      let y = 0;
      let cur: HTMLElement | null = el;
      while (cur && cur !== body) {
        y += cur.offsetTop;
        cur = cur.offsetParent as HTMLElement | null;
      }
      return y;
    };

    const measure = () => {
      const next = new Map<string, SwimlaneBarMetric>();
      body
        .querySelectorAll<HTMLElement>('[data-dep-row-id][data-swimlane-bar]')
        .forEach((el) => {
          const id = el.dataset.depRowId;
          if (!id) return;
          const top = relativeTop(el);
          const height = el.offsetHeight;
          next.set(id, { top, bottom: top + height, centerY: top + height / 2 });
        });
      setSwimlaneBarMetrics(next);
      setMeasuredSwimlaneBodyHeight(body.offsetHeight);
      // Capture the dep layer's rendered pixel width so the memo can compute
      // pixel-accurate milestone/bar dep gaps (see swimlaneDepLayerWidthPx
      // comment). Falls back to 0 if the layer isn't mounted — the memo
      // tolerates that with a sensible default gap.
      const layer = body.querySelector<HTMLElement>('.gantt-dependency-layer');
      setSwimlaneDepLayerWidthPx(layer ? layer.getBoundingClientRect().width : 0);

      // Text-mask rects: walk every element tagged with data-text-mask="1"
      // (bar text, in-bar progress %, short-bar caption, milestone caption)
      // and convert its viewport rect into dep-layer viewbox coords. The
      // dep-layer SVG uses preserveAspectRatio="none" with viewBox 0..1000
      // wide and dependencyLayerHeight tall — so x scales by VIEWBOX_WIDTH
      // and y is 1:1 with pixels. The mask in <defs> reads this list and
      // paints a black rect for each, cutting holes through the dep paths
      // wherever text would otherwise be obscured.
      const layerRect = layer ? layer.getBoundingClientRect() : null;
      const rects: TextMaskRect[] = [];
      if (layerRect && layerRect.width > 0 && layerRect.height > 0) {
        // A few px of padding around each rect so the mask cuts a clean gap
        // around glyph antialiasing and the cap-height vs box-height delta.
        // 2px on each side feels right at the default font-size — small
        // enough not to look like a deliberate gutter, large enough to
        // cover stroke antialiasing on diagonal arrow segments.
        const PAD_X = 2;
        const PAD_Y = 1;
        body.querySelectorAll<HTMLElement>('[data-text-mask="1"]').forEach((el) => {
          // Skip elements that have no text content (empty progress %, etc).
          if (!el.textContent || !el.textContent.trim()) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          const xPx = r.left - layerRect.left - PAD_X;
          const yPx = r.top - layerRect.top - PAD_Y;
          const wPx = r.width + PAD_X * 2;
          const hPx = r.height + PAD_Y * 2;
          // Convert x,w from pixels → viewbox units (0..1000).
          const x = (xPx / layerRect.width) * VIEWBOX_WIDTH;
          const w = (wPx / layerRect.width) * VIEWBOX_WIDTH;
          // y is 1:1 since dep-layer viewbox height === pixel height.
          rects.push({ x, y: yPx, w, h: hPx });
        });
      }
      setSwimlaneTextMaskRects(rects);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    body
      .querySelectorAll<HTMLElement>('[data-dep-row-id][data-swimlane-bar]')
      .forEach((el) => ro.observe(el));
    // Re-measure when any text-mask element changes size (font-load,
    // ellipsis re-truncation, etc) so the dep mask follows the text.
    body
      .querySelectorAll<HTMLElement>('[data-text-mask="1"]')
      .forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // `laneRows` is the source of truth for the bar/text DOM nodes this
    // effect observes — adding it ensures presentational filters (e.g.
    // toggling activeFixVersionIds) re-run the measurement pass instead of
    // leaving stale swimlaneBarMetrics / swimlaneTextMaskRects pointing at
    // unmounted bars. The other listed deps are redundant given laneRows
    // depends on them, but kept for readability of "what affects layout".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, swimlaneMilestoneView, fixVersions, swimlanes, range.start, range.end, laneRows, showDependencies]);

  // Map element under the pointer → the row id it belongs to. The handle
  // sets data-dep-row-id on the bar and we walk up to find it. If we don't
  // land directly on a bar, fall back to any `.gantt-row[data-row-id]`
  // ancestor so that hovering an empty part of a valid row still counts as
  // targeting that row's bar (matches user expectation of "snap to the row
  // I'm over").
  const resolveDragTarget = (clientX: number, clientY: number): { rowId: string; type: DependencyNodeType } | null => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!el) return null;
    const barEl = el.closest<HTMLElement>('[data-dep-row-id]');
    if (barEl) {
      const rowId = barEl.dataset.depRowId;
      const rowType = barEl.dataset.depRowType as DependencyNodeType | undefined;
      if (rowId && rowType) return { rowId, type: rowType };
    }
    if (!depEditEnabled) return null;
    const rowEl = el.closest<HTMLElement>('.gantt-row[data-row-id]');
    if (!rowEl) return null;
    const rowId = rowEl.dataset.rowId;
    if (!rowId) return null;
    const rowItem = visibleRows.find((r) => r.row.id === rowId);
    if (!rowItem) return null;
    if (rowItem.row.type !== 'fix' && rowItem.row.type !== 'epic') return null;
    // Require a rendered/clamped bar so the resulting dep has a visible
    // target to anchor its arrow to. Without this check we'd happily persist
    // a dep to a row whose true date range sits outside the visible window —
    // on the next render the arrow endpoint has no bar to point at and the
    // arrowhead floats off-chart.
    if (!rowItem.clamped) return null;
    return { rowId, type: rowItem.row.type as DependencyNodeType };
  };

  const toLocalCoords = (clientX: number, clientY: number): { xPct: number; yVb: number } | null => {
    const body = ganttBodyRef.current;
    if (!body) return null;
    // The dependency layer sits inside the body but is offset by the label
    // column (--gantt-label-width). We query a live .gantt-dependency-layer
    // element (rendered whenever deps are shown) for the exact offset.
    const layer = body.querySelector<HTMLElement>('.gantt-dependency-layer');
    const rect = (layer || body).getBoundingClientRect();
    const xPct = ((clientX - rect.left) / rect.width) * 100;
    const yVb = ((clientY - rect.top) / rect.height) * dependencyLayerHeight;
    return {
      xPct: Math.max(0, Math.min(100, xPct)),
      yVb: Math.max(0, Math.min(dependencyLayerHeight, yVb))
    };
  };

  // Pointer move/up handlers are attached to window so the drag keeps going
  // even if the cursor leaves the original bar.
  useEffect(() => {
    if (!dragState) return;

    const handleMove = (event: PointerEvent) => {
      const coords = toLocalCoords(event.clientX, event.clientY);
      if (!coords) return;
      const hover = resolveDragTarget(event.clientX, event.clientY);
      setDragState((prev) =>
        prev
          ? {
              ...prev,
              cursorX: coords.xPct,
              cursorY: coords.yVb,
              overRowId:
                hover && hover.rowId !== prev.fromRowId ? hover.rowId : null
            }
          : prev
      );
    };

    const handleUp = async (event: PointerEvent) => {
      const hover = resolveDragTarget(event.clientX, event.clientY);
      const current = dragState;
      setDragState(null);
      if (!current || !hover || hover.rowId === current.fromRowId) return;
      if (!onCreateDependency) return;
      try {
        await onCreateDependency({
          fromId: current.fromRowId,
          toId: hover.rowId,
          fromType: current.fromType,
          toType: hover.type
        });
      } catch {
        // DashboardPage surfaces the error via toast; swallow here so the UI
        // can continue.
      }
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDragState(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('keydown', handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState?.fromRowId]);

  const handleDragHandlePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    row: RowItem,
    index: number
  ) => {
    if (!depEditEnabled) return;
    if (!(row.type === 'fix' || row.type === 'epic')) return;
    event.preventDefault();
    event.stopPropagation();
    const clamped = clampRange(range, row.start, row.end);
    if (!clamped) return;
    const fromX = getPercent(range, clamped.end);
    const metric = rowMetrics.get(row.id);
    const fromY = metric
      ? metric.top + metric.height / 2
      : index * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
    const coords = toLocalCoords(event.clientX, event.clientY);
    setDragState({
      fromRowId: row.id,
      fromType: row.type as DependencyNodeType,
      fromX,
      fromY,
      cursorX: coords?.xPct ?? fromX,
      cursorY: coords?.yVb ?? fromY,
      overRowId: null
    });
  };

  // Swimlane variant: the bar doesn't live in visibleRows so we can't reuse
  // handleDragHandlePointerDown (it expects RowItem + rowMetrics). We derive
  // fromX from the bar's clamped end date and fromY from swimlaneBarMetrics
  // (the measured DOM position), then hand off to the shared dragState.
  const handleSwimlaneDragPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    fixId: string,
    clampedStart: Date,
    clampedEnd: Date
  ) => {
    if (!depEditEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    // Mirror the pixel-aware gap calc from the swimlaneDependencyEdges
    // memo so the drag preview emerges from the same spot as the
    // eventual committed edge. Only the source-side offset matters here
    // (the target is tracked live from the pointer).
    const MILESTONE_RIGHT_VERTEX_PX = 6.5;
    const MILESTONE_SOURCE_CLEARANCE_PX = 2;
    const BAR_DEP_EXIT_PX = 1.5;
    const pxToPct = (px: number): number =>
      swimlaneDepLayerWidthPx > 0 ? (px / swimlaneDepLayerWidthPx) * 100 : px * 0.1;
    const milestoneSourceGapPct = pxToPct(MILESTONE_RIGHT_VERTEX_PX + MILESTONE_SOURCE_CLEARANCE_PX);
    const barDepExitPct = pxToPct(BAR_DEP_EXIT_PX);
    const barStartPct = getPercent(range, clampedStart);
    const barEndPct = getPercent(range, clampedEnd);
    const barVisualRightPct = Math.max(barEndPct, barStartPct + 1);
    const fromX = swimlaneMilestoneView
      ? barEndPct + milestoneSourceGapPct
      : barVisualRightPct + barDepExitPct;
    const metric = swimlaneBarMetrics.get(fixId);
    const fromY = metric ? metric.centerY : 0;
    const coords = toLocalCoords(event.clientX, event.clientY);
    setDragState({
      fromRowId: fixId,
      fromType: 'fix',
      fromX,
      fromY,
      cursorX: coords?.xPct ?? fromX,
      cursorY: coords?.yVb ?? fromY,
      overRowId: null
    });
  };

  const handleRemoveDepClick = useCallback(
    async (overrideId: string) => {
      if (!onRemoveDependency) return;
      setHoveredManualEdgeKey(null);
      try {
        await onRemoveDependency(overrideId);
      } catch {
        // DashboardPage surfaces the error via toast.
      }
    },
    [onRemoveDependency]
  );

  // Whether the swimlane milestone-view toggle should render in the
  // Gantt's own toolbar. Only relevant in swimlane mode and when the
  // parent gave us a change-handler — otherwise the toggle is just
  // displayed elsewhere (e.g. the legacy filter-bar control).
  const swimlaneToggleInToolbar =
    mode === 'swimlane' && typeof onSwimlaneMilestoneViewChange === 'function';
  const depsToggleInToolbar = typeof onShowDependenciesChange === 'function';
  const releasedToggleInToolbar =
    typeof onHideReleasedFixVersionsChange === 'function';
  const initiativesToggleInToolbar =
    typeof onShowInitiativesChange === 'function';
  const timeScaleToggleInToolbar = typeof onTimeScaleChange === 'function';
  const toolbarVisible =
    (onRefresh ||
      swimlaneToggleInToolbar ||
      depsToggleInToolbar ||
      releasedToggleInToolbar ||
      initiativesToggleInToolbar ||
      timeScaleToggleInToolbar) &&
    !loading;

  return (
    <div
      className={`gantt${mode === 'swimlane' ? ' gantt--swimlane' : ''}${
        initiativesActive || standardInitiativesActive ? ' gantt--has-initiatives' : ''
      }`}
    >
      {toolbarVisible && (
        <div className="gantt-toolbar">
          {timeScaleToggleInToolbar && (
            <div className="gantt-toolbar-toggle" role="group" aria-label="Timeline scale">
              <button
                type="button"
                className={`toggle-pill ${timeScale === 'month' ? 'is-active' : ''}`}
                onClick={() => onTimeScaleChange?.('month')}
                aria-pressed={timeScale === 'month'}
              >
                Months
              </button>
              <button
                type="button"
                className={`toggle-pill ${timeScale === 'quarter' ? 'is-active' : ''}`}
                onClick={() => onTimeScaleChange?.('quarter')}
                aria-pressed={timeScale === 'quarter'}
              >
                Quarters
              </button>
            </div>
          )}
          {swimlaneToggleInToolbar && (
            <div className="gantt-toolbar-toggle" role="group" aria-label="Swimlane style">
              <button
                type="button"
                className={`toggle-pill ${!swimlaneMilestoneView ? 'is-active' : ''}`}
                onClick={() => onSwimlaneMilestoneViewChange?.(false)}
                aria-pressed={!swimlaneMilestoneView}
              >
                Bars
              </button>
              <button
                type="button"
                className={`toggle-pill ${swimlaneMilestoneView ? 'is-active' : ''}`}
                onClick={() => onSwimlaneMilestoneViewChange?.(true)}
                aria-pressed={swimlaneMilestoneView}
              >
                Milestones
              </button>
            </div>
          )}
          {initiativesToggleInToolbar && (
            <div className="gantt-toolbar-toggle" role="group" aria-label="Initiatives">
              <button
                type="button"
                className={`toggle-pill ${showInitiatives ? 'is-active' : ''}`}
                onClick={() => onShowInitiativesChange?.(true)}
                aria-pressed={showInitiatives}
              >
                Initiatives on
              </button>
              <button
                type="button"
                className={`toggle-pill ${!showInitiatives ? 'is-active' : ''}`}
                onClick={() => onShowInitiativesChange?.(false)}
                aria-pressed={!showInitiatives}
              >
                Initiatives off
              </button>
            </div>
          )}
          {depsToggleInToolbar && (
            <div className="gantt-toolbar-toggle" role="group" aria-label="Dependencies">
              <button
                type="button"
                className={`toggle-pill ${showDependencies ? 'is-active' : ''}`}
                onClick={() => onShowDependenciesChange?.(true)}
                aria-pressed={showDependencies}
              >
                Deps on
              </button>
              <button
                type="button"
                className={`toggle-pill ${!showDependencies ? 'is-active' : ''}`}
                onClick={() => onShowDependenciesChange?.(false)}
                aria-pressed={!showDependencies}
              >
                Deps off
              </button>
            </div>
          )}
          {releasedToggleInToolbar && (
            <div className="gantt-toolbar-toggle" role="group" aria-label="Released fix versions">
              <button
                type="button"
                className={`toggle-pill ${!hideReleasedFixVersions ? 'is-active' : ''}`}
                onClick={() => onHideReleasedFixVersionsChange?.(false)}
                aria-pressed={!hideReleasedFixVersions}
              >
                Show Released
              </button>
              <button
                type="button"
                className={`toggle-pill ${hideReleasedFixVersions ? 'is-active' : ''}`}
                onClick={() => onHideReleasedFixVersionsChange?.(true)}
                aria-pressed={hideReleasedFixVersions}
              >
                Hide Released
              </button>
            </div>
          )}
          {onRefresh && (
            <button
              type="button"
              className="gantt-refresh-btn"
              onClick={onRefresh}
              title="Refresh Jira data"
              aria-label="Refresh Jira data"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              <span>Refresh</span>
            </button>
          )}
        </div>
      )}
      {loading && (
        <div className="gantt-loading-state">
          <span className="gantt-loading-label">Timeline loading</span>
          <div className="gantt-loading-bar" aria-label="Loading" role="progressbar">
            <div className="gantt-loading-bar__fill" />
          </div>
        </div>
      )}
      {!loading && (
      <>
      <div className="gantt-meta">
        <div className="gantt-labels">Timeline</div>
        <div className="gantt-legend">
          {colourMode !== 'rag' ? (
            <div className="legend-group">
              <span className="legend-title">
                {colourMode === 'project'
                  ? 'Projects'
                  : colourMode === 'swimlane'
                  ? 'Swimlanes'
                  : colourMode === 'initiative'
                  ? 'Initiatives'
                  : 'Colour categories'}
              </span>
              {colourGroups.categories.map((cat) => (
                <span key={cat.id} className="legend-item">
                  <i className="legend-colour-swatch" style={{ background: cat.colour }} />
                  {cat.name}
                </span>
              ))}
              <button
                type="button"
                className="legend-manage-btn"
                onClick={() => setCategoryManagerOpen(true)}
              >
                {colourMode === 'manual'
                  ? barColourCategories.length === 0
                    ? '+ Add categories'
                    : 'Manage'
                  : 'Edit colours'}
              </button>
            </div>
          ) : (
            <div className="legend-group">
              <span className="legend-title">Status</span>
              <span className="legend-item"><i className="legend-dot status-not-started" /> Not started</span>
              <span className="legend-item"><i className="legend-dot status-in-progress" /> In progress</span>
              <span className="legend-item"><i className="legend-dot status-completed" /> Completed</span>
              <span className="legend-item"><i className="legend-dot status-at-risk" /> At risk</span>
              <span className="legend-item"><i className="legend-dot status-overdue" /> Overdue</span>
            </div>
          )}
          <div className="legend-group">
            <span className="legend-title">Markers</span>
            <span className="legend-item"><i className="legend-today" /> Today</span>
            <span className="legend-item"><i className="legend-diamond marker-uat" /> UAT date</span>
            <span className="legend-item"><i className="legend-diamond marker-live" /> Live date</span>
            <span className="legend-item"><i className="legend-milestone" /> Milestone</span>
          </div>
          {showDependencies && (
            <div className="legend-group">
              <span className="legend-title">Dependencies</span>
              <span className="legend-item" aria-label="Warning dependency (out of order)">
                <i className="legend-line dependency-warning" aria-hidden="true" />
              </span>
            </div>
          )}
          {!(mode === 'swimlane' && swimlaneMilestoneView) && (
            <button
              type="button"
              className={`toggle-pill gantt-progress-toggle${showProgressShading ? ' is-active' : ''}`}
              onClick={() => setShowProgressShading((v) => !v)}
              aria-pressed={showProgressShading}
              title="Toggle completion shading on fix bars"
            >
              Show % complete on bars
            </button>
          )}
          {mode === 'swimlane' && (
            <label className="gantt-colour-mode">
              <span className="gantt-colour-mode-label">Colour bars by</span>
              <select
                className="gantt-colour-mode-select"
                value={colourMode}
                onChange={(e) => onColourModeChange?.(e.target.value as BarColourMode)}
                title="Choose how swimlane bars are coloured"
              >
                <option value="rag">RAG (status)</option>
                <option value="project">Project</option>
                <option value="swimlane">Swimlane</option>
                <option value="initiative">Initiative</option>
                <option value="manual">Manual</option>
              </select>
              {/* Floated above the select (absolute) so it never shifts the
                  right-anchored dropdown — appears as a hint on top in Manual mode. */}
              {colourMode === 'manual' && (
                <span className="gantt-colour-hint">
                  Right-click a bar to assign a category
                </span>
              )}
            </label>
          )}
        </div>
      </div>
      <div
        className="gantt-chart-area"
        ref={chartAreaRef}
        onMouseMove={handleChartAreaMouseMove}
        onMouseLeave={handleChartAreaMouseLeave}
      >
        <div className="gantt-milestones-overlay" ref={milestonesOverlayRef}>
          {/* Stagger levels are computed from the labels' real rendered pixel
              rectangles (see the layout effect that sets msLabelLevels), so a
              label is only bumped to a higher row when it genuinely overlaps
              another — no width estimation. */}
          {milestones.map((milestone) => {
            const date = parseDate(milestone.date);
            if (!date || date < range.start || date > range.end) return null;
            const percent = getPercent(range, date);
            const level = msLabelLevels.get(milestone.id) ?? 0;
            return (
              <div
                key={milestone.id}
                className="gantt-milestone-overlay"
                data-milestone-id={milestone.id}
                style={{ left: `${percent}%` }}
              >
                <span
                  className="gantt-milestone-overlay-date"
                  style={{ background: milestone.color }}
                >
                  {formatDay(date)}
                </span>
                {milestone.showLabel !== false && (
                  <>
                    {level > 0 && (
                      // Leader line tying a raised label back to its circle.
                      <span
                        className="gantt-milestone-overlay-leader"
                        style={{
                          borderLeftColor: milestone.color,
                          ['--ms-label-level' as any]: level
                        }}
                      />
                    )}
                    <span
                      className="gantt-milestone-overlay-label"
                      data-ms-label-id={milestone.id}
                      style={{
                        ['--ms-color' as any]: milestone.color,
                        ['--ms-label-level' as any]: level
                      }}
                      title={milestone.label}
                    >
                      {milestone.label}
                    </span>
                  </>
                )}
                <span
                  className="gantt-milestone-overlay-arrow"
                  style={{ borderBottomColor: milestone.color }}
                />
                <div
                  className="gantt-milestone-overlay-line"
                  style={{ borderLeftColor: milestone.color }}
                />
              </div>
            );
          })}
        </div>
      <div className="gantt-header">
        <div className="gantt-labels gantt-labels-spacer" aria-hidden="true" />
        <div className="gantt-timeline">
          <div className="gantt-dates">
            <div className="gantt-months">
              {timeScale === 'quarter'
                ? quarters.map((quarter, index) => {
                    // Centre the quarter label over its visible span.
                    const qStart = quarter;
                    const qEnd = new Date(quarter.getFullYear(), quarter.getMonth() + 3, 1);
                    const effectiveStart = qStart < range.start ? range.start : qStart;
                    const effectiveEnd = qEnd > range.end ? range.end : qEnd;
                    const centerDate = new Date(
                      (effectiveStart.getTime() + effectiveEnd.getTime()) / 2
                    );
                    const prevQuarter = index > 0 ? quarters[index - 1] : null;
                    const showYear = !prevQuarter || prevQuarter.getFullYear() !== quarter.getFullYear();
                    return (
                      <div
                        key={quarter.toISOString()}
                        className="gantt-month"
                        style={{ left: `${getPercent(range, centerDate)}%` }}
                      >
                        <span className="gantt-month-name">{quarterLabel(quarter)}</span>
                        {showYear && (
                          <span className="gantt-month-year"> {quarter.getFullYear()}</span>
                        )}
                      </div>
                    );
                  })
                : months.map((month, index) => {
                    // Centre the label over the month's visible span.
                    const monthStart = month;
                    const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1);
                    const effectiveStart = monthStart < range.start ? range.start : monthStart;
                    const effectiveEnd = monthEnd > range.end ? range.end : monthEnd;
                    const centerMs = (effectiveStart.getTime() + effectiveEnd.getTime()) / 2;
                    const centerDate = new Date(centerMs);
                    const prevMonth = index > 0 ? months[index - 1] : null;
                    const showYear = !prevMonth || prevMonth.getFullYear() !== month.getFullYear();
                    return (
                      <div
                        key={month.toISOString()}
                        className="gantt-month"
                        style={{ left: `${getPercent(range, centerDate)}%` }}
                      >
                        <span className="gantt-month-name">
                          {month.toLocaleDateString('en-GB', { month: 'short' })}
                        </span>
                        {showYear && (
                          <span className="gantt-month-year"> {month.getFullYear()}</span>
                        )}
                      </div>
                    );
                  })}
            </div>
            <div className="gantt-ticks">
              {timeScale === 'quarter' ? (
                <>
                  {quarters.map((quarter) => (
                    <div
                      key={`boundary-${quarter.toISOString()}`}
                      className="gantt-tick-boundary"
                      style={{ left: `${getPercent(range, quarter)}%` }}
                      aria-hidden="true"
                    />
                  ))}
                  {months.map((month) => {
                    // Month labels render as the sub-scale, centred over each
                    // month's visible span beneath the quarter bands.
                    const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1);
                    const effectiveStart = month < range.start ? range.start : month;
                    const effectiveEnd = monthEnd > range.end ? range.end : monthEnd;
                    const centerDate = new Date(
                      (effectiveStart.getTime() + effectiveEnd.getTime()) / 2
                    );
                    return (
                      <div
                        key={`month-sub-${month.toISOString()}`}
                        className="gantt-tick"
                        style={{ left: `${getPercent(range, centerDate)}%` }}
                      >
                        <span>{month.toLocaleDateString('en-GB', { month: 'short' })}</span>
                      </div>
                    );
                  })}
                </>
              ) : (
                <>
                  {months.map((month) => (
                    <div
                      key={`boundary-${month.toISOString()}`}
                      className="gantt-tick-boundary"
                      style={{ left: `${getPercent(range, month)}%` }}
                      aria-hidden="true"
                    />
                  ))}
                  {ticks.map((tick) => (
                    <div
                      key={tick.toISOString()}
                      className="gantt-tick"
                      style={{ left: `${getPercent(range, tick)}%` }}
                    >
                      <span>{formatDay(tick)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="gantt-milestone-row" aria-hidden="true" />
        </div>
      </div>
      <div className="gantt-body" ref={ganttBodyRef}>
        <div className="gantt-grid-lines">
          {months.map((month) => (
            <div
              key={month.toISOString()}
              className="gantt-grid-line"
              style={{ left: `${getPercent(range, month)}%` }}
            />
          ))}
        </div>
        {showDependencies && (dependencyEdges.length > 0 || swimlaneDependencyEdges.length > 0 || dragState) && (
          <div
            className="gantt-dependency-layer"
            aria-hidden="true"
            style={{ pointerEvents: dragState ? 'none' : undefined }}
          >
            <svg viewBox={`0 0 ${VIEWBOX_WIDTH} ${dependencyLayerHeight}`} preserveAspectRatio="none">
              <defs>
                {/*
                  userSpaceOnUse puts the marker in the parent SVG's viewBox
                  units, so we can shorten the path by a known percentage
                  (ARROW_TIP_MARGIN_PCT) and have the triangle's base line up
                  with the line's end. refX=0 anchors the triangle's BACK to
                  the path endpoint; the tip (at internal x=12) then extends
                  forward onto the target bar.
                */}
                <marker id="gantt-dep-arrow-ok" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto">
                  <path className="gantt-dep-arrow ok" d="M0,0 L12,5 L0,10 Z" />
                </marker>
                <marker id="gantt-dep-arrow-warning" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto">
                  <path className="gantt-dep-arrow warning" d="M0,0 L12,5 L0,10 Z" />
                </marker>
                <marker id="gantt-dep-arrow-manual" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto">
                  <path className="gantt-dep-arrow manual" d="M0,0 L12,5 L0,10 Z" />
                </marker>
                <marker id="gantt-dep-arrow-preview" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto">
                  <path className="gantt-dep-arrow preview" d="M0,0 L12,5 L0,10 Z" />
                </marker>
                {/*
                  Swimlane "arrow under text" mask (mockup option 6). White
                  rect covers the full viewbox so paths render normally by
                  default; black rects punch holes wherever a bar/milestone
                  text label lives, so the path is invisible behind text and
                  the underlying letters read cleanly. maskUnits="userSpaceOnUse"
                  pins coords to the parent SVG's viewbox (0..VIEWBOX_WIDTH x
                  0..dependencyLayerHeight) — matching how swimlaneTextMaskRects
                  is computed in the measurement effect above.
                */}
                {mode === 'swimlane' && swimlaneTextMaskRects.length > 0 && (
                  <mask id="gantt-dep-text-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={VIEWBOX_WIDTH} height={dependencyLayerHeight}>
                    <rect x={0} y={0} width={VIEWBOX_WIDTH} height={dependencyLayerHeight} fill="white" />
                    {swimlaneTextMaskRects.map((r, i) => (
                      <rect key={`text-mask-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="black" />
                    ))}
                  </mask>
                )}
              </defs>
              {mode !== 'swimlane' && dependencyEdges.map((edge, index) => {
                const edgeKey = `${edge.fromId}-${edge.toId}-${index}`;
                // Use shared-spine routing only when (a) this target is a
                // hub (the approachXByTarget map has it), and (b) the spine
                // sits safely to the right of the source bar. For backward
                // edges (target before source) the spine would sit behind
                // the source — fall back to the default channel routing.
                const sharedApproachX = approachXByTarget.get(edge.toRowId);
                const useSharedSpine =
                  sharedApproachX !== undefined
                  && edge.fromRowIdx !== edge.toRowIdx
                  && sharedApproachX > edge.fromX + 0.1;
                const path = buildOrthoPath(
                  edge,
                  rowBars,
                  useSharedSpine ? sharedApproachX : undefined
                );
                const markerId = edge.warning
                  ? 'gantt-dep-arrow-warning'
                  : edge.source === 'manual'
                  ? 'gantt-dep-arrow-manual'
                  : 'gantt-dep-arrow-ok';
                return (
                  <g key={edgeKey}>
                    <path
                      d={path}
                      className={`gantt-dependency-path${edge.warning ? ' is-warning' : ''}${
                        edge.source === 'manual' ? ' is-manual' : ''
                      }`}
                      markerEnd={`url(#${markerId})`}
                    />
                    {edge.source === 'manual'
                      && onRemoveDependency
                      && edge.overrideId
                      && !edge.overrideId.startsWith('temp:')
                      && (
                      <g
                        className="gantt-dependency-remove-group"
                        onPointerEnter={() => setHoveredManualEdgeKey(edgeKey)}
                        onPointerLeave={() => setHoveredManualEdgeKey((prev) => (prev === edgeKey ? null : prev))}
                      >
                        {/* Invisible wide hit area so hover is easy to trigger. */}
                        <path
                          d={path}
                          className="gantt-dependency-hit"
                          fill="none"
                          stroke="transparent"
                          strokeWidth={14}
                        />
                        {hoveredManualEdgeKey === edgeKey && (() => {
                          // Place the dot just before the arrow tip — on the
                          // final horizontal "hook" into the target bar.
                          const dotPct = Math.max(0, edge.toX - ORTHO_IN_OFFSET / 10 / 2);
                          return (
                            <g
                              className="gantt-dependency-remove"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRemoveDepClick(edge.overrideId!);
                              }}
                              style={{ cursor: 'pointer' }}
                            >
                              <title>Remove dependency</title>
                              <circle
                                cx={toViewboxX(dotPct)}
                                cy={edge.toY}
                                r={7}
                                className="gantt-dependency-remove-dot"
                              />
                              <line
                                x1={toViewboxX(dotPct) - 3}
                                x2={toViewboxX(dotPct) + 3}
                                y1={edge.toY - 3}
                                y2={edge.toY + 3}
                                className="gantt-dependency-remove-x"
                              />
                              <line
                                x1={toViewboxX(dotPct) - 3}
                                x2={toViewboxX(dotPct) + 3}
                                y1={edge.toY + 3}
                                y2={edge.toY - 3}
                                className="gantt-dependency-remove-x"
                              />
                            </g>
                          );
                        })()}
                      </g>
                    )}
                  </g>
                );
              })}
              {mode === 'swimlane' && swimlaneDependencyEdges.map((edge) => {
                // Forward edges from a source with 2+ outgoing forward edges
                // share a trunk X (source bundling, see swimlaneBundleByFromId).
                // Forward edges that converge on a target with 2+ incoming
                // forward edges share a bus X (target bundling, see
                // swimlaneBundleByToId). When BOTH apply to an edge, the path
                // becomes a 5-segment route. See buildSwimlanePath.
                const sourceBundle = swimlaneBundleByFromId.get(edge.fromId);
                const targetBundle = swimlaneBundleByToId.get(edge.toId);
                const path = buildSwimlanePath(
                  edge,
                  swimlaneGutterYs,
                  sourceBundle?.trunkX,
                  targetBundle?.busX
                );
                const markerId = edge.warning
                  ? 'gantt-dep-arrow-warning'
                  : edge.source === 'manual'
                  ? 'gantt-dep-arrow-manual'
                  : 'gantt-dep-arrow-ok';
                // Apply the text-mask only when there's something to mask
                // (avoids referencing an undefined mask element when there
                // are no text-mask rects yet on first paint). We apply it
                // to the visible path only — the manual-edge remove "X" UI
                // and hover hit-area should NOT get cut by the same mask.
                const maskAttr =
                  swimlaneTextMaskRects.length > 0
                    ? 'url(#gantt-dep-text-mask)'
                    : undefined;
                return (
                  <g key={edge.edgeKey}>
                    <path
                      d={path}
                      className={`gantt-dependency-path${edge.warning ? ' is-warning' : ''}${
                        edge.source === 'manual' ? ' is-manual' : ''
                      }`}
                      markerEnd={`url(#${markerId})`}
                      mask={maskAttr}
                    />
                    {edge.source === 'manual'
                      && onRemoveDependency
                      && edge.overrideId
                      && !edge.overrideId.startsWith('temp:')
                      && (
                      <g
                        className="gantt-dependency-remove-group"
                        onPointerEnter={() => setHoveredManualEdgeKey(edge.edgeKey)}
                        onPointerLeave={() => setHoveredManualEdgeKey((prev) => (prev === edge.edgeKey ? null : prev))}
                      >
                        <path
                          d={path}
                          className="gantt-dependency-hit"
                          fill="none"
                          stroke="transparent"
                          strokeWidth={14}
                        />
                        {hoveredManualEdgeKey === edge.edgeKey && (() => {
                          const dotPct = Math.max(0, edge.toX - 1.2);
                          return (
                            <g
                              className="gantt-dependency-remove"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRemoveDepClick(edge.overrideId!);
                              }}
                              style={{ cursor: 'pointer' }}
                            >
                              <title>Remove dependency</title>
                              <circle
                                cx={toViewboxX(dotPct)}
                                cy={edge.toY}
                                r={7}
                                className="gantt-dependency-remove-dot"
                              />
                              <line
                                x1={toViewboxX(dotPct) - 3}
                                x2={toViewboxX(dotPct) + 3}
                                y1={edge.toY - 3}
                                y2={edge.toY + 3}
                                className="gantt-dependency-remove-x"
                              />
                              <line
                                x1={toViewboxX(dotPct) - 3}
                                x2={toViewboxX(dotPct) + 3}
                                y1={edge.toY + 3}
                                y2={edge.toY - 3}
                                className="gantt-dependency-remove-x"
                              />
                            </g>
                          );
                        })()}
                      </g>
                    )}
                  </g>
                );
              })}
              {dragState && (() => {
                let previewPath: string;
                if (mode === 'swimlane') {
                  // Swimlane preview: use the swimlane bar metrics for the
                  // target (if any), otherwise the ortho-style L-path to the
                  // cursor so the preview still reads as an elbow route.
                  const overId = dragState.overRowId ?? '';
                  const targetMetric = overId ? swimlaneBarMetrics.get(overId) : undefined;
                  if (overId && targetMetric) {
                    // Look up the target's clamped bar via the shared
                    // swimlaneBarById memo so this preview path is O(1) per
                    // pointer-move. The previous nested lane × bar scan ran
                    // on every cursor update and made dependency creation
                    // visibly choppy on dense dashboards.
                    const targetBarInfo = swimlaneBarById.get(overId);
                    const targetBar: { clamped: Range } | null = targetBarInfo
                      ? { clamped: targetBarInfo.clamped }
                      : null;
                    // Mirror the pixel-aware target gaps from the committed-edge
                    // memo (`swimlaneDependencyEdges`) so the dashed preview lands
                    // in exactly the same spot as the finalised arrow — without
                    // this, narrow / wide charts saw a visible "jump" on drop
                    // because the committed edge uses a px-derived gap while the
                    // preview was hardcoded to 2%.
                    const MILESTONE_LEFT_VERTEX_PX = 10.5;
                    const MILESTONE_TARGET_CLEARANCE_PX = 2;
                    const BAR_DEP_TARGET_PX = 5;
                    const pxToPctPreview = (px: number): number =>
                      swimlaneDepLayerWidthPx > 0
                        ? (px / swimlaneDepLayerWidthPx) * 100
                        : px * 0.1;
                    const milestoneTargetGapPct = pxToPctPreview(
                      MILESTONE_LEFT_VERTEX_PX + MILESTONE_TARGET_CLEARANCE_PX
                    );
                    const barDepTargetGapPct = pxToPctPreview(BAR_DEP_TARGET_PX);
                    const toX = targetBar
                      ? swimlaneMilestoneView
                        ? getPercent(range, targetBar.clamped.end) -
                          milestoneTargetGapPct
                        : getPercent(range, targetBar.clamped.start) -
                          barDepTargetGapPct
                      : dragState.cursorX;
                    previewPath = buildSwimlanePath(
                      {
                        fromX: dragState.fromX,
                        toX,
                        fromY: dragState.fromY,
                        toY: targetMetric.centerY
                      },
                      swimlaneGutterYs
                    );
                  } else {
                    previewPath = roundedOrtho(
                      [
                        [dragState.fromX, dragState.fromY],
                        [dragState.cursorX, dragState.fromY],
                        [dragState.cursorX, dragState.cursorY]
                      ],
                      ORTHO_CORNER_R
                    );
                  }
                } else {
                  const fromRowIdx = visibleRows.findIndex((r) => r.row.id === dragState.fromRowId);
                  const toRowIdx = visibleRows.findIndex(
                    (r) => r.row.id === (dragState.overRowId ?? '')
                  );
                  if (dragState.overRowId && toRowIdx >= 0) {
                    // Cursor is over a valid target row — use the real ortho router so
                    // the dashed preview matches the path the committed edge would take.
                    // Snap the preview end point to the target bar's left edge + vertical
                    // centre, so hovering anywhere in the row (not just on the bar) shows
                    // the arrow landing where it actually would on release.
                    const targetBar = rowBars[toRowIdx];
                    const toX = targetBar ? targetBar.leftPct : dragState.cursorX;
                    const toY = targetBar
                      ? (targetBar.barTop + targetBar.barBottom) / 2
                      : dragState.cursorY;
                    const previewEdge: DependencyEdge = {
                      fromId: dragState.fromRowId,
                      toId: '',
                      fromRowId: dragState.fromRowId,
                      toRowId: dragState.overRowId,
                      fromX: dragState.fromX,
                      fromStartX: dragState.fromX,
                      toX,
                      fromY: dragState.fromY,
                      toY,
                      warning: false,
                      source: 'manual',
                      overrideId: null,
                      fromRowIdx,
                      toRowIdx
                    };
                    previewPath = buildOrthoPath(previewEdge, rowBars);
                  } else {
                    // Cursor is in empty space — draw an L-path that still reads as an
                    // ortho route: go right from the source bar, then vertically to the
                    // cursor, rather than a straight diagonal line.
                    previewPath = roundedOrtho(
                      [
                        [dragState.fromX, dragState.fromY],
                        [dragState.cursorX, dragState.fromY],
                        [dragState.cursorX, dragState.cursorY]
                      ],
                      ORTHO_CORNER_R
                    );
                  }
                }
                return (
                  <path
                    d={previewPath}
                    className={`gantt-dependency-path is-preview${
                      dragState.overRowId ? ' is-valid-target' : ''
                    }`}
                    markerEnd="url(#gantt-dep-arrow-preview)"
                  />
                );
              })()}
            </svg>
          </div>
        )}
        {mode === 'swimlane' ? (
          (() => {
            const renderSwimlaneLane = (lane: SwimlaneRow, laneIdx: number) => {
            // Milestone view uses a shrunk per-row height so the track
            // doesn't reserve vertical space for a bar + UAT/Live marker
            // rows that aren't drawn. Everything else (label column,
            // lane gap, padding) stays identical to bars view so the
            // two modes visually align when toggled.
            const rowUnitHeight = swimlaneMilestoneView ? LANE_MILESTONE_ROW_HEIGHT : LANE_ROW_HEIGHT;
            // Milestone view reserves vertical space at the top of the
            // track for the row-0 caption (which renders above its diamond).
            // Bars view doesn't need this — captions live inside the bar.
            const captionGutter = swimlaneMilestoneView ? LANE_MILESTONE_CAPTION_GUTTER : 0;
            const trackHeight =
              lane.rowCount * rowUnitHeight +
              (lane.rowCount - 1) * LANE_ROW_GAP +
              LANE_TRACK_PADDING * 2 +
              captionGutter;

            // Tag odd-indexed lanes so CSS can paint a subtle alternating
            // background tint — helps the eye track horizontally across
            // long lists of lanes without being visually loud.
            const laneClass = `gantt-lane${laneIdx % 2 === 1 ? ' gantt-lane--alt' : ''}`;

            return (
              <div key={`lane-${lane.id}`} className={laneClass}>
                <div className="gantt-lane-label">
                  <span>{lane.name}</span>
                </div>
                <div className="gantt-lane-track" style={{ height: `${trackHeight}px` }}>
                  {/* `.gantt-lane-inner` establishes a positioning context
                      whose x-range matches the top timeline's tick inset
                      (var(--gantt-gap) + var(--gantt-side) on the left,
                      var(--gantt-side) on the right). By wrapping the
                      grid-lines, empty-state, and all bars in here, their
                      `left: X%` positions map to the same viewport x as the
                      "X% tick" in the header above — which fixes the month
                      grid-line / top-tick misalignment that was visible in
                      swimlane mode. The lane-track itself still paints the
                      full-width rounded background/border unchanged. */}
                  <div className="gantt-lane-inner">
                  {/* Per-lane month grid-lines. Rendered inside the track so
                      they share the track's stacking context with the bars —
                      keeping the lines above the lane background but BELOW
                      the bars (which are z:2 inside the track). */}
                  <div className="gantt-lane-grid-lines" aria-hidden="true">
                    {months.map((month) => (
                      <div
                        key={`lane-grid-${lane.id}-${month.toISOString()}`}
                        className="gantt-grid-line"
                        style={{ left: `${getPercent(range, month)}%` }}
                      />
                    ))}
                  </div>
                  {lane.bars.length === 0 && !customBars.some((cb) => cb.swimlaneId === null) && <div className="gantt-lane-empty">No fix versions</div>}
                  {lane.bars.map((bar) => {
                    const labelTop =
                      LANE_TRACK_PADDING +
                      captionGutter +
                      bar.rowIndex * (rowUnitHeight + LANE_ROW_GAP);
                    const barTop = labelTop + LANE_LABEL_HEIGHT;

                    // ── Custom bar (synthesised from user-defined CustomBar) ─
                    if (bar.isCustomBar) {
                      const cbLeft = getPercent(range, bar.clamped.start);
                      const cbWidth = Math.max(1, getPercent(range, bar.clamped.end) - cbLeft);
                      const showCbName = bar.customBarShowName !== false;
                      // Mirror the standard-bar behaviour: a bar narrower than
                      // ~6% of the track can't hold its name without ellipsing to
                      // a single letter, so render the name as a small caption
                      // above the bar instead of inside it.
                      const CB_SHORT_BAR_THRESHOLD_PCT = 6;
                      const cbIsShort = showCbName && cbWidth < CB_SHORT_BAR_THRESHOLD_PCT;
                      const cbInBarName = showCbName && !cbIsShort;
                      return (
                        <div key={`lane-bar-custom-${bar.fix.id}`} className="gantt-lane-item">
                          {cbIsShort && (
                            <span
                              className="gantt-lane-bar-short-label"
                              data-text-mask="1"
                              style={{
                                top: `${barTop - 14}px`,
                                left: `${cbLeft}%`,
                                ...(bar.customBarColor ? { color: bar.customBarColor } : {})
                              }}
                              title={bar.fix.name}
                            >
                              {bar.fix.name}
                            </span>
                          )}
                          <div
                            className={`gantt-lane-bar gantt-lane-bar--custom${cbInBarName ? ' gantt-lane-bar--labelled' : ''}`}
                            data-dep-row-id={bar.fix.id}
                            data-dep-row-type="fix"
                            data-swimlane-bar="true"
                            style={{
                              top: `${barTop}px`,
                              left: `${cbLeft}%`,
                              width: `${cbWidth}%`,
                              height: `${LANE_BAR_HEIGHT}px`,
                              // Only honour the per-bar custom colour in
                              // manual mode. Under an auto colour scheme
                              // (rag/project/swimlane/initiative) custom bars
                              // fall back to the default custom styling; the
                              // stored colour is left untouched so switching
                              // back to manual restores it.
                              ...(colourMode === 'manual' && bar.customBarColor ? {
                                background: `${bar.customBarColor}2e`,
                                outlineColor: bar.customBarColor,
                                color: bar.customBarColor,
                              } : {})
                            }}
                            onMouseEnter={(event) => {
                              if (assignPopover) return;
                              const rect = event.currentTarget.getBoundingClientRect();
                              setHoveredBarRect({ left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width });
                              setHoveredBarRowId(bar.fix.id);
                            }}
                            onMouseLeave={() => {
                              setHoveredBarRowId(null);
                              setHoveredBarRect(null);
                            }}
                            aria-label={bar.fix.name}
                          >
                            {cbInBarName && (
                              <span className="gantt-lane-bar-text" data-text-mask="1">{bar.fix.name}</span>
                            )}
                            {depEditEnabled && (
                              <button
                                type="button"
                                className="gantt-dependency-handle"
                                onPointerDown={(event) =>
                                  handleSwimlaneDragPointerDown(
                                    event,
                                    bar.fix.id,
                                    bar.clamped.start,
                                    bar.clamped.end
                                  )
                                }
                                aria-label="Drag to create dependency"
                              />
                            )}
                          </div>
                        </div>
                      );
                    }

                    const startLabel = formatFullDate(bar.fix.start);
                    const endLabel = formatFullDate(bar.fix.release);
                    const leftPercent = getPercent(range, bar.clamped.start);
                    // UAT / Live are now point-in-time markers anchored to the
                    // end date. Derive the marker date from end ?? start so a
                    // record that only has an end (no start) still renders a
                    // diamond — clampRange's "start || end" fallback lives on
                    // end, not start, so we have to do the fallback ourselves.
                    const uatMarkerDate = bar.fix.uatEnd ?? bar.fix.uatStart;
                    const liveMarkerDate = bar.fix.liveEnd ?? bar.fix.liveStart;
                    const uatRange = clampRange(range, uatMarkerDate, uatMarkerDate);
                    const liveRange = clampRange(range, liveMarkerDate, liveMarkerDate);
                    const markerTop = barTop + LANE_BAR_HEIGHT + LANE_MARKER_OFFSET;
                    const hasUat = Boolean(uatRange);
                    const liveTop = hasUat ? markerTop + LANE_MARKER_HEIGHT + LANE_MARKER_GAP : markerTop;
                    const barWidthPercent = Math.max(
                      1,
                      getPercent(range, bar.clamped.end) - leftPercent
                    );
                    // Milestone view: hide the bar, render only a diamond
                    // at the bar's end date. Keep the row layout/height so
                    // UAT/Live markers below still line up with their bar.
                    const milestoneMode = swimlaneMilestoneView;
                    const barEndPercent = getPercent(range, bar.clamped.end);
                    // A bar narrower than ~6% of the track can't fit the name
                    // + percent without the text becoming an unreadable
                    // single-letter ellipsis. For those we drop the in-bar
                    // label entirely and render a small caption above the
                    // bar instead (see shortLabel below).
                    const SHORT_BAR_THRESHOLD_PCT = 6;
                    const isShortBar = !milestoneMode && barWidthPercent < SHORT_BAR_THRESHOLD_PCT;
                    // 3-way progress shading overlays — same "done → in-flight
                    // → not-started" model the standard view uses, rendered as
                    // two absolutely-positioned divs INSIDE the bar. Skipped
                    // for milestone view (no bar to shade) and when the toggle
                    // is off. Bars with no rolled-up issues (progressTotal == 0)
                    // are still shaded: they sit at 0%, so the incomplete
                    // overlay covers the whole bar — giving an empty 0% release
                    // the same outlined look as a 0%-complete one.
                    const showShading = showProgressShading && !milestoneMode;
                    // At 0% done we suppress the in-flight band and let the
                    // incomplete wash cover the whole bar — so a 0%-complete
                    // release with in-progress work looks identical to an empty
                    // one (uniform outlined wash), instead of showing a lighter
                    // in-flight strip that reads as "a different colour".
                    const incompleteLeft = bar.progressPercent > 0 ? bar.progressInFlightPercent : 0;
                    const progressShading = showShading ? (
                      <>
                        {bar.progressPercent > 0 && bar.progressInFlightPercent > bar.progressPercent && (
                          <div
                            className="gantt-bar-inflight"
                            style={{
                              left: `${bar.progressPercent}%`,
                              width: `${bar.progressInFlightPercent - bar.progressPercent}%`
                            }}
                          />
                        )}
                        {incompleteLeft < 100 && (
                          <div
                            className="gantt-bar-incomplete"
                            style={{ left: `${incompleteLeft}%` }}
                          />
                        )}
                      </>
                    ) : null;
                    const barInner = isShortBar ? null : (
                      <>
                        <span className="gantt-lane-bar-text" data-text-mask="1">{bar.fix.name}</span>
                        <span className="gantt-lane-bar-progress" data-text-mask="1">{bar.progressPercent}%</span>
                      </>
                    );
                    // When a non-RAG colour mode is active, look up the colour
                    // for this fix version's group and apply it as an inline
                    // background override on the bar.
                    const assignedCatId = colourMode !== 'rag' ? colourGroups.fixToGroup.get(bar.fix.id) : undefined;
                    const assignedCatColour = assignedCatId
                      ? catColourById.get(assignedCatId)
                      : undefined;
                    const handleBarContextMenu = (e: React.MouseEvent) => {
                      // Right-click assignment only applies to manual mode.
                      if (colourMode !== 'manual') return;
                      e.preventDefault();
                      setHoveredBarRect(null);
                      setHoveredBarRowId(null);
                      setAssignPopover({ fixVersionId: bar.fix.id, x: e.clientX, y: e.clientY });
                    };
                    const shortLabel = isShortBar ? (
                      <span
                        className="gantt-lane-bar-short-label"
                        data-text-mask="1"
                        style={{
                          top: `${barTop - 14}px`,
                          left: `${leftPercent}%`
                        }}
                        title={bar.fix.name}
                      >
                        {bar.fix.name}
                      </span>
                    ) : null;
                    // Drag handle for creating a dependency off this swimlane
                    // bar. Rendered inside the bar/milestone so CSS can keep it
                    // pinned to the right edge via `.gantt-dependency-handle`.
                    const depHandle = depEditEnabled ? (
                      <button
                        type="button"
                        className="gantt-dependency-handle"
                        onPointerDown={(event) =>
                          handleSwimlaneDragPointerDown(
                            event,
                            bar.fix.id,
                            bar.clamped.start,
                            bar.clamped.end
                          )
                        }
                        aria-label="Drag to create dependency"
                      />
                    ) : null;
                    // Shared hover handlers — capture the bar/milestone's
                    // viewport rect so the portalled styled tooltip (rendered
                    // below the swimlane block) can position itself relative
                    // to this bar. Mirrors the standard-view hover pattern.
                    const onBarMouseEnter: React.MouseEventHandler<HTMLElement> = (event) => {
                      if (assignPopover) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      setHoveredBarRect({
                        left: rect.left,
                        right: rect.right,
                        bottom: rect.bottom,
                        width: rect.width
                      });
                      setHoveredBarRowId(bar.fix.id);
                    };
                    const onBarMouseLeave = () => {
                      setHoveredBarRowId(null);
                      setHoveredBarRect(null);
                    };
                    return (
                      <div key={`lane-bar-${lane.id}-${bar.fix.id}`} className="gantt-lane-item">
                        {shortLabel}
                        {milestoneMode ? (
                          <div
                            className={`gantt-lane-milestone status-${bar.status}`}
                            data-row-index={bar.rowIndex}
                            data-dep-row-id={bar.fix.id}
                            data-dep-row-type="fix"
                            data-swimlane-bar="true"
                            style={{
                              // Centre the diamond vertically inside the
                              // (now compacted) milestone row. Diamond layout
                              // box is 12px, so `rowUnitHeight/2 - 6` puts its
                              // layout centre on the row centre; the extra
                              // -2px matches the classic bars-view offset so
                              // the visual centre (after rotation) feels the
                              // same in both views.
                              top: `${barTop + rowUnitHeight / 2 - 8}px`,
                              left: `${barEndPercent}%`
                            }}
                            onMouseEnter={onBarMouseEnter}
                            onMouseLeave={onBarMouseLeave}
                          >
                            {bar.fix.url ? (
                              <a
                                className="gantt-lane-milestone-hit"
                                href={bar.fix.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={bar.fix.name}
                              >
                                <span
                                  className="gantt-lane-milestone-diamond"
                                  style={assignedCatColour ? { background: assignedCatColour, outline: `1px solid ${assignedCatColour}` } : undefined}
                                />
                                <span className="gantt-lane-milestone-caption" data-text-mask="1">
                                  {showDependencies && bar.fix.externalLinks && bar.fix.externalLinks.length > 0 && (
                                    // Inline variant of the ext-link badge — shown before
                                    // the caption in milestone view so the cross-project
                                    // dep indicator is still visible (no bar to anchor it
                                    // to). Full list surfaces in the hover tooltip.
                                    <span
                                      className="gantt-ext-link-badge gantt-ext-link-badge--caption"
                                      aria-hidden="true"
                                    >
                                      !
                                    </span>
                                  )}
                                  {bar.fix.name}
                                </span>
                              </a>
                            ) : (
                              <>
                                <span
                                  className="gantt-lane-milestone-diamond"
                                  style={assignedCatColour ? { background: assignedCatColour, outline: `1px solid ${assignedCatColour}` } : undefined}
                                />
                                <span className="gantt-lane-milestone-caption" data-text-mask="1">
                                  {showDependencies && bar.fix.externalLinks && bar.fix.externalLinks.length > 0 && (
                                    <span
                                      className="gantt-ext-link-badge gantt-ext-link-badge--caption"
                                      aria-hidden="true"
                                    >
                                      !
                                    </span>
                                  )}
                                  {bar.fix.name}
                                </span>
                              </>
                            )}
                            {depHandle}
                          </div>
                        ) : bar.fix.url ? (
                          <a
                            className={`gantt-lane-bar status-${bar.status} gantt-lane-bar--labelled${assignedCatColour ? ' has-cat-colour' : ''}`}
                            href={bar.fix.url}
                            target="_blank"
                            rel="noreferrer"
                            data-row-index={bar.rowIndex}
                            data-dep-row-id={bar.fix.id}
                            data-dep-row-type="fix"
                            data-swimlane-bar="true"
                            style={{
                              top: `${barTop}px`,
                              left: `${leftPercent}%`,
                              width: `${barWidthPercent}%`,
                              height: `${LANE_BAR_HEIGHT}px`,
                              ...(assignedCatColour ? { background: assignedCatColour, outline: `1px solid ${assignedCatColour}` } : {})
                            }}
                            aria-label={bar.fix.name}
                            onMouseEnter={onBarMouseEnter}
                            onMouseLeave={onBarMouseLeave}
                            onContextMenu={handleBarContextMenu}
                          >
                            {barInner}
                            {progressShading}
                            {depHandle}
                          </a>
                        ) : (
                          <div
                            className={`gantt-lane-bar status-${bar.status} gantt-lane-bar--labelled${assignedCatColour ? ' has-cat-colour' : ''}`}
                            data-row-index={bar.rowIndex}
                            data-dep-row-id={bar.fix.id}
                            data-dep-row-type="fix"
                            data-swimlane-bar="true"
                            style={{
                              top: `${barTop}px`,
                              left: `${leftPercent}%`,
                              width: `${barWidthPercent}%`,
                              height: `${LANE_BAR_HEIGHT}px`,
                              ...(assignedCatColour ? { background: assignedCatColour, outline: `1px solid ${assignedCatColour}` } : {})
                            }}
                            aria-label={bar.fix.name}
                            onMouseEnter={onBarMouseEnter}
                            onMouseLeave={onBarMouseLeave}
                            onContextMenu={handleBarContextMenu}
                          >
                            {barInner}
                            {progressShading}
                            {depHandle}
                          </div>
                        )}
                        {showDependencies && !milestoneMode && bar.fix.externalLinks && bar.fix.externalLinks.length > 0 && (
                          // External-dependencies badge in the swimlane view,
                          // pinned to the bar's top-left corner.
                          <span
                            className="gantt-ext-link-badge gantt-ext-link-badge--lane"
                            role="button"
                            tabIndex={0}
                            aria-label={`External dependencies: ${bar.fix.externalLinks.join(', ')}`}
                            style={{
                              top: `${barTop - 6}px`,
                              left: `calc(${leftPercent}% - 6px)`
                            }}
                            onMouseEnter={(event) => {
                              const r = event.currentTarget.getBoundingClientRect();
                              setHoveredMarker({
                                kind: 'ext-links',
                                keys: bar.fix.externalLinks || [],
                                rect: {
                                  left: r.left,
                                  right: r.right,
                                  bottom: r.bottom,
                                  width: r.width
                                }
                              });
                            }}
                            onMouseLeave={() => setHoveredMarker(null)}
                            onFocus={(event) => {
                              const r = event.currentTarget.getBoundingClientRect();
                              setHoveredMarker({
                                kind: 'ext-links',
                                keys: bar.fix.externalLinks || [],
                                rect: {
                                  left: r.left,
                                  right: r.right,
                                  bottom: r.bottom,
                                  width: r.width
                                }
                              });
                            }}
                            onBlur={() => setHoveredMarker(null)}
                          >
                            !
                          </span>
                        )}
                        {uatRange && !milestoneMode && (
                          /* Point-in-time diamond marker at UAT end date.
                             Suppressed in milestone view: that mode shrinks
                             rows to LANE_MILESTONE_ROW_HEIGHT (20px) which
                             doesn't reserve vertical space for these markers
                             — rendering them anyway would overflow into the
                             next swimlane row. */
                          <div
                            className="gantt-marker-point uat"
                            style={{
                              top: `${markerTop + LANE_MARKER_HEIGHT / 2 - 5}px`,
                              left: `${getPercent(range, uatRange.end)}%`,
                            }}
                          >
                            <div
                              className="gantt-marker-point-diamond"
                              role="button"
                              tabIndex={0}
                              aria-label={`UAT ${formatFullDate(bar.fix.uatStart)} → ${formatFullDate(bar.fix.uatEnd)}`}
                              onMouseEnter={(event) => {
                                const r = event.currentTarget.getBoundingClientRect();
                                setHoveredMarker({
                                  kind: 'uat',
                                  startLabel: formatFullDate(bar.fix.uatStart),
                                  endLabel: formatFullDate(bar.fix.uatEnd),
                                  rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                                });
                              }}
                              onMouseLeave={() => setHoveredMarker(null)}
                              onFocus={(event) => {
                                const r = event.currentTarget.getBoundingClientRect();
                                setHoveredMarker({
                                  kind: 'uat',
                                  startLabel: formatFullDate(bar.fix.uatStart),
                                  endLabel: formatFullDate(bar.fix.uatEnd),
                                  rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                                });
                              }}
                              onBlur={() => setHoveredMarker(null)}
                            />
                          </div>
                        )}
                        {liveRange && !milestoneMode && (
                          /* Point-in-time diamond marker at Live end date.
                             Suppressed in milestone view (see UAT block
                             above for the row-height rationale). */
                          <div
                            className="gantt-marker-point live"
                            style={{
                              top: `${liveTop + LANE_MARKER_HEIGHT / 2 - 5}px`,
                              left: `${getPercent(range, liveRange.end)}%`,
                            }}
                          >
                            <div
                              className="gantt-marker-point-diamond"
                              role="button"
                              tabIndex={0}
                              aria-label={`Live ${formatFullDate(bar.fix.liveStart)} → ${formatFullDate(bar.fix.liveEnd)}`}
                              onMouseEnter={(event) => {
                                const r = event.currentTarget.getBoundingClientRect();
                                setHoveredMarker({
                                  kind: 'live',
                                  startLabel: formatFullDate(bar.fix.liveStart),
                                  endLabel: formatFullDate(bar.fix.liveEnd),
                                  rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                                });
                              }}
                              onMouseLeave={() => setHoveredMarker(null)}
                              onFocus={(event) => {
                                const r = event.currentTarget.getBoundingClientRect();
                                setHoveredMarker({
                                  kind: 'live',
                                  startLabel: formatFullDate(bar.fix.liveStart),
                                  endLabel: formatFullDate(bar.fix.liveEnd),
                                  rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                                });
                              }}
                              onBlur={() => setHoveredMarker(null)}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              </div>
            );
            };
            if (!initiativesActive) {
              return laneRows.map((lane, laneIdx) => renderSwimlaneLane(lane, laneIdx));
            }
            return initiativeGroups.map((group) => {
              // Collapsed groups roll their member lanes up into a single
              // aggregated span (precomputed in `initiativeAggBars`), coloured
              // to match the initiative spine.
              const aggBar = initiativeAggBars.get(group.id) ?? null;
              return (
              <div
                key={`init-${group.id}`}
                className={`gantt-init-block${group.isUngrouped ? ' gantt-init-block--ungrouped' : ''}${
                  group.collapsed ? ' is-collapsed' : ''
                }`}
              >
                {group.isUngrouped ? (
                  <div className="gantt-init-spine gantt-init-spine--ungrouped">
                    <span className="gantt-init-spine-name">Ungrouped</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="gantt-init-spine"
                    style={group.colour ? ({ '--init-colour': group.colour } as React.CSSProperties) : undefined}
                    onClick={() => onToggleInitiative?.(group.id)}
                    aria-expanded={!group.collapsed}
                    title={group.collapsed ? 'Expand initiative' : 'Collapse initiative'}
                  >
                    <span className="gantt-init-spine-chevron" aria-hidden="true">
                      {group.collapsed ? '▶' : '▼'}
                    </span>
                    <span className="gantt-init-spine-name">{group.name}</span>
                    <span className="gantt-init-spine-count">
                      {group.laneCount} {group.laneCount === 1 ? 'lane' : 'lanes'}
                    </span>
                  </button>
                )}
                <div className="gantt-init-lanes">
                  {group.collapsed ? (
                    // Mirror the live-lane structure (label cell + track +
                    // inner) so the aggregated bar and its grid-lines inherit
                    // the exact same x-inset as expanded lanes — without this
                    // the bar drifts left by the label-column width.
                    <div className="gantt-lane gantt-lane--collapsed-init">
                      <div className="gantt-lane-label" aria-hidden="true" />
                      <div
                        className="gantt-lane-track"
                        style={{ minHeight: `${LANE_BAR_HEIGHT + LANE_TRACK_PADDING * 2}px` }}
                      >
                        <div className="gantt-lane-inner">
                          <div className="gantt-lane-grid-lines" aria-hidden="true">
                            {months.map((month) => (
                              <div
                                key={`init-grid-${group.id}-${month.toISOString()}`}
                                className="gantt-grid-line"
                                style={{ left: `${getPercent(range, month)}%` }}
                              />
                            ))}
                          </div>
                          {aggBar ? (
                            <div
                              className="gantt-init-agg-bar"
                              style={{
                                left: `${aggBar.left}%`,
                                width: `${aggBar.width}%`,
                                ...(group.colour
                                  ? {
                                      background: `${group.colour}2e`,
                                      outlineColor: group.colour,
                                      color: group.colour
                                    }
                                  : {})
                              }}
                              title={`${group.name}: ${aggBar.startLabel} → ${aggBar.endLabel}`}
                            >
                              <span className="gantt-init-agg-label" data-text-mask="1">
                                {group.laneCount} {group.laneCount === 1 ? 'lane' : 'lanes'}
                              </span>
                            </div>
                          ) : (
                            <span className="gantt-init-collapsed-empty">
                              {group.laneCount} {group.laneCount === 1 ? 'lane' : 'lanes'} collapsed — no dated work
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    group.lanes.map((entry) => renderSwimlaneLane(entry.lane, entry.laneIdx))
                  )}
                </div>
              </div>
              );
            });
          })()
        ) : !standardInitiativesActive && visibleRows.length === 0 ? (
          <div className="gantt-empty-state">
            No fix versions found for the selected filters and date range.
          </div>
        ) : (
          (() => {
            const renderStandardRow = (entry: VisibleRow) => {
            const { row, clamped, index: rowIndex } = entry;
            // Point-in-time diamond — see comment in the swimlane branch.
            const uatMarkerDate = row.uatEnd ?? row.uatStart;
            const liveMarkerDate = row.liveEnd ?? row.liveStart;
            const uatRange = clampRange(range, uatMarkerDate, uatMarkerDate);
            const liveRange = clampRange(range, liveMarkerDate, liveMarkerDate);
            const hasChildren = row.type === 'fix' || row.type === 'epic';
            const isCollapsed = row.type === 'fix'
              ? collapsedFixVersions.has(row.id)
              : row.type === 'epic'
              ? collapsedEpics.has(row.id)
              : false;
            const startLabel = formatFullDate(row.start);
            const endLabel = formatFullDate(row.end);
            const uatLabel =
              row.uatStart || row.uatEnd
                ? `UAT: ${formatFullDate(row.uatStart)} → ${formatFullDate(row.uatEnd)}`
                : '';
            const liveLabel =
              row.liveStart || row.liveEnd
                ? `Live: ${formatFullDate(row.liveStart)} → ${formatFullDate(row.liveEnd)}`
                : '';
            const progressTotal =
              row.type === 'fix' || row.type === 'epic' ? row.progressTotal || 0 : 0;
            const progressDone =
              row.type === 'fix' || row.type === 'epic' ? row.progressDone || 0 : 0;
            // Only fix rows currently carry a 3-way breakdown (done / in-flight
            // / not-started); epics fall back to the original 2-way shading.
            const progressInProgress =
              row.type === 'fix' ? row.progressInProgress || 0 : 0;
            const progressPercent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0;
            // Cumulative percentage covering done + in-progress stories. The
            // space between `progressPercent` and this value becomes the
            // middle "in-flight" band on the fix-version bar.
            const progressInFlightPercent = getInFlightProgressPercent(
              progressDone,
              progressInProgress,
              progressTotal
            );
            // Epics use the same 5-status scale as fix versions so their bars
            // pick up the same colour palette, with one override: if Jira says
            // the epic is Done (statusCategory === "done"), force "completed"
            // (blue) regardless of dates/progress. This mirrors Conor's ask of
            // "if it's done it should be blue".
            const epicIsDone = row.type === 'epic' && row.epicStatusCategory === 'done';
            // Stories are coloured purely from Jira's statusCategory:
            // done = blue (completed), indeterminate = green (in-progress),
            // new = grey (not-started). No date-based scheduling logic because
            // stories don't have start/end in the same way fix versions do.
            const storyStatus =
              row.type === 'story'
                ? row.storyStatusCategory === 'done'
                  ? 'completed'
                  : row.storyStatusCategory === 'indeterminate'
                    ? 'in-progress'
                    : row.storyStatusCategory === 'new'
                      ? 'not-started'
                      : null
                : null;
            const fixStatus =
              row.type === 'fix'
                // Fix bars use done+in-flight for colour so active work
                // keeps them off the at-risk/grey palette. Epic bars keep
                // the done-only signal since they don't publish an
                // in-flight count.
                ? getScheduleStatus(row.start, row.end, row.released, progressInFlightPercent, new Date())
                : row.type === 'epic'
                  ? epicIsDone
                    ? 'completed'
                    : getScheduleStatus(row.start, row.end, false, progressPercent, new Date())
                  : row.type === 'story'
                    ? storyStatus
                    : null;
            const labelNode = row.url ? (
              <a href={row.url} target="_blank" rel="noreferrer">
                {row.label}
              </a>
            ) : (
              <span>{row.label}</span>
            );

            const dependencyInfo = dependencyLinks.byRow.get(row.id);
            const isHighlighted = Boolean(highlightedRows?.has(row.id));

            return (
              <div
                key={`${row.type}-${row.id}`}
                data-row-id={row.id}
                className={`gantt-row level-${row.level}${isHighlighted ? ' is-dep-highlight' : ''}`}
              >
                <div className="gantt-label">
                  {hasChildren ? (
                    <button
                      className="toggle"
                      onClick={() =>
                        row.type === 'fix' ? onToggleFixVersion(row.id) : onToggleEpic(row.id)
                      }
                      aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span className="toggle spacer" />
                  )}
                  <div className="gantt-label-content">
                    <div className="gantt-label-row">
                      {(row.type === 'fix' || row.type === 'epic' || row.type === 'story') && (
                        <JiraTypeIcon
                          type={row.type}
                          size={14}
                          className="gantt-label-icon"
                        />
                      )}
                      {labelNode}
                    </div>
                    {row.type === 'fix' && (
                      <div className="gantt-progress">
                        <div className="gantt-progress-track">
                          <div
                            className="gantt-progress-fill"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                        <span className="gantt-progress-text">{progressPercent}% completed</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="gantt-track">
                  {clamped && (
                    <div
                      className={`gantt-bar ${row.type}${fixStatus ? ` status-${fixStatus}` : ''}${
                        depEditEnabled && (row.type === 'fix' || row.type === 'epic')
                          ? ' dep-edit-enabled'
                          : ''
                      }${hoveredBarRowId === row.id ? ' is-hovered' : ''}`}
                      data-dep-row-id={
                        depEditEnabled && (row.type === 'fix' || row.type === 'epic') ? row.id : undefined
                      }
                      data-dep-row-type={
                        depEditEnabled && (row.type === 'fix' || row.type === 'epic') ? row.type : undefined
                      }
                      onMouseEnter={(event) => {
                        if (depEditEnabled && (row.type === 'fix' || row.type === 'epic')) {
                          setHoveredBarRowId(row.id);
                        }
                        // Drive the unified bar tooltip (label + dates + Blocked-by)
                        // and the blue outline from the bar itself. Tooltip is now
                        // pointer-events:none so there's no reason to keep a
                        // hover-hide delay — it closes the moment the cursor leaves
                        // the bar.
                        cancelDependencyHoverHide();
                        setHoveredDependencyRow(row.id);
                        // Capture the bar's viewport rect so the portalled tooltip
                        // can use position:fixed and escape overflow:hidden ancestors.
                        const rect = event.currentTarget.getBoundingClientRect();
                        setHoveredBarRect({
                          left: rect.left,
                          right: rect.right,
                          bottom: rect.bottom,
                          width: rect.width
                        });
                      }}
                      onMouseLeave={() => {
                        setHoveredBarRowId((prev) => (prev === row.id ? null : prev));
                        // Hide immediately — no grace period.
                        cancelDependencyHoverHide();
                        setHoveredDependencyRow(null);
                      }}
                      style={{
                        left: `${getPercent(range, clamped.start)}%`,
                        width: `${Math.max(1, getPercent(range, clamped.end) - getPercent(range, clamped.start))}%`
                      }}
                    >
                      {/*
                        Progress shading. Fix-version bars get a 3-way band —
                        done (full colour) → in-flight (medium tint) →
                        not-started (heavy tint). Epic bars keep the original
                        2-way shading (done → outstanding). 100%-done bars stay
                        fully saturated regardless.
                      */}
                      {showProgressShading &&
                        row.type === 'fix' &&
                        progressTotal > 0 &&
                        progressInFlightPercent > progressPercent && (
                          // Middle band: done% → (done+in_progress)%.
                          // Rendered under the "not started" overlay so the
                          // tail overlay wins where they would overlap.
                          <div
                            className="gantt-bar-inflight"
                            style={{
                              left: `${progressPercent}%`,
                              width: `${progressInFlightPercent - progressPercent}%`
                            }}
                          />
                        )}
                      {showProgressShading &&
                        row.type === 'fix' &&
                        progressTotal > 0 &&
                        progressInFlightPercent < 100 && (
                          // Tail band: (done+in_progress)% → 100%.
                          <div
                            className="gantt-bar-incomplete"
                            style={{ left: `${progressInFlightPercent}%` }}
                          />
                        )}
                      {showProgressShading &&
                        row.type === 'epic' &&
                        progressTotal > 0 &&
                        progressPercent < 100 && (
                          // Epics: single "outstanding" tail starting at
                          // progressPercent — unchanged from the original
                          // 2-way model.
                          <div
                            className="gantt-bar-incomplete"
                            style={{ left: `${progressPercent}%` }}
                          />
                        )}
                      {depEditEnabled && (row.type === 'fix' || row.type === 'epic') && (
                        <button
                          type="button"
                          className="gantt-dependency-handle"
                          onPointerDown={(event) => handleDragHandlePointerDown(event, row, rowIndex)}
                          aria-label="Drag to create dependency"
                        />
                      )}
                      {showDependencies &&
                        row.type === 'fix' &&
                        row.externalLinks &&
                        row.externalLinks.length > 0 && (
                          // External-dependencies badge: small purple circle
                          // with a "!" pinned to the bar's top-left corner.
                          // Hover surfaces the linked ticket keys.
                          <span
                            className="gantt-ext-link-badge"
                            role="button"
                            tabIndex={0}
                            aria-label={`External dependencies: ${row.externalLinks.join(', ')}`}
                            onMouseEnter={(event) => {
                              event.stopPropagation();
                              // Suppress the underlying bar tooltip while the
                              // ext-links tooltip is showing — otherwise both
                              // would be visible at once.
                              cancelDependencyHoverHide();
                              setHoveredDependencyRow(null);
                              setHoveredBarRect(null);
                              setHoveredBarRowId(null);
                              const r = event.currentTarget.getBoundingClientRect();
                              setHoveredMarker({
                                kind: 'ext-links',
                                keys: row.externalLinks || [],
                                rect: {
                                  left: r.left,
                                  right: r.right,
                                  bottom: r.bottom,
                                  width: r.width
                                }
                              });
                            }}
                            onFocus={(event) => {
                              // Keyboard equivalent of onMouseEnter.
                              cancelDependencyHoverHide();
                              setHoveredDependencyRow(null);
                              setHoveredBarRect(null);
                              setHoveredBarRowId(null);
                              const r = event.currentTarget.getBoundingClientRect();
                              setHoveredMarker({
                                kind: 'ext-links',
                                keys: row.externalLinks || [],
                                rect: {
                                  left: r.left,
                                  right: r.right,
                                  bottom: r.bottom,
                                  width: r.width
                                }
                              });
                            }}
                            onBlur={() => setHoveredMarker(null)}
                            onMouseLeave={(event) => {
                              setHoveredMarker(null);
                              // Bidirectional transfer: if the cursor is moving
                              // BACK onto the parent bar (not off the bar
                              // entirely), re-show the bar's own tooltip —
                              // otherwise the transition badge→bar leaves the
                              // user staring at an empty hover state.
                              const badge = event.currentTarget;
                              const bar = badge.closest('.gantt-bar') as HTMLElement | null;
                              const relatedTarget = event.relatedTarget as Node | null;
                              if (bar && relatedTarget && bar.contains(relatedTarget)) {
                                const rect = bar.getBoundingClientRect();
                                cancelDependencyHoverHide();
                                setHoveredDependencyRow(row.id);
                                setHoveredBarRect({
                                  left: rect.left,
                                  right: rect.right,
                                  bottom: rect.bottom,
                                  width: rect.width
                                });
                                if (depEditEnabled && (row.type === 'fix' || row.type === 'epic')) {
                                  setHoveredBarRowId(row.id);
                                }
                              }
                            }}
                          >
                            !
                          </span>
                        )}
                    </div>
                  )}
                  {hoveredDependencyRow === row.id &&
                    hoveredBarRect &&
                    createPortal(
                      (() => {
                        // Right-edge flip: if the tooltip's default left-aligned
                        // position would push it past the viewport, anchor it to the
                        // bar's right edge instead. 340 is slightly above the tooltip's
                        // max-width so the flip kicks in before we actually clip.
                        const TOOLTIP_MAX_W = 340;
                        const GAP = 6;
                        const viewportW = window.innerWidth;
                        const wouldOverflow =
                          hoveredBarRect.left + TOOLTIP_MAX_W > viewportW - 8;
                        const style: React.CSSProperties = wouldOverflow
                          ? {
                              right: Math.max(8, viewportW - hoveredBarRect.right),
                              top: hoveredBarRect.bottom + GAP
                            }
                          : {
                              left: hoveredBarRect.left,
                              top: hoveredBarRect.bottom + GAP
                            };
                        return (
                          <div
                            className="gantt-bar-tooltip"
                            style={style}
                          >
                            {(row.type === 'fix' || row.type === 'epic' || row.type === 'story') && (
                              // Header: type icon + the row's identifier.
                              // Fix versions get their name (e.g. "IP10 - The
                              // Sweep"); epics and stories get their Jira key
                              // (e.g. "GPO-6287"). Gives a quick "what am I
                              // hovering over" cue before the status/dates.
                              <div className="gantt-bar-tooltip-type">
                                <JiraTypeIcon type={row.type} size={14} />
                                <span>
                                  {row.type === 'fix'
                                    ? row.label
                                    : row.jiraKey ?? row.label}
                                </span>
                              </div>
                            )}
                            {row.type === 'story' && row.storyStatusName && (
                              // Story-only status line (e.g. "In Progress",
                              // "Done - Released"). Reuses the dates block's
                              // styling for a consistent label / value look.
                              <div className="gantt-bar-tooltip-dates">
                                <span>
                                  <span className="label">Status</span>
                                  {row.storyStatusName}
                                </span>
                              </div>
                            )}
                            <div className="gantt-bar-tooltip-dates">
                              <span>
                                <span className="label">Start</span>
                                {startLabel}
                              </span>
                              <span>
                                <span className="label">End</span>
                                {endLabel}
                              </span>
                            </div>
                            {row.type === 'fix' && progressTotal > 0 && (
                              // Fix-version 3-way progress breakdown mirroring
                              // the segmented bar shading. Percentages are
                              // rounded to whole numbers — same rounding as
                              // progressPercent / progressInFlightPercent — so
                              // they match what the shading draws.
                              <div className="gantt-bar-tooltip-dates">
                                <span>
                                  <span className="label">Done</span>
                                  {progressPercent}%
                                </span>
                                <span>
                                  <span className="label">In-flight</span>
                                  {Math.max(0, progressInFlightPercent - progressPercent)}%
                                </span>
                                <span>
                                  <span className="label">Not started</span>
                                  {Math.max(0, 100 - progressInFlightPercent)}%
                                </span>
                              </div>
                            )}
                            {row.type === 'epic' && progressTotal > 0 && (
                              // Epics only carry a 2-way split for now — show
                              // Done% alongside the raw done/total count.
                              <div className="gantt-bar-tooltip-dates">
                                <span>
                                  <span className="label">Done</span>
                                  {progressPercent}% ({progressDone}/{progressTotal})
                                </span>
                              </div>
                            )}
                            {showDependencies &&
                              dependencyInfo &&
                              dependencyInfo.outgoing.length > 0 && (
                                // A row's `outgoing` list stores the targets it
                                // points at. Per our dep semantics (see backend
                                // routers/roadmap.py: a Jira "blocks" outward link
                                // becomes from→to), the SOURCE of a dep blocks its
                                // target — so on the source side, outgoing targets
                                // are rendered as "Blocks".
                                <div className="gantt-bar-tooltip-deps">
                                  <span className="dep-title">Blocks</span>
                                  <div className="dep-links">
                                    {dependencyInfo.outgoing.map((link, index) => {
                                      // Prefer the row label (release / epic name);
                                      // fall back to the Jira key if we somehow
                                      // couldn't resolve a label.
                                      const text = link.label || link.key || '';
                                      return (
                                        <span key={`out-${row.id}-${index}`}>{text}</span>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            {showDependencies &&
                              dependencyInfo &&
                              dependencyInfo.incoming.length > 0 && (
                                // `incoming` holds the sources pointing at this row.
                                // On the target side, those sources are the things
                                // that block this row.
                                <div className="gantt-bar-tooltip-deps">
                                  <span className="dep-title">Blocked by</span>
                                  <div className="dep-links">
                                    {dependencyInfo.incoming.map((link, index) => {
                                      const text = link.label || link.key || '';
                                      return (
                                        <span key={`in-${row.id}-${index}`}>{text}</span>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                          </div>
                        );
                      })(),
                      document.body
                    )}
                  {showDependencies && (
                    <div className="gantt-dependency-interactive">
                      {/*
                        This layer used to render the standalone "Blocked by" popup;
                        that's now rolled into `.gantt-bar-tooltip` above. We keep the
                        wrapper for the small dep-track strip so routing calculations
                        that query `.gantt-dependency-layer` / `.gantt-dependency-track`
                        stay intact.
                      */}
                      <div className="gantt-dependency-track" />
                    </div>
                  )}
                  {uatRange && row.type === 'fix' && (
                    /* Point-in-time diamond at end of UAT range, vertically
                       centred on the bar/row. When dep-edit mode is active
                       a CSS rule shifts this up above the bar so it doesn't
                       block the dep-handle at the bar's right-middle edge. */
                    <div
                      className="gantt-marker-point uat"
                      style={{
                        top: '9px',
                        left: `${getPercent(range, uatRange.end)}%`,
                      }}
                    >
                      <div
                        className="gantt-marker-point-diamond"
                        role="button"
                        tabIndex={0}
                        aria-label={`UAT ${formatFullDate(row.uatStart)} → ${formatFullDate(row.uatEnd)}`}
                        onMouseEnter={(event) => {
                          const r = event.currentTarget.getBoundingClientRect();
                          setHoveredMarker({
                            kind: 'uat',
                            startLabel: formatFullDate(row.uatStart),
                            endLabel: formatFullDate(row.uatEnd),
                            rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                          });
                        }}
                        onMouseLeave={() => setHoveredMarker(null)}
                        onFocus={(event) => {
                          const r = event.currentTarget.getBoundingClientRect();
                          setHoveredMarker({
                            kind: 'uat',
                            startLabel: formatFullDate(row.uatStart),
                            endLabel: formatFullDate(row.uatEnd),
                            rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                          });
                        }}
                        onBlur={() => setHoveredMarker(null)}
                      />
                    </div>
                  )}
                  {liveRange && row.type === 'fix' && (
                    /* Point-in-time diamond at end of Live range, vertically
                       centred on the bar/row. Same dep-edit lift rule as UAT. */
                    <div
                      className="gantt-marker-point live"
                      style={{
                        top: '9px',
                        left: `${getPercent(range, liveRange.end)}%`,
                      }}
                    >
                      <div
                        className="gantt-marker-point-diamond"
                        role="button"
                        tabIndex={0}
                        aria-label={`Live ${formatFullDate(row.liveStart)} → ${formatFullDate(row.liveEnd)}`}
                        onMouseEnter={(event) => {
                          const r = event.currentTarget.getBoundingClientRect();
                          setHoveredMarker({
                            kind: 'live',
                            startLabel: formatFullDate(row.liveStart),
                            endLabel: formatFullDate(row.liveEnd),
                            rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                          });
                        }}
                        onMouseLeave={() => setHoveredMarker(null)}
                        onFocus={(event) => {
                          const r = event.currentTarget.getBoundingClientRect();
                          setHoveredMarker({
                            kind: 'live',
                            startLabel: formatFullDate(row.liveStart),
                            endLabel: formatFullDate(row.liveEnd),
                            rect: { left: r.left, right: r.right, bottom: r.bottom, width: r.width }
                          });
                        }}
                        onBlur={() => setHoveredMarker(null)}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
            };
            if (!standardInitiativesActive) {
              return visibleRows.map(renderStandardRow);
            }
            // Standard-mode initiative grouping reuses the swimlane spine
            // structure (left colour spine + stacked member rows). The
            // `.gantt-init-block`/`.gantt-init-lanes` wrappers are static so
            // each row's offsetParent stays `.gantt-body`, keeping the
            // dep-layer / row-measurement maths intact. Overlay alignment is
            // handled by `--gantt-x-offset` on `.gantt--has-initiatives`.
            return standardInitiativeGroups.map((group) => {
              // Collapsed standard groups roll their member fix versions up into
              // a single aggregated span (precomputed in
              // `standardInitiativeAggBars`), tinted to match the initiative
              // colour — mirrors the swimlane behaviour.
              const aggBar = standardInitiativeAggBars.get(group.id) ?? null;
              return (
              <div
                key={`init-${group.id}`}
                className={`gantt-init-block${group.isUngrouped ? ' gantt-init-block--ungrouped' : ''}${
                  group.collapsed ? ' is-collapsed' : ''
                }`}
              >
                {group.isUngrouped ? (
                  <div className="gantt-init-spine gantt-init-spine--ungrouped">
                    <span className="gantt-init-spine-name">Ungrouped</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="gantt-init-spine"
                    style={
                      group.colour
                        ? ({ '--init-colour': group.colour } as React.CSSProperties)
                        : undefined
                    }
                    onClick={() => onToggleInitiative?.(group.id)}
                    aria-expanded={!group.collapsed}
                    title={group.collapsed ? 'Expand initiative' : 'Collapse initiative'}
                  >
                    <span className="gantt-init-spine-chevron" aria-hidden="true">
                      {group.collapsed ? '▶' : '▼'}
                    </span>
                    <span className="gantt-init-spine-name">{group.name}</span>
                    <span className="gantt-init-spine-count">
                      {group.fixIds.length} {group.fixIds.length === 1 ? 'version' : 'versions'}
                    </span>
                  </button>
                )}
                <div className="gantt-init-lanes">
                  {group.collapsed ? (
                    // Mirror the .gantt-row structure (label cell + track) so
                    // the aggregated bar inherits the same label-column x-inset
                    // as expanded member rows and stays aligned with the ticks.
                    <div className="gantt-row gantt-row--collapsed-init">
                      <div className="gantt-label" aria-hidden="true" />
                      <div className="gantt-track">
                        {aggBar ? (
                          // Sit the aggregated bar directly in the track and use the
                          // same left/width percentages as the member `.gantt-bar`s
                          // (both resolve against the track's padding box). This keeps
                          // the collapsed bar pixel-aligned with the expanded member
                          // bars so toggling collapse doesn't shift dates sideways.
                          <div
                            className="gantt-init-agg-bar"
                            style={{
                              left: `${aggBar.left}%`,
                              width: `${aggBar.width}%`,
                              ...(group.colour
                                ? {
                                    background: `${group.colour}2e`,
                                    outlineColor: group.colour,
                                    color: group.colour
                                  }
                                : {})
                            }}
                            title={`${group.name}: ${aggBar.startLabel} → ${aggBar.endLabel}`}
                          >
                            <span className="gantt-init-agg-label" data-text-mask="1">
                              {group.fixIds.length} {group.fixIds.length === 1 ? 'version' : 'versions'}
                            </span>
                          </div>
                        ) : (
                          <span className="gantt-init-collapsed-empty">
                            {group.fixIds.length} {group.fixIds.length === 1 ? 'version' : 'versions'} collapsed — no dated work
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    group.fixIds
                      .flatMap((fid) => standardRowsByFix.get(fid) ?? [])
                      .map(renderStandardRow)
                  )}
                </div>
              </div>
              );
            });
          })()
        )}
        {/* All-lanes custom bars: each spans the full vertical height of the
            body, overlapping all swimlane tracks. No dep arrows attach. */}
        {mode === 'swimlane' && customBars.some((cb) => cb.swimlaneId === null) && (
          <div className="gantt-all-lanes-overlay" aria-hidden="true">
            {customBars
              .filter((cb) => cb.swimlaneId === null)
              .map((cb) => {
                const cbClamped = clampRange(range, cb.start, cb.end);
                if (!cbClamped) return null;
                const cbLeft = getPercent(range, cbClamped.start);
                const cbWidth = Math.max(0.5, getPercent(range, cbClamped.end) - cbLeft);
                // Mirror the per-lane short-bar behaviour: a band narrower than
                // ~6% of the track can't hold a centred, ellipsis-clipped label,
                // so pin the name to the top and let it overflow the band width.
                const ALL_LANES_SHORT_THRESHOLD_PCT = 6;
                const isShort = cbWidth < ALL_LANES_SHORT_THRESHOLD_PCT;
                return (
                  <div
                    key={`all-lanes-bar-${cb.id}`}
                    className="gantt-all-lanes-bar"
                    style={{
                      left: `${cbLeft}%`,
                      width: `${cbWidth}%`,
                      // Custom colour only applies in manual mode (see the
                      // per-lane custom bar above); auto schemes fall back to
                      // the default custom styling.
                      ...(colourMode === 'manual' ? {
                        background: `${cb.color}2e`,
                        outlineColor: `${cb.color}bf`,
                      } : {})
                    }}
                  >
                    {cb.showName !== false && (
                      <span
                        className={`gantt-all-lanes-bar-label${isShort ? ' gantt-all-lanes-bar-label--short' : ''}`}
                        style={colourMode === 'manual' ? { color: cb.color } : undefined}
                      >
                        {cb.name}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
        {todayPercent !== null && (
          <div className="gantt-today-overlay" aria-hidden="true">
            <div className="gantt-today-overlay-line" style={{ left: `${todayPercent}%` }} />
            <span className="gantt-today-date" style={{ left: `${todayPercent}%` }}>{formatDay(new Date())}</span>
            <span className="gantt-today-arrow" style={{ left: `${todayPercent}%` }} />
          </div>
        )}
      </div>
      {hoveredMarker &&
        createPortal(
          (() => {
            // Marker tooltip: mirrors the `.gantt-bar-tooltip` look and
            // positioning logic so UAT/Live hovers match the main bar tooltip.
            // Uses mouseenter/mouseleave so it appears instantly instead of the
            // browser's delayed native title tooltip.
            const TOOLTIP_MAX_W = 260;
            const GAP = 6;
            const viewportW = window.innerWidth;
            const wouldOverflow =
              hoveredMarker.rect.left + TOOLTIP_MAX_W > viewportW - 8;
            const style: React.CSSProperties = wouldOverflow
              ? {
                  right: Math.max(8, viewportW - hoveredMarker.rect.right),
                  top: hoveredMarker.rect.bottom + GAP
                }
              : {
                  left: hoveredMarker.rect.left,
                  top: hoveredMarker.rect.bottom + GAP
                };
            if (hoveredMarker.kind === 'milestone') {
              return (
                <div className="gantt-bar-tooltip gantt-marker-tooltip" style={style}>
                  <div
                    className="gantt-bar-tooltip-title"
                    style={{ color: hoveredMarker.color }}
                  >
                    {hoveredMarker.label}
                  </div>
                  <div className="gantt-bar-tooltip-dates">
                    <span>
                      <span className="label">Date</span>
                      {hoveredMarker.dateLabel}
                    </span>
                  </div>
                </div>
              );
            }
            if (hoveredMarker.kind === 'ext-links') {
              return (
                <div className="gantt-bar-tooltip gantt-marker-tooltip" style={style}>
                  <div className="gantt-marker-tooltip-title">External dependencies</div>
                  <div className="gantt-ext-link-keys">
                    {hoveredMarker.keys.join(', ')}
                  </div>
                </div>
              );
            }
            return (
              <div className="gantt-bar-tooltip gantt-marker-tooltip" style={style}>
                <div className="gantt-marker-tooltip-title">
                  {hoveredMarker.kind === 'uat' ? 'UAT date' : 'Live date'}
                </div>
                <div className="gantt-bar-tooltip-dates">
                  <span>
                    <span className="label">Start</span>
                    {hoveredMarker.startLabel}
                  </span>
                  <span>
                    <span className="label">End</span>
                    {hoveredMarker.endLabel}
                  </span>
                </div>
              </div>
            );
          })(),
          document.body
        )}
      {/* Swimlane-mode bar/milestone tooltip. Rendered in a portal to escape
          `.gantt-timeline`'s `overflow: hidden` clipping, mirroring the
          standard-view tooltip look (`gantt-bar-tooltip` + type icon +
          dates + progress + dep links). In swimlane mode visibleRows is
          empty, so the standard-view tooltip render path never fires —
          this block handles the hover UI for fix-version bars instead. */}
      {mode === 'swimlane' &&
        hoveredBarRowId &&
        hoveredBarRect &&
        (() => {
          const entry = swimlaneTooltipData.barByFixId.get(hoveredBarRowId);
          if (!entry) return null;
          const bar = entry.bar;
          const fix = bar.fix;
          // Custom bars have no Jira data — suppress progress and dep sections.
          const isCustomBar = bar.isCustomBar ?? false;
          const startLabel = formatFullDate(fix.start);
          const endLabel = formatFullDate(fix.release);
          const progressDone = fix.progressDone || 0;
          const progressTotal = fix.progressTotal || 0;
          const progressPercent = progressTotal
            ? Math.round((progressDone / progressTotal) * 100)
            : 0;
          const progressInFlightPercent = getInFlightProgressPercent(
            fix.progressDone,
            fix.progressInProgress,
            fix.progressTotal
          );
          const depInfo = isCustomBar ? null : swimlaneTooltipData.depByFixId.get(fix.id);
          return createPortal(
            (() => {
              const TOOLTIP_MAX_W = 340;
              const GAP = 6;
              const viewportW = window.innerWidth;
              const wouldOverflow =
                hoveredBarRect.left + TOOLTIP_MAX_W > viewportW - 8;
              const style: React.CSSProperties = wouldOverflow
                ? {
                    right: Math.max(8, viewportW - hoveredBarRect.right),
                    top: hoveredBarRect.bottom + GAP
                  }
                : {
                    left: hoveredBarRect.left,
                    top: hoveredBarRect.bottom + GAP
                  };
              return (
                <div className="gantt-bar-tooltip" style={style}>
                  <div className="gantt-bar-tooltip-type">
                    {!isCustomBar && <JiraTypeIcon type="fix" size={14} />}
                    <span>{fix.name}</span>
                  </div>
                  <div className="gantt-bar-tooltip-dates">
                    <span>
                      <span className="label">Start</span>
                      {startLabel}
                    </span>
                    <span>
                      <span className="label">End</span>
                      {endLabel}
                    </span>
                  </div>
                  {!isCustomBar && progressTotal > 0 && (
                    <div className="gantt-bar-tooltip-dates">
                      <span>
                        <span className="label">Done</span>
                        {progressPercent}%
                      </span>
                      <span>
                        <span className="label">In-flight</span>
                        {Math.max(0, progressInFlightPercent - progressPercent)}%
                      </span>
                      <span>
                        <span className="label">Not started</span>
                        {Math.max(0, 100 - progressInFlightPercent)}%
                      </span>
                    </div>
                  )}
                  {showDependencies && depInfo && depInfo.outgoing.length > 0 && (
                    // Outgoing targets = things this fix blocks (see semantics
                    // note on the standard-mode tooltip above).
                    <div className="gantt-bar-tooltip-deps">
                      <span className="dep-title">Blocks</span>
                      <div className="dep-links">
                        {depInfo.outgoing.map((link, index) => {
                          const text = link.label || link.key || '';
                          return (
                            <span key={`sl-out-${fix.id}-${index}`}>{text}</span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {showDependencies && depInfo && depInfo.incoming.length > 0 && (
                    // Incoming sources = things blocking this fix.
                    <div className="gantt-bar-tooltip-deps">
                      <span className="dep-title">Blocked by</span>
                      <div className="dep-links">
                        {depInfo.incoming.map((link, index) => {
                          const text = link.label || link.key || '';
                          return (
                            <span key={`sl-in-${fix.id}-${index}`}>{text}</span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {fix.externalLinks && fix.externalLinks.length > 0 && (
                    // External (cross-project) dependencies — surfaced in
                    // the tooltip so milestone view still exposes them
                    // (there's no in-bar badge to hover in milestone mode).
                    <div className="gantt-bar-tooltip-deps">
                      <span className="dep-title">External dependencies</span>
                      <div className="dep-links">
                        {fix.externalLinks.map((key, index) => (
                          <span key={`sl-ext-${fix.id}-${index}`}>{key}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })(),
            document.body
          );
        })()}
      </>
      )}

      {/* ── Category manager modal ── */}
      {categoryManagerOpen && createPortal(
        <div
          className="gantt-cat-overlay"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setCategoryManagerOpen(false); }}
        >
          <div className="gantt-cat-modal">
            <div className="gantt-cat-modal-header">
              <span className="gantt-cat-modal-title">
                {colourMode === 'manual' ? 'Colour categories' : 'Edit group colours'}
              </span>
              <button
                type="button"
                className="gantt-cat-modal-close"
                onClick={() => setCategoryManagerOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="gantt-cat-modal-body">
              {colourMode === 'manual' ? (
                <>
                  <p className="gantt-cat-modal-hint">
                    Define named colours and assign them to bars in the swimlane view.
                  </p>
                  {barColourCategories.length > 0 && (
                    <ul className="gantt-cat-list">
                      {barColourCategories.map((cat) => (
                        <li key={cat.id} className="gantt-cat-list-item">
                          <span className="gantt-cat-swatch" style={{ background: cat.colour }} />
                          <span className="gantt-cat-name">{cat.name}</span>
                          <button
                            type="button"
                            className="gantt-cat-delete"
                            aria-label={`Delete ${cat.name}`}
                            onClick={() => {
                              const next = barColourCategories.filter((c) => c.id !== cat.id);
                              onBarColourCategoriesChange?.(next);
                              // Remove any assignments that referenced this category
                              const nextColours = { ...fixVersionColours };
                              Object.keys(nextColours).forEach((fvId) => {
                                if (nextColours[fvId] === cat.id) delete nextColours[fvId];
                              });
                              onFixVersionColoursChange?.(nextColours);
                            }}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="gantt-cat-add-row">
                    <ColourPicker
                      value={newCatColour}
                      ariaLabel="Category colour"
                      onChange={(next) => setNewCatColour(next)}
                    />
                    <input
                      type="text"
                      className="gantt-cat-name-input"
                      placeholder="Category name"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newCatName.trim()) {
                          const next: BarColourCategory = {
                            id: `cat-${Date.now()}`,
                            name: newCatName.trim(),
                            colour: newCatColour
                          };
                          onBarColourCategoriesChange?.([...barColourCategories, next]);
                          setNewCatName('');
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="gantt-cat-add-btn"
                      disabled={!newCatName.trim()}
                      onClick={() => {
                        const next: BarColourCategory = {
                          id: `cat-${Date.now()}`,
                          name: newCatName.trim(),
                          colour: newCatColour
                        };
                        onBarColourCategoriesChange?.([...barColourCategories, next]);
                        setNewCatName('');
                      }}
                    >
                      Add
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="gantt-cat-modal-hint">
                    Colours are assigned automatically. Adjust any colour below — your
                    choice is remembered for this dashboard.
                  </p>
                  {colourGroups.categories.length === 0 ? (
                    <p className="gantt-cat-modal-hint">No groups to colour yet.</p>
                  ) : (
                    <ul className="gantt-cat-list">
                      {colourGroups.categories.map((cat) => (
                        <li key={cat.id} className="gantt-cat-list-item">
                          <ColourPicker
                            value={cat.colour}
                            ariaLabel={`${cat.name} colour`}
                            onChange={(next) =>
                              onAutoBarColoursChange?.({ ...autoBarColours, [cat.id]: next })
                            }
                          />
                          <span className="gantt-cat-name">{cat.name}</span>
                          {autoBarColours[cat.id] && (
                            <button
                              type="button"
                              className="gantt-cat-delete"
                              aria-label={`Reset ${cat.name} colour`}
                              title="Reset to auto colour"
                              onClick={() => {
                                const next = { ...autoBarColours };
                                delete next[cat.id];
                                onAutoBarColoursChange?.(next);
                              }}
                            >
                              ↺
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Category assignment popover ── */}
      {assignPopover && createPortal(
        <div
          className="gantt-assign-popover"
          style={{ left: assignPopover.x, top: assignPopover.y }}
          onMouseLeave={() => setAssignPopover(null)}
        >
          <div className="gantt-assign-popover-title">Assign colour category</div>
          {barColourCategories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`gantt-assign-option${fixVersionColours[assignPopover.fixVersionId] === cat.id ? ' is-active' : ''}`}
              onClick={() => {
                onFixVersionColoursChange?.({
                  ...fixVersionColours,
                  [assignPopover.fixVersionId]: cat.id
                });
                setAssignPopover(null);
              }}
            >
              <span className="gantt-assign-swatch" style={{ background: cat.colour }} />
              {cat.name}
            </button>
          ))}
          {barColourCategories.length === 0 && (
            <button
              type="button"
              className="gantt-assign-option gantt-assign-option--add"
              onClick={() => { setAssignPopover(null); setCategoryManagerOpen(true); }}
            >
              + Add categories first
            </button>
          )}
          {fixVersionColours[assignPopover.fixVersionId] && (
            <>
              <hr className="gantt-assign-sep" />
              <button
                type="button"
                className="gantt-assign-option gantt-assign-option--remove"
                onClick={() => {
                  const next = { ...fixVersionColours };
                  delete next[assignPopover.fixVersionId];
                  onFixVersionColoursChange?.(next);
                  setAssignPopover(null);
                }}
              >
                Remove colour
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};
