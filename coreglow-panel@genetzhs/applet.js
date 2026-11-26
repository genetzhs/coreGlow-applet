// Coreglow Panel — Coreglow-style CPU & memory monitor for the Cinnamon panel.
// Visual language ported from the coreglow@genetzhs desklet (rings, glow, gradients).

const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Cairo = imports.cairo;

const UUID = "coreglow-panel@genetzhs";
const FONT = "Roboto";
const FONT_MED = "Roboto Medium";   // bold text: medium weight, tabular digits
const HIST = 120;          // seconds of history kept in the ring buffers
const W_FULL = 298;        // labels + values + sparklines
const W_MINI = 126;        // labels + values only
const W_LOAD = 152;        // load mode: label + value + sparkline
const W_LOAD_MINI = 64;    // load mode: label + value (compact)
const W_NET = 112;         // network: down over up (two rows)
const W_UP = 84;           // uptime (compact)
const W_IP = 168;          // public IP (flag + full address)
const W_TEMP = 64;         // temperature (compact)
const WX_LABEL = 10.5;      // weather place-name size
const W_WX = 112;          // weather: icon + place + temp
const MW = 300, MH = 590;  // drop-down body (CSS px)
const MH_LOAD = 368;       // drop-down body in load mode
const MH_NET = 300, MH_UP = 250, MH_IP = 240, MH_TEMP = 262, MH_WX = 380;
const MENU_SCALE = 1.2;    // drop-down zoom (window + text)
const INSTANCES = new Set();
const STYLE = "coreglow-panel-applet";
// per-mode accent: header dot, menu border glow
const MODE_ACCENT = {
    cpumem: [0, 200, 255], load: [150, 110, 255], net: [70, 215, 120], uptime: [90, 150, 255],
    ip: [40, 210, 200], temp: [255, 140, 60], weather: [255, 196, 60],
};

const DARK = {
    bgTop: [28, 24, 44], bg: [18, 20, 28], border: [255, 255, 255, 0.11],
    text: [248, 250, 255, 1], label: [196, 204, 220, 1],
    track: [255, 255, 255, 0.09], base: [255, 255, 255, 0.07], divider: [255, 255, 255, 0.07],
};
const LIGHT = {
    bgTop: [236, 238, 248], bg: [248, 249, 252], border: [0, 0, 0, 0.10],
    text: [25, 28, 38, 1], label: [72, 80, 98, 1],
    track: [0, 0, 0, 0.08], base: [0, 0, 0, 0.06], divider: [0, 0, 0, 0.06],
};
const FIXED = { ok: [40, 230, 120, 1], warn: [255, 190, 30, 1], hot: [255, 75, 85, 1], sun: [255, 196, 60, 1], rain: [80, 170, 255, 1], down: [0, 229, 255, 1], up: [255, 46, 136, 1] };
const WX_UA = "coreglow-panel/1.1";

function readFile(path) {
    try {
        let [ok, data] = GLib.file_get_contents(path);
        return ok ? imports.byteArray.toString(data) : null;
    } catch (e) { return null; }
}

function fmtBytes(b, suffix) {
    if (b === undefined || b === null || isNaN(b)) return "—";
    if (b < 0) b = 0;
    const u = ["B", "kB", "MB", "GB", "TB"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b.toFixed(0) : b.toFixed(1)) + " " + u[i] + (suffix || "");
}

function parseColor(s, fallback) {
    let m = (s || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3], 1] : fallback;
}

function rgb2hsv(c) {
    let r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    let mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

function hsv2rgb(c) {
    let [h, s, v] = c, f = n => { let k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)].map(x => Math.round(x * 255)).concat([1]);
}

function ring(n) { return { a: new Array(n).fill(NaN), i: 0, n }; }
function push(r, v) { r.a[r.i] = v; r.i = (r.i + 1) % r.n; }
function ordered(r) { return r.a.slice(r.i).concat(r.a.slice(0, r.i)); }

function stats(r) {
    let v = r.a.filter(x => !isNaN(x));
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length };
}

function readNum(path) { let s = readFile(path); return s === null ? NaN : parseFloat(s); }

function hwmonBy(pred) {
    for (let i = 0; i < 32; i++) {
        let p = `/sys/class/hwmon/hwmon${i}`, n = (readFile(p + "/name") || "").trim();
        if (n && pred(n, p)) return p;
    }
    return null;
}

const CACHE = GLib.get_user_cache_dir() + "/coreglow";
GLib.mkdir_with_parents(CACHE, 0o755);

class CoreglowPanelApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._meta = metadata;
        this._ph = panelHeight;
        this.d = { cpu: 0, threads: [], memUsed: 0, memTot: 0, memPct: 0, swapUsed: 0, swapTot: 0, cached: 0, load: "", mhz: 0, host: GLib.get_host_name(), load1: 0, load5: 0, load15: 0, uptime: "", top: [], upSec: 0, procs: 0, iface: "", lan: "", ext: "", gateway: "", dns: "", ping: "", down: 0, upl: 0, totDown: 0, totUp: 0, cpuTemp: NaN, userPct: 0, sysPct: 0, pressure: NaN, topMem: [], cc: "", fan: NaN, nvmeTemp: NaN, gpuTemp: NaN, acpiTemp: NaN, topCpu: [] };
        this.wx = null; this.wxAt = 0; this.wxKey = ""; this.sun = null; this.sunDay = "";
        this.vis = {}; this.tgt = {}; this._animId = 0;
        this.hits = []; this.killArm = null; this.killMsg = "";
        this.hGpu = ring(HIST); this.hAcpi = ring(HIST); this.hNvme = ring(HIST);
        this.hwAcpi = hwmonBy(n => n === "acpitz");
        this.hasNvidia = GLib.find_program_in_path("nvidia-smi") !== null;
        this.hCpu = ring(HIST);
        this.hMem = ring(HIST);
        this.hLoad = ring(HIST);
        this.hDown = ring(HIST);
        this.hUp = ring(HIST);
        this.hTemp = ring(HIST);
        this.prevNet = null;
        this.hwTemp = hwmonBy(n => ["coretemp", "k10temp", "zenpower"].includes(n));
        this.tempFiles = [];
        if (this.hwTemp) for (let i = 1; i < 32; i++) {
            let f = `${this.hwTemp}/temp${i}_input`;
            if (GLib.file_test(f, GLib.FileTest.EXISTS)) this.tempFiles.push(f);
        }
        this.hwFan = hwmonBy((n, p) => GLib.file_test(p + "/fan1_input", GLib.FileTest.EXISTS));
        this.hwNvme = hwmonBy(n => n === "nvme");
        this._cc = null;
        this.flag = null;
        this.prevStat = null;
        this.tick = 0;
        this.hover = false;
        this.sysDark = this._sysDark();

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        for (let k of ["mode", "interval", "theme", "accent1", "accent2", "showSpark", "showLabels", "hoverOpen", "hotAt", "wxPlace", "wxLat", "wxLon", "wxMins"])
            this.settings.bind(k, k, () => this._onSettings());

        this.canvas = new St.DrawingArea();
        this.canvas.connect("repaint", (area) => this._draw(area));
        this.actor.add_child(this.canvas);
        this.actor.add_style_class_name(STYLE);
        this.actor.set_style("padding: 0px; spacing: 0px;");
        this._closeId = 0;
        this.actor.connect("enter-event", () => this._onEnter());
        this.actor.connect("leave-event", () => this._onLeave());

        let itemMon = new PopupMenu.PopupMenuItem(_("Open System Monitor"));
        itemMon.connect("activate", () => Util.spawnCommandLine("gnome-system-monitor"));
        this._applet_context_menu.addMenuItem(itemMon);
        let itemCfg = new PopupMenu.PopupMenuItem(_("Coreglow settings…"));
        itemCfg.connect("activate", () => this.configureApplet());
        this._applet_context_menu.addMenuItem(itemCfg);
        // iStat-style drop-down: detailed CPU cores + memory breakdown
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this._menuManager.addMenu(this.menu);

        this.menuCanvas = new St.DrawingArea();
        this.menuCanvas.connect("repaint", (area) => this._drawMenu(area));
        this.menuCanvas.set_size(MW, MH);
        this.menuCanvas.reactive = true;
        this.menuCanvas.connect("button-release-event", (a, e) => this._menuClick(a, e));
        let section = new PopupMenu.PopupMenuSection();
        let itemBody = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        itemBody.addActor(this.menuCanvas, { span: 2 });
        section.addMenuItem(itemBody);
        this.menu.addMenuItem(section);
        let itemOpen = this._itemOpen = new PopupMenu.PopupMenuItem(_("Open System Monitor"));
        itemOpen.connect("activate", () => {
            if (this.mode === "weather") Util.spawnCommandLine(`xdg-open https://www.yr.no/en/forecast/daily-table/${this._wxLat()},${this._wxLon()}`);
            else Util.spawnCommandLine("gnome-system-monitor");
        });
        this.menu.addMenuItem(itemOpen);
        this.menu.connect("open-state-changed", (m, isOpen) => {
            this.canvas.queue_repaint();
            if (isOpen) this._update(true);
        });
        this.menu.actor.connect("enter-event", () => { this._cancelClose(); return false; });
        this.menu.actor.connect("leave-event", () => { this._scheduleClose(); return false; });

        this._onSettings();
        this._update(true);
        this._restartTimer();
        INSTANCES.add(this);
    }

    _restartTimer() {
        let iv = Math.max(1, Math.min(30, Math.round(this.interval || 1)));
        if (this._timer && this._iv === iv) return;
        if (this._timer) Mainloop.source_remove(this._timer);
        this._iv = iv;
        this._timer = Mainloop.timeout_add_seconds(iv, () => { this._update(); return true; });
    }

    on_applet_removed_from_panel() {
        if (this._timer) { Mainloop.source_remove(this._timer); this._timer = 0; }
        if (this._animId) { Mainloop.source_remove(this._animId); this._animId = 0; }
        this._cancelClose();
        INSTANCES.delete(this);
    }

    on_panel_height_changed() {
        if (!this.canvas) return;
        this._ph = (this.panel && this.panel.height) || this._ph;
        this._layout();
        this.canvas.queue_repaint();
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    _onEnter() {
        this.hover = true;
        this.canvas.queue_repaint();
        if (!this.hoverOpen) return;
        this._cancelClose();
        this._applet_tooltip.hide();
        if (!this.menu.isOpen) {
            for (let inst of INSTANCES)
                if (inst !== this && inst.menu && inst.menu.isOpen) inst.menu.close(true);
            this.menu.open(true);
        }
    }

    _onLeave() {
        this.hover = false;
        this.canvas.queue_repaint();
        this._scheduleClose();
    }

    _scheduleClose() {
        if (!this.hoverOpen) return;
        this._cancelClose();
        this._closeId = Mainloop.timeout_add(400, () => {
            this._closeId = 0;
            if (this._pointerInside()) return false;
            if (this.menu.isOpen) this.menu.close(true);
            return false;
        });
    }

    _pointerInside() {
        let [x, y] = global.get_pointer();
        let inside = (actor) => {
            if (!actor || !actor.visible) return false;
            let [ax, ay] = actor.get_transformed_position();
            let [w, h] = actor.get_transformed_size();
            return x >= ax && x <= ax + w && y >= ay && y <= ay + h;
        };
        return inside(this.actor) || inside(this.menu.actor);
    }

    _cancelClose() {
        if (this._closeId) { Mainloop.source_remove(this._closeId); this._closeId = 0; }
    }

    // ---------- settings / palette ----------
    _onSettings() {
        if (!this.canvas) return;
        if (this._timer) this._restartTimer();
        this._palette();
        this._layout();
        this.canvas.queue_repaint();
        if (this.menuCanvas) this.menuCanvas.queue_repaint();
        // no hover UI: details open on click only (hoverOpen is opt-in)
        this._applet_tooltip.preventShow = true;
        this._menuStyle();
        if (this._itemOpen) this._itemOpen.label.set_text(this.mode === "weather" ? _("Open forecast (yr.no)") : _("Open System Monitor"));
        if (this.mode === "weather") this._wxTick(true);
        this._tooltip();
    }

    _sysDark() {
        try {
            if (!this._portal) this._portal = new Gio.Settings({ schema_id: "org.x.apps.portal" });
            let v = this._portal.get_string("color-scheme");
            if (v === "prefer-dark") return true;
            if (v === "prefer-light") return false;
        } catch (e) { }
        try {
            if (!this._iface) this._iface = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
            return /dark/i.test(this._iface.get_string("gtk-theme"));
        } catch (e) { return true; }
    }

    _palette() {
        let dark = this.theme === "dark" || (this.theme !== "light" && this.sysDark);
        this.C = Object.assign({}, dark ? DARK : LIGHT, FIXED, {
            a1: parseColor(this.accent1, [0, 200, 255, 1]),
            a2: parseColor(this.accent2, [150, 90, 255, 1]),
        });
        let C = this.C;
        this._labelHex = "#" + [C.label[0], C.label[1], C.label[2]].map(n => n.toString(16).padStart(2, "0")).join("");
    }

    _layout() {
        let ph = (this.panel && this.panel.height) || this._ph || 40;
        let H = Math.max(22, ph);
        let loadMode = this.mode === "load";
        let W = loadMode ? W_LOAD_MINI
            : this.mode === "net" ? W_NET
            : this.mode === "uptime" ? W_UP
            : this.mode === "ip" ? W_IP
            : this.mode === "temp" ? W_TEMP
            : this.mode === "weather" ? W_WX
            : (this.showSpark ? W_FULL : W_MINI);
        this.canvas.set_size(W, H);
        let mh = { load: MH_LOAD, net: MH_NET, uptime: MH_UP, ip: MH_IP, temp: MH_TEMP, weather: MH_WX }[this.mode] || MH;
        if (this.menuCanvas) this.menuCanvas.set_size(
            Math.round(MW * MENU_SCALE),
            Math.round(mh * MENU_SCALE));

        let inset = H >= 34 ? 3 : 2;
        let ch = H - inset * 2;
        let g = {
            W, H, inset, ch,
            labels: !!this.showLabels,
            labelY: inset + 10,
            valueY: inset + ch - 4,
            sparkY: inset + 5,
            sparkH: ch - 10,
        };
        if (loadMode) {
            if (this.showSpark) { g.sparkX = 64; g.sparkW = 76; }
        } else if (this.showSpark) {
            g.cpuX = 12;
            g.cpuSparkX = 52;
            g.sparkW = 90;
            g.divX = 148;
            g.ramX = 156;
            g.ramSparkX = 196;
        } else {
            g.cpuX = 12;
            g.divX = 64;
            g.ramX = 78;
        }
        this.geo = g;
    }

    // ---------- data ----------
    _update(first) {
        let d = this.d, t = ++this.tick, m = this.mode, open = !!(this.menu && this.menu.isOpen);
        // Only collect what this instance shows; expensive extras only while the drop-down is open.
        let needCpu = m === "cpumem" || m === "load" || (m === "uptime" && open);
        let needMem = m === "cpumem" || (m === "uptime" && open);
        let needLoad = m === "load" || m === "uptime";
        let needTemp = m === "temp" || (m === "cpumem" && open);

        if (needCpu) {
            let stat = (readFile("/proc/stat") || "").split("\n").filter(l => /^cpu\d* /.test(l))
                .map(l => {
                    let v = l.trim().split(/\s+/).slice(1).map(Number);
                    return [v.reduce((a, b) => a + b, 0), v[3] + (v[4] || 0), v[0] + v[1], v[2] + (v[5] || 0) + (v[6] || 0)];
                });
            if (this.prevStat && this.prevStat.length === stat.length) {
                let pct = stat.map((s, i) => {
                    let dt = s[0] - this.prevStat[i][0], di = s[1] - this.prevStat[i][1];
                    return dt > 0 ? 100 * (dt - di) / dt : 0;
                });
                d.cpu = pct[0];
                d.threads = pct.slice(1);
                let dt = stat[0][0] - this.prevStat[0][0];
                if (dt > 0) {
                    d.userPct = 100 * (stat[0][2] - this.prevStat[0][2]) / dt;
                    d.sysPct = 100 * (stat[0][3] - this.prevStat[0][3]) / dt;
                }
                push(this.hCpu, d.cpu);
            }
            this.prevStat = stat;
        }
        if (!d.threads.length && needLoad) d.threads = new Array(GLib.get_num_processors()).fill(0);

        if (needMem) {
            let mi = {};
            (readFile("/proc/meminfo") || "").split("\n").forEach(l => { let mm = l.match(/^(\w+):\s+(\d+)/); if (mm) mi[mm[1]] = +mm[2] * 1024; });
            d.memTot = mi.MemTotal || 0;
            d.memUsed = d.memTot - (mi.MemAvailable || d.memTot);
            d.memPct = d.memTot ? 100 * d.memUsed / d.memTot : 0;
            d.swapTot = mi.SwapTotal || 0;
            d.swapUsed = d.swapTot - (mi.SwapFree || 0);
            d.cached = (mi.Cached || 0) + (mi.SReclaimable || 0);
            push(this.hMem, d.memPct);
        }

        if (needLoad || m === "cpumem") {
            let la = (readFile("/proc/loadavg") || "").trim().split(/\s+/);
            if (la.length >= 3) { d.load1 = +la[0] || 0; d.load5 = +la[1] || 0; d.load15 = +la[2] || 0; d.load = la[0]; }
        }

        if (needTemp && this.tempFiles.length) {
            let max = NaN;
            for (let f of this.tempFiles) { let v = readNum(f); if (!isNaN(v) && !(v <= max)) max = v; }
            d.cpuTemp = max / 1000;
            if (!isNaN(d.cpuTemp)) push(this.hTemp, d.cpuTemp);
        }
        if (m === "temp" && open) this._tempSensors(t);

        if (m === "uptime" || m === "load") { let up = readNum("/proc/uptime"); if (!isNaN(up)) d.upSec = up; }
        if (m === "net" || m === "ip") this._netTick(t, open);
        if (m === "weather") { this._wxTick(false); this._rainNotify(); }

        if (open && (first || t % 5 === 0)) {
            if (m === "cpumem" || m === "temp") {
                let mh = (readFile("/proc/cpuinfo") || "").match(/cpu MHz\s*:\s*[\d.]+/g) || [];
                d.mhz = mh.reduce((a, s) => Math.max(a, parseFloat(s.split(":")[1])), 0);
                d.fan = this.hwFan ? readNum(this.hwFan + "/fan1_input") : NaN;
                let pm = (readFile("/proc/pressure/memory") || "").match(/some avg10=([\d.]+)/);
                d.pressure = pm ? parseFloat(pm[1]) : NaN;
            }
            if (m === "uptime" || m === "load")
                this._sh("ls -d /proc/[0-9]* 2>/dev/null | wc -l", (o) => { d.procs = +o || 0; });
            if (m === "cpumem")
                this._sh("ps -eo comm=,rss= --sort=-rss | head -4", (out) => {
                    d.topMem = out.split("\n").filter(l => l).map(l => { let p = l.trim().split(/\s+/); return [p[0], (+p[1] || 0) * 1024]; });
                });
            if ((m === "cpumem" || m === "load") && !this._topBusy) {
                this._topBusy = true;
                this._sh("ps -eo pid=,pcpu=,comm= --sort=-pcpu | head -5", (out) => {
                    this._topBusy = false;
                    let rows = out.split("\n").filter(l => l).map(l => { let p = l.trim().split(/\s+/); return { pid: parseInt(p[0]) || 0, cpu: parseFloat(p[1]) || 0, name: p.slice(2).join(" ") }; }).filter(p => p.pid > 0);
                    d.topCpu = rows;
                    d.top = rows.slice(0, 4).map(p => [p.name, p.cpu]);
                });
            }
        }
        if (t % 30 === 0) {
            let dark = this._sysDark();
            if (dark !== this.sysDark) { this.sysDark = dark; this._palette(); this._sig = null; this._menuStyle(); }
        }

        this._animate();
        if (open && this.menuCanvas) this.menuCanvas.queue_repaint();
        if (first || t % 5 === 0) this._tooltip();
    }

    // ---------- data helpers ----------
    _sh(script, cb) {
        try { Util.spawn_async(["bash", "-c", script], (out) => { try { cb(out.trim()); } catch (e) { } }); }
        catch (e) { }
    }

    _netTick(t, open) {
        let d = this.d;
        if (t === 1 || t % 10 === 0) {
            // physical default route for traffic; `ip route get` follows policy routing (WireGuard/Tailscale)
            this._sh("dev=$(ip -4 route show default | sort -t' ' -k9 -n | head -1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); " +
                "echo \"$dev\"; ip -4 -o addr show dev \"$dev\" | awk '{print $4}' | cut -d/ -f1 | head -1; " +
                "ip -4 route show default | awk 'NR==1{print $3}'; awk '/^nameserver/{print $2; exit}' /etc/resolv.conf; " +
                "ip -4 route get 1.1.1.1 2>/dev/null | head -1",
                (out) => {
                    let [iface, lan, gw, dns, rt] = out.split("\n");
                    if (iface !== d.iface) this.prevNet = null;
                    d.iface = iface || ""; d.lan = lan || ""; d.gateway = gw || ""; d.dns = dns || "";
                    let mm = (rt || "").match(/ dev (\S+).*? src (\S+)/);
                    let route = mm ? mm[1] + " " + mm[2] : "";
                    d.vpn = mm && mm[1] !== d.iface ? mm[1] : "";
                    if (route !== this._route) {          // VPN up/down or network change → new public IP
                        this._route = route;
                        this._extAt = 0;
                    }
                });
        }
        if (d.iface) {
            let rx = readNum(`/sys/class/net/${d.iface}/statistics/rx_bytes`), tx = readNum(`/sys/class/net/${d.iface}/statistics/tx_bytes`);
            if (!isNaN(rx) && !isNaN(tx)) {
                let now = GLib.get_monotonic_time() / 1e6;
                if (this.prevNet) {
                    let dt = Math.max(0.5, now - this.prevNet[2]);
                    d.down = Math.max(0, rx - this.prevNet[0]) / dt; d.upl = Math.max(0, tx - this.prevNet[1]) / dt;
                }
                this.prevNet = [rx, tx, now];
                d.totDown = rx; d.totUp = tx;
                push(this.hDown, d.down); push(this.hUp, d.upl);
            }
        }
        if (open && t % 5 === 0)
            this._sh("ping -c1 -W2 1.1.1.1 2>/dev/null | sed -n 's/.*time=\\([0-9.]*\\).*/\\1/p'",
                (out) => { d.ping = out ? Math.round(parseFloat(out)) + " ms" : "—"; });
        let now = Date.now();
        if (!this._extBusy && (!this._extAt || now - this._extAt > 300000)) {
            this._extBusy = true;
            this._extAt = now;
            this._sh("curl -s -m 8 https://ipinfo.io/json", (out) => {
                this._extBusy = false;
                try {
                    let j = JSON.parse(out);
                    if (j.ip) d.ext = j.ip;
                    let cc = (j.country || "").toLowerCase();
                    if (cc) this._ensureFlag(cc);
                    this.canvas.queue_repaint();
                } catch (e) { this._extAt = now - 300000 + 30000; }   // retry in 30 s
            });
        }
    }

    // ---------- panel values ----------
    _animate() {
        // no easing: panel shows values as sampled (smooth transitions were rejected)
        let d = this.d;
        this.vis = { cpu: d.cpu, mem: d.memPct, load1: d.load1, temp: d.cpuTemp, down: d.down, upl: d.upl };
        // repaint only when what the panel shows changed (cpumem sparklines move every tick)
        let w = this.wx, sig = this.mode === "cpumem" ? Math.random() : [this.mode, (d.load1 || 0).toFixed(2), Math.round(d.cpuTemp),
            this._upShort(), fmtBytes(d.down), fmtBytes(d.upl), d.ext, !!this.flag, w ? Math.round(w.t) + w.sym : "", this._rainIn()].join("|");
        if (sig === this._sig) return;
        this._sig = sig;
        this.canvas.queue_repaint();
    }
    _v(k, fallback) { let v = this.vis[k]; return v === undefined || isNaN(v) ? fallback : v; }

    // ---------- glass drop-down ----------
    _menuStyle() {
        // same dark navy gradient as the Coreglow desklet (DARK.bgTop -> DARK.bg); light theme keeps the theme's popup
        if (!this.menu || !this.menu.box) return;
        if (this.C.text[0] <= 128) { this.menu.box.set_style(null); return; }
        let t = DARK.bgTop, b = DARK.bg;
        this.menu.box.set_style(
            `background-color: rgb(${b.join(",")});` +
            `background-gradient-direction: vertical; background-gradient-start: rgb(${t.join(",")}); background-gradient-end: rgb(${b.join(",")});` +
            `border: none; border-radius: 12px;`);
    }
    _accent() { let a = MODE_ACCENT[this.mode] || MODE_ACCENT.cpumem; return [a[0], a[1], a[2], 1]; }

    // ---------- clickable regions in the drop-down ----------
    _menuClick(actor, event) {
        let [ex, ey] = event.get_coords(), [ax, ay] = actor.get_transformed_position();
        let x = (ex - ax) / MENU_SCALE, y = (ey - ay) / MENU_SCALE;
        for (let h of this.hits)
            if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { h.fn(); this.menuCanvas.queue_repaint(); return true; }
        return false;
    }

    _kill(p) {
        let now = Date.now();
        // two-step: first click arms, second click within 3 s sends SIGTERM
        if (!this.killArm || this.killArm.pid !== p.pid || now - this.killArm.at > 3000) {
            this.killArm = { pid: p.pid, at: now };
            Mainloop.timeout_add(3100, () => { if (this.menuCanvas) this.menuCanvas.queue_repaint(); return false; });
            return;
        }
        this.killArm = null;
        let pid = parseInt(p.pid);
        if (!(pid > 1)) return;
        this._sh(`kill -TERM ${pid} 2>/dev/null && echo ok || echo fail`, (o) => {
            this.killMsg = (o === "ok" ? "sent SIGTERM to " : "not permitted: ") + p.name;
            this.d.topCpu = this.d.topCpu.filter(q => o !== "ok" || q.pid !== pid);
            Mainloop.timeout_add_seconds(4, () => { this.killMsg = ""; return false; });
        });
    }

    // ---------- extra temperature sensors ----------
    _tempSensors(t) {
        let d = this.d;
        if (this.hwAcpi) { d.acpiTemp = readNum(this.hwAcpi + "/temp1_input") / 1000; if (!isNaN(d.acpiTemp)) push(this.hAcpi, d.acpiTemp); }
        if (this.hwNvme) { let v = readNum(this.hwNvme + "/temp1_input") / 1000; if (!isNaN(v)) { d.nvmeTemp = v; push(this.hNvme, v); } }
        if (this.hasNvidia && (t === 1 || t % 3 === 0))
            this._sh("nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits | head -1", (o) => { let v = parseFloat(o); if (!isNaN(v)) d.gpuTemp = v; });
        if (!isNaN(d.gpuTemp)) push(this.hGpu, d.gpuTemp);
    }

    // ---------- weather (MET Norway locationforecast) ----------
    _wxLat() { let v = parseFloat(this.wxLat); return isNaN(v) ? 35.2681 : +v.toFixed(4); }
    _wxLon() { let v = parseFloat(this.wxLon); return isNaN(v) ? 25.1818 : +v.toFixed(4); }

    _wxTick(force) {
        let key = this._wxLat() + "," + this._wxLon(), now = Date.now();
        let period = Math.max(10, this.wxMins || 30) * 60000;
        if (key !== this.wxKey) { this.wxKey = key; this.wxAt = 0; this.wx = null; }
        if (this._wxBusy || (this.wxAt && now - this.wxAt < period && !(force && !this.wx))) return;
        this._wxBusy = true;
        this.wxAt = now;
        let url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${this._wxLat()}&lon=${this._wxLon()}`;
        this._sh(`curl -s -m 12 -A '${WX_UA}' '${url}'`, (out) => {
            this._wxBusy = false;
            try { this.wx = this._parseWx(JSON.parse(out)); this._sunTick(); }
            catch (e) { this.wxAt = now - period + 120000; }   // retry in 2 min
            this.canvas.queue_repaint();
            if (this.menuCanvas) this.menuCanvas.queue_repaint();
        });
        // _sh swallows spawn errors; never stay busy forever
        Mainloop.timeout_add_seconds(20, () => { this._wxBusy = false; return false; });
    }

    _parseWx(j) {
        let ts = j.properties.timeseries;
        let at = s => GLib.DateTime.new_from_iso8601(s, null).to_local();
        let nowU = GLib.DateTime.new_now_utc().to_unix();
        let i0 = 0;
        while (i0 + 1 < ts.length && at(ts[i0 + 1].time).to_unix() <= nowU) i0++;
        let sym = e => {
            let dd = e.data;
            let n = dd.next_1_hours || dd.next_6_hours || dd.next_12_hours;
            return n && n.summary ? n.summary.symbol_code : "cloudy";
        };
        let cur = ts[i0], det = cur.data.instant.details;
        let hours = [];
        for (let i = i0 + 1; i < ts.length && hours.length < 6; i++) {
            let dt = at(ts[i].time), n1 = ts[i].data.next_1_hours;
            if (!n1) break;
            hours.push({ h: dt.get_hour(), t: ts[i].data.instant.details.air_temperature, sym: sym(ts[i]), mm: n1.details ? n1.details.precipitation_amount || 0 : 0 });
        }
        let days = [], byDay = {};
        for (let i = i0; i < ts.length; i++) {
            let dt = at(ts[i].time), k = dt.format("%Y-%m-%d");
            if (!byDay[k]) { if (days.length >= 4) break; byDay[k] = { dt, min: 1e9, max: -1e9, sym: null, symDist: 99, mm: 0 }; days.push(byDay[k]); }
            let D = byDay[k], t = ts[i].data.instant.details.air_temperature, h = dt.get_hour();
            D.min = Math.min(D.min, t); D.max = Math.max(D.max, t);
            let dd = Math.abs(h - 13);
            if (dd < D.symDist) { D.symDist = dd; D.sym = sym(ts[i]); }
            let n1 = ts[i].data.next_1_hours, n6 = ts[i].data.next_6_hours;
            if (n1 && n1.details) D.mm += n1.details.precipitation_amount || 0;
            else if (n6 && n6.details && h % 6 === 0) D.mm += n6.details.precipitation_amount || 0;
        }
        let n1 = cur.data.next_1_hours;
        // first rainy hour in the next 12 h
        let rainAt = null, rainMm = 0;
        for (let i = i0; i < ts.length && i < i0 + 13; i++) {
            let r = ts[i].data.next_1_hours;
            if (r && r.details && (r.details.precipitation_amount || 0) >= 0.2) { rainAt = at(ts[i].time); rainMm = r.details.precipitation_amount; break; }
        }
        let today = at(cur.time).format("%Y-%m-%d"), uvMax = 0;
        for (let i = i0; i < ts.length; i++) {
            let dt = at(ts[i].time);
            if (dt.format("%Y-%m-%d") !== today) break;
            uvMax = Math.max(uvMax, ts[i].data.instant.details.ultraviolet_index_clear_sky || 0);
        }
        let feels = det.apparent_air_temperature;
        if (feels === undefined) {
            let e = det.relative_humidity / 100 * 6.105 * Math.exp(17.27 * det.air_temperature / (237.7 + det.air_temperature));
            feels = det.air_temperature + 0.33 * e - 0.70 * (det.wind_speed || 0) - 4.0;
        }
        return {
            feels, uv: det.ultraviolet_index_clear_sky || 0, uvMax, rainAt, rainMm,
            t: det.air_temperature, hum: det.relative_humidity, wind: (det.wind_speed || 0) * 3.6,
            dir: det.wind_from_direction, pres: det.air_pressure_at_sea_level, sym: sym(cur),
            mm: n1 && n1.details ? n1.details.precipitation_amount || 0 : 0,
            hours, days: days.slice(0, 3), at: GLib.DateTime.new_now_local().format("%H:%M"),
        };
    }

    _sunTick() {
        let now = GLib.DateTime.new_now_local(), day = now.format("%Y-%m-%d");
        if (this.sunDay === day && this.sun) return;
        this.sunDay = day;
        let url = `https://api.met.no/weatherapi/sunrise/3.0/sun?lat=${this._wxLat()}&lon=${this._wxLon()}&date=${day}&offset=${now.format("%:z")}`;
        this._sh(`curl -s -m 12 -A '${WX_UA}' '${url}'`, (out) => {
            try {
                let p = JSON.parse(out).properties, hm = s => (s || "").slice(11, 16);
                this.sun = { rise: hm(p.sunrise && p.sunrise.time), set: hm(p.sunset && p.sunset.time) };
            } catch (e) { this.sunDay = ""; }
        });
    }

    _rainIn() {
        let w = this.wx;
        if (!w || !w.rainAt) return null;
        return Math.round((w.rainAt.to_unix() - GLib.DateTime.new_now_utc().to_unix()) / 60);
    }

    _rainText() {
        let w = this.wx, m = this._rainIn();
        if (m === null) return "No rain expected in the next 12 h";
        if (m <= 0) return `Raining now · ${w.rainMm.toFixed(1)} mm/h`;
        let when = m < 60 ? `in ${m}′` : `in ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}′`;
        return `Rain ${when} · ${w.rainAt.format("%H:%M")} · ${w.rainMm.toFixed(1)} mm`;
    }

    _rainNotify() {
        let w = this.wx, m = this._rainIn();
        if (m === null || m > 60 || m < -5) return;
        let key = w.rainAt.format("%Y%m%d%H");
        if (this._rainKey === key) return;
        this._rainKey = key;
        let place = (this.wxPlace || "").replace(/['"\\$`]/g, "");
        Util.spawn(["notify-send", "-i", "weather-showers", "-a", "Coreglow",
            m <= 0 ? "Rain now" : `Rain in ~${m} min`, `${w.rainMm.toFixed(1)} mm expected at ${w.rainAt.format("%H:%M")}${place ? " · " + place : ""}`]);
    }

    _uvColor(u) {
        return u >= 8 ? this.C.hot : u >= 6 ? [255, 120, 50, 1] : u >= 3 ? this.C.sun : this.C.ok;
    }

    _wxDesc(sym) {
        let b = (sym || "").replace(/_(day|night|polartwilight)$/, "");
        const M = {
            clearsky: "Clear", fair: "Fair", partlycloudy: "Partly cloudy", cloudy: "Cloudy", fog: "Fog",
            lightrain: "Light rain", rain: "Rain", heavyrain: "Heavy rain",
            lightrainshowers: "Light showers", rainshowers: "Showers", heavyrainshowers: "Heavy showers",
            lightsleet: "Light sleet", sleet: "Sleet", heavysleet: "Heavy sleet",
            lightsnow: "Light snow", snow: "Snow", heavysnow: "Heavy snow",
        };
        if (M[b]) return M[b];
        let s = b.replace(/andthunder/, " + thunder").replace(/showers/, " showers").replace(/^light/, "light ").replace(/^heavy/, "heavy ");
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    _compass(deg) {
        if (deg === undefined || isNaN(deg)) return "";
        return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
    }

    // Vector weather icon in a box of width s centred on (cx, cy).
    _wxIcon(cr, cx, cy, s, sym) {
        let C = this.C, b = sym || "cloudy";
        let night = /_night$/.test(b), base = b.replace(/_(day|night|polartwilight)$/, "");
        let thunder = /thunder/.test(base), snow = /snow/.test(base), sleet = /sleet/.test(base);
        let rain = /rain/.test(base) && !sleet, showers = /showers/.test(base);
        let heavy = /^heavy/.test(base), light = /^light/.test(base);
        let precip = rain || snow || sleet || thunder;
        let celestial = base === "clearsky" || base === "fair" || base === "partlycloudy" || showers;
        let dark = C.text[0] > 128;
        let cloudCol = thunder ? (dark ? [150, 158, 178, 1] : [110, 118, 135, 1]) : (dark ? [214, 222, 236, 1] : [160, 170, 188, 1]);

        let sun = (x, y, r) => {
            if (night) {
                cr.save();
                cr.newPath();
                cr.rectangle(x - 3 * r, y - 3 * r, 6 * r, 6 * r);
                cr.arc(x + r * 0.55, y - r * 0.35, r * 0.85, 0, 2 * Math.PI);
                cr.setFillRule(Cairo.FillRule.EVEN_ODD);
                cr.clip();
                this._col(cr, [235, 225, 190, 1]);
                cr.newPath(); cr.arc(x, y, r, 0, 2 * Math.PI); cr.fill();
                cr.restore();
                return;
            }
            this._col(cr, C.sun, 0.18);
            cr.newPath(); cr.arc(x, y, r * 1.55, 0, 2 * Math.PI); cr.fill();
            this._col(cr, C.sun);
            cr.newPath(); cr.arc(x, y, r, 0, 2 * Math.PI); cr.fill();
            cr.setLineWidth(Math.max(1, r * 0.22)); cr.setLineCap(Cairo.LineCap.ROUND);
            for (let k = 0; k < 8; k++) {
                let a = k * Math.PI / 4;
                cr.newPath();
                cr.moveTo(x + Math.cos(a) * r * 1.35, y + Math.sin(a) * r * 1.35);
                cr.lineTo(x + Math.cos(a) * r * 1.75, y + Math.sin(a) * r * 1.75);
                cr.stroke();
            }
        };
        let cloud = (x, y, w, col) => {      // (x, y) = centre of the cloud base line
            let h = w * 0.34;
            this._col(cr, col);
            cr.newPath(); this._rrect(cr, x - w / 2, y - h, w, h, h / 2); cr.fill();
            cr.newPath(); cr.arc(x - w * 0.18, y - h * 0.95, w * 0.21, 0, 2 * Math.PI); cr.fill();
            cr.newPath(); cr.arc(x + w * 0.10, y - h * 1.15, w * 0.27, 0, 2 * Math.PI); cr.fill();
        };

        if (base === "clearsky") { sun(cx, cy, s * 0.24); return; }
        if (base === "fog") {
            cloud(cx, cy - s * 0.02, s * 0.86, cloudCol);
            this._col(cr, C.label); cr.setLineWidth(Math.max(1.2, s * 0.07)); cr.setLineCap(Cairo.LineCap.ROUND);
            [0.14, 0.28].forEach((dy, i) => { cr.newPath(); cr.moveTo(cx - s * (0.38 - i * 0.08), cy + s * dy); cr.lineTo(cx + s * (0.34 + i * 0.04), cy + s * dy); cr.stroke(); });
            return;
        }
        let cyc = precip ? cy + s * 0.04 : cy + s * 0.2;
        if (celestial) {
            let r = base === "fair" ? s * 0.2 : s * 0.16;
            sun(cx - s * 0.17, cyc - s * 0.36, r);
        }
        let cw = base === "fair" ? s * 0.62 : s * 0.86;
        cloud(base === "fair" ? cx + s * 0.12 : cx, cyc, cw, cloudCol);
        if (!precip) return;

        let n = heavy ? 4 : light ? 2 : 3, y0 = cyc + s * 0.1, len = s * 0.2;
        let span = s * 0.5, x0 = cx - span / 2;
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (let k = 0; k < n; k++) {
            let x = x0 + (n === 1 ? span / 2 : k * span / (n - 1));
            let flake = snow || (sleet && k % 2);
            if (flake) {
                this._col(cr, dark ? [235, 242, 255, 1] : [120, 160, 220, 1]);
                cr.newPath(); cr.arc(x, y0 + len * 0.55, Math.max(1.1, s * 0.05), 0, 2 * Math.PI); cr.fill();
            } else if (rain || sleet) {
                this._col(cr, C.rain); cr.setLineWidth(Math.max(1.2, s * 0.065));
                cr.newPath(); cr.moveTo(x + len * 0.25, y0); cr.lineTo(x - len * 0.15, y0 + len); cr.stroke();
            }
        }
        if (thunder) {
            let bx = cx + s * 0.04, by = cyc + s * 0.04, u = s * 0.11;
            this._col(cr, C.sun);
            cr.newPath();
            cr.moveTo(bx + u * 0.4, by); cr.lineTo(bx - u * 0.7, by + u * 1.6); cr.lineTo(bx, by + u * 1.6);
            cr.lineTo(bx - u * 0.5, by + u * 3.0); cr.lineTo(bx + u * 1.0, by + u * 1.1); cr.lineTo(bx + u * 0.2, by + u * 1.1);
            cr.lineTo(bx + u * 0.9, by); cr.closePath(); cr.fill();
        }
    }

    _tempHue(t) {
        // cold → blue, mild → teal/green, warm → amber, hot → red
        if (isNaN(t)) return this.C.label;
        if (t < 5) return [110, 170, 255, 1];
        if (t < 15) return [90, 210, 220, 1];
        if (t < 25) return [120, 215, 140, 1];
        if (t < 32) return this.C.sun;
        return this.C.hot;
    }

    _wxBody(cr) {
        let C = this.C, w = this.wx, pad = 12, right = MW - 12;
        this._header(cr, pad, right);
        this._tracked(cr, "WEATHER", pad, 44, 9.2, C.label, 0.7, "l");
        this._text(cr, this._fit(cr, this.wxPlace || "—", 170, 9.5, true), right, 44, "r", C.label, 9.5, true);
        if (!w) { this._text(cr, "loading forecast…", pad, 80, "l", C.label, 11); return; }

        this._wxIcon(cr, 46, 82, 62, w.sym);
        this._text(cr, Math.round(w.t) + "°", 92, 92, "l", C.text, 36, true);
        this._text(cr, this._fit(cr, this._wxDesc(w.sym), 120, 12, true), 92, 112, "l", this._tempHue(w.t), 12, true);
        if (w.days.length) {
            let d0 = w.days[0];
            this._text(cr, `H ${Math.round(d0.max)}°   L ${Math.round(d0.min)}°`, right, 68, "r", C.label, 10.5);
        }
        if (this.sun) {
            let x = right - this._text(cr, this.sun.set, right, 88, "r", C.text, 10.5, true);
            x -= this._arrowIconW(10) + 2; this._arrowIcon(cr, x, 87, false, [255, 140, 60, 1], 10);
            x -= 8 + this._textW(cr, this.sun.rise, 10.5, true);
            this._text(cr, this.sun.rise, x, 88, "l", C.text, 10.5, true);
            x -= this._arrowIconW(10) + 2; this._arrowIcon(cr, x, 87, true, C.sun, 10);
        }
        // rain alert line
        let m = this._rainIn(), soon = m !== null && m <= 120;
        if (m !== null) this._drop(cr, pad + 3, 130, 4.5, C.rain);
        this._text(cr, this._rainText(), m !== null ? pad + 12 : pad, 134, "l", soon ? C.rain : C.label, 10.5, soon);

        let cols = [["FEELS", Math.round(w.feels) + "°", C.text], ["HUMIDITY", Math.round(w.hum) + "%", C.text],
            ["WIND", Math.round(w.wind) + " " + this._compass(w.dir), C.text], ["UV MAX", w.uvMax.toFixed(1), this._uvColor(w.uvMax)]];
        let cwid = (right - pad) / 4;
        cols.forEach((c, i) => {
            let x = pad + i * cwid;
            this._text(cr, c[0], x, 156, "l", C.label, 8, true);
            this._text(cr, c[1], x, 172, "l", c[2], 11.5, true);
        });
        this._dividerLine(cr, pad, right, 186);

        // next hours
        this._tracked(cr, "NEXT HOURS", pad, 204, 9.2, C.label, 0.7, "l");
        this._text(cr, Math.round(w.pres) + " hPa", right, 204, "r", C.label, 9);
        let hn = w.hours.length, hstep = (right - pad) / Math.max(1, hn);
        w.hours.forEach((h, i) => {
            let x = pad + hstep * (i + 0.5);
            this._text(cr, String(h.h).padStart(2, "0"), x, 222, "c", C.label, 9.5);
            this._wxIcon(cr, x, 240, 24, h.sym);
            this._text(cr, Math.round(h.t) + "°", x, 268, "c", C.text, 11.5, true);
            if (h.mm >= 0.1) this._text(cr, h.mm.toFixed(1), x, 280, "c", C.rain, 8.5, true);
        });
        this._dividerLine(cr, pad, right, 288);

        // daily range bars
        this._tracked(cr, "FORECAST", pad, 306, 9.2, C.label, 0.7, "l");
        this._text(cr, "MET Norway · " + w.at, right, 306, "r", C.label, 9);
        let lo = Math.min(...w.days.map(d => d.min)), hi = Math.max(...w.days.map(d => d.max));
        let bx0 = 150, bx1 = right - 30, span = Math.max(1, hi - lo);
        w.days.forEach((d, i) => {
            let y = 328 + i * 20;
            this._text(cr, i === 0 ? "Today" : d.dt.format("%a"), pad, y, "l", C.text, 11, !i);
            this._wxIcon(cr, 66, y - 4, 16, d.sym);
            if (d.mm >= 0.1) this._text(cr, d.mm.toFixed(1) + " mm", 84, y, "l", C.rain, 9, true);
            this._text(cr, Math.round(d.min) + "°", bx0 - 6, y, "r", C.label, 10.5);
            cr.newPath(); this._rrect(cr, bx0, y - 6, bx1 - bx0, 5, 2.5); this._col(cr, C.track); cr.fill();
            let xa = bx0 + (d.min - lo) / span * (bx1 - bx0), xb = bx0 + (d.max - lo) / span * (bx1 - bx0);
            if (xb - xa < 5) xb = xa + 5;
            cr.newPath(); this._rrect(cr, xa, y - 6, xb - xa, 5, 2.5);
            cr.setSource(this._gradX(xa, xb, this._tempHue(d.min), this._tempHue(d.max))); cr.fill();
            this._text(cr, Math.round(d.max) + "°", right, y, "r", C.text, 10.5, true);
        });
    }

    _drop(cr, x, y, r, col) {
        this._col(cr, col);
        cr.newPath();
        cr.moveTo(x, y - r * 2.1);
        cr.curveTo(x + r * 0.4, y - r * 1.2, x + r, y - r * 0.6, x + r, y);
        cr.arc(x, y, r, 0, Math.PI);
        cr.curveTo(x - r, y - r * 0.6, x - r * 0.4, y - r * 1.2, x, y - r * 2.1);
        cr.closePath(); cr.fill();
    }

    _textW(cr, s, size, bold) { this._font(cr, size, bold); return cr.textExtents(s).xAdvance; }
    _arrowIconW(size) { return size * 0.55 + size * 0.35; }

    _metricWx(cr, g) {
        let C = this.C, w = this.wx, H = g.H;
        let s = Math.min(26, H - 8);
        this._wxIcon(cr, 4 + s / 2, H / 2, s, w ? w.sym : "cloudy");
        let m = this._rainIn();
        if (m !== null && m <= 120) this._drop(cr, 4 + s - 2, H - 7, 3, C.rain);   // rain soon badge
        let x = 10 + s;
        let place = this._upper(this.wxPlace || "WEATHER");
        let lw = 0;                                          // same metrics as _plabel (bold, +0.6 tracking)
        if (g.labels) {
            cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(WX_LABEL);
            for (let ch of place) lw += cr.textExtents(ch).xAdvance + 0.6;
        }
        lw = Math.min(lw, 120);
        let temp = w ? Math.round(w.t) + "°" : "—";
        let tw = this._textW(cr, temp, 14, true);
        let colW = Math.max(lw, tw);
        this._fitW(Math.ceil(x + colW + 11));               // right pad → ~25px gap to the next item
        if (g.labels) this._plabel(cr, this._fit(cr, place, g.W - x - 4, WX_LABEL, true), x, g.labelY, WX_LABEL);
        this._text(cr, temp, x, g.valueY, "l", w ? C.text : C.label, 14, true);
    }

    _tooltip() {
        let d = this.d, C = this.C, hex = this._labelHex;
        if (this.mode === "weather") {
            let w = this.wx;
            this.set_applet_tooltip(w ? `<b>${this.wxPlace || ""}</b>  ${Math.round(w.t)}°  ${this._wxDesc(w.sym)}` : "Weather: loading…", true);
            return;
        }
        if (this.mode === "temp") {
            let t = d.cpuTemp, st = stats(this.hTemp);
            this.set_applet_tooltip(`<b>CPU temp</b>  ${isNaN(t) ? "—" : Math.round(t) + "°"}` +
                (st ? `\nmin ${Math.round(st.min)}° · avg ${Math.round(st.avg)}° · max ${Math.round(st.max)}°` : ""), true);
            return;
        }
        if (this.mode === "net") {
            this.set_applet_tooltip(`<b>↓</b> ${fmtBytes(d.down, "/s")}   <b>↑</b> ${fmtBytes(d.upl, "/s")}\n` +
                `${d.iface || "—"} · ${d.lan || "—"} · ${d.ping || "—"}`, true);
            return;
        }
        if (this.mode === "uptime") {
            this.set_applet_tooltip(`<b>Uptime</b>  ${this._upLong()}\n` +
                `<b>Load</b>  ${d.load1.toFixed(2)} · ${d.load5.toFixed(2)} · ${d.load15.toFixed(2)}   <span foreground="${hex}" size="small">1 / 5 / 15 min</span>`, true);
            return;
        }
        if (this.mode === "ip") {
            this.set_applet_tooltip(`<b>Public</b>  ${d.ext || "—"}\n<b>LAN</b>  ${d.lan || "—"}  ·  ${d.iface || "—"}`, true);
            return;
        }
        if (this.mode === "load") {
            this.set_applet_tooltip(
                `<b>Load</b>  ${d.load1.toFixed(2)} · ${d.load5.toFixed(2)} · ${d.load15.toFixed(2)}   <span foreground="${hex}" size="small">1 / 5 / 15 min</span>\n` +
                `<b>CPU</b>  ${Math.round(d.cpu)}%  ·  ${d.threads.length} threads${d.uptime ? "  ·  UP " + d.uptime : ""}`, true);
            return;
        }
        let lines = [];
        let ghz = d.mhz ? "  ·  " + (d.mhz / 1000).toFixed(2) + " GHz" : "";
        let load = d.load ? "  ·  load " + d.load : "";
        lines.push(`<b>CPU</b>  ${Math.round(d.cpu)}%${ghz}${load}`);
        if (d.threads.length) {
            let c = d.threads.map(v => String(Math.round(v)));
            let half = Math.ceil(c.length / 2);
            lines.push(`<span foreground="${hex}" size="small">cores</span>  ${c.slice(0, half).join("  ")}`);
            if (c.length > half)
                lines.push(`<span foreground="${hex}" size="small">      </span>  ${c.slice(half).join("  ")}`);
        }
        lines.push(`<b>RAM</b>  ${fmtBytes(d.memUsed)} / ${fmtBytes(d.memTot)}  ·  ${Math.round(d.memPct)}%`);
        let swap = d.swapTot ? `${fmtBytes(d.swapUsed)} / ${fmtBytes(d.swapTot)}` : "none";
        lines.push(`<span foreground="${hex}" size="small">swap</span>  ${swap}  ·  cached ${fmtBytes(d.cached)}`);
        this.set_applet_tooltip(lines.join("\n"), true);
    }

    // ---------- drawing primitives ----------
    _col(cr, c, a) {
        cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, a === undefined ? (c[3] === undefined ? 1 : c[3]) : a);
    }
    _font(cr, size, bold) {
        cr.selectFontFace(bold ? FONT_MED : FONT, Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
        cr.setFontSize(size);
    }
    _text(cr, s, x, y, align, col, size, bold) {
        if (col === this.C.label && size < 11) size += 0.8;   // secondary labels: slightly larger
        this._font(cr, size, bold); this._col(cr, col);
        let w = cr.textExtents(s).xAdvance;
        cr.moveTo(align === "r" ? x - w : align === "c" ? x - w / 2 : x, y);
        cr.showText(s);
        return w;
    }
    _tracked(cr, s, cx, y, size, col, track, align) {
        size *= 1.12;   // section titles: larger and bold
        cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(size);
        let widths = [], total = 0;
        for (let ch of s) { let w = cr.textExtents(ch).xAdvance; widths.push(w); total += w + track; }
        total -= track;
        let x = align === "l" ? cx : cx - total / 2;
        this._col(cr, col);
        for (let i = 0; i < s.length; i++) {
            cr.moveTo(x, y); cr.showText(s[i]);
            x += widths[i] + track;
        }
    }
    _rrect(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }
    _gradX(x0, x1, c0, c1) {
        let g = new Cairo.LinearGradient(x0, 0, x1, 0);
        g.addColorStopRGBA(0, c0[0] / 255, c0[1] / 255, c0[2] / 255, 1);
        g.addColorStopRGBA(1, c1[0] / 255, c1[1] / 255, c1[2] / 255, 1);
        return g;
    }
    _mix(stops, v) {
        if (v <= stops[0][0]) return stops[0][1];
        for (let i = 1; i < stops.length; i++) {
            let [v1, c1] = stops[i];
            if (v <= v1) {
                let [v0, c0] = stops[i - 1], k = (v - v0) / Math.max(1e-6, v1 - v0);
                // interpolate in HSV: RGB blending of green→amber gives muddy olive
                let h0 = rgb2hsv(c0), h1 = rgb2hsv(c1), dh = h1[0] - h0[0];
                if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
                return hsv2rgb([(h0[0] + dh * k + 360) % 360, h0[1] + (h1[1] - h0[1]) * k, h0[2] + (h1[2] - h0[2]) * k]);
            }
        }
        return stops[stops.length - 1][1];
    }
    _pctColor(pct) {
        // smooth green → amber → red, anchored on the warn threshold
        let w = this.hotAt || 85, C = this.C;
        return this._mix([[0, C.ok], [w * 0.5, C.ok], [w, C.warn], [w + 15, C.hot]], isNaN(pct) ? 0 : pct);
    }
    _ringColors(pct) {
        let C = this.C, w = this.hotAt || 85;
        if (pct >= w + 15) return [[255, 138, 60, 1], C.hot];
        if (pct >= w) return [C.warn, [255, 138, 60, 1]];
        return [C.a2, C.a1];
    }

    // ---------- pieces ----------
    _ring(cr, cx, cy, r, pct, lw) {
        let C = this.C, LW = lw || 3;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(LW);
        this._col(cr, C.track);
        cr.newPath(); cr.arc(cx, cy, r, 0, 2 * Math.PI); cr.stroke();

        let frac = Math.max(0, Math.min(1, pct / 100));
        if (frac < 0.005) return;
        let [c0, c1] = this._ringColors(pct);
        let a0 = -Math.PI / 2, a1 = a0 + frac * 2 * Math.PI;

        cr.setLineWidth(LW * 2.7);
        this._col(cr, c1, 0.10 + 0.08 * frac);
        cr.newPath(); cr.arc(cx, cy, r, a0, a1); cr.stroke();

        cr.setLineWidth(LW);
        cr.setSource(this._gradX(cx - r, cx + r, c0, c1));
        cr.newPath(); cr.arc(cx, cy, r, a0, a1); cr.stroke();
    }

    _pct(cr, cx, cy, r, pct, base) {
        let s = Math.round(pct) + "%";
        let size = base || 7.8, maxw = 2 * (r - 1.4 * (size / 7.8));
        for (let i = 0; i < 14; i++) {
            this._font(cr, size, true);
            if (cr.textExtents(s).xAdvance <= maxw || size <= 5.8) break;
            size -= 0.25;
        }
        this._text(cr, s, cx, cy + size * 0.36, "c", this._pctColor(pct), size, true);
    }

    _window(ringBuf, n) {
        let all = ordered(ringBuf), out = new Array(n).fill(NaN);
        let take = Math.min(n, all.length);
        for (let i = 0; i < take; i++) out[n - take + i] = all[all.length - take + i];
        return out;
    }

    _spark(cr, x, y, w, h, ringBuf, col, pct) {
        let C = this.C;
        this._col(cr, C.base);
        cr.newPath(); cr.rectangle(x, y + h, w, 1); cr.fill();

        let n = Math.max(2, Math.round(w));
        let vals = this._window(ringBuf, n);
        let first = vals.findIndex(v => !isNaN(v));
        if (first < 0) return;
        let px = i => x + i * w / (n - 1);
        let py = v => y + h - Math.max(0, Math.min(100, v)) / 100 * h;

        cr.newPath();
        cr.moveTo(px(first), py(vals[first]));
        for (let i = first + 1; i < n; i++) cr.lineTo(px(i), py(isNaN(vals[i]) ? vals[first] : vals[i]));
        cr.lineTo(px(n - 1), y + h + 0.5);
        cr.lineTo(px(first), y + h + 0.5);
        cr.closePath();
        let g = new Cairo.LinearGradient(0, y, 0, y + h);
        g.addColorStopRGBA(0, col[0] / 255, col[1] / 255, col[2] / 255, 0.42);
        g.addColorStopRGBA(1, col[0] / 255, col[1] / 255, col[2] / 255, 0.04);
        cr.setSource(g);
        cr.fill();

        let trace = () => {
            cr.newPath();
            cr.moveTo(px(first), py(vals[first]));
            for (let i = first + 1; i < n; i++) cr.lineTo(px(i), py(isNaN(vals[i]) ? vals[first] : vals[i]));
        };
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        trace(); cr.setLineWidth(3.6); this._col(cr, col, 0.16); cr.stroke();
        trace(); cr.setLineWidth(1.6); this._col(cr, col, 1); cr.stroke();

        let lv = vals[n - 1];
        if (!isNaN(lv)) {
            let ex = px(n - 1), ey = py(lv), dot = this._pctColor(pct);
            this._col(cr, dot, 0.14);
            cr.newPath(); cr.arc(ex, ey, 3.4, 0, 2 * Math.PI); cr.fill();
            this._col(cr, dot);
            cr.newPath(); cr.arc(ex, ey, 1.5, 0, 2 * Math.PI); cr.fill();
        }
    }

    _divider(cr, g) {
        let x = Math.round(g.divX) + 0.5;
        this._col(cr, this.C.divider);
        cr.setLineWidth(1);
        cr.newPath();
        cr.moveTo(x, g.sparkY - 1);
        cr.lineTo(x, g.sparkY + g.sparkH + 1);
        cr.stroke();
    }

    _fit(cr, s, maxw, size, bold) {
        this._font(cr, size, bold);
        if (cr.textExtents(s).xAdvance <= maxw) return s;
        while (s.length > 1 && cr.textExtents(s + "…").xAdvance > maxw) s = s.slice(0, -1);
        return s + "…";
    }

    _bar(cr, x, y, w, h, pct, warnAt) {
        let C = this.C;
        cr.newPath(); this._rrect(cr, x, y, w, h, h / 2); this._col(cr, C.track); cr.fill();
        let fw = Math.max(0, Math.min(1, pct / 100)) * w;
        if (fw < h) return;
        cr.newPath(); this._rrect(cr, x, y, fw, h, h / 2);
        if (warnAt && pct >= warnAt + 15) cr.setSource(this._gradX(x, x + w, [255, 138, 60, 1], C.hot));
        else if (warnAt && pct >= warnAt) cr.setSource(this._gradX(x, x + w, C.warn, [255, 138, 60, 1]));
        else cr.setSource(this._gradX(x, x + w, C.a2, C.a1));
        cr.fill();
    }

    // ---------- iStat-style drop-down ----------
    _drawMenu(area) {
        let cr = area.get_context();
        try {
            cr.save();
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            cr.scale(MENU_SCALE, MENU_SCALE);
            // Content is drawn into a group first; section separators are collected
            // and turned into rounded tiles painted underneath.
            this._seps = null;     // no tiles: separators are drawn as plain lines
            this.hits = [];
            cr.pushGroup();
            if (this.mode === "load") this._loadBody(cr);
            else if (this.mode === "net") this._netBody(cr);
            else if (this.mode === "uptime") this._uptimeBody(cr);
            else if (this.mode === "ip") this._ipBody(cr);
            else if (this.mode === "temp") this._tempBody(cr);
            else if (this.mode === "weather") this._wxBody(cr);
            else this._menuBody(cr);
            let content = cr.popGroup();
            let mh = { load: MH_LOAD, net: MH_NET, uptime: MH_UP, ip: MH_IP, temp: MH_TEMP, weather: MH_WX }[this.mode] || MH;
            let bounds = [27].concat(this._seps || [], [mh - 2]);
            if (this._seps) for (let i = 0; i + 1 < bounds.length; i++) this._tile(cr, 4, bounds[i] + 3, MW - 8, bounds[i + 1] - bounds[i] - 6);
            this._seps = null;
            cr.setSource(content);
            cr.paint();
            cr.restore();
        } finally {
            cr.$dispose();
        }
    }

    _header(cr, pad, right) {
        let C = this.C;
        this._col(cr, C.a1);
        cr.newPath(); cr.arc(pad + 3, 12.5, 3.5, 0, 2 * Math.PI); cr.fill();
        let when = GLib.DateTime.new_now_local().format("%H:%M  ·  %a %d %b");
        let tw = this._text(cr, when, right, 16, "r", C.label, 10.5);
        this._text(cr, this._fit(cr, this.d.host, right - tw - 30, 11.5, true), pad + 10, 16, "l", C.text, 11.5, true);
    }

    _cores(cr, pad, right, labelY, top, warnAt) {
        let C = this.C, d = this.d;
        this._tracked(cr, "CPU CORES", pad, labelY, 9.2, C.label, 0.7, "l");
        this._text(cr, d.threads.length ? "per-thread load · 1 s" : "waiting…", right, labelY, "r", C.label, 9);
        let n = d.threads.length;
        if (!n) return;
        let x0 = pad, x1 = right, gap = 2, bh = 28;
        let bw = (x1 - x0 - (n - 1) * gap) / n;
        for (let i = 0; i < n; i++) {
            let v = d.threads[i], x = x0 + i * (bw + gap);
            this._col(cr, C.track);
            cr.newPath(); cr.rectangle(x, top, bw, bh); cr.fill();
            let h = Math.max(1.5, v / 100 * bh);
            let col = v >= warnAt + 15 ? C.hot : v >= warnAt ? C.warn : C.a1;
            this._col(cr, col, 0.22);
            cr.newPath(); cr.rectangle(x - 0.8, top + bh - h - 0.8, bw + 1.6, h + 1.6); cr.fill();
            this._col(cr, col);
            cr.newPath(); cr.rectangle(x, top + bh - h, bw, h); cr.fill();
        }
    }

    _tile(cr, x, y, w, h) {
        if (h <= 4) return;
        let dark = this.C.text[0] > 128;
        let g = new Cairo.LinearGradient(0, y, 0, y + h);
        g.addColorStopRGBA(0, dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, dark ? 0.055 : 0.035);
        g.addColorStopRGBA(1, dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, dark ? 0.025 : 0.02);
        cr.newPath(); this._rrect(cr, x, y, w, h, 10); cr.setSource(g); cr.fill();
        cr.newPath(); this._rrect(cr, x + 0.5, y + 0.5, w - 1, h - 1, 9.5);
        this._col(cr, dark ? [255, 255, 255, 0.07] : [0, 0, 0, 0.06]);
        cr.setLineWidth(1); cr.stroke();
    }

    _dividerLine(cr, pad, right, y) {
        if (this._seps) { this._seps.push(y); return; }
        this._col(cr, this.C.divider);
        cr.setLineWidth(1);
        cr.newPath(); cr.moveTo(pad, y + 0.5); cr.lineTo(right, y + 0.5); cr.stroke();
    }

    _loadBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12;
        let warnAt = this.hotAt || 85;
        let tn = Math.max(1, d.threads.length || 1);
        this._header(cr, pad, right);

        // load averages, normalised to the number of threads
        this._tracked(cr, "LOAD AVERAGE", pad, 44, 9.2, C.label, 0.7, "l");
        this._text(cr, tn + " threads · 100% = " + tn.toFixed(2), right, 44, "r", C.label, 9);
        [["1 min", d.load1], ["5 min", d.load5], ["15 min", d.load15]].forEach((r, i) => {
            let y = 66 + i * 24;
            let pct = Math.max(0, Math.min(100, 100 * r[1] / tn));
            this._text(cr, r[0], pad, y, "l", C.text, 11.5);
            this._text(cr, r[1].toFixed(2), 56, y, "l", this._pctColor(pct), 12.5, true);
            this._bar(cr, 108, y - 7, 128, 7, pct, warnAt);
            this._text(cr, Math.round(pct) + "%", right, y, "r", this._pctColor(pct), 11);
        });
        this._dividerLine(cr, pad, right, 132);

        // total CPU usage + 60 s history
        this._tracked(cr, "CPU USAGE", pad, 150, 9.2, C.label, 0.7, "l");
        this._text(cr, "last 60 s", right, 150, "r", C.label, 9);
        let cpu = Math.max(0, Math.min(100, d.cpu || 0));
        this._text(cr, Math.round(cpu) + "%", pad, 192, "l", this._pctColor(cpu), 26, true);
        this._spark(cr, 96, 156, right - 96, 40, this.hCpu, C.a1, cpu);
        this._dividerLine(cr, pad, right, 208);

        this._cores(cr, pad, right, 226, 234, warnAt);
        this._dividerLine(cr, pad, right, 272);

        // top processes by instantaneous CPU
        this._tracked(cr, "TOP PROCESSES", pad, 290, 9.2, C.label, 0.7, "l");
        this._text(cr, "%CPU", right, 290, "r", C.label, 9);
        if (!d.top.length) this._text(cr, "collecting…", pad, 312, "l", C.label, 10.5);
        d.top.forEach((p, i) => {
            let y = 310 + i * 15;
            this._text(cr, this._fit(cr, p[0], 200, 10.5), pad, y, "l", i ? C.label : C.text, 10.5);
            this._text(cr, p[1].toFixed(1) + "%", right, y, "r", i ? C.label : C.text, 10.5);
        });
    }

    _graph(cr, x, y, w, h, data, col, fill, maxv) {
        let n = data.length, first = data.findIndex(v => !isNaN(v));
        if (first < 0) return;
        let px = i => x + i * w / (n - 1);
        let py = v => y + h - Math.min(1, (isNaN(v) ? 0 : v) / maxv) * h;
        cr.newPath();
        cr.moveTo(px(first), py(data[first]));
        for (let i = first + 1; i < n; i++) cr.lineTo(px(i), py(data[i]));
        if (fill) {
            cr.lineTo(px(n - 1), y + h); cr.lineTo(px(first), y + h); cr.closePath();
            let g = new Cairo.LinearGradient(0, y, 0, y + h);
            g.addColorStopRGBA(0, col[0] / 255, col[1] / 255, col[2] / 255, 0.4);
            g.addColorStopRGBA(1, col[0] / 255, col[1] / 255, col[2] / 255, 0.02);
            cr.setSource(g); cr.fill();
        } else {
            cr.setLineWidth(1.2); cr.setLineJoin(Cairo.LineJoin.ROUND);
            this._col(cr, col); cr.stroke();
        }
    }

    _ioGraph(cr, x, y, w, h, ra, rb) {
        let A = this._window(ra, Math.max(2, Math.round(w)));
        let B = this._window(rb, Math.max(2, Math.round(w)));
        let mx = 1024;
        for (let v of A) if (!isNaN(v) && v > mx) mx = v;
        for (let v of B) if (!isNaN(v) && v > mx) mx = v;
        this._col(cr, this.C.base);
        cr.newPath(); cr.rectangle(x, y + h, w, 1); cr.fill();
        this._graph(cr, x, y, w, h, A, this.C.down, true, mx);
        this._graph(cr, x, y, w, h, A, this.C.down, false, mx);
        this._graph(cr, x, y, w, h, B, this.C.up, false, mx);
    }

    _netBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12;
        this._header(cr, pad, right);
        this._tracked(cr, "NETWORK", pad, 44, 9.2, C.label, 0.7, "l");
        this._text(cr, (d.iface || "—") + "   ·   " + (d.ping || "—"), right, 44, "r", C.label, 9);

        this._text(cr, "DOWNLOAD", pad, 62, "l", C.label, 8, true);
        this._text(cr, fmtBytes(d.down, "/s"), pad, 84, "l", C.down, 18, true);
        this._text(cr, "UPLOAD", 170, 62, "l", C.label, 8, true);
        this._text(cr, fmtBytes(d.upl, "/s"), 170, 84, "l", C.up, 18, true);

        this._ioGraph(cr, pad, 94, right - pad, 46, this.hDown, this.hUp);
        let tx = pad;
        tx += this._arrowIcon(cr, tx, 151, false, C.down, 10) + 2;
        tx += this._text(cr, "total " + fmtBytes(d.totDown), tx, 152, "l", C.down, 9.5) + 12;
        tx += this._arrowIcon(cr, tx, 151, true, C.up, 10) + 2;
        this._text(cr, "total " + fmtBytes(d.totUp), tx, 152, "l", C.up, 9.5);
        this._text(cr, "last 60 s", right, 152, "r", C.label, 9);
        this._dividerLine(cr, pad, right, 168);

        [["LAN", d.lan || "—"], ["PUBLIC", d.ext || "—"], ["GATEWAY", d.gateway || "—"], ["DNS", d.dns || "—"]].forEach((r, i) => {
            let y = 190 + i * 22;
            this._text(cr, r[0], pad, y, "l", C.label, 9.5, true);
            this._text(cr, r[1], right, y, "r", C.text, 11.5);
        });
    }

    _uptimeBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12;
        let warnAt = this.hotAt || 85;
        this._header(cr, pad, right);
        this._tracked(cr, "UPTIME", pad, 44, 9.2, C.label, 0.7, "l");
        this._text(cr, d.threads.length + " threads", right, 44, "r", C.label, 9);
        this._text(cr, this._upLong(), pad, 80, "l", C.text, 24, true);
        let boot = GLib.DateTime.new_now_local().add_seconds(-(d.upSec || 0));
        this._text(cr, "booted " + (boot ? boot.format("%a %d %b %Y · %H:%M") : "—"), pad, 100, "l", C.label, 10);
        this._dividerLine(cr, pad, right, 114);

        this._tracked(cr, "LOAD AVERAGE", pad, 132, 9.2, C.label, 0.7, "l");
        this._text(cr, d.procs + " processes", right, 132, "r", C.label, 9);
        let tn = Math.max(1, d.threads.length || 1);
        [["1 min", d.load1], ["5 min", d.load5], ["15 min", d.load15]].forEach((r, i) => {
            let y = 152 + i * 24;
            let pct = Math.max(0, Math.min(100, 100 * r[1] / tn));
            this._text(cr, r[0], pad, y, "l", C.text, 11.5);
            this._text(cr, r[1].toFixed(2), 56, y, "l", this._pctColor(pct), 12.5, true);
            this._bar(cr, 108, y - 7, 128, 7, pct, warnAt);
            this._text(cr, Math.round(pct) + "%", right, y, "r", this._pctColor(pct), 11);
        });
        this._text(cr, `CPU ${Math.round(d.cpu)}%   ·   RAM ${Math.round(d.memPct)}%`, pad, 230, "l", C.label, 10);
    }

    _ipBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12;
        this._header(cr, pad, right);
        this._tracked(cr, "PUBLIC IP", pad, 44, 9.2, C.label, 0.7, "l");
        let fw = this._drawFlag(cr, pad, 60, 16);
        this._text(cr, d.ext || "—", pad + (fw ? fw + 8 : 0), 78, "l", C.a1, 22, true);
        this._dividerLine(cr, pad, right, 96);
        [["LAN", d.lan || "—"], ["INTERFACE", d.iface || "—"], ["VPN", d.vpn || "off"], ["GATEWAY", d.gateway || "—"], ["PING", d.ping || "—"]].forEach((r, i) => {
            let y = 118 + i * 22;
            this._text(cr, r[0], pad, y, "l", C.label, 9.5, true);
            this._text(cr, r[1], right, y, "r", C.text, 11.5);
        });
    }

    _barHistory(cr, x, y, w, h, ringBuf, col) {
        let n = 60, vals = this._window(ringBuf, n);
        let step = w / n, bw = Math.max(1.5, step - 1.5);
        for (let i = 0; i < n; i++) {
            let v = vals[i];
            if (isNaN(v)) continue;
            let bh = Math.max(1.5, Math.min(100, v) / 100 * h);
            this._col(cr, col, 0.30 + 0.70 * Math.min(1, v / 80));
            cr.newPath(); cr.rectangle(x + i * step, y + h - bh, bw, bh); cr.fill();
        }
        this._col(cr, this.C.base);
        cr.newPath(); cr.rectangle(x, y + h, w, 1); cr.fill();
    }

    _coreRings(cr, pad, right, cy1, cy2, warnAt) {
        let d = this.d, n = d.threads.length;
        if (!n) return;
        let perRow = Math.ceil(n / 2), step = (right - pad) / perRow;
        for (let i = 0; i < n; i++) {
            let row = i < perRow ? 0 : 1, col = i % perRow;
            let cx = pad + step / 2 + col * step, cy = row ? cy2 : cy1;
            this._ring(cr, cx, cy, 7.5, d.threads[i], 1.8);
        }
    }

    _tempBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12, t = d.cpuTemp;
        this._header(cr, pad, right);
        this._tracked(cr, "TEMPERATURES", pad, 44, 9.2, C.label, 0.7, "l");
        let hw = this.hwTemp ? (readFile(this.hwTemp + "/name") || "").trim() : "";
        this._text(cr, hw || "—", right, 44, "r", C.label, 9);

        this._ring(cr, 48, 86, 30, isNaN(t) ? 0 : t, 3.4);
        this._text(cr, isNaN(t) ? "—" : Math.round(t) + "°", 48, 86 + 4.5, "c", this._tempColor(t), 13, true);
        this._tracked(cr, "CPU", 48, 128, 8.5, C.label, 0.9);

        let st = stats(this.hTemp);
        let stat = (label, value, x, y, col) => {
            this._text(cr, label, x, y, "l", C.label, 8.5, true);
            this._text(cr, value, x, y + 14, "l", col || C.text, 13, true);
        };
        stat("MIN", st ? Math.round(st.min) + "°" : "—", 116, 62);
        stat("AVG", st ? Math.round(st.avg) + "°" : "—", 116, 96);
        stat("MAX", st ? Math.round(st.max) + "°" : "—", 200, 62, st ? this._tempColor(st.max) : null);
        if (d.fan > 0) stat("FAN", Math.round(d.fan) + " rpm", 200, 96);

        // all sensors on one graph, shared auto-scaled axis
        let series = [
            ["CPU", this.hTemp, [0, 200, 255, 1], d.cpuTemp],
            ["GPU", this.hGpu, [118, 200, 60, 1], d.gpuTemp],
            ["NVMe", this.hNvme, [255, 170, 40, 1], d.nvmeTemp],
            ["Board", this.hAcpi, [170, 120, 255, 1], d.acpiTemp],
        ].filter(s => !isNaN(s[3]));
        let gx = pad + 22, gy = 146, gw = right - gx, gh = 62;
        let lo = 1e9, hi = -1e9;
        series.forEach(s => s[1].a.forEach(v => { if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
        if (lo > hi) { lo = 30; hi = 60; }
        lo = Math.floor((lo - 3) / 5) * 5; hi = Math.ceil((hi + 3) / 5) * 5;
        [lo, (lo + hi) / 2, hi].forEach(v => {
            let y = gy + gh - (v - lo) / (hi - lo) * gh;
            this._col(cr, C.divider); cr.setLineWidth(1);
            cr.newPath(); cr.moveTo(gx, Math.round(y) + 0.5); cr.lineTo(right, Math.round(y) + 0.5); cr.stroke();
            this._text(cr, Math.round(v) + "°", gx - 4, y + 3, "r", C.label, 8);
        });
        let n = Math.max(2, Math.round(gw));
        series.forEach(s => {
            let vals = this._window(s[1], n), first = vals.findIndex(v => !isNaN(v));
            if (first < 0) return;
            let px = i => gx + i * gw / (n - 1), py = v => gy + gh - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * gh;
            let trace = () => {
                cr.newPath(); cr.moveTo(px(first), py(vals[first]));
                for (let i = first + 1; i < n; i++) if (!isNaN(vals[i])) cr.lineTo(px(i), py(vals[i]));
            };
            cr.setLineJoin(Cairo.LineJoin.ROUND); cr.setLineCap(Cairo.LineCap.ROUND);
            trace(); cr.setLineWidth(3.2); this._col(cr, s[2], 0.12); cr.stroke();
            trace(); cr.setLineWidth(1.4); this._col(cr, s[2]); cr.stroke();
        });

        // legend with current values
        let lw = (right - pad) / Math.max(1, series.length);
        series.forEach((s, i) => {
            let x = pad + i * lw;
            this._dot(cr, x, 232, s[2]);
            this._text(cr, s[0], x + 8, 232, "l", C.label, 9.5);
            this._text(cr, Math.round(s[3]) + "°", x + 8, 248, "l", this._tempColor(s[3]), 12, true);
        });
        this._text(cr, "last 2 min", right, 232, "r", C.label, 8.5);
    }

    _menuBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12;
        let warnAt = this.hotAt || 85;
        let cpu = Math.max(0, Math.min(100, d.cpu || 0));
        let mem = Math.max(0, Math.min(100, d.memPct || 0));
        let sep = (y) => this._dividerLine(cr, pad, right, y);
        this._header(cr, pad, right);

        // CPU: clock / temperature, 60 s bar history, user/system split
        this._tracked(cr, "CPU", pad, 44, 9.2, C.label, 0.7, "l");
        let ghz = d.mhz ? (d.mhz / 1000).toFixed(2) + " GHz" : "—";
        let temp = isNaN(d.cpuTemp) ? "" : ", " + Math.round(d.cpuTemp) + "°";
        this._text(cr, ghz + temp, right, 44, "r", C.label, 9.5);
        this._barHistory(cr, pad, 56, right - pad, 44, this.hCpu, C.a1);

        this._dot(cr, pad, 118, C.a1);
        this._text(cr, "User", pad + 8, 118, "l", C.label, 10);
        this._text(cr, Math.round(d.userPct) + "%", pad + 52, 118, "l", C.text, 10.5, true);
        this._dot(cr, right - 88, 118, C.label);
        this._text(cr, "System", right - 82, 118, "l", C.label, 10);
        this._text(cr, Math.round(d.sysPct) + "%", right, 118, "r", C.text, 10.5, true);

        this._coreRings(cr, pad, right, 142, 168, warnAt);
        sep(184);

        // Memory: used + pressure rings, then the breakdown list
        this._tracked(cr, "MEMORY", pad, 202, 9.2, C.label, 0.7, "l");
        this._text(cr, fmtBytes(d.memTot) + " total", right, 202, "r", C.label, 9.5);
        this._ring(cr, 80, 246, 26, mem, 3.4);
        this._pct(cr, 80, 246, 26, mem, 12);
        this._tracked(cr, "USED", 80, 284, 8.5, C.label, 0.9);
        let pr = d.pressure;
        this._ring(cr, 220, 246, 26, isNaN(pr) ? 0 : pr, 3.4);
        if (isNaN(pr)) this._text(cr, "—", 220, 246 + 4, "c", C.label, 12, true);
        else this._pct(cr, 220, 246, 26, pr, 12);
        this._tracked(cr, "PRESSURE", 220, 284, 8.5, C.label, 0.9);

        let free = Math.max(0, d.memTot - d.memUsed - d.cached);
        let rows = [
            [C.a2, "Used", fmtBytes(d.memUsed)],
            [C.a1, "Cached", fmtBytes(d.cached)],
            [C.track, "Free", fmtBytes(free)],
            [C.a2, "Swap", d.swapTot ? fmtBytes(d.swapUsed) + " / " + fmtBytes(d.swapTot) : "none"],
        ];
        rows.forEach((r, i) => {
            let y = 306 + i * 20;
            this._dot(cr, pad, y, r[0]);
            this._text(cr, r[1], pad + 8, y, "l", C.label, 10.5);
            this._text(cr, r[2], right, y, "r", C.text, 10.5);
        });
        sep(392);

        // Top memory processes
        this._tracked(cr, "PROCESSES", pad, 410, 9.2, C.label, 0.7, "l");
        this._text(cr, "RSS", right, 410, "r", C.label, 9);
        if (!d.topMem.length) this._text(cr, "collecting…", pad, 430, "l", C.label, 10.5);
        d.topMem.forEach((p, i) => {
            let y = 430 + i * 15;
            this._text(cr, this._fit(cr, p[0], 190, 10.5), pad, y, "l", i ? C.label : C.text, 10.5);
            this._text(cr, fmtBytes(p[1]), right, y, "r", i ? C.label : C.text, 10.5);
        });
        sep(494);

        // Top CPU processes with a two-step kill button
        this._tracked(cr, "TOP CPU", pad, 512, 9.2, C.label, 0.7, "l");
        this._text(cr, this.killMsg || "click kill twice to end", right, 512, "r", this.killMsg ? C.warn : C.label, 9);
        if (!d.topCpu.length) this._text(cr, "collecting…", pad, 534, "l", C.label, 10.5);
        d.topCpu.slice(0, 4).forEach((p, i) => {
            let y = 532 + i * 17;
            this._text(cr, this._fit(cr, p.name, 150, 10.5), pad, y, "l", i ? C.label : C.text, 10.5);
            this._text(cr, String(p.pid), 196, y, "r", C.label, 9);
            this._text(cr, p.cpu.toFixed(1) + "%", right - 46, y, "r", this._pctColor(p.cpu), 10.5, true);
            let armed = this.killArm && this.killArm.pid === p.pid && Date.now() - this.killArm.at <= 3000;
            let bx = right - 38, by = y - 10, bw = 38, bh = 13;
            cr.newPath(); this._rrect(cr, bx, by, bw, bh, 6.5);
            this._col(cr, armed ? C.hot : C.track, armed ? 0.9 : undefined); cr.fill();
            this._text(cr, armed ? "sure?" : "kill", bx + bw / 2, y, "c", armed ? [255, 255, 255, 1] : C.hot, 8.5, true);
            this.hits.push({ x: bx, y: by, w: bw, h: bh, fn: () => this._kill(p) });
        });
    }

    _metric(cr, g, x, sparkX, label, pct, col, hist) {
        // on a dark panel lift accents toward white so dim hues (purple, blue) stay readable
        if (this.C.text[0] > 128) col = [0, 1, 2].map(i => Math.round(col[i] + (255 - col[i]) * 0.22)).concat([1]);
        if (g.labels) {
            this._dot(cr, x, g.labelY, col);
            this._plabel(cr, label, x + 8, g.labelY);
        }
        this._text(cr, Math.round(pct) + "%", x, g.valueY, "l", this._pctColor(pct), 14, true);
        if (this.showSpark) this._spark(cr, sparkX, g.sparkY, g.sparkW, g.sparkH, hist, col, pct);
    }

    // panel labels: a bit larger, bold, brighter than the menu labels
    _plabel(cr, label, x, y, size) {
        let C = this.C, col = [0, 1, 2].map(i => Math.round(C.label[i] * 0.25 + C.text[i] * 0.75)).concat([1]);
        cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(size || 9.5);
        this._col(cr, col);
        for (let ch of label) { cr.moveTo(x, y); cr.showText(ch); x += cr.textExtents(ch).xAdvance + 0.6; }
    }

    // upper-case without Greek tonos (ΠΑΤΣΙΔΕΣ, not ΠΑΤΣΊΔΕΣ)
    _upper(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase(); }

    _dot(cr, x, y, col) {
        this._col(cr, col);
        cr.newPath(); cr.arc(x + 2, y - 2.6, 2.1, 0, 2 * Math.PI); cr.fill();
    }

    _ensureFlag(cc) {
        if (!cc || cc === this._cc) return;
        this._cc = cc;
        this.flag = null;
        let f = CACHE + "/flag-" + cc + ".png";
        let load = () => { try { this.flag = Cairo.ImageSurface.createFromPNG(f); } catch (e) { } };
        if (GLib.file_test(f, GLib.FileTest.EXISTS)) load();
        else this._sh(`curl -s -m 8 -o '${f}' https://flagcdn.com/w40/${cc}.png && echo ok`, (o) => { if (o === "ok") load(); });
    }

    _drawFlag(cr, x, y, h) {
        if (!this.flag) return 0;
        let fw = this.flag.getWidth(), fh = this.flag.getHeight(), k = h / fh;
        cr.save();
        cr.translate(x, y);
        cr.scale(k, k);
        this._rrect(cr, 0, 0, fw, fh, 2 / k);
        cr.clip();
        cr.setSourceSurface(this.flag, 0, 0);
        cr.paint();
        cr.restore();
        return fw * k;
    }

    _metricLoad(cr, g) {
        let C = this.C, d = this.d;
        let tn = Math.max(1, d.threads.length || 1), l1 = this._v("load1", d.load1);
        let pct = Math.max(0, Math.min(100, 100 * l1 / tn));
        if (g.labels) {
            this._dot(cr, 12, g.labelY, C.a1);
            this._plabel(cr, "LOAD", 20, g.labelY);
        }
        this._text(cr, l1.toFixed(2), g.W / 2 + 4, g.valueY, "c", this._pctColor(pct), 14, true);
    }

    _metricNet(cr, g) {
        let C = this.C, d = this.d;
        // two stacked rows: download on top, upload below
        let H = g.H, y1 = Math.round(H / 2) - 1, y2 = H - Math.max(3, Math.round(H * 0.1));
        let fs = H >= 34 ? 13.5 : 12;
        let row = (y, up, col, v) => {
            this._arrowIcon(cr, 7, y, up, col, fs);
            this._text(cr, fmtBytes(v, "/s"), g.W - 6, y, "r", col, fs, true);
        };
        row(y1, false, C.down, this._v("down", d.down));
        row(y2, true, C.up, this._v("upl", d.upl));
    }

    _arrowIcon(cr, x, y, up, col, size) {
        let h = size * 0.8, w = size * 0.55, top = y - h, mid = x + w / 2;
        this._col(cr, col);
        cr.setLineWidth(Math.max(1.4, size / 6.5));
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.newPath(); cr.moveTo(mid, top); cr.lineTo(mid, y); cr.stroke();
        cr.newPath();
        if (up) { cr.moveTo(x, top + w / 2); cr.lineTo(mid, top); cr.lineTo(x + w, top + w / 2); }
        else { cr.moveTo(x, y - w / 2); cr.lineTo(mid, y); cr.lineTo(x + w, y - w / 2); }
        cr.stroke();
        return w + size * 0.35;
    }

    _metricUp(cr, g) {
        let C = this.C;
        if (g.labels) {
            this._dot(cr, 12, g.labelY, C.a1);
            this._plabel(cr, "UPTIME", 20, g.labelY);
        }
        this._text(cr, this._upShort(), g.W / 2 + 4, g.valueY, "c", C.text, 14, true);
    }

    // content-sized items: ask for a new width, applied on idle (not during repaint)
    _fitW(need) {
        if (!this.geo || Math.abs(need - this.geo.W) <= 1 || this._fitPending) return;
        this._fitPending = Mainloop.idle_add(() => {
            this._fitPending = 0;
            if (!this.canvas || !this.geo) return false;
            this.geo.W = need;
            this.canvas.set_size(need, this.geo.H);
            this.canvas.queue_repaint();
            return false;
        });
    }

    _metricIp(cr, g) {
        let C = this.C, d = this.d;
        // no label: flag + address, item width fitted to content
        let ip = d.ext || "—";
        this._font(cr, 14, true);
        let tw = cr.textExtents(ip).xAdvance;
        let fw = this.flag ? this.flag.getWidth() * 13 / this.flag.getHeight() : 0;
        let total = tw + (fw ? fw + 7 : 0);
        this._fitW(Math.ceil(total) + 12);
        let x = 6, base = Math.round(g.H / 2 + 5);
        if (fw) { this._drawFlag(cr, x, base - 11.5, 13); x += fw + 7; }
        this._text(cr, ip, x, base, "l", C.text, 14, true);
    }

    _metricTemp(cr, g) {
        let C = this.C, t = this._v("temp", this.d.cpuTemp);
        if (g.labels) {
            this._dot(cr, 12, g.labelY, this._tempColor(t));
            this._plabel(cr, "TEMP", 20, g.labelY);
        }
        this._text(cr, isNaN(t) ? "—" : Math.round(t) + "°", g.W / 2 + 4, g.valueY, "c", this._tempColor(t), 14, true);
    }

    _tempColor(t) {
        let C = this.C;
        if (isNaN(t)) return C.label;
        return this._mix([[0, C.ok], [50, C.ok], [72, C.warn], [88, C.hot]], t);
    }

    _upShort() {
        let s = this.d.upSec || 0;
        if (s < 3600) return `${Math.floor(s / 60)}m`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`;
        return `${Math.floor(s / 86400)}d ${String(Math.floor(s % 86400 / 3600)).padStart(2, "0")}h`;
    }

    _upLong() {
        let s = this.d.upSec || 0;
        return `${Math.floor(s / 86400)}d ${String(Math.floor(s % 86400 / 3600)).padStart(2, "0")}h ${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`;
    }

    // ---------- repaint ----------
    _draw(area) {
        let cr = area.get_context(), g = this.geo, C = this.C;
        try {
            cr.save();
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            if (this.hover || (this.menu && this.menu.isOpen)) {
                let dark = C.text[0] > 128;
                cr.newPath(); this._rrect(cr, 1, 3, g.W - 2, g.H - 6, Math.min(8, (g.H - 6) / 2));
                this._col(cr, dark ? [255, 255, 255, 0.08] : [0, 0, 0, 0.06]); cr.fill();
            }

            let cpu = Math.max(0, Math.min(100, this._v("cpu", this.d.cpu || 0)));
            let mem = Math.max(0, Math.min(100, this._v("mem", this.d.memPct || 0)));

            if (this.mode === "load") this._metricLoad(cr, g);
            else if (this.mode === "net") this._metricNet(cr, g);
            else if (this.mode === "uptime") this._metricUp(cr, g);
            else if (this.mode === "ip") this._metricIp(cr, g);
            else if (this.mode === "temp") this._metricTemp(cr, g);
            else if (this.mode === "weather") this._metricWx(cr, g);
            else {
                this._metric(cr, g, g.cpuX, g.cpuSparkX, "CPU", cpu, C.a1, this.hCpu);
                this._metric(cr, g, g.ramX, g.ramSparkX, "RAM", mem, C.a2, this.hMem);
                if (g.divX !== undefined) this._divider(cr, g);
            }

            cr.restore();
        } finally {
            cr.$dispose();
        }
    }
}

function _(str) { return str; }

function main(metadata, orientation, panelHeight, instanceId) {
    return new CoreglowPanelApplet(metadata, orientation, panelHeight, instanceId);
}
