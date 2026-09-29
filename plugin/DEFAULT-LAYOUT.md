# Default layout (approved) — build it once in Stream Deck, export, ship

Stream Deck profiles can only be produced by the Stream Deck app (Elgato: “profiles must be created through the
Stream Deck application … then export”), and the file format is undocumented, so v0.1 ships **without** a
generated profile. Build this layout with ordinary folders and pages, then run
`npm run add-profile -- <exported>.streamDeckProfile` and `npm run pack`.

**Plugin actions used.** Every key below is one of the plugin's actions (category “Capture”). *Folder* and *Back*
keys are Stream Deck's own **Create Folder** / **Back to parent** actions.
Commands are set in the action's inspector by picking them from the live list; the menu paths below are what that
list will contain (paths marked † should be confirmed against the dropdown; the dump you sent lists Import/Export
under File without the exact submenu names).

## HOME (8 folders + dials)

| View | Display | Camera | Positions | Select | Edit | Patch & Focus | Tabs |
|---|---|---|---|---|---|---|---|

Dials on HOME and on every folder: **Exposure · Ambient · Bloom · White Balance** (View Dial action, view *Live view*).
On **Display** the four dials are **Fill · Hue Clamp · Contrast · Saturation** (the manual confirms contrast and
saturation; a Stream Deck+ has four dials, so these replace the usual four on that page).

## Folders (Back + 7 keys each)

**View** — *Capture Command*, all under the **View** menu except the last three (Navigate menu)

| Key | Menu path | Match |
|---|---|---|
| Wireframe | View › Wireframe | exact |
| Plot | View › Plot | exact |
| Live | View › Live | exact |
| Custom | View › Custom | exact |
| Alpha View | Navigate › Alpha View | exact |
| Beta View | Navigate › Beta View | exact |
| Gamma View | Navigate › Gamma View | exact |

**Display**

| Key | Menu path | Match |
|---|---|---|
| Grid | View › Grid | exact |
| Widgets | View › Widgets | exact |
| Hidden Objects | View › Hidden Objects | exact |
| Fixture Information | View › Fixture Information | exact |
| Dim Background | View › Dim Background | exact |
| Quad | Window › Arrangements › Quad | exact |
| Full Screen | View › Enter Full Screen \| Exit Full Screen | alternates |

**Camera**

| Key | Menu path | Match |
|---|---|---|
| Swing to Top / Front / Right / Left / Selection | View › Camera › Swing to … | exact |
| Focus Selection | View › Camera › Focus Selection | exact |
| Focus All | View › Camera › Focus All | exact |

**Positions**

| Key | Action | Settings |
|---|---|---|
| Slot 1–5 | Camera Slot | `slot` 1…5 |
| Store | Store Modifier | — |
| Show Positions | Create Folder → 7 × *Show Position* | `mode: "auto"`, `catalog: 1`, `index: 1…7` |

**Select** — *Capture Command*

| Key | Menu path | Match |
|---|---|---|
| Select All | Edit › Select All | exact |
| Deselect All | Edit › Deselect All | exact |
| By Fixture Type | Edit › Select › By Fixture Type | exact |
| By Fixture Group | Edit › Select › By Fixture Group | exact |
| By Layer | Edit › Select › By Layer | exact |
| Fixtures on Truss | Edit › Select › Fixtures on Truss | exact |
| Selection Navigator | View › Selection Navigator | exact |

**Edit** — *Capture Command* (Delete is hold-to-fire by default)

| Key | Menu path | Match |
|---|---|---|
| Undo | Edit › Undo | prefix |
| Redo | Edit › Redo | prefix |
| Save | File › Save | exact |
| Duplicate… | Edit › Duplicate… | exact |
| Delete | Edit › Delete | exact (hold) |
| Group | Edit › Group | exact |
| Align… | Edit › Align… | exact |

**Patch & Focus** — *Capture Command* (Unpatch is hold-to-fire by default)

| Key | Menu path | Match |
|---|---|---|
| Unit… | Edit › Sequential › Unit… | exact |
| Circuit… | Edit › Sequential › Circuit… | exact |
| Patch… | Edit › Sequential › Patch… | exact |
| Channel… | Edit › Sequential › Channel… | exact |
| Focus… | Edit › Focus… | exact |
| Fixture Details… | Edit › Fixture Details… | exact |
| Unpatch | Edit › Unpatch | exact (hold) |

**Tabs**

| Key | Action | Settings |
|---|---|---|
| Design, Fixtures, Universes, Media, Snapshots, Library | Capture Tab | `tab` |
| Export | Create Folder → the six keys below | |

*Export* folder (*Capture Command*): Save As… (File › Save As…), Export Focus Sheets… †, Export Documentation… †,
Export Presentation… †, Save Image… (View › Save Image…), Render Image… (View › Render Image…).
† These live under File › Export (or similar); pick them from the dropdown.

## Extras worth placing somewhere

*Connection* (status + re-check), *View Toggle* (Auto Exposure, Laser Flicker).
