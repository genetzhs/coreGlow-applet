# Coreglow Panel — context for other models

Read this before editing `coreglow-panel@genetzhs/`. It explains what the applet does,
how it is wired into Cinnamon, and the traps that already cost time.

## What it is

`coreglow-panel@genetzhs` is a **Cinnamon panel applet** (GJS / CJS, Cinnamon 6.x, tested on 6.6.9)
in the visual language of the `coreglow@genetzhs` desklet (same repo). It shows small
system metrics in the panel and an **iStat-Menus-style drop-down on click**.

One code base, **five modes** selected per instance with the `mode` setting:

| mode | Panel item | Drop-down content |
|---|---|---|
| `cpumem` | `CPU` + big % + 60 s sparkline, `RAM` + big % + 60 s sparkline | iStat-Menus layout: clock+temp, 60 s bar history, user/system split, per-core ring grid, USED/PRESSURE rings, used/cached/free/swap list, top RSS processes |
| `load` | `LOAD` + 1-minute load (no graph — it duplicated the CPU one) | 1/5/15 min bars normalised to thread count, CPU usage + history, per-core bars, top 4 processes |
| `net` | `NET` + down/up rates with drawn arrows | down/up rates, 60 s down+up graph, totals, LAN/PUBLIC/GATEWAY/DNS |
| `uptime` | `UPTIME` + `6d 21h` | uptime, boot time, load bars, process count, CPU/RAM summary |
| `ip` | `IP` + country flag + public IP | public IP large with flag, LAN/interface/gateway/DNS/ping |
| `temp` | `TEMP` + CPU temperature (green < 60°, amber < 80°, red ≥ 80°) | temp ring, min/avg/max over 2 min, 2 min graph, fan rpm, NVMe temp |

All values refresh every 1 s (`Mainloop.timeout_add_seconds`). The drop-down is a
`St.DrawingArea` inside an `AppletPopupMenu`, drawn at `MENU_SCALE = 1.2`.
There is **no surrounding card** on the panel item — only accent dot + label + value
(+ sparkline in `cpumem`).

## Files

- `applet.js` — everything: data collection, Cairo drawing, menu logic (~950 lines).
- `settings-schema.json` — `mode`, `theme`, `accent1`, `accent2`, `showSpark`, `showLabels`, `hoverOpen`, `hotAt`.
- `metadata.json` — uuid, name, version.
- `stylesheet.css` — removes the theme's applet-box padding/hover so the Cairo card is the only background.
- `context.md` — this file.

## Install / instances

Symlink the folder into Cinnamon and add instances to `org.cinnamon enabled-applets`:

```bash
ln -s ~/coreGlow-applet/coreglow-panel@genetzhs ~/.local/share/cinnamon/applets/coreglow-panel@genetzhs
# entry format:  panel<location>:<order>:<uuid>:<instanceId>
# e.g.           panel1:right:11:coreglow-panel@genetzhs:28
```

Per-instance settings live in `~/.config/cinnamon/spices/coreglow-panel@genetzhs/<instanceId>.json`.
The same applet can run several times with different `mode` values.

Instances on the development machine (25 Nov 2026):

| id | mode | panel entry |
|---|---|---|
| 28 | cpumem | `panel1:right:11` |
| 29 | load | `panel1:right:0` |
| 30 | net | `panel1:right:8` |
| 31 | uptime | `panel1:right:3` |
| 32 | ip | `panel1:right:4` |
| 33 | temp | `panel1:right:5` |

They replaced (still installed, just not enabled): `hwmonitor@sylfurd`,
`bash-sensors@pkkk`, `download-and-upload-speed@cardsurf`, `uptime@vatanuki.kun`,
`ipindicator@matus.benko@gmail.com`, `temperature@fevimu`.

## Interaction model

- **Click opens the drop-down** (`on_applet_clicked` → `this.menu.toggle()`). This is the default and
  what the user asked for: *no hover UI*.
- `hoverOpen` (settings, default **false**) re-enables open-on-hover. When off, the text tooltip is
  suppressed too (`this._applet_tooltip.preventShow = true`), so hover shows nothing.
- When hover is on: `_onEnter` opens the menu and closes sibling instances' menus (module-level
  `INSTANCES` set), `_onLeave` schedules a 400 ms close. `_pointerInside()` checks the real pointer
  against applet **and** menu rectangles before closing — without it the menu flickers open/closed.
- Context menu (right click): "Open System Monitor", "Coreglow settings…" plus Cinnamon's own items.

## Data sources

