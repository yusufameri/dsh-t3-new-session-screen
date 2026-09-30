# dsh-t3-new-session-screen

T3 Code's **New Session screen** for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) composer.

![The New Session screen: the headline, the project menu, the branch picker and the effort picker](assets/demo.gif)

Three things that screen has and DeepSeek Harness's blank session does not:

- **`What should we build in <project>?`** — the headline from T3's
  `DraftHeroHeadline`, where the project name is itself the picker.
- **A reasoning-effort picker** — T3's `TraitsPicker`, surfaced in the composer
  tool row instead of hidden behind the model menu.
- **A git branch picker** — T3's `BranchToolbar`, with real `git checkout`.

## Credit

The screen this plugin implements is T3 Code's. The headline sentence and its
inline project control, the effort picker's shape, and the branch strip with its
searchable ref menu are all theirs. T3 Code is
[open source under MIT](https://github.com/pingdotgg/t3code/blob/main/LICENSE);
this port keeps the same behaviour and swaps the data underneath for DeepSeek
Harness's own services. Please support the original project.

## Features

- **The headline.** `What should we build in <project>?`, centred over the
  composer, with the project name underlined and clickable. Clicking it opens a
  T3-shaped project menu: every registered workspace, a check on the current
  one, a divider, and **New project**. Picking a project moves the blank session
  to it. DSH renders its own headline from a literal string with no slot, so
  this plugin fills the only additive hole in that row
  (`conversation.hero.brand.mark`) and suppresses the shipped title beside it.
  The template is configurable, and `{project}` marks where the control goes.
  DSH's own workspace chip shares the row below the headline with the agent-preset
  seat; with the headline carrying the project, that chip leaves the layout too,
  and the preset seat it used to lead re-seats on the composer's right edge — see
  [Alignment](#alignment).
- **Reasoning effort.** A gauge control in the composer tool row showing the
  level the current model is actually using (`Off`, `Low`, `High`, `Max` for
  DeepSeek's own models). The menu carries each level's description and a check
  on the current one. It reads and writes the same per-session model directory
  the model seat uses, so the model seat's own label updates with it. A model
  that advertises no effort levels renders no control at all — effort is a
  per-model capability, not a global preference.
- **Git branch.** A strip under the composer card: the checkout on the left, the
  current ref on the right. The ref menu searches, lists local and remote refs,
  labels `current` / `default` / `remote`, and switches with
  `git checkout <ref>`. A **Create new ref** row appears once the query names a
  ref that does not exist yet, and runs `git checkout -b`. DSH ships no git
  surface of any kind, so every fact here comes from this bundle's Host half.
  The strip is aligned on the composer's shared width axis, not on the card — see
  [Alignment](#alignment).

## Screenshots

| The New Session screen | Project menu | Branch picker | Reasoning effort |
|---|---|---|---|
| ![Headline and strip](assets/hero.png) | ![Project menu](assets/project-menu.png) | ![Branch picker](assets/branch-picker.png) | ![Effort picker](assets/effort-picker.png) |

## Install

From this repository:

```sh
dsh plugin --profile web add github:yusufameri/dsh-t3-new-session-screen
```

Once the package is on npm, the registry form is one word shorter:

```sh
dsh plugin --profile web add dsh-t3-new-session-screen
```

Either reconciles the profile's bundle list, so the next boot merges the
plugin's patch and loads its client half. Removing the bundle restores the
shipped headline, model seat and composer with no residue.

## Configuration

Every field is optional; the defaults render the whole screen. Set them on the
bundle's row in the profile's `cordis.patch.yml`:

```yaml
- id: t3-new-session-screen
  name: 'dsh-t3-new-session-screen'
  config:
    headlineText: 'What should we build in {project}?'
    effortSlot: right
    branchCreateEnabled: false
```

| Key | Default | Meaning |
|---|---|---|
| `headlineEnabled` | `true` | Replace the blank-session headline with the T3 sentence. |
| `headlineText` | `What should we build in {project}?` | Headline template; `{project}` becomes the interactive project name. Without the hole the sentence renders as plain text. |
| `hideShippedHeadline` | `true` | Hide DSH's own "Into the Unknown" title beside the headline. |
| `hideWorkspaceChip` | `true` | Hide the shipped workspace chip under the headline, which the headline supersedes. |
| `effortEnabled` | `true` | Reasoning-effort picker in the composer tool row. |
| `effortSlot` | `left` | Which composer seat the effort picker occupies: `left` (beside the permission and plan controls) or `right` (beside the model seat). |
| `branchEnabled` | `true` | Git branch strip under the composer, on the new-session screen and in an active session. |
| `branchCreateEnabled` | `true` | Offer **Create new ref** (`git checkout -b`) in the branch picker. |
| `gitEnabled` | `true` | The git bridge behind the branch strip. Turning it off leaves the strip absent. |
| `gitTimeoutMs` | `30000` | Budget of one `git` child process. |

The client half reads the resolved configuration from the Host over the same
route the branch data uses, so a change takes effect on the next page load.

## How it works

The whole screen is contributed through DSH's own seams.

| Piece | Seam |
|---|---|
| Headline | `conversation.hero.brand.mark` (single, root) — the only additive hole in DSH's headline row. |
| Project menu | `conversation.hero.workspace` (single, root) at priority `-1`, which shadows the shipped `WorkspacePicker` in the same cell. |
| Project roster | The root `useWorkspaces` standard hook, fed by `ctx.slots.provideRoot`. |
| New project | `ctx.uiWorkspace.pickDirectory()` then `ctx.workspaces.create({ path })`. |
| Reasoning effort | `conversation.input.left` / `.right` (list), reading `ctx.modelDirectories.directoryFor(sessionId)`. |
| Branch strip | `conversation.input.dock` (one seat for both phases). |
| Hero workspace row | No seat of its own. The shipped row is re-declared: its workspace chip leaves the layout and its agent-preset seat is trailed onto the composer axis, keyed off a `data-t3nss-preset-trailing` attribute the plugin sets on `<html>`. |
| Working directory | `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd`. |
| Git | The Host half's fenced `POST /t3-new-session/api` route (`config`, `git.status`, `git.branches`, `git.checkout`, `git.createBranch`), running `git` through `node:child_process`. |

Two details are load-bearing rather than incidental:

- The client half must inject `remote` and `remote.session`.
  `modelDirectories.directoryFor` resolves through Cordis's caller-context
  tracker, so a plugin that reads the model directory without holding the same
  remote namespace gets `cannot get property "remote.session" without inject`
  and the effort control silently disappears.
- The Host half imports nothing outside `node:*`. A plugin installed as a
  directory link resolves its imports from its own real path, where none of
  DSH's `@deepseek-ai/*` packages are reachable, so the configuration schema is
  a hand-written [Standard Schema](https://standardschema.dev) rather than a
  Schemastery one — Cordis needs nothing more than a synchronous
  `~standard.validate`.

## Alignment

The screen is measured against T3's own numbers rather than eyeballed. T3's
composer shell is `max-w-3xl` with `--chat-composer-drawer-inset: 1.375rem`, and
its context strip is inset by two of those (44px) with `ps-1 pe-2`. DSH's axis is
`--dsh-composer-side-clearance` (16px), `--dsh-composer-dock-inset` (8px) and
`--dsh-composer-card-max-width`, and the shipped `QueueDock` derives its width
from the same three values. The strip uses that derivation, so with the shipped
profile it lands on the card's **content** box:

| Element | X range | |
|---|---|---|
| Composer card | 498..1375 | 877px |
| Composer tool row, content box | **506..1367** | 861px |
| Headline stack (`HeroShell`) | **506..1367** | 861px |
| **Branch strip** | **506..1367** | 861px |
| **Hero preset seat** (right-aligned) | 1218..**1367** | 149px |

All three share centre **936**, and the strip's text sits **4px** under the card —
which is exactly what T3's `-mt-4` + `pt-5` pair nets out to. Inside the tool row
the reasoning-effort control is 28px tall and vertically centred with the attach
button and the permission control (all `513..541`).

The preset seat is the row's only *label-sized* element, so only its right edge is
a fixed number: the seat is content-sized (149px for `Standard mode`), and its
left edge follows whatever DSH names the preset. Its right edge lands on the same
1367 as the strip, the headline stack and the tool row's content box, which is
also the send button's and the strip's trailing control's right edge — the row
reads as one trailing column above the card rather than a chip mid-row.

Two details are load-bearing and easy to regress:

- `box-sizing: border-box` on the strip. Without it the horizontal padding adds
  to `width: 100%` and the strip overflows its stack by the padding on each side
  — which is what it did before this was measured.
- The `width` / `max-width` pair. On the hero the stack is already inset by one
  side clearance per edge, so both clearances and both dock insets come off the
  percentage. In an active session the stack is the full seat width and
  `max-width` does the clamping while `margin-inline: auto` re-centres it — the
  same 861px at the same 506px start, from a different parent.

The hero workspace row is the one place the plugin adjusts DSH's own box rather
than filling a seat. Removing the shipped workspace chip from the row is what
frees the preset seat, and it is the *layout* removal that matters:
`visibility: hidden` — the obvious way to hide an element whose behaviour is
still wanted — leaves its 226px box behind for this repository's own name, and
the seat beside it then sits at whatever x that box ends on. Two things follow,
and both are what the check below measures:

- the chip is `display: none`d, not hidden, so nothing it used to size survives
  in the row;
- the seat is trailed with an auto left margin plus an 8px right margin, not with
  `justify-content` on the row: the row belongs to DSH, the margins belong to the
  seat, and an auto margin keeps the slip right at any row width — the row's own
  right padding (16px) is one side clearance, so the 8px margin is what lands the
  seat on the axis rather than on the card's outer edge.

`scripts/measure-alignment.mjs` re-checks every number above against a running
page and exits non-zero on a regression — including checks 6 and 7, which fail on
either half of that mistake: a seat that stops ending on 1367, and a chip that
starts occupying space again.

## Differences from T3

DSH has no equivalent of these T3 concepts, so the port leaves them out rather
than faking them:

- **No local/worktree environment switch.** T3's strip opens with a
  `Current checkout` / `New worktree` selector. DSH has no worktree concept, so
  the strip's left label reports the checkout and is not a menu.
- **No pull-request badge** on the strip.
- **The strip is ordered below the card rather than laid out there.** DSH's
  blank-session hero renders no extension seat below the input card, so the
  strip is contributed to the seat above it and moved down with `order`. Every
  wrapper the renderer puts around a slot occupant is a contents-only box, so
  the strip is a flex item of the composer stack and the ordering works without
  touching shipped CSS. In an active session DSH's own context meter occupies
  the space directly under the card, so the strip sits below that instead.

One behaviour worth knowing: DSH's `session/selectModel` writes the session
selection **and** the deployment default, so picking an effort level also makes
it the default for new sessions. That is the Host's behaviour, not this
plugin's; it is the same thing the shipped model menu does.

## Development

```sh
# one-time: shim pnpm if it is not on PATH
mkdir -p ~/.dsh/dsh-runtimes/shim

# install into a scratch profile and boot it
dsh plugin --profile t3demo add "$PWD"
dsh --profile t3demo --port 8899 --no-open
```

The capture tooling behind `assets/` is in `scripts/`: `record.mjs` drives a
scripted interaction over one Chrome DevTools Protocol connection (and can
record frames), `encode-gif.py` turns those frames into the GIF, and
`capture-stills.json` / `demo-steps.json` are the two scripts it runs.

```sh
CDP_PORT=9333 node scripts/record.mjs scripts/capture-stills.json --no-frames
CDP_PORT=9333 node scripts/record.mjs scripts/demo-steps.json /tmp/frames
python3 scripts/encode-gif.py /tmp/frames assets/demo.gif
```

`scripts/measure-alignment.mjs` is the alignment check described in
[Alignment](#alignment). Point it at a page running this plugin and it fails with
a non-zero exit if any of those numbers move:

```sh
CDP_PORT=9333 node scripts/measure-alignment.mjs
```

## License

MIT. T3 Code is MIT too; see [Credit](#credit).
