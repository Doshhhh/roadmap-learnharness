# Contributing

Thanks for your interest. This plugin is deliberately small and opinionated, and I'd like to keep it that way. A little coordination up front saves everyone time.

## Before you start

- **Open an issue before writing code for anything beyond a small fix.** Describe the problem you're solving, not only the solution.
- **One issue per feature.** Please don't split an idea into a series of linked issues. Start with one, and if it grows, we'll split it together.
- **Big or open-ended ideas** belong in Discussions first, not in issues.
- I may say no to good ideas. The answer is usually about scope, not quality.

## Design principle

This plugin exists to help learners do the thinking. The path provides **structure, prompts and feedback**. The learner generates the understanding. A change fits when it moves work from the system to the learner (for example, asking a question instead of stating an answer). A change usually doesn't fit when it has the system produce conclusions the learner could have produced themselves.

This doesn't mean leaving learners alone with a blank page. Novices need guidance, worked examples and feedback. The aim is guided generation that fades as the learner gains skill. The reasoning, with references to the learning science, is in [FRAMEWORK.md](FRAMEWORK.md).

## Branches and review

- `main` is what people install.
- Work is done on one branch per issue, named `issue-N`, with one commit per change.
- After review, the branch is merged into `main` with `--no-ff`.
- Nothing is pushed to a remote without the owner's go-ahead.

## Pull requests

- Keep PRs small and focused on one issue. Use `Refs #n` rather than `Closes #n` unless the PR fully resolves the issue.
- Draft PRs are welcome for early feedback.
- Run `npm run check` before asking for review, and say in the PR what you ran. Typecheck needs the SDK types in `.sdk/`; see [Development](#development).
- **Show evidence of the change.** For anything a learner or user can see, include screenshots or a short screen recording (before and after where it helps). For behaviour changes, describe the outcome you observed, such as the steps you took and what happened. For agent or prompt changes, include a short example of the resulting conversation. Evidence helps me review faster and is often more convincing than test output alone.
- Use the public plugin SDK only. No private host imports, and no writes to host-owned data.

## Scope

Not planned: scheduling or study calendars, gamification, automatic changes to a learner's path without their approval, and claims about a learner's mastery based on indirect evidence.

## Development

### Setup

Use Node 24 (the version CI uses), then run `npm ci`.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run sdk -- [path]` | Copies the LearnHarness plugin API types (`learnharness-plugin-api`) into `.sdk/`. The default source is `learnharness-plugins/types`, which is git-ignored; pass another `types` folder after `--`. It fails if the folder has no `learnharness-plugin-api` package. |
| `npm run build` | Bundles `src/main.ts` into `dist/main.js` and `src/backend.ts` into `dist/backend.cjs`, copies `styles.css` and `manifest.json`, and checks the manifest. It writes only `dist/` and refuses to build if `dist/data` exists. `src/local-only/` (git-ignored) is bundled into the backend when present; set `ROADMAP_PUBLIC=1` to leave it out. |
| `npm run typecheck` | Fails unless `.sdk/index.d.ts` exists, then runs `tsc --noEmit`. |
| `npm test` | Runs `node --test` on `tests/*.test.mjs` and `tests/*.test.ts`. |
| `npm run check` | Runs typecheck, build, test and the version check, in that order. |
| `npm run install:local -- "<plugins-directory>"` | Builds, then copies `dist/` to `<plugins-directory>/roadmap-learnharness/dist/`. It replaces only that `dist/`; the `data/` folder is not touched. Restart LearnHarness to load changed code. |

The SDK types are not in this repository. Building and testing do not need them; typecheck does, so run `npm run sdk -- <path>` first.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. On Ubuntu with Node 24, it runs `npm ci`, the version check, `npm run build` and `npm test`. It does not run typecheck, because `.sdk/` is not in the repository. Run `npm run check` locally, where `.sdk/` is present.

### Versions and release

`manifest.json` and `package.json` both carry the plugin version.

1. `node scripts/release.mjs <major|minor|patch|x.y.z>` sets the new version in both files.
2. The script does not commit or tag. It prints the `git commit` and `git tag` commands to run next.
3. `node scripts/check-version.mjs` fails if the two versions differ. It runs in CI and in `npm run check`.

### Plugin id

The `id` in `manifest.json` is `roadmap-learnharness`. The install folder is named from that id, so `install:local` copies into `<plugins-directory>/roadmap-learnharness/`.

### Tests

- Tests live in `tests/`. Files named `*.test.mjs` or `*.test.ts` are run by `npm test`. The other files there (`fixtures.ts`, `host.ts`, `view-host.ts`, `roadmap-dom.ts`) are shared helpers.
- Run all tests with `npm test`. Run one file with `node --test tests/<name>.test.ts`, for example `tests/roadmap-mastery.test.ts`.
- Tests use synthetic data only. `tests/fixtures.ts` holds the shared domain fixtures, and several test files say so in their header.