| Data | Source | Interval |
|---|---|---|
| CPU total + per-thread | `/proc/stat` deltas | 1 s |
| RAM/swap/cached | `/proc/meminfo` | 1 s |
| Load 1/5/15 | `/proc/loadavg` | 1 s |
| Clock | max `cpu MHz` in `/proc/cpuinfo` | 5 s |
| Uptime/process count | `/proc/uptime`, `ls -d /proc/[0-9]* | wc -l` | 1 s / 10 s |
| Top processes | `top -b -n2 -d0.5 -o %CPU` (2nd sample) | 5 s, load mode only |
| Rates/totals | `/sys/class/net/<iface>/statistics/{rx,tx}_bytes` deltas | 1 s, net/ip modes |
| Interface/LAN/gateway/DNS | `ip route`, `ip addr`, `/etc/resolv.conf` | 10 s, net/ip modes |
| Ping | `ping -c1 -W2 1.1.1.1` | 5 s, net/ip modes |
| Public IP | `https://ipinfo.io/json` | first tick + every 10 min, net/ip modes |
| Country flag | `j.country` → `https://flagcdn.com/w40/<cc>.png`, cached in `~/.cache/coreglow` | on country change, ip mode |
| CPU temperature | max `temp*_input` of the coretemp/k10temp/zenpower hwmon | 5 s, cpumem |
| Memory pressure | `/proc/pressure/memory` `some avg10` | 5 s, cpumem |
| Top RSS processes | `ps -eo comm=,rss= --sort=-rss | head -4` | 10 s, cpumem |
| Fan / NVMe temp | hwmon `fan1_input`, `nvme/temp1_input` | 5 s, temp mode |
| Panel value font | 14 px (load, uptime, cpu, ram, temp) | — |

Shell calls go through `_sh()` → `Util.spawn_async(["bash","-c",...])`, so keep quoting intact.

## Drawing notes

Palette `DARK`/`LIGHT` + `accent1` (cyan, CPU/download) and `accent2` (violet, RAM/upload),
`hotAt` threshold turns rings/bars amber then red. Helpers: `_card`, `_ring`, `_pct`, `_bar`,
`_spark`, `_graph`, `_ioGraph`, `_tracked` (letter-spaced labels), `_arrowIcon`.
`_window()` converts the 120-sample ring buffers into a fixed-width, NaN-left-padded series.

- **Noto Sans has no ↓/↑ glyphs in Cairo** — arrows are drawn with `_arrowIcon`, never text.
- No card is drawn around the panel item (the old `_card` was removed, `bgAlpha` is gone).
- Panel item widths are fixed constants per mode (`W_FULL`, `W_LOAD_MINI`, `W_NET`, `W_UP`, `W_IP`).
- Menu height is per mode (`MH = 486`, `MH_LOAD`, `MH_NET`, `MH_UP`, `MH_IP`) and scaled by `MENU_SCALE`.
- `cpumem` popup is the iStat-style one: `_barHistory` (60 vertical bars), `_coreRings`
  (small per-core rings in two rows), USED/PRESSURE rings, breakdown list, top RSS processes.
- `_dot` draws the accent dot before panel labels; `_ensureFlag` / `_drawFlag` fetch and draw
  the country flag (rounded clip, PNG cache shared with the desklet).

## Editing / reloading

```bash
# syntax check (there is no gjs binary, use cjs; ImportError about 'ui' is expected)
cjs ~/coreGlow-applet/coreglow-panel@genetzhs/applet.js

# live reload, no Cinnamon restart needed
busctl --user call org.Cinnamon /org/Cinnamon org.Cinnamon Eval s \
  "imports.ui.extension.reloadExtension('coreglow-panel@genetzhs', imports.ui.extension.Type.APPLET)"

# read live state / change a setting
busctl --user call org.Cinnamon /org/Cinnamon org.Cinnamon Eval s \
  "(function(){let a=null;Main.panelManager.panels.forEach(p=>{p._rightBox.get_children().forEach(c=>{let d=c._delegate;if(d&&d._uuid==='coreglow-panel@genetzhs'&&d.instance_id==28)a=d;});});a.settings.setValue('mode','load');return a.mode})()"
```

Gotchas already hit:

- `Applet._panelHeight` is a **getter-only** property — use `this._ph` instead (the first version crashed on it).
- `instance_id` is a **string** on applet delegates; compare with `==` or `+id`.
- Editing the settings JSON on disk does **not** update a running applet; use `settings.setValue()`
  via Eval or `reloadExtension()`.
- `cinnamon --replace` / `global.reexec_self()` clears a cached failed import; `reloadExtension()` is enough afterwards.
- `gdbus call` mis-parses JS arguments (GVariant); use `busctl --user call ... Eval s '<js>'`.
- Screenshot checks: `gnome-screenshot -f x.png` + `convert x.png -crop WxH+X+Y`. Panel is at the
  **bottom** (y=1400 on the 2560x1440 monitor), notifications at the top are unrelated.

## Possible next steps

Per-core bars in the panel item, GPU mode, Wi-Fi SSID/signal in `net`, copy-IP button,
configurable ping host and history length, top CPU processes in `cpumem`.
