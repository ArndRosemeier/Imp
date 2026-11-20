import type { Project } from '@imp/core';
import { WorldElement } from '@imp/world';
import { useId, type ReactElement } from 'react';
import { z } from 'zod';
import { runCommand, useLive } from './context.js';

const Items = z.object({ items: z.array(WorldElement) });

type Act = (id: string, input: Record<string, unknown>) => Promise<unknown>;

/** The locations and objects of a project, kept up to date. */
export function useWorld(project: Project): {
  locations: readonly WorldElement[];
  objects: readonly WorldElement[];
} {
  const world = useLive([`projects/${project.id}/world/`], async (imp) => ({
    locations: Items.parse(
      await runCommand(imp, 'world.location.list', { projectId: project.id, full: true }),
    ).items,
    objects: Items.parse(
      await runCommand(imp, 'world.object.list', { projectId: project.id, full: true }),
    ).items,
  }));
  return { locations: world.data?.locations ?? [], objects: world.data?.objects ?? [] };
}

/** Where a scene happens, and the state the place is in. */
export function ScenePlace({
  sceneId,
  locationId,
  stateId,
  locations,
  act,
}: {
  sceneId: string;
  locationId: string | null;
  stateId: string | null;
  locations: readonly WorldElement[];
  act: Act;
}): ReactElement {
  const placeId = useId();
  const stateFieldId = useId();
  const place = locations.find((candidate) => candidate.id === locationId);
  return (
    <div className="row wrap scene-place">
      <div className="field">
        <label htmlFor={placeId}>Location</label>
        <select
          id={placeId}
          className="select"
          value={locationId ?? ''}
          onChange={(event) => {
            void act('movie.scene.update', {
              sceneId,
              locationId: event.target.value === '' ? null : event.target.value,
            });
          }}
        >
          <option value="">{locations.length === 0 ? 'No locations designed yet' : 'None'}</option>
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {place !== undefined && place.states.length > 0 && (
        <div className="field">
          <label htmlFor={stateFieldId}>State</label>
          <select
            id={stateFieldId}
            className="select"
            value={stateId ?? ''}
            onChange={(event) => {
              void act('movie.scene.update', {
                sceneId,
                locationStateId: event.target.value === '' ? null : event.target.value,
              });
            }}
          >
            <option value="">Usual look</option>
            {place.states.map((state) => (
              <option key={state.id} value={state.id}>
                {state.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** The view a shot is filmed from and the objects seen in it. */
export function ShotPlace({
  shot,
  sceneLocationId,
  locations,
  objects,
  change,
}: {
  shot: {
    locationId: string | null;
    viewId: string | null;
    objects: readonly { objectId: string; stateId: string | null }[];
  };
  sceneLocationId: string | null;
  locations: readonly WorldElement[];
  objects: readonly WorldElement[];
  change: (fields: Record<string, unknown>) => Promise<unknown>;
}): ReactElement | null {
  const viewFieldId = useId();
  const place = locations.find(
    (candidate) => candidate.id === (shot.locationId ?? sceneLocationId),
  );
  if (place === undefined && objects.length === 0) return null;
  const seen = new Set(shot.objects.map((entry) => entry.objectId));
  return (
    <>
      {place !== undefined && (
        <div className="field">
          <label htmlFor={viewFieldId}>Filmed from ({place.name})</label>
          <select
            id={viewFieldId}
            className="select"
            value={shot.viewId ?? ''}
            onChange={(event) => {
              void change({ viewId: event.target.value === '' ? null : event.target.value });
            }}
          >
            <option value="">{place.views[0]?.name ?? 'First view'} (master)</option>
            {place.views.slice(1).map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {objects.length > 0 && (
        <fieldset className="choices">
          <legend>Objects seen</legend>
          {objects.map((object) => (
            <label key={object.id} className="choice">
              <input
                type="checkbox"
                checked={seen.has(object.id)}
                onChange={() => {
                  void change({
                    objects: seen.has(object.id)
                      ? shot.objects.filter((entry) => entry.objectId !== object.id)
                      : [...shot.objects, { objectId: object.id, stateId: null }],
                  });
                }}
              />
              {object.name}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
