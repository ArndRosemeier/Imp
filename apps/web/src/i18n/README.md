# Languages in Imp

Imp's interface speaks English and German. English is the default. The
person picks the language in Settings or on the first setup screen; agents
pick it with `settings.language.set`. The choice is the setting
`ui.language`, so Save all keeps it, and it is mirrored to `localStorage`
(`imp.language`) so the first paint is already in the right language.

## Writing text in the app

The English text is the key. Wrap every text a person reads:

```tsx
import { t, tn, tx } from '../i18n/i18n.js';

<button>{t('Add shot')}</button>
<p>{t('Saved {name}.', { name })}</p>
<p>{tn(count, '{count} shot in this scene', '{count} shots in this scene')}</p>
<span>{tx(stage.name)}</span>
```

- `t('...')` for text written in the app. The key must be a literal.
- `tn(count, one, other)` for anything with a number of things. `{count}`
  is filled in for you.
- `tx(value)` for names that come from the core (stage and role names,
  command titles, kinds, templates). The i18n test collects these from the
  core, so they need catalog entries too.
- Translate whole sentences. Never glue pieces together (`t('Delete') + name`),
  because other languages put the words in another order. For a sentence with
  bold words, use `<Marked text={t('**Pickup to come.** It stands here…')} />`.
- Call `t` while drawing or in a handler, never at the top of a module: the
  language can change while Imp runs. For a constant table, use getters:
  `get label(): string { return t('Done'); }`.
- Numbers and money go through `formatNumber`, `fixed` and `formatUsd`, dates
  through `Intl.DateTimeFormat(currentLanguage())`, and keys through `keyLabel`.
- Text for agents (their context and instructions) stays English. Mark such a
  line with `// i18n-ignore`.

## Adding the German

Add every new key to `de.ts`, in natural German with "du". Keep the glossary:

| English                                                         | German                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Development, Script, Casting, Design, Shots, Sound, Edit, Audio | Entwicklung, Drehbuch, Casting, Ausstattung, Einstellungen, Ton, Schnitt, Audio |
| shot                                                            | Einstellung                                                                     |
| Settings                                                        | Optionen (Einstellungen is the Shots stage)                                     |
| timeline, playhead, track or lane                               | Zeitleiste, Abspielkopf, Spur                                                   |
| pickup                                                          | Nachdreh                                                                        |
| Save all / Load all                                             | Alles sichern / Alles laden                                                     |
| What's new, Ask Imp, library, model mix                         | Neuigkeiten, Frag Imp, Bibliothek, Modellmix                                    |
| Coordinator, Screenwriter, Film Editor                          | Koordinator, Drehbuchautor, Cutter                                              |
| Ctrl, Shift, Space                                              | Strg, Umschalt, Leertaste                                                       |

The guide has German pages beside the English ones (`packages/host/src/guide.de.ts`,
`packages/mode-movie/src/guide.de.ts`), and every What's new entry has a
`changes/<name>.de.md`.

## The checks

`apps/web/test/i18n.test.ts` fails when a text a person reads is not
wrapped, when a key has no German, when placeholders differ, when a German
entry is empty, still English or no longer used, or when `t` runs at the top
of a module. Tests beside the guide and the release notes fail when a page,
tip or entry has no German version.

## Another language

1. Add it to `LANGUAGES` and the `Language` enum in `packages/core/src/language.ts`.
2. Add a catalog beside `de.ts` and register it in `CATALOGS` in `i18n.ts`.
3. Add its guide pages, its `changes/*.<id>.md` entries, its id to
   `TRANSLATED_LANGUAGES` in `packages/release`, and its Imp names in
   `apps/web/src/app/imp-names.tsx`.

The tests then list everything still missing.
