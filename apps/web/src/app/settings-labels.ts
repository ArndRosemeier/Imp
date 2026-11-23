import { t } from '../i18n/i18n.js';
/**
 * How the Settings view names the settings Imp stores. Every setting is
 * either named in words here or kept for the app itself and hidden; a test
 * (apps/web/test/settings-labels.test.ts) fails when a new one is neither.
 */
export const ACTIVE_MIX_KEY = 'models.mix';
// Shown in Settings' Models section, where they are changed, so not listed as raw rows.
export const MODEL_SETTINGS: ReadonlySet<string> = new Set([
  'coordinator.model',
  'video.model',
  'speech.model',
  'images.model',
  'sounds.model',
  'music.model',
  'transcription.model',
  ACTIVE_MIX_KEY,
]);
// Kept by the app itself, or shown in their own section (Help, Language), so not listed as raw rows.
export const INTERNAL_SETTINGS: ReadonlySet<string> = new Set([
  'coordinator.member',
  'project.current',
  'help.enabled',
  'help.dismissed',
  'ui.language',
  // The theme button in the top bar.
  'ui.theme',
  // Its own switch, under What agents do without asking.
  'edit.agent-drafts',
  // The budget without approval has its own fields, under What agents do without asking.
  'spend.allowance.project',
  'spend.allowance.step',
]);
export const SETTING_LABELS: Readonly<Record<string, string>> = {
  get 'coordinator.model'(): string {
    return t('Coordinator model');
  },
  get 'video.model'(): string {
    return t('Video model');
  },
  get 'speech.model'(): string {
    return t('Voice model');
  },
  get 'images.model'(): string {
    return t('Image model');
  },
  get 'sounds.model'(): string {
    return t('Sound effects model');
  },
  get 'music.model'(): string {
    return t('Music model');
  },
  get 'transcription.model'(): string {
    return t('Transcript model');
  },
  get [ACTIVE_MIX_KEY](): string {
    return t('Model mix');
  },
  get 'edit.agent-drafts'(): string {
    return t('Agents cut drafts on the Edit stage');
  },
  get 'ui.theme'(): string {
    return t('Theme');
  },
  get 'spend.allowance.project'(): string {
    return t('Budget without approval, per project');
  },
  get 'spend.allowance.step'(): string {
    return t('Most per step without approval');
  },
};

/** A setting's name in words: "video.model" reads as "Video model". */
export function settingLabel(key: string): string {
  const known = SETTING_LABELS[key];
  if (known !== undefined) return known;
  const words = key.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
