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
const FONT = "Noto Sans";
const HIST = 120;          // seconds of history kept in the ring buffers
const W_FULL = 238;        // labels + values + sparklines
const W_MINI = 126;        // labels + values only
const W_LOAD = 152;        // load mode: label + value + sparkline
const W_LOAD_MINI = 80;    // load mode: label + value
const W_NET = 185;         // network: down / up
const W_UP = 110;          // uptime
const W_IP = 130;          // public IP
const MW = 300, MH = 330;  // drop-down body (CSS px)
const MH_LOAD = 368;       // drop-down body in load mode
const MH_NET = 300, MH_UP = 250, MH_IP = 240;
const MENU_SCALE = 1.2;    // drop-down zoom (window + text)
const INSTANCES = new Set();
const STYLE = "coreglow-panel-applet";

const DARK = {
    bgTop: [28, 24, 44], bg: [18, 20, 28], border: [255, 255, 255, 0.11],
    text: [235, 238, 245, 1], label: [150, 158, 175, 1],
    track: [255, 255, 255, 0.09], base: [255, 255, 255, 0.07], divider: [255, 255, 255, 0.07],
};
const LIGHT = {
    bgTop: [236, 238, 248], bg: [248, 249, 252], border: [0, 0, 0, 0.10],
    text: [25, 28, 38, 1], label: [96, 104, 122, 1],
    track: [0, 0, 0, 0.08], base: [0, 0, 0, 0.06], divider: [0, 0, 0, 0.06],
};
const FIXED = { warn: [255, 170, 40, 1], hot: [255, 70, 80, 1] };

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

function ring(n) { return { a: new Array(n).fill(NaN), i: 0, n }; }
function push(r, v) { r.a[r.i] = v; r.i = (r.i + 1) % r.n; }
function ordered(r) { return r.a.slice(r.i).concat(r.a.slice(0, r.i)); }

function readNum(path) { let s = readFile(path); return s === null ? NaN : parseFloat(s); }

class CoreglowPanelApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._meta = metadata;
        this._ph = panelHeight;
        this.d = { cpu: 0, threads: [], memUsed: 0, memTot: 0, memPct: 0, swapUsed: 0, swapTot: 0, cached: 0, load: "", mhz: 0, host: GLib.get_host_name(), load1: 0, load5: 0, load15: 0, uptime: "", top: [], upSec: 0, procs: 0, iface: "", lan: "", ext: "", gateway: "", dns: "", ping: "", down: 0, upl: 0, totDown: 0, totUp: 0 };
        this.hCpu = ring(HIST);
        this.hMem = ring(HIST);
        this.hLoad = ring(HIST);
        this.hDown = ring(HIST);
        this.hUp = ring(HIST);
        this.prevNet = null;
        this.prevStat = null;
        this.tick = 0;
        this.hover = false;
        this.sysDark = this._sysDark();

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        for (let k of ["mode", "theme", "bgAlpha", "accent1", "accent2", "showSpark", "showLabels", "hoverOpen", "hotAt"])
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
        let section = new PopupMenu.PopupMenuSection();
        let itemBody = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        itemBody.addActor(this.menuCanvas, { span: 2 });
        section.addMenuItem(itemBody);
        this.menu.addMenuItem(section);
        let itemOpen = new PopupMenu.PopupMenuItem(_("Open System Monitor"));
        itemOpen.connect("activate", () => Util.spawnCommandLine("gnome-system-monitor"));
        this.menu.addMenuItem(itemOpen);
        this.menu.actor.connect("enter-event", () => { this._cancelClose(); return false; });
        this.menu.actor.connect("leave-event", () => { this._scheduleClose(); return false; });

        this._onSettings();
        this._update(true);
        this._timer = Mainloop.timeout_add_seconds(1, () => { this._update(); return true; });
        INSTANCES.add(this);
    }

    on_applet_removed_from_panel() {
        if (this._timer) { Mainloop.source_remove(this._timer); this._timer = 0; }
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
        this._palette();
        this._layout();
        this.canvas.queue_repaint();
        if (this.menuCanvas) this.menuCanvas.queue_repaint();
        // no hover UI: details open on click only (hoverOpen is opt-in)
        this._applet_tooltip.preventShow = true;
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
            : (this.showSpark ? W_FULL : W_MINI);
        this.canvas.set_size(W, H);
        let mh = { load: MH_LOAD, net: MH_NET, uptime: MH_UP, ip: MH_IP }[this.mode] || MH;
        if (this.menuCanvas) this.menuCanvas.set_size(
            Math.round(MW * MENU_SCALE),
            Math.round(mh * MENU_SCALE));

        let inset = H >= 34 ? 3 : 2;
        let ch = H - inset * 2;
        let g = {
            W, H, inset, ch,
            labels: !!this.showLabels,
            labelY: inset + 9,
            valueY: inset + ch - 4,
            sparkY: inset + 5,
            sparkH: ch - 10,
        };
        if (loadMode) {
            if (this.showSpark) { g.sparkX = 64; g.sparkW = 76; }
        } else if (this.showSpark) {
            g.cpuX = 12;
            g.cpuSparkX = 52;
            g.sparkW = 60;
            g.divX = 118;
            g.ramX = 126;
            g.ramSparkX = 166;
        } else {
            g.cpuX = 12;
            g.divX = 64;
            g.ramX = 78;
        }
        this.geo = g;
    }

    // ---------- data ----------
    _update(first) {
        let d = this.d, t = ++this.tick;

        let stat = (readFile("/proc/stat") || "").split("\n").filter(l => /^cpu\d* /.test(l))
            .map(l => { let v = l.trim().split(/\s+/).slice(1).map(Number); return [v.reduce((a, b) => a + b, 0), v[3] + (v[4] || 0)]; });
        if (this.prevStat && this.prevStat.length === stat.length) {
            let pct = stat.map((s, i) => {
                let dt = s[0] - this.prevStat[i][0], di = s[1] - this.prevStat[i][1];
                return dt > 0 ? 100 * (dt - di) / dt : 0;
            });
            d.cpu = pct[0];
            d.threads = pct.slice(1);
            push(this.hCpu, d.cpu);
        }
        this.prevStat = stat;

        let mi = {};
        (readFile("/proc/meminfo") || "").split("\n").forEach(l => { let m = l.match(/^(\w+):\s+(\d+)/); if (m) mi[m[1]] = +m[2] * 1024; });
        d.memTot = mi.MemTotal || 0;
        d.memUsed = d.memTot - (mi.MemAvailable || d.memTot);
        d.memPct = d.memTot ? 100 * d.memUsed / d.memTot : 0;
        d.swapTot = mi.SwapTotal || 0;
        d.swapUsed = d.swapTot - (mi.SwapFree || 0);
        d.cached = (mi.Cached || 0) + (mi.SReclaimable || 0);
        push(this.hMem, d.memPct);

        let la = (readFile("/proc/loadavg") || "").trim().split(/\s+/);
        if (la.length >= 3) { d.load1 = +la[0] || 0; d.load5 = +la[1] || 0; d.load15 = +la[2] || 0; }
        let tn = Math.max(1, d.threads.length || 1);
        push(this.hLoad, Math.max(0, Math.min(100, 100 * d.load1 / tn)));

        if (this.mode === "net" || this.mode === "ip") this._netTick(t);
        if (this.mode === "uptime" || this.mode === "load") {
            let up = readNum("/proc/uptime");
            if (!isNaN(up)) d.upSec = up;
            if (t % 10 === 0) this._sh("ls -d /proc/[0-9]* 2>/dev/null | wc -l", (o) => { d.procs = +o || 0; });
        }

        if (t % 5 === 0) {
            d.load = la[0] || d.load;
            let up = readNum("/proc/uptime");
            if (!isNaN(up)) d.uptime = `${Math.floor(up / 86400)}d ${String(Math.floor(up % 86400 / 3600)).padStart(2, "0")}h`;
            let mh = (readFile("/proc/cpuinfo") || "").match(/cpu MHz\s*:\s*[\d.]+/g) || [];
            d.mhz = mh.reduce((a, s) => Math.max(a, parseFloat(s.split(":")[1])), 0);
        }
        if (this.mode === "load" && t % 5 === 0)
            this._sh("top -b -n2 -d0.5 -o %CPU -w 512 | awk '/^ *PID/{n++;next} n==2{print $12\" \"$9; if(++c==4) exit}'", (out) => {
                d.top = out.split("\n").filter(l => l).map(l => { let p = l.split(" "); return [p[0], parseFloat(p[1]) || 0]; });
            });
        if (t % 15 === 0) {
            let dark = this._sysDark();
            if (dark !== this.sysDark) { this.sysDark = dark; this._palette(); }
        }

        this.canvas.queue_repaint();
        if (this.menuCanvas) this.menuCanvas.queue_repaint();
        if (first || t % 2 === 0) this._tooltip();
    }

    // ---------- data helpers ----------
    _sh(script, cb) {
        try { Util.spawn_async(["bash", "-c", script], (out) => { try { cb(out.trim()); } catch (e) { } }); }
        catch (e) { }
    }

    _netTick(t) {
        let d = this.d;
        if (t === 1 || t % 10 === 0) {
            this._sh("dev=$(ip -4 route show default | sort -t' ' -k9 -n | head -1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); " +
                "echo \"$dev\"; ip -4 -o addr show dev \"$dev\" | awk '{print $4}' | cut -d/ -f1 | head -1; " +
                "ip -4 route show default | awk 'NR==1{print $3}'; awk '/^nameserver/{print $2; exit}' /etc/resolv.conf",
                (out) => {
                    let [iface, lan, gw, dns] = out.split("\n");
                    if (iface !== d.iface) this.prevNet = null;
                    d.iface = iface || ""; d.lan = lan || ""; d.gateway = gw || ""; d.dns = dns || "";
                });
        }
        if (d.iface) {
            let rx = readNum(`/sys/class/net/${d.iface}/statistics/rx_bytes`), tx = readNum(`/sys/class/net/${d.iface}/statistics/tx_bytes`);
            if (!isNaN(rx) && !isNaN(tx)) {
                if (this.prevNet) { d.down = Math.max(0, rx - this.prevNet[0]); d.upl = Math.max(0, tx - this.prevNet[1]); }
                this.prevNet = [rx, tx];
                d.totDown = rx; d.totUp = tx;
                push(this.hDown, d.down); push(this.hUp, d.upl);
            }
        }
        if (t % 5 === 0)
            this._sh("ping -c1 -W2 1.1.1.1 2>/dev/null | sed -n 's/.*time=\\([0-9.]*\\).*/\\1/p'",
                (out) => { d.ping = out ? Math.round(parseFloat(out)) + " ms" : "—"; });
        if (!d.ext || t % 600 === 0)
            this._sh("curl -s -m 8 https://ipinfo.io/json", (out) => {
                try { let j = JSON.parse(out); if (j.ip) d.ext = j.ip; } catch (e) { }
            });
    }

    _tooltip() {
        let d = this.d, C = this.C, hex = this._labelHex;
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
        cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
        cr.setFontSize(size);
    }
    _text(cr, s, x, y, align, col, size, bold) {
        this._font(cr, size, bold); this._col(cr, col);
        let w = cr.textExtents(s).xAdvance;
        cr.moveTo(align === "r" ? x - w : align === "c" ? x - w / 2 : x, y);
        cr.showText(s);
        return w;
    }
    _tracked(cr, s, cx, y, size, col, track, align) {
        this._font(cr, size, true);
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
    _pctColor(pct) {
        let w = this.hotAt || 85;
        return pct >= w + 15 ? this.C.hot : pct >= w ? this.C.warn : this.C.text;
    }
    _ringColors(pct) {
        let C = this.C, w = this.hotAt || 85;
        if (pct >= w + 15) return [[255, 138, 60, 1], C.hot];
        if (pct >= w) return [C.warn, [255, 138, 60, 1]];
        return [C.a2, C.a1];
    }

    // ---------- pieces ----------
    _card(cr, g) {
        let C = this.C, a = Math.min(1, (this.bgAlpha || 0) + (this.hover ? 0.06 : 0));
        cr.newPath();
        this._rrect(cr, 0.5, g.inset + 0.5, g.W - 1, g.ch - 1, 8);
        let bg = new Cairo.LinearGradient(0, g.inset, 0, g.inset + g.ch);
        bg.addColorStopRGBA(0, C.bgTop[0] / 255, C.bgTop[1] / 255, C.bgTop[2] / 255, a);
        bg.addColorStopRGBA(1, C.bg[0] / 255, C.bg[1] / 255, C.bg[2] / 255, a);
        cr.setSource(bg);
        cr.fillPreserve();
        this._col(cr, C.border, this.hover ? 0.20 : C.border[3]);
        cr.setLineWidth(1);
        cr.stroke();
    }

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
        g.addColorStopRGBA(0, col[0] / 255, col[1] / 255, col[2] / 255, 0.30);
        g.addColorStopRGBA(1, col[0] / 255, col[1] / 255, col[2] / 255, 0.01);
        cr.setSource(g);
        cr.fill();

        let trace = () => {
            cr.newPath();
            cr.moveTo(px(first), py(vals[first]));
            for (let i = first + 1; i < n; i++) cr.lineTo(px(i), py(isNaN(vals[i]) ? vals[first] : vals[i]));
        };
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        trace(); cr.setLineWidth(3.2); this._col(cr, col, 0.10); cr.stroke();
        trace(); cr.setLineWidth(1.25); this._col(cr, col, 0.95); cr.stroke();

        let lv = vals[n - 1];
        if (!isNaN(lv)) {
            let ex = px(n - 1), ey = py(lv), dot = this._pctColor(pct);
            this._col(cr, dot, 0.18);
            cr.newPath(); cr.arc(ex, ey, 4, 0, 2 * Math.PI); cr.fill();
            this._col(cr, dot);
            cr.newPath(); cr.arc(ex, ey, 1.7, 0, 2 * Math.PI); cr.fill();
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
            if (this.mode === "load") this._loadBody(cr);
            else if (this.mode === "net") this._netBody(cr);
            else if (this.mode === "uptime") this._uptimeBody(cr);
            else if (this.mode === "ip") this._ipBody(cr);
            else this._menuBody(cr);
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

    _dividerLine(cr, pad, right, y) {
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
        this._graph(cr, x, y, w, h, A, this.C.a1, true, mx);
        this._graph(cr, x, y, w, h, A, this.C.a1, false, mx);
        this._graph(cr, x, y, w, h, B, this.C.a2, false, mx);
    }

    _netBody(cr) {
        let C = this.C, d = this.d, pad = 12, right = MW - 12;
        this._header(cr, pad, right);
        this._tracked(cr, "NETWORK", pad, 44, 9.2, C.label, 0.7, "l");
        this._text(cr, (d.iface || "—") + "   ·   " + (d.ping || "—"), right, 44, "r", C.label, 9);

        this._text(cr, "DOWNLOAD", pad, 62, "l", C.label, 8, true);
        this._text(cr, fmtBytes(d.down, "/s"), pad, 84, "l", C.a1, 18, true);
        this._text(cr, "UPLOAD", 170, 62, "l", C.label, 8, true);
        this._text(cr, fmtBytes(d.upl, "/s"), 170, 84, "l", C.a2, 18, true);

        this._ioGraph(cr, pad, 94, right - pad, 46, this.hDown, this.hUp);
        let tx = pad;
        tx += this._arrowIcon(cr, tx, 151, false, C.a1, 10) + 2;
        tx += this._text(cr, "total " + fmtBytes(d.totDown), tx, 152, "l", C.a1, 9.5) + 12;
        tx += this._arrowIcon(cr, tx, 151, true, C.a2, 10) + 2;
        this._text(cr, "total " + fmtBytes(d.totUp), tx, 152, "l", C.a2, 9.5);
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
        this._text(cr, d.ext || "—", pad, 78, "l", C.a1, 22, true);
        this._dividerLine(cr, pad, right, 96);
        [["LAN", d.lan || "—"], ["INTERFACE", d.iface || "—"], ["GATEWAY", d.gateway || "—"], ["DNS", d.dns || "—"], ["PING", d.ping || "—"]].forEach((r, i) => {
            let y = 118 + i * 22;
            this._text(cr, r[0], pad, y, "l", C.label, 9.5, true);
            this._text(cr, r[1], right, y, "r", C.text, 11.5);
        });
    }

    _menuBody(cr) {
        let C = this.C, d = this.d;
        let pad = 12, right = MW - 12, cpu = Math.max(0, Math.min(100, d.cpu || 0));
        let mem = Math.max(0, Math.min(100, d.memPct || 0));
        let warnAt = this.hotAt || 85;
        let sep = (y) => { this._col(cr, C.divider); cr.setLineWidth(1); cr.newPath(); cr.moveTo(pad, y + 0.5); cr.lineTo(right, y + 0.5); cr.stroke(); };

        this._header(cr, pad, right);

        // CPU / RAM rings
        this._tracked(cr, "CPU", 48, 40, 8.5, C.label, 0.9);
        this._tracked(cr, "RAM", 252, 40, 8.5, C.label, 0.9);
        this._ring(cr, 48, 76, 30, cpu, 3.4);
        this._pct(cr, 48, 76, 30, cpu, 12.5);
        this._ring(cr, 252, 76, 30, mem, 3.4);
        this._pct(cr, 252, 76, 30, mem, 12.5);

        // centre stats
        let stat = (label, value, y) => {
            this._text(cr, label, 150, y, "c", C.label, 8, true);
            this._text(cr, value, 150, y + 12, "c", C.text, 11.5);
        };
        stat("CLK", d.mhz ? (d.mhz / 1000).toFixed(2) + " GHz" : "—", 44);
        stat("LOAD", d.load || "—", 72);
        stat("THREADS", String(d.threads.length || "—"), 100);

        sep(122);

        this._cores(cr, pad, right, 140, 148, warnAt);

        sep(190);

        // memory
        this._tracked(cr, "MEMORY", pad, 208, 9.2, C.label, 0.7, "l");
        this._text(cr, fmtBytes(d.memUsed) + " / " + fmtBytes(d.memTot), right, 208, "r", C.text, 10.5);
        this._text(cr, "RAM", pad, 230, "l", C.text, 11.5);
        this._bar(cr, 56, 223, 176, 7, mem, warnAt);
        this._text(cr, Math.round(mem) + "%", right, 230, "r", this._pctColor(mem), 11.5);
        let free = Math.max(0, d.memTot - d.memUsed - d.cached);
        this._text(cr, "used " + fmtBytes(d.memUsed) + "   ·   cached " + fmtBytes(d.cached) + "   ·   free " + fmtBytes(free),
            56, 244, "l", C.label, 9.3);

        let swapPct = d.swapTot ? 100 * d.swapUsed / d.swapTot : 0;
        this._text(cr, "SWAP", pad, 266, "l", C.text, 11.5);
        this._bar(cr, 56, 259, 176, 7, swapPct, warnAt);
        this._text(cr, Math.round(swapPct) + "%", right, 266, "r", this._pctColor(swapPct), 11.5);
        this._text(cr, d.swapTot ? fmtBytes(d.swapUsed) + " / " + fmtBytes(d.swapTot) : "none", 56, 280, "l", C.label, 9.3);

        sep(292);

        // stacked memory bar: used / cached / free
        let w = right - pad, y = 302, h = 8;
        cr.newPath(); this._rrect(cr, pad, y, w, h, h / 2); this._col(cr, C.track); cr.fill();
        if (d.memTot) {
            cr.save();
            cr.newPath(); this._rrect(cr, pad, y, w, h, h / 2); cr.clip();
            let ux = 0, uw = w * d.memUsed / d.memTot, cw = w * d.cached / d.memTot, fw = Math.max(0, w - uw - cw);
            this._col(cr, C.a2); cr.rectangle(pad + ux, y, uw, h); cr.fill();
            this._col(cr, C.a1); cr.rectangle(pad + ux + uw, y, cw, h); cr.fill();
            this._col(cr, C.track); cr.rectangle(pad + ux + uw + cw, y, fw, h); cr.fill();
            cr.restore();
        }
        let lx = pad, ly = 322;
        let legend = [[C.a2, "used " + fmtBytes(d.memUsed)], [C.a1, "cached " + fmtBytes(d.cached)], [C.track, "free " + fmtBytes(free)]];
        for (let i = 0; i < legend.length; i++) {
            this._col(cr, legend[i][0], 1);
            cr.newPath(); cr.arc(lx + 3, ly - 3.2, 3, 0, 2 * Math.PI); cr.fill();
            let lw = this._text(cr, legend[i][1], lx + 10, ly, "l", C.label, 8.8);
            lx += 10 + lw + 10;
        }
    }

    _metric(cr, g, x, sparkX, label, pct, col, hist) {
        if (g.labels) this._tracked(cr, label, x, g.labelY, 6.5, this.C.label, 0.5, "l");
        this._text(cr, Math.round(pct) + "%", x, g.valueY, "l", this._pctColor(pct), 15, true);
        if (this.showSpark) this._spark(cr, sparkX, g.sparkY, g.sparkW, g.sparkH, hist, col, pct);
    }

    _metricLoad(cr, g) {
        let C = this.C, d = this.d;
        let tn = Math.max(1, d.threads.length || 1);
        let pct = Math.max(0, Math.min(100, 100 * d.load1 / tn));
        if (g.labels) this._tracked(cr, "LOAD", 12, g.labelY, 6.5, C.label, 0.5, "l");
        this._text(cr, d.load1.toFixed(2), 12, g.valueY, "l", this._pctColor(pct), 15, true);
    }

    _metricNet(cr, g) {
        let C = this.C, d = this.d;
        if (g.labels) this._tracked(cr, "NET", 12, g.labelY, 6.5, C.label, 0.5, "l");
        let x = 12;
        x += this._arrowIcon(cr, x, g.valueY - 1, false, C.a1, 11) + 2;
        let dw = this._text(cr, fmtBytes(d.down, "/s"), x, g.valueY, "l", C.a1, 12, true);
        x += dw + 12;
        x += this._arrowIcon(cr, x, g.valueY - 1, true, C.a2, 11) + 2;
        this._text(cr, fmtBytes(d.upl, "/s"), x, g.valueY, "l", C.a2, 12, true);
    }

    _arrowIcon(cr, x, y, up, col, size) {
        let h = size * 0.8, w = size * 0.55, top = y - h, mid = x + w / 2;
        this._col(cr, col);
        cr.setLineWidth(Math.max(1.2, size / 8));
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
        if (g.labels) this._tracked(cr, "UPTIME", 12, g.labelY, 6.5, C.label, 0.5, "l");
        this._text(cr, this._upShort(), 12, g.valueY, "l", C.text, 15, true);
    }

    _metricIp(cr, g) {
        let C = this.C, d = this.d;
        if (g.labels) this._tracked(cr, "IP", 12, g.labelY, 6.5, C.label, 0.5, "l");
        this._text(cr, d.ext || "—", 12, g.valueY, "l", C.text, 12.5, true);
    }

    _upShort() {
        let s = this.d.upSec || 0;
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

            this._card(cr, g);
            let cpu = Math.max(0, Math.min(100, this.d.cpu || 0));
            let mem = Math.max(0, Math.min(100, this.d.memPct || 0));

            if (this.mode === "load") this._metricLoad(cr, g);
            else if (this.mode === "net") this._metricNet(cr, g);
            else if (this.mode === "uptime") this._metricUp(cr, g);
            else if (this.mode === "ip") this._metricIp(cr, g);
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
