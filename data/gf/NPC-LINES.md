# What people say: `npc-lines.json`

Everything the people of Glens Falls say when you talk to them comes from one file, [`npc-lines.json`](npc-lines.json),
in this folder. Dave writes every line. The game makes up nothing: no AI and no network service, only this file.
You can edit it on GitHub (open the file, press the pencil, commit) or in any text editor. No code changes are needed.

## In the game

Walk up to someone (on foot: get out of the taxi with `F`, or press `1`), face them, and press `T`. On a phone or
tablet, a **Talk** button appears beside Jump while someone is close enough. They stop, turn to you and say a line for
about four seconds, or until you walk away. Press `T` again to hear another line from the same person.

## The file

```json
{
  "randos": {
    "day":   ["A line for daytime.", "Another one."],
    "night": ["A line for night."],
    "any":   ["A line for any time of day."]
  },
  "specials": {
    "thrill-hill-crowd": {
      "name": "Thrill Hill crowd",
      "where": "thrill-hill",
      "night": ["..."],
      "day":   ["..."]
    }
  }
}
```

- **`randos`**: any ordinary pedestrian on the sidewalks and trails. By day they say a line from `day` or `any`; at
  night (Twilight and Midnight in the time-of-day buttons), a line from `night` or `any`. Nobody says the same line twice
  in a row.
- **`specials`**: named characters or groups. Each one has an id (`"thrill-hill-crowd"`), a `name` (shown at the top of
  the speech bubble) and its own `day`, `night` and/or `any` lists. A special with nothing to say at that time of day
  (an empty or missing list) leaves the talking to the randos' lines.
  - `thrill-hill-crowd` speaks for the people standing round the fire at the (fictional) Thrill Hill party at night.
  - `"where": "thrill-hill"` also gives it anyone you talk to within 30 m of the fire ring, so its `day` lines are
    what trail walkers say there by day, when the party has gone home.

## Rules for editing

- Every line is text in double quotes: `"like this"`. Lines in a list are separated by commas, and the **last line in a
  list has no comma after it**.
- To put a double quote inside a line, write `\"`. Apostrophes (`'`) need nothing special.
- Keep lines short enough for a phone screen: one or two sentences. Lines over 400 characters are cut.
- Replace the `PLACEHOLDER — Dave writes this` lines with your own. A list can be empty (`[]`).
- To add a special, copy the `thrill-hill-crowd` block, give it a new id and name, and put a comma between the two
  blocks. A new special speaks only once the game ties it to someone: either by `where` (a place the game knows; today
  that is `thrill-hill`) or by a one-line hook in the code (`speech.bind(object, "your-id")` in
  `js/gf-npc-talk-ui.js`), for example for a future ghost carriage in Crandall Park.

## If something is wrong with the file

The game never stops for a bad file. It writes what is wrong to the browser console (`[npc-lines] ...`, e.g. a missing
comma) and carries on: a missing or broken list counts as empty, and a file that cannot be read at all makes everyone
say `PLACEHOLDER — npc-lines.json could not be read (see the browser console)`. A quick check before committing:
paste the file into any JSON validator, or run `node --test tests/gf-npc-talk.test.mjs`, which checks this file.

Changes show on the next reload of the game (GitHub Pages can take a minute or two to publish a commit).
