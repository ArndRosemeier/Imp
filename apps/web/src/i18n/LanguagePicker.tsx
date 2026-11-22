import { Language, LANGUAGES } from '@imp/core';
import { TranslateIcon } from '@phosphor-icons/react';
import { Fragment, useId, type ReactElement } from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from '../app/context.js';
import { currentLanguage, switchLanguage, t } from './i18n.js';

const LanguageState = z.object({ language: Language });

/** The interface language the core holds, which agents and Save all see too. */
export function useLanguageSetting(): Language | undefined {
  return useLive(
    ['settings/ui.language'],
    async (imp) => LanguageState.parse(await runCommand(imp, 'settings.language.get', {})).language,
  ).data;
}

/**
 * Draws everything inside it in the language the core holds, and draws it
 * again when that changes, whoever changed it: the person, or an agent asked
 * to. Each language is drawn fresh, so no text is left over from the last one.
 */
export function FollowLanguage({ children }: { children: ReactElement }): ReactElement {
  const language = useLanguageSetting() ?? currentLanguage();
  switchLanguage(language);
  return <Fragment key={language}>{children}</Fragment>;
}

/** English or Deutsch, each written in its own language so anyone finds theirs. */
export function LanguagePicker({ compact = false }: { compact?: boolean }): ReactElement {
  const imp = useImp();
  const id = useId();
  const current = useLanguageSetting() ?? currentLanguage();
  const choose = (language: Language): void => {
    runCommand(imp, 'settings.language.set', { language }).catch((error: unknown) => {
      console.error(messageOf(error));
    });
  };
  return (
    <div
      className={compact ? 'language-picker compact' : 'language-picker'}
      role="radiogroup"
      aria-labelledby={id}
    >
      <span id={id} className={compact ? 'sr-only' : 'eyebrow'}>
        {t('Language')}
      </span>
      {compact && <TranslateIcon aria-hidden="true" className="language-picker-icon" />}
      {LANGUAGES.map((language) => (
        <button
          key={language.id}
          type="button"
          role="radio"
          lang={language.id}
          aria-checked={language.id === current}
          className="language-option"
          onClick={() => {
            choose(language.id);
          }}
        >
          {language.name}
        </button>
      ))}
    </div>
  );
}
