# RectoVeritas — notes for whoever works on this next

## This machine runs two different editors

A second, separate editor is being built in parallel with Codex, in the
`site-editor` repository. Both are called RectoVeritas and both are Vite apps,
so they are easy to mistake for one another.

**This one:**

| | |
|---|---|
| repo | `WelcomedRain/RectoVeritas`, checked out at `G:\Verso2Recto\repo` |
| dev server | **http://localhost:5180** — pinned, `strictPort` |
| browser storage | IndexedDB `verso2recto` |
| deployed at | https://recto.antheasolve.com |
| edits the site | `WelcomedRain/Anthea-Solve` → https://antheasolve.com |

The other one uses port **5173** (Vite's default) and the `site-editor` repo.

**Browser storage is scoped by origin, which means by port.** A session here
once let Vite hop off a busy port, drove the other project's page believing it
was this one, and deleted an IndexedDB on its origin. `strictPort: true` now
turns that into a startup error instead of a silent move — but before touching
browser storage, check the page title says `RECTO • VERITAS` and the port says
5180.

## Working without a token

`npm run dev` serves the real antheasolve.com export at `/__sample.html`. To
exercise the app against it, seed IndexedDB directly: put `{path:'index.html',
text}` in `files`, and `source` + `github-token` in `meta`. Nothing reaches
GitHub unless Publish is pressed.

Do not open the database from the console before the app has: creating it
without the app's `upgrade` leaves it at version 1 with no object stores, and
the app then cannot create them.

## Before pushing

`npm run verify` — typecheck, tests, build. Tests that read the real site at
`G:/Anthea-Solve/index.html` must guard the read *inside* the test, not in the
`describe` body: `describe.skipIf` skips the tests but still evaluates the body,
and CI has no G: drive.
