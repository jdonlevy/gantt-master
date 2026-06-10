import React from 'react';
import { Link } from 'react-router-dom';

const releases = [
  {
    version: 'v8',
    date: 'Jun 5, 2026',
    title: 'Initiative grouping, swimlane colour modes + Updates date scoping'
  },
  {
    version: 'v7',
    date: 'May 22, 2026',
    title: 'Dependency links + Jira setup guidance'
  },
  {
    version: 'v6',
    date: 'May 1, 2026',
    title: 'Filter list grouping + project-prefixed fix versions'
  },
  {
    version: 'v5',
    date: 'Apr 17, 2026',
    title: 'Dashboard-scoped milestones + swimlane polish'
  },
  {
    version: 'v4',
    date: 'Apr 3, 2026',
    title: 'Swimlane Gantt + dashboard deletion'
  },
  {
    version: 'v3',
    date: 'Mar 20, 2026',
    title: 'Release notes navigation + mainline sync'
  },
  {
    version: 'v2',
    date: 'Mar 6, 2026',
    title: 'Gantt + auth reliability updates'
  },
  {
    version: 'v1',
    date: 'Feb 20, 2026',
    title: 'Initial mainline release'
  }
];

export const ReleaseNotesList: React.FC = () => (
  <div className="release-notes">
    <div className="release-notes-card">
      <h1>Release Notes</h1>
      <p>What’s new in Delivery Tracker. Select a version below.</p>

      <div className="release-notes-list">
        {releases.map((release) => (
          <Link key={release.version} className="release-notes-item" to={`/release-notes/${release.version}`}>
            <div>
              <div className="release-title">{release.version}</div>
              <div className="release-date">Released: {release.date}</div>
            </div>
            <div className="release-summary">{release.title}</div>
          </Link>
        ))}
      </div>
    </div>
  </div>
);
