/**
 * Presentation-mode slide ordering.
 *
 * The saved order (`WeeklyUpdateResponse.presentationOrder`) is a list of
 * section ids captured when the user last dragged slides around. Sections are
 * regenerated from live Jira independently, so the saved order can drift out of
 * sync — a fix version may have been added or dropped since. `reconcileOrder`
 * folds the saved order back onto the current live section ids:
 *
 *   - ids present in both → kept in the saved order
 *   - live ids not in the saved order → appended in their natural order
 *   - saved ids no longer live → dropped
 *
 * The result is always exactly the set of live ids, so it is safe to map over
 * for rendering without missing or duplicating a slide.
 */
export const reconcileOrder = (
  naturalIds: string[],
  savedOrder: string[] | undefined | null,
): string[] => {
  if (!savedOrder || savedOrder.length === 0) return [...naturalIds];
  const live = new Set(naturalIds);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of savedOrder) {
    if (live.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  for (const id of naturalIds) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  return ordered;
};
