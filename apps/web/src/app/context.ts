import type { Actor } from '@imp/core';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ImpClient } from '../host/client.js';

export const USER: Actor = { kind: 'user', id: 'local' };

export const ImpContext = createContext<ImpClient | null>(null);

export function useImp(): ImpClient {
  const imp = useContext(ImpContext);
  if (imp === null) {
    throw new Error('useImp must be used inside ImpContext.');
  }
  return imp;
}

/**
 * Runs a command as the user and returns its output. The user is never asked
 * for approval by the default policy, so anything but `ok` is a bug.
 */
export async function runCommand(imp: ImpClient, id: string, input: unknown): Promise<unknown> {
  const result = await imp.run(id, input);
  if (result.status !== 'ok') {
    throw new Error(`"${id}" was not run: ${result.status}`);
  }
  return result.output;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { details?: unknown }).details;
    return Array.isArray(details) && details.length > 0
      ? `${error.message} ${details.join('; ')}`
      : error.message;
  }
  return String(error);
}

export interface Live<T> {
  readonly data: T | undefined;
  readonly error: string | null;
}

/**
 * Reads through a command and reads again whenever the store changes under
 * one of the prefixes. Views stay current no matter who made the change.
 */
export function useLive<T>(
  prefixes: readonly string[],
  load: (imp: ImpClient) => Promise<T>,
): Live<T> {
  const imp = useImp();
  const [state, setState] = useState<Live<T>>({ data: undefined, error: null });
  const key = prefixes.join('|');

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      load(imp).then(
        (data) => {
          if (active) setState({ data, error: null });
        },
        (error: unknown) => {
          if (active) setState({ data: undefined, error: messageOf(error) });
        },
      );
    };
    refresh();
    const unsubscribes = key.split('|').map((prefix) => imp.subscribe(prefix, refresh));
    return () => {
      active = false;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    // `load` is expected to be stable in what it reads; the prefixes identify it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imp, key]);

  return state;
}
