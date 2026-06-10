import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

const extractBody = (html: string) => {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return doc.body.innerHTML || html;
  } catch {
    return html;
  }
};

export const ReleaseNotesPage: React.FC = () => {
  const { version } = useParams();
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!version) return;
    fetch(`/release-notes/${version}.html`)
      .then((res) => {
        if (!res.ok) throw new Error('Release not found');
        return res.text();
      })
      .then((html) => setContent(extractBody(html)))
      .catch((err) => setError(err.message || 'Failed to load release notes'));
  }, [version]);

  return (
    <div className="release-notes">
      <div className="release-notes-card">
        <div className="release-notes-nav">
          <Link to="/release-notes">← All releases</Link>
        </div>
        {error ? (
          <div className="release-notes-error">{error}</div>
        ) : (
          <div className="release-notes-content" dangerouslySetInnerHTML={{ __html: content }} />
        )}
      </div>
    </div>
  );
};
