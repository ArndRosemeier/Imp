import { ProblemReport } from '@imp/core';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { useId, useState, type ReactElement, type SyntheticEvent } from 'react';
import { messageOf, runCommand, useImp } from '../context.js';

/** The screen and input, which explain most layout problems. */
function clientLine(): string {
  const touch = navigator.maxTouchPoints > 0 ? 'touch' : 'mouse';
  return `${String(window.innerWidth)}×${String(window.innerHeight)} at ${String(window.devicePixelRatio)}x, ${touch}`;
}

/**
 * Reporting a problem: the person says what happened, Imp adds the version,
 * where it runs and what failed lately, and the report opens as a new GitHub
 * issue for them to check and submit. Nothing leaves the app from here, and
 * the report can be copied instead, for anyone without a GitHub account.
 */
export function ReportProblem(): ReactElement {
  const imp = useImp();
  const [title, setTitle] = useState('');
  const [happened, setHappened] = useState('');
  const [expected, setExpected] = useState('');
  const [activity, setActivity] = useState(true);
  const [report, setReport] = useState<ProblemReport | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const happenedId = useId();
  const expectedId = useId();

  const prepare = (event: SyntheticEvent): void => {
    event.preventDefault();
    setError(null);
    runCommand(imp, 'support.report.prepare', {
      title: title.trim(),
      whatHappened: happened.trim(),
      expected: expected.trim(),
      includeActivity: activity,
      client: clientLine(),
    }).then(
      (raw) => {
        setReport(ProblemReport.parse(raw));
        setCopied(false);
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  if (report !== null) {
    return (
      <div className="report stack">
        <p className="muted">
          Here is what the report says. <strong>Open on GitHub</strong> shows it as a new issue,
          filled in; read it there and press Submit. You need a free GitHub account. Without one,
          copy the report and send it however you like.
        </p>
        <pre className="report-preview" aria-label="The report">
          {report.body}
        </pre>
        <div className="row wrap">
          <a className="button primary" href={report.url} target="_blank" rel="noreferrer">
            <ArrowSquareOutIcon aria-hidden="true" /> Open on GitHub
          </a>
          <button
            className="button"
            onClick={() => {
              navigator.clipboard.writeText(`${report.title}\n\n${report.body}`).then(
                () => {
                  setCopied(true);
                },
                (reason: unknown) => {
                  setError(messageOf(reason));
                },
              );
            }}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy the report'}
          </button>
          <button
            className="button quiet"
            onClick={() => {
              setReport(null);
            }}
          >
            <PencilSimpleIcon aria-hidden="true" /> Change it
          </button>
        </div>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="report stack" onSubmit={prepare}>
      <p className="muted">
        Something broken or confusing? Say what happened and Imp writes a report for its makers,
        with the version and what failed lately. Your key, prompts and story never go in, and
        nothing is sent until you submit it yourself.
      </p>
      <label className="field" htmlFor={titleId}>
        <span>The problem in a few words</span>
        <input
          id={titleId}
          className="input"
          required
          maxLength={200}
          placeholder="For example: clips stay on Making forever"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </label>
      <label className="field" htmlFor={happenedId}>
        <span>What happened, and what you did just before</span>
        <textarea
          id={happenedId}
          className="input"
          required
          rows={4}
          maxLength={3000}
          value={happened}
          onChange={(event) => {
            setHappened(event.target.value);
          }}
        />
      </label>
      <label className="field" htmlFor={expectedId}>
        <span>What you expected (optional)</span>
        <textarea
          id={expectedId}
          className="input"
          rows={2}
          maxLength={1500}
          value={expected}
          onChange={(event) => {
            setExpected(event.target.value);
          }}
        />
      </label>
      <label className="choice report-activity">
        <input
          type="checkbox"
          checked={activity}
          onChange={(event) => {
            setActivity(event.target.checked);
          }}
        />
        <span>
          Add the last few commands and their errors{' '}
          <span className="muted">(names and outcomes only, no inputs)</span>
        </span>
      </label>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="button primary" disabled={title.trim() === '' || happened.trim() === ''}>
          Write the report
        </button>
      </div>
    </form>
  );
}
