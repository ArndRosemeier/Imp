// @vitest-environment jsdom
import { CommandError } from '@imp/core';
import { ProviderError } from '@imp/providers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Problem } from '../src/app/movie.js';
import { canRetry } from '../src/app/retry.js';

afterEach(cleanup);

describe('Retry', () => {
  it('is offered for failures outside Imp, also when a command wraps them', () => {
    const busy = new ProviderError('rate_limit', 'openrouter', 'Busy.');
    expect(canRetry(busy)).toBe(true);
    expect(canRetry(new CommandError('handler_failed', 'x', 'No image.', { cause: busy }))).toBe(
      true,
    );
    expect(canRetry(new ProviderError('auth', 'openrouter', 'Bad key.'))).toBe(false);
    expect(canRetry(new CommandError('invalid_input', 'x', 'No such scene.'))).toBe(false);
    // As it arrives from the local server: a plain error with the flag copied over.
    expect(canRetry(Object.assign(new Error('Busy.'), { retryable: true }))).toBe(true);
  });

  it('shows the button only beside the failure it belongs to, and sends it again once', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<Problem text="Other trouble." retry={{ text: 'Busy.', run }} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    rerender(<Problem text="Busy." retry={{ text: 'Busy.', run }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    const trying = screen.getByRole('button', { name: /Trying again/ });
    expect((trying as HTMLButtonElement).disabled).toBe(true);
    await user.click(trying);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
