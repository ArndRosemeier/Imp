// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { chooseModel, completeSetup, start, setUpAppTests } from './app-harness.js';

setUpAppTests();

describe('App: stages', () => {
  it('designs a location from two views, links it to a scene and films a shot from a view', async () => {
    const { provider, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Design' }));
    expect(await screen.findByText(/No places yet/)).toBeTruthy();
    await chooseModel(user, await screen.findByLabelText('Image model'), 'vendor/painter');
    await user.click(screen.getByRole('button', { name: /Add location/ }));
    const card = await screen.findByRole('article', { name: 'New location' });
    await user.type(within(card).getByLabelText('Look'), 'Round iron room.');
    await user.tab();
    await user.click(within(card).getByRole('button', { name: /Draw/ }));
    await vi.waitFor(() => {
      expect(provider.imageRequests).toHaveLength(1);
    });
    expect(provider.imageRequests[0]?.prompt).toContain('Round iron room.');

    await user.type(within(card).getByLabelText('Add view'), 'From the stairs');
    await user.click(within(card).getByRole('button', { name: /Add view/ }));
    expect(
      await within(card).findByRole('heading', { name: 'View · From the stairs' }),
    ).toBeTruthy();
    expect(within(card).getByText(/Stand-in/)).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: /Draw/ }));
    await vi.waitFor(() => {
      expect(provider.imageRequests).toHaveLength(2);
    });
    // The second view is drawn to agree with the first.
    expect(provider.imageRequests[1]?.references).toHaveLength(1);
    await user.type(within(card).getByLabelText('Add state'), 'Night');
    await user.click(within(card).getByRole('button', { name: /Add state/ }));
    expect(await within(card).findByRole('heading', { name: 'State · Night' })).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: 'From the stairs, Night, not drawn' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /Objects/ }));
    await user.click(await screen.findByRole('button', { name: /Add object/ }));
    await screen.findByRole('article', { name: 'New object' });

    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await user.selectOptions(await screen.findByLabelText('Location'), 'New location');
    await user.selectOptions(await screen.findByLabelText('State'), 'Night');

    await user.click(screen.getByRole('button', { name: 'Shots' }));
    await user.click(await screen.findByRole('button', { name: /Add shot/ }));
    const shot = await screen.findByRole('article', { name: 'Shot 1' });
    await user.selectOptions(await within(shot).findByLabelText(/Filmed from/), 'From the stairs');
    await user.click(within(shot).getByRole('checkbox', { name: 'New object' }));
    await vi.waitFor(() => {
      expect(within(shot).getByRole('checkbox', { name: 'New object' })).toHaveProperty(
        'checked',
        true,
      );
    });
    await user.type(within(shot).getByLabelText('What we see'), 'Mara climbs into the light.');
    await user.tab();
    const paint = within(shot).getByRole('button', { name: /Paint frame/ });
    await vi.waitFor(() => {
      expect(paint).toHaveProperty('disabled', false);
    });
    await user.click(paint);
    expect(await within(shot).findByText('The clip starts exactly on this frame.')).toBeTruthy();
    expect(provider.imageRequests.at(-1)?.prompt).toContain('The first frame of a film shot');
    // The place's picture of that view guides the frame.
    expect(provider.imageRequests.at(-1)?.references).toHaveLength(1);
  });

  it('breaks a scene into shots and makes a clip that arrives later', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { imp, provider, user } = start();
      await completeSetup(user);
      await user.click(screen.getByRole('button', { name: 'Development' }));
      await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
      await user.click(screen.getByRole('button', { name: /Start the movie/ }));
      await screen.findByLabelText('Logline');

      await user.click(screen.getByRole('button', { name: 'Shots' }));
      expect(await screen.findByText(/there are no scenes yet/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Script' }));
      await user.click(await screen.findByRole('button', { name: /Add scene/ }));
      await user.type(await screen.findByLabelText('Scene heading'), 'INT. LAMP ROOM - NIGHT');
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'Casting' }));
      await user.click(await screen.findByRole('button', { name: /Add character/ }));
      await screen.findByRole('article', { name: 'New character' });

      await user.click(screen.getByRole('button', { name: 'Shots' }));
      expect(await screen.findByText(/This scene has no shots yet/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: /Add shot/ }));
      const card = await screen.findByRole('article', { name: 'Shot 1' });
      const generate = within(card).getByRole('button', { name: /Generate clip/ });
      expect(generate).toHaveProperty('disabled', true);
      await chooseModel(user, await screen.findByLabelText('Video model'), 'vendor/clips');
      await user.type(within(card).getByLabelText('What we see'), 'The lamp turns.');
      await user.tab();
      await user.click(within(card).getByRole('checkbox', { name: 'New character' }));
      await user.selectOptions(within(card).getByLabelText('Spoken by'), 'New character');
      await user.type(within(card).getByLabelText('Line, as it is said'), 'Get back!');
      await user.tab();
      await vi.waitFor(() => {
        expect(generate).toHaveProperty('disabled', false);
      });

      await user.click(generate);
      expect(await within(card).findByText(/Being made, 50%/)).toBeTruthy();
      expect(provider.videoRequests[0]).toMatchObject({
        model: 'vendor/clips',
        audio: true,
        prompt: expect.stringContaining('New character says "Get back!"') as string,
      });
      // The view looks again by itself until the clip is there.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await within(card).findByLabelText('Clip of shot 1')).toBeTruthy();
      expect(within(card).getByText(/vendor\/clips.*\$0\.20/)).toBeTruthy();

      await user.click(within(card).getByRole('button', { name: /Delete clip/ }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));
      expect(await within(card).findByText('No clip yet')).toBeTruthy();
      await user.click(within(card).getByRole('button', { name: /Delete shot/ }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText(/This scene has no shots yet/)).toBeTruthy();
      expect(await imp.blobs.list('')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cuts a film: copy, paste, undo, title cards and an overview', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    const actor = { kind: 'user', id: 'arnd' } as const;
    const call = async (id: string, input: Record<string, unknown>) => {
      const result = await imp.registry.executeById(id, input, { actor });
      if (result.status !== 'ok') throw new Error(id);
      return result.output as Record<string, string>;
    };
    const projects = (await call('project.list', {})) as unknown as { projects: { id: string }[] };
    const projectId = projects.projects[0]?.id ?? '';
    await call('settings.set', { key: 'video.model', value: 'vendor/clips' });
    const scene = await call('movie.scene.create', {
      projectId,
      heading: 'INT. LAMP ROOM - NIGHT',
    });
    for (const description of ['The lamp turns.', 'Mara at the stairs.']) {
      const shot = await call('movie.shot.create', {
        projectId,
        sceneId: scene['id'],
        description,
      });
      const at = { projectId, sceneId: scene['id'], shotId: shot['id'] };
      await call('movie.shot.clip.generate', { ...at, durationSeconds: 4 });
      await call('movie.shot.clip.check', at);
      await call('movie.shot.clip.check', at);
    }

    await call('movie.character.create', {
      projectId,
      name: 'Narrator',
      voiceOnly: true,
      ownLane: true,
    });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText(/2 of 2 pieces ready/)).toBeTruthy();
    // A character with its own lane gets a lane, where lines are added at the playhead.
    await user.click(await screen.findByRole('button', { name: /Add a line to Narrator/ }));
    expect(await screen.findByText(/not recorded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Narrator: New line/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Remove line/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Narrator: New line/ })).toBeNull();
    });
    const first = await screen.findByRole('button', { name: /Shot 1: The lamp turns/ });
    expect(screen.getByRole('button', { name: /Shot 2: Mara at the stairs/ })).toBeTruthy();
    // Each piece shows a still from the start of the stretch of its clip it uses.
    const thumb = first.querySelector('video.block-thumb');
    expect(thumb?.getAttribute('src')).toMatch(/^blob:test\/\d+#t=0\.10$/);
    expect(screen.getAllByText(/0:08/).length).toBeGreaterThan(0);
    // jsdom cannot record video, so export says so instead of offering a broken button.
    // Export and help live in menus, so the picture and the timeline share one screen.
    await user.click(screen.getByRole('button', { name: /^Export/ }));
    expect(screen.getByText(/cannot record video/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Export film/ }).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Close export' }));

    await user.click(first);
    expect(await screen.findByText(/Shot 1/, { selector: 'h3' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Copy/ }));
    await user.click(screen.getByRole('button', { name: /^Paste/ }));
    // The copy goes in right after the original.
    expect(await screen.findByRole('button', { name: /Shot 2: The lamp turns/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Shot 3: Mara at the stairs/ })).toBeTruthy();
    expect(screen.getAllByText(/0:12/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /Undo/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Shot 3: Mara/ })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: /Redo/ }));
    expect(await screen.findByRole('button', { name: /Shot 3: Mara/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add to the scene' }));
    await user.click(screen.getByRole('button', { name: /Add title/ }));
    expect(await screen.findByRole('button', { name: /Title 2: Title/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Title 2: Title/ })).toBeNull();
    });

    // A piece moves by dragging it onto another; at 48 pixels a second, shot 3
    // starts at 384 and shot 1 covers 0 to 192.
    const drag = (pointerType: string) => {
      const last = screen.getByRole('button', { name: /Shot 3: Mara/ });
      const at = (clientX: number) => ({ clientX, pointerId: 2, pointerType });
      fireEvent.pointerDown(last, at(400));
      fireEvent.pointerMove(last, at(100));
      fireEvent.pointerUp(last, at(100));
    };
    // A finger on a piece that is not selected scrolls instead of moving it.
    drag('touch');
    expect(screen.getByRole('button', { name: /Shot 3: Mara/ })).toBeTruthy();
    drag('mouse');
    expect(await screen.findByRole('button', { name: /Shot 1: Mara/ })).toBeTruthy();
  });

  it('manages projects from the start screen: templates, duplicates, export, import, delete', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    const call = async (id: string, input: unknown) => {
      const result = await imp.registry.executeById(id, input, {
        actor: { kind: 'user', id: 'local' },
      });
      return (result as { output: Record<string, unknown> }).output;
    };

    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(await screen.findByLabelText('Working title'), 'Storm');
    await user.click(screen.getByRole('radio', { name: 'Short film' }));
    await user.click(screen.getByRole('button', { name: /Create project/ }));
    await screen.findByRole('heading', { name: 'Development' });
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'Storm' })).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getAllByText('0/5').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Actions for Storm' }));
    await user.click(screen.getByRole('button', { name: 'Duplicate: Storm' }));
    expect(await screen.findByRole('heading', { name: 'Storm (2)' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Actions for Storm (2)' }));
    await user.click(screen.getByRole('button', { name: 'Rename: Storm (2)' }));
    const field = screen.getByLabelText('Project name');
    await user.clear(field);
    await user.type(field, 'Squall{Enter}');
    expect(await screen.findByRole('heading', { name: 'Squall' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Actions for Squall' }));
    await user.click(screen.getByRole('button', { name: 'Save as template: Squall' }));
    await user.click(await screen.findByRole('button', { name: /Save template/ }));
    expect(await screen.findByText(/Saved the template “Squall template”/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your templates' })).toBeTruthy();

    // Export hands the file over and removes it from the store.
    let saved = 0;
    HTMLAnchorElement.prototype.click = () => {
      saved += 1;
    };
    await user.click(screen.getByRole('button', { name: 'Actions for Squall' }));
    await user.click(screen.getByRole('button', { name: 'Export to a file: Squall' }));
    expect(await screen.findByText(/Saved Squall\.imp\.zip/)).toBeTruthy();
    expect(saved).toBe(1);
    expect(await imp.blobs.list('exports/')).toEqual([]);

    // Import a file made by export.
    const projects = (await call('project.list', {}))['projects'] as { id: string; name: string }[];
    const squall = projects.find((p) => p.name === 'Squall');
    const exported = await call('project.export', { projectId: squall?.id });
    const file = await imp.blobs.get(String(exported['fileKey']));
    const picked = new File([file?.bytes.slice() ?? new Uint8Array()], 'Squall.imp.zip', {
      type: 'application/zip',
    });
    await user.upload(screen.getByLabelText('Project file to import'), picked);
    expect(await screen.findByRole('heading', { name: 'Squall (2)' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Actions for Squall (2)' }));
    await user.click(screen.getByRole('button', { name: 'Delete: Squall (2)' }));
    await user.click(await screen.findByRole('button', { name: /Delete for good/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Squall (2)' })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Delete template Squall template' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Your templates' })).toBeNull();
    });
  });

  it('opens the sample film from the start screen, written down to its shots', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(await screen.findByRole('button', { name: /Open the sample film/ }));
    await screen.findByRole('heading', { name: 'Development' });
    expect(await screen.findByDisplayValue(/last night before her lighthouse/)).toBeTruthy();

    // The guided path has ticked off what the sample holds, and hands the next step on.
    const path = await screen.findByRole('region', { name: 'Your first film' });
    expect(within(path).getByText('3 of 6')).toBeTruthy();
    expect(within(path).getByText('Cast a character')).toBeTruthy();
    await user.click(within(path).getByRole('button', { name: /Ask the coordinator/ }));
    await vi.waitFor(() => {
      expect(screen.getByDisplayValue(/Cast the main character/)).toBeTruthy();
    });
    await user.click(within(path).getByRole('button', { name: /Your first film/ }));
    expect(within(path).getAllByLabelText('Done')).toHaveLength(3);
    await user.click(within(path).getByRole('button', { name: /Hide the guided path/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Your first film' })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'The Last Light' })).toBeTruthy();
  });

  it('shows each project its own chat with the coordinator', async () => {
    const { imp, user } = start([{ content: 'Keeper it is.' }, { content: 'Tide it is.' }]);
    await completeSetup(user);
    const call = async (id: string, input: unknown) =>
      (
        (await imp.registry.executeById(id, input, {
          actor: { kind: 'user', id: 'local' },
        })) as { output: Record<string, unknown> }
      ).output;
    const a = await call('project.create', { name: 'Keeper', mode: 'movie' });
    const b = await call('project.create', { name: 'Tide', mode: 'movie' });

    await call('project.open', { projectId: a['id'] });
    // The start screen shows the chat for all projects; the project's is one tap away.
    await user.click(await screen.findByRole('tab', { name: /Keeper/ }));
    await user.type(await screen.findByLabelText('Message to Coordinator'), 'About Keeper.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByText('Keeper it is.')).toBeTruthy();

    await call('project.open', { projectId: b['id'] });
    expect(await screen.findByRole('tab', { name: /Tide/ })).toBeTruthy();
    expect(await screen.findByText(/Tell Coordinator what you want/)).toBeTruthy();
    expect(screen.queryByText('About Keeper.')).toBeNull();
    await user.type(screen.getByLabelText('Message to Coordinator'), 'About Tide.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByText('Tide it is.')).toBeTruthy();

    await call('project.open', { projectId: a['id'] });
    expect(await screen.findByText('About Keeper.')).toBeTruthy();
    expect(screen.queryByText('About Tide.')).toBeNull();
  });

  it('copies between projects and puts collisions to the person, also when an agent copies', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    const call = async (
      id: string,
      input: unknown,
      actor: Record<string, string> = { kind: 'user', id: 'local' },
    ) => {
      const result = await imp.registry.executeById(id, input, { actor: actor as never });
      return (result as { output: Record<string, unknown> }).output;
    };
    const a = await call('project.create', { name: 'Keeper', mode: 'movie' });
    const b = await call('project.create', { name: 'Tide', mode: 'movie' });
    await call('movie.character.create', { projectId: a['id'], name: 'Mara' });
    await call('movie.character.create', { projectId: a['id'], name: 'Tomas' });
    await call('movie.character.create', { projectId: b['id'], name: 'Mara' });

    await user.click(await screen.findByRole('button', { name: 'Copy between projects' }));
    await user.selectOptions(screen.getByLabelText('From', { exact: true }), 'Keeper');
    await user.selectOptions(screen.getByLabelText('Into', { exact: true }), 'Tide');
    await user.click(await screen.findByRole('checkbox', { name: /^Tomas/ }));
    await user.click(screen.getByRole('button', { name: /^Copy 1/ }));
    expect(await screen.findByText(/Copied 1 into “Tide”/)).toBeTruthy();

    // An agent asks; the question comes to the person.
    const cast = (await call('movie.character.list', { projectId: a['id'] }))['characters'] as {
      id: string;
      name: string;
    }[];
    const maraId = cast.find((c) => c.name === 'Mara')?.id;
    const asked = await call(
      'project.resources.copy',
      {
        fromProjectId: a['id'],
        toProjectId: b['id'],
        items: [{ kind: 'character', id: maraId }],
        note: 'Mara appears in the sequel.',
      },
      { kind: 'agent', id: 'c', role: 'casting-director' },
    );
    expect(asked['status']).toBe('waiting-for-person');
    const dialog = await screen.findByRole('dialog', { name: 'Already in the target' });
    expect(within(dialog).getByText(/Casting director wants to copy/)).toBeTruthy();
    expect(within(dialog).getByText('Mara appears in the sequel.')).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: 'Keep both' })).toHaveProperty(
      'checked',
      true,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Overwrite' }));
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Already in the target' })).toBeNull();
    });
    const request = await call('project.resources.request.get', { requestId: asked['requestId'] });
    expect(request['status']).toBe('done');
    expect((request['outcomes'] as { outcome: string }[])[0]?.outcome).toBe('overwritten');

    // Cancelling also answers it.
    const again = await call('project.resources.copy', {
      fromProjectId: a['id'],
      toProjectId: b['id'],
      items: [{ kind: 'character', id: maraId }],
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel the copy' }));
    await vi.waitFor(async () => {
      expect(
        (await call('project.resources.request.get', { requestId: again['requestId'] }))['status'],
      ).toBe('cancelled');
    });
  });

  it('gives a scene sound effects and music', async () => {
    const { imp, provider, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(await screen.findByText(/there are no scenes yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await screen.findByLabelText('Scene heading');
    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(await screen.findByText(/This scene is silent so far/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add sound effect/ }));
    const effect = await screen.findByRole('article', { name: 'Sound effect' });
    const generate = within(effect).getByRole('button', { name: /Generate/ });
    expect(generate).toHaveProperty('disabled', true);
    await chooseModel(user, await screen.findByLabelText('Sound effects model'), 'vendor/speaker');
    await user.type(within(effect).getByLabelText('What is heard'), 'A gale at sea.');
    await user.tab();
    await vi.waitFor(() => {
      expect(generate).toHaveProperty('disabled', false);
    });
    await user.type(within(effect).getByLabelText('Name'), 'Wind');
    await user.tab();
    const wind = await screen.findByRole('article', { name: 'Wind' });
    await user.click(within(wind).getByRole('button', { name: /Generate/ }));
    expect(await within(wind).findByLabelText('Recording of Wind')).toBeTruthy();
    expect(within(wind).getByRole('button', { name: /Generate again/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add music/ }));
    const music = await screen.findByRole('article', { name: 'Music' });
    await chooseModel(user, await screen.findByLabelText('Music model'), 'vendor/composer');
    await user.type(within(music).getByLabelText('What is heard'), 'Low strings.');
    await user.tab();
    await vi.waitFor(() => {
      expect(within(music).getByRole('button', { name: /Generate/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await user.click(within(music).getByRole('button', { name: /Generate/ }));
    expect(await within(music).findByText(/vendor\/composer · \$0\.04/)).toBeTruthy();
    expect(provider.soundRequests).toEqual([
      { model: 'vendor/speaker', kind: 'effect', prompt: 'A gale at sea.' },
      { model: 'vendor/composer', kind: 'music', prompt: 'Low strings.\nInstrumental, no vocals.' },
    ]);
    expect(screen.getByText('2 sounds in this scene')).toBeTruthy();

    for (const card of [wind, music]) {
      await user.click(within(card).getByRole('button', { name: /Delete sound/ }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));
    }
    expect(await screen.findByText(/This scene is silent so far/)).toBeTruthy();
    expect(await imp.blobs.list('')).toEqual([]);
  });

  it('opens an audio document and edits its tracks with undo', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Audio' }));
    expect(await screen.findByText(/No sounds are recorded yet/)).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Lamp room');
    await user.click(screen.getByRole('button', { name: /Start empty/ }));
    expect(await screen.findByRole('tab', { name: 'Lamp room' })).toBeTruthy();
    expect(await screen.findByText('1 track')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add track/ }));
    expect(await screen.findByText('2 tracks')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mute Track 2' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute Track 2' })).toHaveProperty(
        'ariaPressed',
        'true',
      );
    });
    expect(await screen.findByRole('heading', { name: 'Audio' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute Track 2' })).toHaveProperty(
        'ariaPressed',
        'false',
      );
    });
    expect(screen.getByRole('button', { name: 'Play' })).toHaveProperty('disabled', true);
  });
});
