# What people say: `npc-lines.json`

Everything the people of Glens Falls say when you talk to them comes from one file, [`npc-lines.json`](npc-lines.json),
in this folder. Dave writes every line. The game makes up nothing: no AI and no network service, only this file.
You can edit it on GitHub (open the file, press the pencil, commit) or in any text editor. No code changes are needed.

The file starts as Dave's line bank from the "Slop Glens Falls" Notion page (2026-11-16), copied word for word.

## In the game

Walk up to someone (on foot: get out of the taxi with `F`, or press `1`), face them, and press `T`. On a phone or
tablet, a **Talk** button appears beside Jump while someone is close enough. They stop, turn to you and say a line for
about four seconds, or until you walk away. Press `T` (or Talk) again to hear another line from the same person. The
name over the line (for example "Red Wings fan" or "Keg guy") says who is talking.

## The file

```json
{
  "randos": {
    "day":   [],
    "night": [],
    "any":   [],
    "groups": {
      "hockey-red-wings": {
        "name": "Red Wings fan",
        "any": ["A line for any time of day.", "Another one."]
      }
    }
  },
  "specials": {
    "thrill-hill-crowd": {
      "name": "Thrill Hill crowd",
      "where": "thrill-hill",
      "night": [
        { "speaker": "Keg guy", "text": "A line with its own speaker." }
      ],
      "day": ["..."]
    }
  }
}
```

### Lines

A line is either plain text in double quotes, or an object with the text and who says it:

```json
"Just the words.",
{ "speaker": "Keg guy", "text": "The words, with a name shown over them." }
```

When a line has a `speaker`, the speech bubble shows that name. Otherwise it shows the group's or the special's `name`.

### `randos`: ordinary people on the sidewalks and trails

- **`groups`** are named groups of town talk. Each has a `name` (shown in the bubble) and `day`, `night` and/or `any`
  lists. `any` lines are said at any time of day.
- Each time you talk to someone, the game first picks **one group**, every group with the same chance (a group with 45
  lines is no more likely than one with 20). It only picks among the groups that have something to say at this time of
  day: by day a group's `day` + `any` lines, at night its `night` + `any` lines. Then it picks a line from that group.
- `day`, `night` and `any` directly under `randos` are a plain, nameless group. They are empty now: town talk comes from
  the named groups. If you put lines there, they count as one more group.
- Night means Twilight and Midnight in the time-of-day buttons; day means Golden Hour and Midday.
- Nobody says the same line twice in a row.

### `specials`: named characters and groups

Each special has an id (`"thrill-hill-crowd"`), a `name` and its own `day`, `night` and/or `any` lists. A special only
speaks when the game ties it to someone:

- by **`where`**: `"where": "thrill-hill"` gives it anyone you talk to within 30 m of the Thrill Hill fire. Only the
  Thrill Hill crowd has a `where`. Do not give one to a single character: everyone in that circle would become them.
- by a one-line hook in the code (`speech.bind(object, "your-id")` in `js/gf-npc-talk-ui.js`).

A special with nothing to say at this time of day leaves the talking to the randos. A special that nothing is tied to
is simply stored for later and never heard.

## What is heard now, and what is only stored

| Group | Where you hear it |
| --- | --- |
| `thrill-hill-crowd` | At night, the people round the Thrill Hill fire (`night`). By day, anyone within 30 m of the dead fire (`day`). |
| `party-oregano-guy` | One of the people at the fire at night (the last to arrive). |
| `thrill-cop` | By day, one person walking the park trails (Cole's Woods, Crandall Park, Fire Road). |
| `randos.groups`: `thrill-hill-talk`, `gf-history-talk`, `hockey-red-wings`, `hockey-icehawks`, `hockey-phantoms`, `hockey-thunder`, `hockey-gfhs-93` | Anyone on the sidewalks and trails, any time. |
| `buckley-tire`, `jeff-hammel`, `charles-penguin`, `cast-link-lines`, `rodin`, `haus`, `wing-ghost`, `glen-ghost` | **Stored only**, for later (their places and people come with later work). |

`cast-link-lines` belong to particular people (Keg Guy, the Puke Freshman, Bonzo, the Professor, the Cop, Oregano Guy).
Keep them out of the crowd and the town groups, or a random guest will claim to be Keg Guy.

## Rules for the lines

- **Jeff Hammel and Charles Penguin stay separate.** No `jeff-hammel` line mentions Charles Penguin, no
  `charles-penguin` line mentions Jeff Hammel, and no line anywhere in the file names both. A test checks this.
- **Do not fix typos or eras.** The game mixes eras on purpose and every line is said in the present, never as a
  time-travel joke. MF Doom, later hockey teams and 1965 Buckley stay as written. Typos stay until Dave changes them.
- No source notes or citations in the lines. They are spoken words only.

## Rules for editing

- Every line is text in double quotes: `"like this"`. Lines in a list are separated by commas, and the **last line in a
  list has no comma after it**. The same goes for groups and specials: commas between them, none after the last.
- To put a double quote inside a line, write `\"`. Apostrophes (`'` or `’`) need nothing special.
- Keep lines short enough for a phone screen. Lines over 400 characters are cut.
- To add a town group, copy a block under `groups`, give it a new id and `name`. It is heard at once.
- To add a special, copy a block under `specials`, give it a new id and `name`. It is stored until the game ties it to
  someone (see above).

## If something is wrong with the file

The game never stops for a bad file. It writes what is wrong to the browser console (`[npc-lines] ...`, e.g. a missing
comma) and carries on: a missing or broken list counts as empty, and a file that cannot be read at all makes everyone
say `PLACEHOLDER — npc-lines.json could not be read (see the browser console)`. A quick check before committing:
paste the file into any JSON validator, or run `node --test tests/gf-npc-talk.test.mjs`. That test also checks the
group counts of the starter bank, so after adding or removing lines, update the counts at the top of the test (`BANK`),
or ask for it to be updated.

Changes show on the next reload of the game (GitHub Pages can take a minute or two to publish a commit).
