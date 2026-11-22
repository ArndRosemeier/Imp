# What's new: one file per change

Imp's version goes up by 0.001 with every merge to `main`. Nobody edits the
number: the build counts the merges since this file was added, so pull
requests that merge at the same time never collide. The first merge with
this file is 0.001.

Each version's entry in the app's **What's new** panel (and in the
`app.changelog` command agents read) comes from here:

- **Add a file to this folder in your pull request** to describe it for the
  people using Imp. Name it after your branch or feature, for example
  `changes/edit-ripple-delete.md`, so that it never clashes with another
  pull request's file.
- Without a file, the pull request's title is shown instead.
- **Add the German version beside it** as `changes/<name>.de.md`, in the same
  shape: a `# Title` and the same bullets, in natural German with "du". A test
  fails while an entry has no translation. Imp shows the German one when the
  interface is German.

## Writing an entry

```md
# Ripple delete on the Edit stage

- Removing a shot closes the gap, and the sound after it moves along.
- Hold Shift (or long-press on a tablet) to leave the gap open instead.
```

- The `# Title` line is optional and replaces the pull request's title.
- One bullet per change someone will notice. Write for the person making a
  film, not for developers: what they can do now, in plain words. Leave out
  internal refactors unless they make something faster or more reliable.
- Fix a typo in an entry by editing the file; it stays with its version.
