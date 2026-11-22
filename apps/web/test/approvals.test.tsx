// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { completeSetup, start, setUpAppTests } from './app-harness.js';

setUpAppTests();

const deleteCall = (id: string, projectId: string) => ({
  id,
  name: 'run_command',
  arguments: { id: 'project.delete', input: { projectId } },
  argumentsText: JSON.stringify({ id: 'project.delete', input: { projectId } }),
});

describe('deciding many requests at once', () => {
  it('opens when several requests arrive, and decides them together', async () => {
    const { imp, provider, user } = start([
      { toolCalls: [deleteCall('c1', 'old-cut'), deleteCall('c2', 'keeper')] },
      { content: 'Waiting for you.' },
      { content: 'One gone, one kept.' },
    ]);
    await completeSetup(user);
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Tidy up.');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    const dialog = await screen.findByRole('dialog', { name: '2 requests are waiting' });
    expect(within(dialog).getByText(/Asked by Coordinator/)).toBeTruthy();
    expect(
      within(dialog).getAllByRole('checkbox', { name: 'Approve Delete project' }),
    ).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: 'Approve all 2' })).toBeTruthy();

    // Unpicking one declines it; the other is approved, and always allowed from now on.
    const [first, second] = within(dialog).getAllByRole('checkbox', {
      name: 'Approve Delete project',
    });
    if (first === undefined || second === undefined) throw new Error('two rows expected');
    await user.click(second);
    const [always] = within(dialog).getAllByRole('checkbox', { name: /Always allow/ });
    if (always === undefined) throw new Error('an always-allow switch expected');
    await user.click(always);
    await user.click(within(dialog).getByRole('button', { name: 'Approve 1 · decline 1' }));

    // The coordinator goes on once everything it asked for is decided.
    expect(await screen.findByText('One gone, one kept.')).toBeTruthy();
    expect(screen.getByText('Approved: project.delete')).toBeTruthy();
    expect(screen.getByText('Declined: project.delete')).toBeTruthy();
    expect(await imp.store.get('approvals/always-allow')).toEqual({
      commandIds: ['project.delete'],
    });
    expect(provider.requests).toHaveLength(3);
  });

  it('opens from the crew panel, and declines everything with one press', async () => {
    const { provider, user } = start([
      { toolCalls: [deleteCall('c1', 'a'), deleteCall('c2', 'b'), deleteCall('c3', 'c')] },
      { content: 'Waiting for you.' },
      { content: 'Nothing deleted.' },
    ]);
    await completeSetup(user);
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Tidy up.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    const dialog = await screen.findByRole('dialog', { name: '3 requests are waiting' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Review all 3 requests at once/ }));
    const again = await screen.findByRole('dialog', { name: '3 requests are waiting' });
    await user.click(within(again).getByRole('button', { name: /Decline all/ }));
    expect(await screen.findByText('Nothing deleted.')).toBeTruthy();
    expect(screen.getAllByText('Declined: project.delete')).toHaveLength(3);
    expect(provider.requests).toHaveLength(3);
  });

  it('lists what agents may do without asking, and takes it back', async () => {
    const { imp, user } = start([]);
    await completeSetup(user);
    await imp.store.batch([
      { type: 'put', key: 'approvals/always-allow', value: { commandIds: ['project.delete'] } },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const heading = await screen.findByRole('heading', { name: 'What agents do without asking' });
    const section = heading.parentElement;
    if (section === null) throw new Error('the section expected');
    expect(await within(section).findByText('Delete project')).toBeTruthy();
    await user.click(within(section).getByRole('button', { name: 'Ask again' }));
    expect(await within(section).findByText(/Nothing is always allowed/)).toBeTruthy();
    expect(await imp.store.get('approvals/always-allow')).toEqual({ commandIds: [] });
  });
});
