import React from 'react';

/**
 * Inline SVG icons that visually match Atlassian Jira's issue-type icons.
 *
 * We draw these ourselves (rather than linking to Jira's iconUrl CDN) so the
 * chart renders offline, stays theme-friendly, and doesn't incur dozens of
 * tiny HTTP requests per dashboard. The colours and glyphs mirror Jira's
 * defaults:
 *   - Epic    → purple lightning bolt on #904EE2
 *   - Story   → green bookmark on #63BA3C
 *   - Fix ver → blue release/package on #0052CC
 */

type IconProps = {
  size?: number;
  className?: string;
  title?: string;
};

/**
 * Epic icon: purple rounded square with a white lightning bolt.
 */
export function EpicIcon({ size = 14, className, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      role="img"
      aria-label={title ?? 'Epic'}
    >
      <title>{title ?? 'Epic'}</title>
      <rect width="16" height="16" rx="3" fill="#904EE2" />
      {/* Classic lightning bolt shape */}
      <path d="M9.2 2.5 4.6 9h3l-.8 4.5L12 7H9z" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Story icon: green rounded square with a white bookmark.
 */
export function StoryIcon({ size = 14, className, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      role="img"
      aria-label={title ?? 'Story'}
    >
      <title>{title ?? 'Story'}</title>
      <rect width="16" height="16" rx="3" fill="#63BA3C" />
      {/* Bookmark: rectangle with a V cut out of the bottom */}
      <path d="M4.5 3.5h7v9l-3.5-2.2-3.5 2.2z" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Fix Version icon: blue rounded square with a stylised release/package mark.
 * Jira uses a small shipping-box glyph for versions; this is a simplified
 * stack-of-layers that reads as "release" at small sizes.
 */
export function FixVersionIcon({ size = 14, className, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      role="img"
      aria-label={title ?? 'Fix version'}
    >
      <title>{title ?? 'Fix version'}</title>
      <rect width="16" height="16" rx="3" fill="#0052CC" />
      {/* Package/box outline with diagonal band (mirrors Jira's release icon) */}
      <path
        d="M8 2.8 3 5v6l5 2.2L13 11V5z M3 5l5 2.2L13 5 M8 7.2v6"
        stroke="#FFFFFF"
        strokeWidth="1.1"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Convenience dispatcher so callers can write <JiraTypeIcon type="epic" />
 * without branching at every call site. Returns null for unknown types.
 */
export function JiraTypeIcon({
  type,
  size,
  className
}: {
  type: 'fix' | 'epic' | 'story' | string;
  size?: number;
  className?: string;
}) {
  if (type === 'fix') return <FixVersionIcon size={size} className={className} />;
  if (type === 'epic') return <EpicIcon size={size} className={className} />;
  if (type === 'story') return <StoryIcon size={size} className={className} />;
  return null;
}
