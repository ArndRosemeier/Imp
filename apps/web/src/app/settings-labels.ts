/**
 * How the Settings view names the settings Imp stores. Every setting is
 * either named in words here or kept for the app itself and hidden; a test
 * (apps/web/test/settings-labels.test.ts) fails when a new one is neither.
 */
export const ACTIVE_MIX_KEY = 'models.mix';
// Kept by the app itself, or shown in their own section (Help), so not listed as raw rows.
export const INTERNAL_SETTINGS: ReadonlySet<string> = new Set([
  'coordinator.member',
  'project.current',
  'help.enabled',
  'help.dismissed',
]);
export const SETTING_LABELS: Readonly<Record<string, string>> = {
  'coordinator.model': 'Coordinator model',
  'video.model': 'Video model',
  'speech.model': 'Voice model',
  'images.model': 'Image model',
  'sounds.model': 'Sound effects model',
  'music.model': 'Music model',
  'transcription.model': 'Transcript model',
  [ACTIVE_MIX_KEY]: 'Model mix',
  'edit.agent-drafts': 'Agents cut drafts on the Edit stage',
  theme: 'Theme',
  'budget.daily': 'Daily budget',
  'spend.allowance.project': 'Budget without approval, per project',
  'spend.allowance.step': 'Most per step without approval',
};

/** A setting's name in words: "video.model" reads as "Video model". */
export function settingLabel(key: string): string {
  const known = SETTING_LABELS[key];
  if (known !== undefined) return known;
  const words = key.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
