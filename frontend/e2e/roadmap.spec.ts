import { expect, test } from '@playwright/test';

test('loads roadmap with mocked API', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { authenticated: true } })
  );
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: [{ key: 'GPO', name: 'Outdoor' }] })
  );
  await page.route('**/api/fix-versions**', (route) =>
    route.fulfill({
      json: [{ id: '1', name: 'Release One', release: '2026-02-10', released: false, archived: false }]
    })
  );
  await page.route('**/api/components**', (route) =>
    route.fulfill({ json: [{ id: 'comp-1', name: 'Core' }] })
  );
  await page.route('**/api/dashboards/gpo', (route) =>
    route.fulfill({
      json: {
        id: 'dash-1',
        slug: 'gpo',
        title: 'Outdoor Weekly',
        description: null,
        filters: {
          projects: ['GPO'],
          fixVersions: [],
          components: [],
          incrementStart: '2026-01-19',
          incrementEnd: '2026-06-30'
        },
        panels: []
      }
    })
  );
  await page.route('**/api/roadmap**', (route) =>
    route.fulfill({
      json: {
        projects: [{ key: 'GPO', name: 'Outdoor' }],
        fixVersions: [
          {
            id: '1',
            name: 'Release One',
            start: '2026-01-10',
            release: '2026-02-10',
            released: false,
            archived: false,
            uatStart: null,
            uatEnd: null,
            liveStart: null,
            liveEnd: null,
            notes: null,
            epics: []
          }
        ],
        milestones: [],
        updatedAt: '2026-01-01T00:00:00Z'
      }
    })
  );

  const roadmapResponse = page.waitForResponse('**/api/roadmap**');
  await page.goto('/dashboards/gpo');
  await roadmapResponse;
  await expect(page.locator('.gantt')).toContainText('Release One');
});
