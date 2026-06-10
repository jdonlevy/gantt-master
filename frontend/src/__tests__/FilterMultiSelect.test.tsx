import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { FilterMultiSelect } from '../components/FilterMultiSelect';

describe('FilterMultiSelect', () => {
  it('groups selected items before all items', async () => {
    const user = userEvent.setup();
    render(
      <FilterMultiSelect
        label="Projects"
        placeholder="Select"
        items={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
          { id: 'c', label: 'Gamma' }
        ]}
        selected={['b']}
        onChange={() => {}}
      />
    );

    // Trigger now exposes the `label` prop as its accessible name (a11y fix),
    // so query by that rather than the visible selected text.
    await user.click(screen.getByRole('button', { name: /projects/i }));

    expect(screen.getByText('Selected')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();

    const keys = Array.from(document.querySelectorAll('.filter-item .filter-key')).map(
      (node) => node.textContent
    );
    expect(keys[0]).toBe('Beta');
  });

  it('selects only the filtered results when a search is active', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterMultiSelect
        label="Fix versions"
        placeholder="Select"
        items={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
          { id: 'c', label: 'Bravo' }
        ]}
        selected={['a']}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole('button', { name: /fix versions/i }));
    await user.type(screen.getByPlaceholderText(/search fix versions/i), 'br');
    await user.click(screen.getByRole('button', { name: /select all/i }));

    // Existing selection ('a', outside the search) is preserved and only the
    // matching result ('c' / Bravo) is added — 'b' / Beta is not matched.
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });
});
