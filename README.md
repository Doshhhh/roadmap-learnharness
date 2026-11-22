# Roadmap — LearnHarness plugin

Learning roadmaps drawn like [roadmap.sh](https://roadmap.sh): the first module at
the bottom, the goal at the top, sub-topics branching off the main line. A
persistent **Architect** builds the roadmap from a real book, course or your
own PDF; every node opens native **Lesson** and **Practice** sessions that report
progress and mistakes back to the map.

![Roadmap with the node panel](docs/roadmap.png)

Roadmap is a LearnHarness Community plugin (`apiVersion: 1`, id `roadmap-learnharness`,
LearnHarness 0.6.0 or newer). The interface is available in English and
Russian (Settings → Roadmap → Interface language; *Auto* follows the system).

> Roadmap started as a fork of [Learning Paths](https://github.com/kerr-mwv/learning-path-plugin)
> by **kerr-mwv** (AGPL-3.0). The pedagogical framework, the Architect, the error
> ledger and the session bridge come from that project; Roadmap replaces the
> interface and extends the data model. See [Credits](#credits).

## What it looks like

- **Graph view.** Modules form the main line from bottom to top; each module's
  nodes hang off a bracket. The module you are working on opens as a box with
  *In order*, *Additional* and *Consolidation* columns. Interchangeable choices
  (GCC *or* Clang) sit on the left marked `alt.`; optional nodes are dashed.
  Drag to pan, Ctrl + wheel or the zoom control to zoom.
- **Tree view.** The same roadmap as a compact list.
- **Node panel** (Node / Errors / Architect tabs): status, type, the goal,
  *After this node I can…*, the source anchor with a pre-reading pointer, typed
  resources (book, article, video, course, docs, exercises; free or not), the
  nodes it builds on, linked sessions with focused minutes and correct answers,
  and the recommended artifact with the reason for it.
- **Status line**: required nodes done, nodes in progress, open errors.

![The roadmap with the legend](docs/roadmap-map.png)

Statuses are *not started*, *in progress*, *consolidated* and *skipped*. Nothing
is gated: any node can be opened at any time. Optional nodes are never counted
in progress, and a group of alternatives counts once.

## How it works

1. **Create a roadmap.** Tell the Architect what you want to be able to do in the
   end and what you already know. It picks one or two reputable sources (or uses
   the PDF/text you upload) and drafts modules and nodes anchored to chapters.
   Before drafting it **researches**: it looks up the canonical books and courses
   of the field and deeper, less popular but strong ones, opens their tables of
   contents and syllabi, and anchors nodes to real chapters (see *Research* below).
   It follows the roadmap-author method: start from the end goal, build the
   dependency graph, lead all the way to the goal, trace the path as a learner
   before saving; every node is one concrete ability with 2–4 outcomes; 3–8
   resources per node — canonical first, with which chapters to use and what to
   skip, marked *essential* and *checked* when it actually looked inside.
   Drop books and notes (PDF, Markdown, text) onto the Architect panel or attach
   them with *Book or notes*.
2. **Study a node.** *Lesson* or *Practice* creates a native LearnHarness session,
   stages a brief (goal, outcomes, source anchor, earlier nodes to weave in, open
   errors, the artifact) and opens it. Linked sessions get `roadmap_*` tools to
   read the brief and record progress, errors and suggestions.
3. **Mistakes travel forward.** Errors are logged by cognitive root cause
   (misconception, confusing concepts, prerequisite gap, procedural slip, missed
   cue), never as grades. Open errors follow into later sessions until resolved.
   When a topic really is not sticking, a session may suggest a small repair
   node; you accept, discuss or dismiss it. The roadmap never changes silently.
4. **A roadmap from any session.** When the prober or teacher has assessed you
   and your goal is wider than one session, it offers a roadmap once (never in
   sessions launched from a roadmap or in research sessions; if you say no, it
   stops). On agreement it hands the Architect the full diagnostic dossier —
   goal, background, every check with your answer and its verdict, strengths,
   gaps, misconceptions by root cause, preferences, constraints, sources, open
   questions and key quotes. A card in the chat offers *Build* / *Not now*.
   *Build* opens Roadmap and the Architect builds from the dossier without
   asking again: mastered material becomes optional or a short review, gaps get
   bridge nodes, misconceptions get contrast nodes and land in the Error Ledger
   as open entries. The source session is not linked to the roadmap.
5. **Refine.** *Refine* reopens the roadmap's Architect conversation; *Find
   resources* on a node asks it for typed resources for that node.

There is deliberately **no scheduling and no gamification**: no hours, streaks,
points or deadlines.

## Research

Settings → Roadmap → Research. Every channel can be switched off; with all of them
off the Architect works from what the model knows and never invents links.

| Channel | Default | What it does |
| --- | --- | --- |
| Research sessions in LearnHarness | On (hybrid) | *Research in a session* opens a teaching chat that researches the topic with the search engine set in LearnHarness and hands the report to the Architect. The search key stays inside LearnHarness. |
| Open catalogs | On (hybrid) | Open Library, Google Books, OpenAlex, arXiv, Wikipedia and reading public pages. No key. |
| Deep research via Claude Code | Off | Runs the Claude Code CLI (the one LearnHarness uses for its claude-code provider) with **only** web search and page reading, in an empty temporary folder. Slow (10–30 min) and uses your Claude limits. |
| My own search key | Off | Web search with your Tavily or Brave key. Plugins cannot use the system password store, so the key is a plain file in `data/secrets/` — use a key with a spending limit. |

*Deep research* in the composer asks for confirmation (it can take long and use
many tokens) and applies to the next message. Page reading refuses local and
private network addresses. Reports from research sessions and Claude Code are
kept as research notes (listed in settings) that the Architect reads.

## Install

### From a release (no build tools)

1. Download `roadmap-<version>.zip` from the latest release.
2. In LearnHarness open **Settings → Community plugins** and copy the plugins
   directory path.
3. Unzip there so that `<plugins-directory>/roadmap-learnharness/dist/manifest.json` exists.
4. Press **Refresh**, enable **Roadmap**, and restart LearnHarness.

To update, replace `roadmap-learnharness/dist/` and keep `roadmap-learnharness/data/` (your roadmaps).
The plugin id changed from `roadmap`; on first start it copies this fork's
roadmap files from `<plugins-directory>/roadmap/data/` if the new data folder is empty. The old
folder is never changed.

### From source

The plugin API types are not on npm. In LearnHarness open **Settings → Community
plugins** and use **Download authoring skill**, then extract the downloaded
`learnharness-plugins/` folder into this repo (it is git-ignored).

```sh
git clone https://github.com/808arc/roadmap-learnharness.git
cd roadmap-learnharness
npm run sdk      # copies learnharness-plugins/types into .sdk/
npm ci
npm run install:local -- "<plugins-directory>"
```

`install:local` builds `dist/` and copies it into `<plugins-directory>/roadmap/`.
It never touches `data/`, so your roadmaps are kept.

For a quick rebuild-and-copy loop during development, `./plugin-sync.sh` builds
and copies the whole plugin folder into LearnHarness. It deletes the existing
copy first, including `data/`, so back up roadmaps you care about before running it.

### Coming from Learning Paths

On first start Roadmap **copies** your Learning Paths data (paths, settings,
uploaded sources and Architect conversations) into its own folder. The original
plugin's data is never modified, and the import runs only once. After checking
that everything is there you can disable Learning Paths.

## Settings

Settings → Roadmap:

| Setting | Default |
| --- | --- |
| Interface language | Auto (system language) |
| Architect writes in | Auto (the language you write in) |
| Default view | Graph |
| Show optional nodes | On |
| Artifact defaults per node type | Framework recommendation |
| Architect model | Follow the host's strong model, or choose one |
| Research | Hybrid: research sessions + open catalogs |
| Offer roadmaps from sessions | On (off removes both the rule and the tool) |
| Roadmaps | Delete a roadmap (sessions and the Knowledge Graph are never touched) |

## Data

Everything lives in the plugin's own data folder (`<plugins>/roadmap-learnharness/data/`):
`roadmaps/` (one file per roadmap, named by a hash of its id), `roadmaps-index.json`, `settings.json`,
`architect.json`, `sources/`, `research/` (research notes), `research-chats.json`, `secrets/` (only if
you save your own search key) and the host-managed `agents/`. An older `learning-paths.json` is read
once to write the roadmap files; it stays in the data folder as `learning-paths.json.migrated`.
Records are versioned and written atomically; corrupt or newer files are refused rather than overwritten. Roadmap never deletes native
chats or Knowledge Graph records.

## Development

```sh
npm ci
npm test            # Node test runner, no model or network
npm run typecheck   # needs the LearnHarness plugin SDK types in .sdk/
npm run build       # bundles into dist/
```

The tests mount the real views against recorded host primitives and an
in-memory backend; the backend tests run the real `activate` against an
in-process host.

## Credits

- [Learning Paths](https://github.com/kerr-mwv/learning-path-plugin) by
  **kerr-mwv** — the original plugin this project is forked from: the
  pedagogical framework ([FRAMEWORK.md](./FRAMEWORK.md)), the Path Architect,
  the error ledger, pivots and the native session bridge.
- [roadmap.sh](https://roadmap.sh) — the visual reference for the roadmap.
- [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist.

## License

[AGPL-3.0-only](./LICENSE), the same license as the original project.
