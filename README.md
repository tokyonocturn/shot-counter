# Shot Counter

Press one key. The count goes up by one. A bottle pours into a glass on a transparent overlay, with sound and particles, and the OBS source updates instantly.

It works two ways:

- **With OBS**: OBS owns the hotkey, the overlay runs as a Browser source.
- **Without OBS**: a small local hotkey agent owns the same key and the overlay runs in its own window. No OBS, no internet, no account.

The shelf holds **184 drinks** across 12 categories, including somaek and 27 shaken cocktails that rattle a cocktail shaker first.

## What you need

- Windows (the local hotkey agent and the OBS binding script are Windows only)
- Node.js 20 or newer
- Optional: OBS Studio with the WebSocket server enabled

## Quick start, no OBS

Download the packaged zip, or from a checkout:

```
npm install
start.bat
```

`start.bat` builds the hotkey agent on first run, starts the agent and the server together, and when you close its window it stops both: the agent watches the server process and exits as soon as the server is gone, so nothing is left running.

Then open <http://localhost:4321/> for the dashboard, or <http://localhost:4321/window> for the overlay on a second monitor. If you prefer the terminal: `npm run local-hotkey` in one window and `npm start` in another.

## Quick start, with OBS

1. `npm install`
2. Close OBS, then run `npm run setup-hotkey`. This writes the trigger binding into your scene collection and keeps a timestamped backup in `backup/`. It refuses to run while OBS is open, because OBS would overwrite the file on exit.
3. Start OBS, then `start.bat` or `npm start`.
4. In OBS add a **Browser** source pointing at <http://localhost:4321/overlay>.
5. Open the dashboard and turn **Run without OBS** off if it is on, so the OBS trigger is used.

If you would rather bind the key by hand: OBS, Settings, Hotkeys, search for **Shot Counter Trigger**, and bind **Restart playback** to your key. The trigger source is a muted, invisible media source parked off canvas.

## Triggers

| Mode | Who registers the key | Needs OBS |
| --- | --- | --- |
| OBS | OBS, through its own hotkey system | yes |
| Local agent | `bin/shot-counter-hotkey.exe`, through `RegisterHotKey`, life tied to the server | no |
| Button | the dashboard `+1 shot` button | no |

Change the local key with `node setup-local-hotkey.mjs --key F8`, then restart the agent.

## Drinks

| Category | Count | Examples |
| --- | --- | --- |
| Soju & Sake | 11 | Jinro Chamisul, Chum Churum, makgeolli, Dassai 45 |
| Beer | 34 | Cass, Hite, Guinness, Asahi, Corona, Lagunitas IPA |
| Whiskey | 23 | Jack Daniel's, Jameson, Lagavulin 16, Eagle Rare |
| Tequila & Mezcal | 9 | Patron, Don Julio, Del Maguey Vida |
| Vodka | 9 | Tito's, Grey Goose, Belvedere |
| Gin | 6 | Tanqueray, Hendrick's, Plymouth |
| Rum | 8 | Bacardi, Kraken, Gosling's |
| Liqueur | 19 | Jagermeister, Campari, Midori, Blue Curacao |
| Wine & Bubbles | 7 | Prosecco, champagne, sangria |
| Mixed | 15 | Somaek, soju bomb, michelada, Jagerbomb |
| Shaken Cocktails | 27 | Margarita, mojito, espresso martini, pina colada |
| Stirred & Built | 16 | Negroni, old fashioned, Moscow mule |

Drinks are drawn from parts, not 184 separate pictures: five glass shapes, six bottle shapes, per drink brand labels and liquid colours, foam heads, and garnishes (lime, lemon, orange, cherry, olive, mint, salt rim).

**Shaken drinks** run a short process: the tin appears, rattles for about half a second with ice particles flying, plays a synthesised rattle (ice against steel, ice clicks, the cap seating), then pours from the tin into the glass.

**Mixed drinks** pour a full base, then dash a second spirit on top, so somaek is beer first and soju second.

The dashboard search filters by name, brand and category, and labels each drink `shaker`, `mix` or `built`.

## Build a package

```
npm run package
```

Produces `dist/shot-counter-<version>.zip` with the server, the overlay, the drinks, the compiled agent source, the hotkey setup scripts, a `START-HERE.txt` and all runtime dependencies. Extract it anywhere and double click `start.bat`. Node.js is the only external requirement; nothing is downloaded at runtime.

## Why antivirus is quiet

Earlier versions read the keyboard directly, which is what keyloggers do, and Defender flagged the helper binary that came with it. That code is gone.

This version never reads the keyboard:

- no global keyboard hooks
- no key state polling
- no injected input
- no key logging, no key history
- no child process that reads keys
- no bundled keyboard capture binaries

Both trigger paths are Windows shortcuts owned by the OS: OBS registers the key with its hotkey system, and the local agent calls `RegisterHotKey` and receives a single `WM_HOTKEY` message. Nothing in this project observes what you type.

The agent is compiled from `tools/local-hotkey.cs` on your machine by `setup-local-hotkey.mjs` using the .NET Framework compiler that ships with Windows. The app itself never compiles anything at runtime.

## Configuration

`config.json` is created from `config.example.json` and is ignored by git, so your OBS password never reaches the repository.

| Field | Meaning |
| --- | --- |
| `port` | HTTP port, default 4321, bound to 127.0.0.1 only |
| `label` | Text under the number on the overlay |
| `drink` | Current drink id from `public/drinks.js` |
| `sound` | Overlay sound switch and volume |
| `resetOnStreamStart` | Reset the count when an OBS stream starts |
| `localHotkey.key` | Key the offline agent registers |
| `obs.enabled` | `false` runs fully offline and never contacts OBS |
| `obs.host`, `obs.port`, `obs.password` | OBS WebSocket connection |

## API

| Route | Purpose |
| --- | --- |
| `GET /api/state` | current count, drink, trigger and OBS status |
| `POST /api/shot` | add one (the overlay consumes the change) |
| `POST /api/undo`, `POST /api/reset` | undo or reset |
| `POST /api/config` | update any config field |
| `POST /api/obs/trigger-setup` | re-create the OBS trigger source |
| `GET /overlay` | transparent overlay for OBS |
| `GET /window` | standalone overlay window |

## License

**View only.** This repository is public so the code can be read, not reused. The [LICENSE](LICENSE) forbids copying, forking for reuse, redistribution, modification and derivative works. Plain English version: you may look, you may not take.

A license is a legal instrument, not a technical lock. GitHub still lets a visitor download or fork a public repository, and anyone determined to copy the files can. If you need copying to be impossible rather than prohibited, the repository has to be private. Publishing it publicly was your call, so the terms above are the strongest protection that exists at that setting.

## Troubleshooting

- **`RegisterHotKey` failed, or the key does nothing**: another program already owns that key. Pick another with `node setup-local-hotkey.mjs --key F9`, then restart `start.bat`.
- **The agent is missing**: `start.bat` builds it on first run. If that failed, run `setup-local-hotkey.bat`, or `node setup-local-hotkey.mjs` in a terminal to see the compiler message.
- **No agent built**: run `node setup-local-hotkey.mjs`, or use the dashboard button.
- **Port 4321 already in use**: change `port` in `config.json`, then update the overlay URL in OBS.
- **OBS connected but no counting**: the trigger binding is missing. Close OBS and run `npm run setup-hotkey`, or bind it by hand as described above.
- **No sound in OBS**: enable audio on the Browser source and keep its volume up. The overlay synthesises sound through WebAudio, so there is no audio file to miss.
