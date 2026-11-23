// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { completeSetup, start, setUpAppTests } from './app-harness.js';

setUpAppTests();

const local = { actor: { kind: 'user', id: 'local' } } as const;

describe('App: the Imp coordinator and the project coordinators', () => {
  it('passes what concerns all projects from a project to the Imp coordinator, visibly', async () => {
    const { imp, provider, user } = start();
    await completeSetup(user);
    const created = (await imp.registry.executeById(
      'project.create',
      { name: 'Keeper', mode: 'movie' },
      local,
    )) as { output: { id: string } };
    await imp.registry.executeById('project.open', { projectId: created.output.id }, local);
    // Passing something on is a paid step; this one fits the budget.
    await imp.store.batch([{ type: 'put', key: 'settings/spend.allowance.project', value: 10 }]);
    const global = (await imp.store.list('crew/'))
      .map((entry) => entry.value as { id: string; roleId: string })
      .find((member) => member.roleId === 'global-coordinator');
    if (global === undefined) throw new Error('an Imp coordinator expected');
    const args = { memberId: global.id, task: 'Switch the interface to German.' };
    provider.script(
      { toolCalls: [{ id: 'c1', name: 'crew__ask', arguments: args, argumentsText: '{}' }] },
      { content: 'Done: the interface is German now.' },
      { content: 'The Imp coordinator switched the interface to German.' },
    );

    await user.click(await screen.findByRole('tab', { name: /Keeper/ }));
    const projectChat = screen.getByRole('complementary', {
      name: 'Conversation with Coordinator',
    });
    expect(within(projectChat).getByText('Keeper')).toBeTruthy();
    await user.type(
      within(projectChat).getByLabelText('Message to Coordinator'),
      'German, please.',
    );
    await user.click(within(projectChat).getByRole('button', { name: /Send/ }));
    expect(
      await within(projectChat).findByText('The Imp coordinator switched the interface to German.'),
    ).toBeTruthy();
    expect(
      within(projectChat).getByText('Passed to the Imp coordinator (all projects)'),
    ).toBeTruthy();

    // One tap opens the chat for all projects, which shows where the ask came from.
    await user.click(within(projectChat).getByRole('button', { name: 'Open that chat' }));
    expect(screen.getByRole('tab', { name: /All projects/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const globalChat = screen.getByRole('complementary', {
      name: 'Conversation with Imp coordinator',
    });
    expect(within(globalChat).getByText('All projects')).toBeTruthy();
    expect(within(globalChat).getByText('Passed on from Keeper')).toBeTruthy();
    expect(within(globalChat).getByText('Switch the interface to German.')).toBeTruthy();
    expect(within(globalChat).getByText('Done: the interface is German now.')).toBeTruthy();
    // The Imp coordinator was told where the ask came from.
    const passed = provider.requests[1]?.messages.at(-1);
    expect(passed?.context).toMatch(/^Passed on by the coordinator of the project "Keeper"/);
  });

  it('gets an Imp set up before it existed its Imp coordinator, which cannot be dismissed', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    const global = (await imp.store.list('crew/')).find(
      (entry) => (entry.value as { roleId: string }).roleId === 'global-coordinator',
    );
    if (global === undefined) throw new Error('an Imp coordinator expected');
    await imp.store.batch([{ type: 'delete', key: global.key }]);
    await vi.waitFor(async () => {
      const roles = (await imp.store.list('crew/')).map(
        (entry) => (entry.value as { roleId: string; model: string }).roleId,
      );
      expect(roles.sort()).toEqual(['coordinator', 'global-coordinator']);
    });
    await user.click(await screen.findByRole('button', { name: 'Crew' }));
    expect(
      await screen.findByRole('checkbox', { name: 'Imp coordinator can search the web' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss Imp coordinator' })).toBeNull();
  });
});
