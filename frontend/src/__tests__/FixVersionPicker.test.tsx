import { createRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { FixVersionPicker, FixVersionPickerHandle } from '../components/FixVersionPicker';
import type { FixVersion } from '../types';

const sampleFixVersions: FixVersion[] = [
  {
    id: 'fix-1',
    name: 'Release One',
    start: '2026-01-10',
    release: '2026-02-20',
    released: false,
    archived: false,
    uatStart: '2026-02-05',
    uatEnd: '2026-02-10',
    liveStart: null,
    liveEnd: null,
    notes: null,
    epics: [],
  },
  {
    id: 'fix-2',
    name: 'Release Two',
    start: null,
    release: '2026-03-05',
    released: false,
    archived: false,
    uatStart: null,
    uatEnd: null,
    liveStart: null,
    liveEnd: null,
    notes: null,
    epics: [],
  },
];

describe('FixVersionPicker', () => {
  it('renders a dropdown with the fix versions and a disabled Save button on first render', () => {
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={vi.fn()} />);

    expect(screen.getByLabelText('Fix version')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Release One' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Release Two' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('pulls back UAT dates (in dd/mm/yyyy) when a fix version with saved dates is selected', () => {
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-1' } });

    expect(screen.getByLabelText('UAT start')).toHaveValue('05/02/2026');
    expect(screen.getByLabelText('UAT end')).toHaveValue('10/02/2026');
    expect(screen.getByLabelText('Live start')).toHaveValue('');
  });

  it('shows the release date from Jira and tags it as Jira-sourced', () => {
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-1' } });

    expect(screen.getByLabelText('Release date from Jira')).toHaveTextContent('20/02/2026');
    expect(screen.getByLabelText('Release date from Jira')).toHaveTextContent('Jira');
  });

  it('blocks Save and shows an error when UAT start is after UAT end', () => {
    const onSave = vi.fn();
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-2' } });
    fireEvent.change(screen.getByLabelText('UAT start'), { target: { value: '20/02/2026' } });
    fireEvent.change(screen.getByLabelText('UAT end'), { target: { value: '10/02/2026' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/UAT start/);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('blocks Save and shows an error when Live start is after Live end', () => {
    const onSave = vi.fn();
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-2' } });
    fireEvent.change(screen.getByLabelText('Live start'), { target: { value: '20/03/2026' } });
    fireEvent.change(screen.getByLabelText('Live end'), { target: { value: '10/03/2026' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/Live start/);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('calls onSave with only the changed fields', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-1' } });
    // Only change uatEnd
    fireEvent.change(screen.getByLabelText('UAT end'), { target: { value: '12/02/2026' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('fix-1', { uatEnd: '2026-02-12' });
  });

  it('disables date inputs until a fix version is selected', () => {
    render(<FixVersionPicker fixVersions={sampleFixVersions} onSave={vi.fn()} />);

    expect(screen.getByLabelText('UAT start')).toBeDisabled();
    expect(screen.getByLabelText('Live end')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-2' } });

    expect(screen.getByLabelText('UAT start')).not.toBeDisabled();
    expect(screen.getByLabelText('Live end')).not.toBeDisabled();
  });

  describe('Clear dates (imperative handle)', () => {
    it('onCanClearChange reports false when no fix version is selected', () => {
      const onCanClearChange = vi.fn();
      render(
        <FixVersionPicker
          fixVersions={sampleFixVersions}
          onSave={vi.fn()}
          onCanClearChange={onCanClearChange}
        />
      );
      // Initial render: nothing selected → can't clear.
      expect(onCanClearChange).toHaveBeenLastCalledWith(false);
    });

    it('onCanClearChange reports false when the selected version has no saved dates', () => {
      const onCanClearChange = vi.fn();
      render(
        <FixVersionPicker
          fixVersions={sampleFixVersions}
          onSave={vi.fn()}
          onCanClearChange={onCanClearChange}
        />
      );
      fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-2' } });
      expect(onCanClearChange).toHaveBeenLastCalledWith(false);
    });

    it('onCanClearChange reports true when the selected version has saved dates', () => {
      const onCanClearChange = vi.fn();
      render(
        <FixVersionPicker
          fixVersions={sampleFixVersions}
          onSave={vi.fn()}
          onCanClearChange={onCanClearChange}
        />
      );
      fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-1' } });
      expect(onCanClearChange).toHaveBeenLastCalledWith(true);
    });

    it('clearDates() wipes all four date fields (but does not auto-save)', () => {
      const onSave = vi.fn();
      const ref = createRef<FixVersionPickerHandle>();
      render(
        <FixVersionPicker ref={ref} fixVersions={sampleFixVersions} onSave={onSave} />
      );

      fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-1' } });
      expect(screen.getByLabelText('UAT start')).toHaveValue('05/02/2026');

      act(() => {
        ref.current?.clearDates();
      });

      expect(screen.getByLabelText('UAT start')).toHaveValue('');
      expect(screen.getByLabelText('UAT end')).toHaveValue('');
      expect(screen.getByLabelText('Live start')).toHaveValue('');
      expect(screen.getByLabelText('Live end')).toHaveValue('');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('commits the clear on Save by sending empty strings for previously-set fields', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const ref = createRef<FixVersionPickerHandle>();
      render(
        <FixVersionPicker ref={ref} fixVersions={sampleFixVersions} onSave={onSave} />
      );

      fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-1' } });
      act(() => {
        ref.current?.clearDates();
      });
      fireEvent.click(screen.getByRole('button', { name: /^save/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      // fix-1 had uatStart + uatEnd saved; liveStart + liveEnd were null so
      // we should only send the two that changed from a value to empty.
      expect(onSave).toHaveBeenCalledWith('fix-1', { uatStart: '', uatEnd: '' });
    });

    it('clearDates() clears any pending validation error', () => {
      const ref = createRef<FixVersionPickerHandle>();
      render(
        <FixVersionPicker ref={ref} fixVersions={sampleFixVersions} onSave={vi.fn()} />
      );

      fireEvent.change(screen.getByLabelText('Fix version'), { target: { value: 'fix-2' } });
      fireEvent.change(screen.getByLabelText('UAT start'), { target: { value: '20/02/2026' } });
      fireEvent.change(screen.getByLabelText('UAT end'), { target: { value: '10/02/2026' } });
      expect(screen.getByRole('alert')).toBeInTheDocument();

      act(() => {
        ref.current?.clearDates();
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
