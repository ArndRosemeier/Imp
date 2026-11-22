import { PathStep } from '@imp/core';
import {
  ArrowRightIcon,
  CaretDownIcon,
  CheckCircleIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  FlagCheckeredIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from '../context.js';
import { OPEN_VIEW } from '../library/model.js';
import { askCoordinator, useHelpState } from './help.js';

/** The id the path is closed under, like a tip, so "Turn off all tips" and the help settings cover it. */
export const FIRST_FILM = 'path.first-film';

const Path = z.object({
  projectId: z.string().nullable(),
  steps: z.array(PathStep.extend({ done: z.boolean() })),
  next: z.string().nullable(),
});

/**
 * The guided way to a first film, as one slim bar above the stage: how far the
 * open project has come, the next step, and two ways to take it, by going to
 * its stage or by having the coordinator do it. It opens into the whole list.
 * Steps tick themselves off from what the project holds, so doing a step by
 * hand, through an agent or from the sample all count.
 */
export function FirstFilm({
  stage,
  stageNames,
}: {
  stage: string;
  stageNames: Readonly<Record<string, string>>;
}): ReactElement | null {
  const imp = useImp();
  const help = useHelpState();
  const [open, setOpen] = useState(false);
  const show =
    help.data !== undefined && help.data.enabled && !help.data.dismissed.includes(FIRST_FILM);
  const path = useLive(
    ['projects/', 'settings/project.current', `first-film:${String(show)}`],
    async (current) => (show ? Path.parse(await runCommand(current, 'project.path', {})) : null),
  );
  const data = path.data;
  if (!show || data === null || data === undefined || data.steps.length === 0) return null;

  const close = (): void => {
    runCommand(imp, 'help.hint.dismiss', { id: FIRST_FILM }).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  };
  const go = (to: string): void => {
    window.dispatchEvent(new CustomEvent(OPEN_VIEW, { detail: to }));
  };
  const doneCount = data.steps.filter((step) => step.done).length;
  const next = data.steps.find((step) => step.id === data.next);

  const actions = (step: PathStep): ReactElement => (
    <span className="first-film-actions">
      {step.stage !== stage && (
        <button
          className="button small"
          onClick={() => {
            go(step.stage);
          }}
        >
          Go to {stageNames[step.stage] ?? step.stage} <ArrowRightIcon aria-hidden="true" />
        </button>
      )}
      <button
        className="button quiet small"
        title="Puts the request in the coordinator's message box. Nothing is sent until you press Send."
        onClick={() => {
          askCoordinator(step.ask);
        }}
      >
        <ChatCircleDotsIcon aria-hidden="true" /> Ask the coordinator
      </button>
    </span>
  );

  return (
    <section className="first-film" aria-label="Your first film" data-open={open}>
      <div className="first-film-bar">
        <button
          className="first-film-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className="first-film-dots" aria-hidden="true">
            {data.steps.map((step) => (
              <span key={step.id} data-done={step.done} data-next={step.id === data.next} />
            ))}
          </span>
          <span className="eyebrow">Your first film</span>
          <span className="muted small">
            {String(doneCount)} of {String(data.steps.length)}
          </span>
          <CaretDownIcon className="first-film-caret" aria-hidden="true" size={14} />
        </button>
        {next === undefined ? (
          <span className="first-film-next">
            <FlagCheckeredIcon aria-hidden="true" size={18} />
            <strong>Your first film is made.</strong>
            <span className="muted">Export it from Edit whenever you like.</span>
          </span>
        ) : (
          <span className="first-film-next">
            <span className="muted small">Next</span>
            <strong>{next.title}</strong>
          </span>
        )}
        {next !== undefined && !open && actions(next)}
        <button
          className="button quiet icon first-film-close"
          aria-label={next === undefined ? 'Close: done' : 'Hide the guided path for good'}
          title={next === undefined ? 'Done' : 'Hide for good. It comes back if you reset tips.'}
          onClick={close}
        >
          <XIcon aria-hidden="true" size={16} />
        </button>
      </div>
      {open && (
        <ol className="first-film-steps">
          {data.steps.map((step) => (
            <li key={step.id} data-done={step.done} data-next={step.id === data.next}>
              {step.done ? (
                <CheckCircleIcon aria-label="Done" size={20} weight="fill" />
              ) : (
                <CircleIcon aria-label="Not done yet" size={20} />
              )}
              <span className="first-film-step">
                <strong>{step.title}</strong>
                <span className="muted">{step.body}</span>
              </span>
              {!step.done && actions(step)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
