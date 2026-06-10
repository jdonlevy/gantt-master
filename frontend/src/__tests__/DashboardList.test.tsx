import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardList } from '../pages/DashboardList';
import * as api from '../api';

vi.mock('../api');

const mockDashboards = [
  { id: '1', slug: 'gpo-metrics', title: 'GPO Metrics', folder: 'gPlan Outdoor', updatedAt: '2026-04-13T10:00:00Z' },
  { id: '2', slug: 'radio-weekly', title: 'Radio Weekly', folder: 'Radio', updatedAt: '2026-04-10T10:00:00Z' },
  { id: '3', slug: 'intl-v2', title: 'Intl V2', folder: 'International', updatedAt: '2026-04-10T10:00:00Z' },
  { id: '4', slug: 'no-folder', title: 'No Folder', folder: null, updatedAt: '2026-04-01T10:00:00Z' },
];

const renderList = (authenticated = true) =>
  render(
    <MemoryRouter>
      <DashboardList authenticated={authenticated} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.mocked(api.fetchDashboards).mockResolvedValue(mockDashboards);
});

describe('DashboardList — folders', () => {
  it('renders dashboards under their correct folder when expanded', async () => {
    const { container, getByText } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    // Open gPlan Outdoor
    const gpoHeader = Array.from(container.querySelectorAll('button.folder-header')).find(
      (btn) => btn.querySelector('.folder-name')?.textContent === 'gPlan Outdoor'
    ) as HTMLElement;
    fireEvent.click(gpoHeader);

    await waitFor(() => expect(getByText('GPO Metrics')).toBeInTheDocument());

    // Open Radio
    const radioHeader = Array.from(container.querySelectorAll('button.folder-header')).find(
      (btn) => btn.querySelector('.folder-name')?.textContent === 'Radio'
    ) as HTMLElement;
    fireEvent.click(radioHeader);

    await waitFor(() => expect(getByText('Radio Weekly')).toBeInTheDocument());
  });

  it('renders all 8 team folders in alphabetical order', async () => {
    const { container } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    // Chevrons are aria-hidden (decorative), so select folder headers by class.
    const folderButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button.folder-header')
    );
    const folderNames = folderButtons.map((btn) => btn.textContent?.replace(/[▾▸\d]/g, '').trim());

    expect(folderNames[0]).toBe('AI');
    expect(folderNames[1]).toBe('gPlan Outdoor');
    expect(folderNames[2]).toBe('International');
  });

  it('shows unassigned folder and its dashboards when expanded', async () => {
    const { getByText, getAllByText } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    // "Unassigned" folder button should always be visible
    const unassignedBtn = getByText('Unassigned').closest('button')!;
    expect(unassignedBtn).toBeInTheDocument();

    // Expand it, then the dashboard inside should appear
    fireEvent.click(unassignedBtn);
    await waitFor(() => expect(getAllByText('No Folder').length).toBeGreaterThan(0));
  });

  it('shows folder count next to each folder name', async () => {
    const { container } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    // gPlan Outdoor has 1 dashboard — find the folder header button specifically
    const gpoHeader = Array.from(container.querySelectorAll('button.folder-header')).find(
      (btn) => btn.querySelector('.folder-name')?.textContent === 'gPlan Outdoor'
    );
    expect(gpoHeader?.querySelector('.folder-count')?.textContent).toBe('1');
  });

  it('expands a folder on click then collapses it again', async () => {
    const { getByText, queryByText, container } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    const radioHeader = Array.from(container.querySelectorAll('button.folder-header')).find(
      (btn) => btn.querySelector('.folder-name')?.textContent === 'Radio'
    ) as HTMLElement;

    // Starts collapsed — content not visible
    expect(queryByText('Radio Weekly')).not.toBeInTheDocument();

    // Expand
    fireEvent.click(radioHeader);
    await waitFor(() => expect(getByText('Radio Weekly')).toBeInTheDocument());

    // Collapse again
    fireEvent.click(radioHeader);
    await waitFor(() => expect(queryByText('Radio Weekly')).not.toBeInTheDocument());
  });

  it('disables Create button when no folder is selected', async () => {
    const { getByRole } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    const createBtn = getByRole('button', { name: /create dashboard/i });
    expect(createBtn).toBeDisabled();
  });

  it('enables Create button when both title and folder are filled', async () => {
    const { getByRole, getByPlaceholderText, getByLabelText } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    fireEvent.change(getByPlaceholderText('New dashboard title'), { target: { value: 'My Dashboard' } });
    fireEvent.change(getByLabelText('Select folder'), { target: { value: 'Radio' } });

    expect(getByRole('button', { name: /create dashboard/i })).not.toBeDisabled();
  });

  it('calls updateDashboard with the new folder when move dropdown changes', async () => {
    vi.mocked(api.updateDashboard).mockResolvedValue({
      id: '1',
      slug: 'gpo-metrics',
      title: 'GPO Metrics',
      folder: 'AI',
      panels: [],
    });

    // Open gPlan Outdoor folder so the card is visible
    const { container, getByLabelText } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    const gpoHeader = Array.from(container.querySelectorAll('button.folder-header')).find(
      (btn) => btn.querySelector('.folder-name')?.textContent === 'gPlan Outdoor'
    ) as HTMLElement;
    fireEvent.click(gpoHeader);

    // Open the card menu to reveal the Move to folder select
    await waitFor(() => expect(container.querySelector('button[aria-label="Dashboard options"]')).toBeInTheDocument());
    const menuBtn = container.querySelector('button[aria-label="Dashboard options"]') as HTMLElement;
    fireEvent.click(menuBtn);

    const moveSelect = getByLabelText('Move to folder');
    fireEvent.change(moveSelect, { target: { value: 'AI' } });

    await waitFor(() =>
      expect(vi.mocked(api.updateDashboard)).toHaveBeenCalledWith('gpo-metrics', { folder: 'AI' })
    );
  });

  it('shows a flat grid of results when searching, bypassing folder structure', async () => {
    const { getByPlaceholderText, getByText, container } = renderList();
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());

    fireEvent.change(getByPlaceholderText('Search dashboards'), { target: { value: 'radio' } });

    // Matching dashboard should be visible
    await waitFor(() => expect(getByText('Radio Weekly')).toBeInTheDocument());

    // Folder header buttons should be gone during search (flat view, no folder-group structure)
    expect(container.querySelectorAll('button.folder-header').length).toBe(0);
  });

  it('re-fetches dashboards after a successful move to confirm persistence', async () => {
    vi.mocked(api.updateDashboard).mockResolvedValue({
      id: '1',
      slug: 'gpo-metrics',
      title: 'GPO Metrics',
      folder: 'AI',
      panels: [],
    });

    const { container, getByLabelText } = renderList();

    // Wait for initial load, then reset the call count so we can track the re-fetch cleanly
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());
    vi.mocked(api.fetchDashboards).mockClear();

    // Expand gPlan Outdoor so the card is visible
    const gpoHeader = Array.from(container.querySelectorAll('button.folder-header')).find(
      (btn) => btn.querySelector('.folder-name')?.textContent === 'gPlan Outdoor'
    ) as HTMLElement;
    fireEvent.click(gpoHeader);

    // Open the card menu to reveal the Move to folder select
    await waitFor(() => expect(container.querySelector('button[aria-label="Dashboard options"]')).toBeInTheDocument());
    const menuBtn = container.querySelector('button[aria-label="Dashboard options"]') as HTMLElement;
    fireEvent.click(menuBtn);

    const moveSelect = getByLabelText('Move to folder');
    fireEvent.change(moveSelect, { target: { value: 'AI' } });

    // fetchDashboards should be called again after the move to confirm persistence
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalledTimes(1));
  });

  it('hides create controls when not authenticated', async () => {
    const { queryByPlaceholderText } = renderList(false);
    await waitFor(() => expect(vi.mocked(api.fetchDashboards)).toHaveBeenCalled());
    expect(queryByPlaceholderText('New dashboard title')).not.toBeInTheDocument();
  });
});
