// Coreglow — Cinnamon desklet port of github.com/stavros-it/coreglow-rainmeter
const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Cairo = imports.cairo;
const Main = imports.ui.main;

const W = 300, MH = 906, WH = 266, GAP = 12, H = MH + GAP + WH, COLH = 92;
const FONT = "Noto Sans";
const DARK = {
    bgTop: [28, 24, 44], bg: [18, 20, 28], wxTop: [20, 34, 52], border: [255, 255, 255, 0.11], text: [235, 238, 245, 1],
    label: [150, 158, 175, 1], track: [255, 255, 255, 0.09], divider: [255, 255, 255, 0.08], cloud: [190, 198, 215, 1], cloudDark: [140, 148, 165, 1],
};
const LIGHT = {
    bgTop: [236, 238, 248], bg: [248, 249, 252], wxTop: [226, 238, 250], border: [0, 0, 0, 0.10], text: [25, 28, 38, 1],
    label: [96, 104, 122, 1], track: [0, 0, 0, 0.08], divider: [0, 0, 0, 0.08], cloud: [160, 168, 185, 1], cloudDark: [110, 118, 135, 1],
};
const FIXED = { ok: [60, 200, 130, 1], warn: [255, 170, 40, 1], hot: [255, 70, 80, 1], sun: [255, 196, 60, 1] };
const HIST = 120;          // network / disk graphs (seconds)
const SPARK = 600;         // cpu/temp sparkline (10 min)
const HOUR = 3600;         // min/avg/max window
const CACHE = GLib.get_user_cache_dir() + "/coreglow";
GLib.mkdir_with_parents(CACHE, 0o755);

function readFile(path) {
    try {
        let [ok, data] = GLib.file_get_contents(path);
        return ok ? imports.byteArray.toString(data) : null;
    } catch (e) { return null; }
}
function readNum(path) { let s = readFile(path); return s === null ? NaN : parseFloat(s); }
function fmtBytes(b, suffix = "") {
    const u = ["B", "kB", "MB", "GB", "TB"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b.toFixed(0) : b.toFixed(1)) + " " + u[i] + suffix;
}
function parseColor(s, fallback) {
    let m = (s || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3], 1] : fallback;
}
function to24(s) {   // "07:31 AM" -> "07:31"
    let m = (s || "").match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return s || "";
    let h = +m[1] % 12 + (/pm/i.test(m[3]) ? 12 : 0);
    return String(h).padStart(2, "0") + ":" + m[2];
}
function minutesOf(hhmm) { let p = hhmm.split(":"); return +p[0] * 60 + +p[1]; }
function hwmonBy(pred) {
    for (let i = 0; i < 32; i++) {
        let p = `/sys/class/hwmon/hwmon${i}`, n = (readFile(p + "/name") || "").trim();
        if (n && pred(n, p)) return p;
    }
    return null;
}
function ring(n) { return { a: new Array(n).fill(NaN), i: 0, n }; }
function push(r, v) { r.a[r.i] = v; r.i = (r.i + 1) % r.n; }
function ordered(r) { return r.a.slice(r.i).concat(r.a.slice(0, r.i)); }
function stats(r) {
    let v = r.a.filter(x => !isNaN(x));
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length };
}

class CoreglowDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);
        this.settings = new Settings.DeskletSettings(this, metadata.uuid, deskletId);
        for (let k of ["scale", "bgAlpha", "weatherLoc", "weatherMins", "pingHost", "loadAlert", "theme", "accent1", "accent2", "collapsed"])
            this.settings.bind(k, k, () => this._onSettings());

        this.d = {
            cpu: 0, threads: [], temp: NaN, gpu: NaN, vram: NaN, gpuState: "", mhz: 0, fan: NaN, load: "",
            top: [], memUsed: 0, memTot: 0, swapUsed: 0, swapTot: 0,
            bat: null, diskUsed: 0, diskTot: 0, rd: 0, wr: 0, nvmeTemp: NaN,
            iface: "", lan: "", ext: "", ping: "", wifi: null, vpn: "",
            down: 0, upl: 0, totDown: 0, totUp: 0, uptime: "", cpuName: "", host: GLib.get_host_name(),
        };
        this.hDown = ring(HIST); this.hUp = ring(HIST); this.hRd = ring(HIST); this.hWr = ring(HIST);
        this.sCpu = ring(SPARK); this.sTemp = ring(SPARK); this.hourCpu = ring(HOUR); this.hourTemp = ring(HOUR);
        this.prevStat = null; this.prevDisk = null; this.prevNet = null;
        this.alertSince = 0; this.tick = 0; this.sysDark = true;

        this.d.cpuName = this._cpuName();
        this.hwTemp = hwmonBy(n => ["coretemp", "k10temp", "zenpower"].includes(n));
        this.hwFan = hwmonBy((n, p) => GLib.file_test(p + "/fan1_input", GLib.FileTest.EXISTS));
        this.hwNvme = hwmonBy(n => n === "nvme");
        this.bat = ["BAT0", "BAT1"].map(b => "/sys/class/power_supply/" + b).find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) || null;
        this.nvidiaDev = this._findNvidia();
        this.diskDev = this._rootDisk();

        this.off = this.bat ? 0 : 82;                 // vertical space taken by the battery panel
        this.MH = MH - this.off; this.H = this.MH + GAP + WH;

        this.canvas = new St.DrawingArea();
        this.canvas.connect("repaint", (area) => this._draw(area));
        this.setContent(this.canvas);
        this.actor.reactive = true;
        this.actor.connect("button-release-event", (a, ev) => this._onClick(ev));
        this._onSettings();

        this._update();
        this.timer = Mainloop.timeout_add_seconds(1, () => { this._update(); return true; });
    }

    on_desklet_removed() { if (this.timer) Mainloop.source_remove(this.timer); }

    // effective scale: fit the desklet into whichever monitor it currently sits on
    _effScale() {
        let s = this.scale;
        let mons = Main.layoutManager.monitors || [], mon = null;
        for (let m of mons) {
            if (this.actor.x >= m.x && this.actor.x < m.x + m.width && this.actor.y >= m.y && this.actor.y < m.y + m.height) { mon = m; break; }
        }
        if (mon) s = Math.min(s, (mon.height - 20) / this.H, (mon.width - 20) / W);
        return s;
    }

    _onSettings() {
        this._sc = this._effScale();
        let h = this.collapsed ? COLH : this.H;
        this.canvas.set_size(Math.round(W * this._sc), Math.round(h * this._sc));
        if (this.lastLoc !== this.weatherLoc) { this.weatherAt = 0; this.lastLoc = this.weatherLoc; }
        this._palette();
        this.canvas.queue_repaint();
    }
    _palette() {
        let dark = this.theme === "dark" || (this.theme !== "light" && this.sysDark);
        this.C = Object.assign({}, dark ? DARK : LIGHT, FIXED, {
            a1: parseColor(this.accent1, [0, 200, 255, 1]), a2: parseColor(this.accent2, [150, 90, 255, 1]),
        });
        this.C.down = this.C.a1; this.C.up = this.C.a2;
    }

    // ---------- one-time discovery ----------
    _cpuName() {
        let m = (readFile("/proc/cpuinfo") || "").match(/model name\s*:\s*(.*)/);
        return m ? m[1].replace(/\((R|TM)\)/g, "").replace(/\s+(CPU|Processor).*$/, "").replace(/\s+/g, " ").trim() : "CPU";
    }
    _findNvidia() {
        try {
            let en = Gio.File.new_for_path("/sys/bus/pci/devices").enumerate_children("standard::name", 0, null), info;
            while ((info = en.next_file(null))) {
                let p = "/sys/bus/pci/devices/" + info.get_name();
                if ((readFile(p + "/vendor") || "").trim() === "0x10de" && /^0x03/.test(readFile(p + "/class") || "")) return p;
            }
        } catch (e) { }
        return null;
    }
    _rootDisk() {
        let m = (readFile("/proc/mounts") || "").match(/^\/dev\/(\S+) \/ /m);
        if (!m) return null;
        let dev = m[1], nv = dev.match(/^(nvme\d+n\d+)p\d+$/), sd = dev.match(/^([a-z]+)\d+$/);
        return nv ? nv[1] : sd ? sd[1] : dev;
    }

    _sh(script, cb) {
        try { Util.spawn_async(["bash", "-c", script], (out) => { try { cb(out.trim()); } catch (e) { } }); }
        catch (e) { }
    }

    // ---------- data ----------
    _update() {
        let d = this.d, t = this.tick++;

        // moved to another monitor? re-fit the scale
        if (this.actor.x !== this._lastX || this.actor.y !== this._lastY) {
            this._lastX = this.actor.x; this._lastY = this.actor.y;
            if (this._effScale() !== this._sc) this._onSettings();
        }

        // CPU total + per thread
        let stat = (readFile("/proc/stat") || "").split("\n").filter(l => /^cpu\d* /.test(l))
            .map(l => { let v = l.trim().split(/\s+/).slice(1).map(Number); return [v.reduce((a, b) => a + b, 0), v[3] + (v[4] || 0)]; });
        if (this.prevStat && this.prevStat.length === stat.length) {
            let pct = stat.map((s, i) => { let dt = s[0] - this.prevStat[i][0], di = s[1] - this.prevStat[i][1]; return dt > 0 ? 100 * (dt - di) / dt : 0; });
            d.cpu = pct[0]; d.threads = pct.slice(1);
            push(this.sCpu, d.cpu); push(this.hourCpu, d.cpu);
        }
        this.prevStat = stat;
        let now = GLib.get_monotonic_time() / 1e6;
        if (d.cpu >= this.loadAlert) { if (!this.alertSince) this.alertSince = now; } else this.alertSince = 0;
        this.alert = this.alertSince && now - this.alertSince >= 30;

        // temperatures, fan
        if (this.hwTemp) {
            let max = NaN;
            for (let i = 1; i < 64; i++) { let v = readNum(`${this.hwTemp}/temp${i}_input`); if (!isNaN(v) && !(v <= max)) max = v; }
            d.temp = max / 1000;
            if (!isNaN(d.temp)) { push(this.sTemp, d.temp); push(this.hourTemp, d.temp); }
        }
        d.fan = this.hwFan ? readNum(this.hwFan + "/fan1_input") : NaN;
        d.nvmeTemp = this.hwNvme ? readNum(this.hwNvme + "/temp1_input") / 1000 : NaN;
        d.load = ((readFile("/proc/loadavg") || "").split(" ")[0]) || "";

        let mh = (readFile("/proc/cpuinfo") || "").match(/cpu MHz\s*:\s*[\d.]+/g) || [];
        d.mhz = mh.length ? mh.reduce((a, s) => a + parseFloat(s.split(":")[1]), 0) / mh.length : 0;

        // battery
        if (this.bat) {
            let b = this.bat, st = (readFile(b + "/status") || "").trim(), cap = readNum(b + "/capacity");
            let p = readNum(b + "/power_now");
            if (isNaN(p)) p = readNum(b + "/current_now") * readNum(b + "/voltage_now") / 1e6;
            let en = readNum(b + "/energy_now"), ef = readNum(b + "/energy_full");
            if (isNaN(en)) { en = readNum(b + "/charge_now"); ef = readNum(b + "/charge_full"); }
            let left = "";
            if (p > 0 && st === "Discharging") left = this._hm(en / p) + " left";
            else if (p > 0 && st === "Charging") left = this._hm((ef - en) / p) + " to full";
            d.bat = { cap, st, w: p / 1e6, left };
        }

        // memory
        let mi = {};
        (readFile("/proc/meminfo") || "").split("\n").forEach(l => { let m = l.match(/^(\w+):\s+(\d+)/); if (m) mi[m[1]] = +m[2] * 1024; });
        d.memTot = mi.MemTotal; d.memUsed = mi.MemTotal - mi.MemAvailable;
        d.swapTot = mi.SwapTotal; d.swapUsed = mi.SwapTotal - mi.SwapFree;

        // disk usage + io
        if (t % 10 === 0) {
            try {
                let info = Gio.File.new_for_path("/").query_filesystem_info("filesystem::size,filesystem::free", null);
                d.diskTot = info.get_attribute_uint64("filesystem::size");
                d.diskUsed = d.diskTot - info.get_attribute_uint64("filesystem::free");
            } catch (e) { }
        }
        if (this.diskDev) {
            let m = (readFile("/proc/diskstats") || "").split("\n").map(l => l.trim().split(/\s+/)).find(f => f[2] === this.diskDev);
            if (m) {
                let cur = [+m[5] * 512, +m[9] * 512];
                if (this.prevDisk) { d.rd = cur[0] - this.prevDisk[0]; d.wr = cur[1] - this.prevDisk[1]; push(this.hRd, d.rd); push(this.hWr, d.wr); }
                this.prevDisk = cur;
            }
        }

        // network interface, wifi, vpn
        if (t % 10 === 0) {
            this._sh("dev=$(ip -4 route show default | sort -t' ' -k9 -n | head -1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); echo \"$dev\"; " +
                "ip -4 -o addr show dev \"$dev\" | awk '{print $4}' | cut -d/ -f1 | head -1",
                (out) => { let [i, a] = out.split("\n"); if (i !== d.iface) this.prevNet = null; d.iface = i || ""; d.lan = a || ""; });
            let wl = (readFile("/proc/net/wireless") || "").split("\n").slice(2).map(l => l.trim().split(/\s+/)).find(f => f.length > 3);
            if (wl) {
                let dev = wl[0].replace(":", ""), dbm = parseFloat(wl[3]);
                this._sh(`nmcli -t -g GENERAL.CONNECTION dev show ${dev} 2>/dev/null`, (o) => { d.wifi = o ? { ssid: o, dbm } : null; });
            } else d.wifi = null;
            this._sh("nmcli -t -f NAME,TYPE con show --active 2>/dev/null | awk -F: '$2 ~ /wireguard|vpn/ {print $1; exit}'", (o) => { d.vpn = o; });
            this._sh("gsettings get org.x.apps.portal color-scheme 2>/dev/null; gsettings get org.cinnamon.desktop.interface gtk-theme", (o) => {
                let dark = /prefer-dark/.test(o) || (!/prefer-light/.test(o) && /dark/i.test(o));
                if (dark !== this.sysDark) { this.sysDark = dark; this._palette(); }
            });
        }
        if (d.iface) {
            let rx = readNum(`/sys/class/net/${d.iface}/statistics/rx_bytes`), tx = readNum(`/sys/class/net/${d.iface}/statistics/tx_bytes`);
            if (this.prevNet) { d.down = Math.max(0, rx - this.prevNet[0]); d.upl = Math.max(0, tx - this.prevNet[1]); }
            this.prevNet = [rx, tx]; d.totDown = rx; d.totUp = tx;
            push(this.hDown, d.down); push(this.hUp, d.upl);
        }

        let up = readNum("/proc/uptime");
        if (!isNaN(up)) d.uptime = `UP ${Math.floor(up / 86400)}d ${String(Math.floor(up % 86400 / 3600)).padStart(2, "0")}h ${String(Math.floor(up % 3600 / 60)).padStart(2, "0")}m`;

        // GPU (NVIDIA) — only query when the card is awake, so we never wake a sleeping dGPU
        if (t % 3 === 0 && this.nvidiaDev) {
            let rs = (readFile(this.nvidiaDev + "/power/runtime_status") || "active").trim();
            if (rs !== "active") { d.gpu = NaN; d.vram = NaN; d.gpuState = "sleep"; d.gpuTemp = undefined; }
            else this._sh("nvidia-smi --query-gpu=utilization.gpu,memory.used,fan.speed,temperature.gpu --format=csv,noheader,nounits", (out) => {
                let [u, m, f, gt] = out.split(",").map(s => parseFloat(s));
                d.vram = m * 1024 * 1024;
                if (!isNaN(gt)) d.gpuTemp = gt;
                if (!isNaN(f)) d.fanPct = f;          // GPU fan (%), fallback when no hwmon fan
                else if (isNaN(u)) d.fanPct = undefined;
                if (isNaN(u))
                    // old 470-era drivers report N/A; fall back to nvidia-settings
                    this._sh("nvidia-settings -q GPUUtilization -t 2>/dev/null | sed -n 's/.*graphics=\\([0-9]*\\).*/\\1/p'", (o) => {
                        d.gpu = parseFloat(o); d.gpuState = isNaN(d.gpu) ? "n/a" : "";
                    });
                else { d.gpu = u; d.gpuState = ""; }
            });
        }

        if (t % 3 === 0)
            this._sh("top -b -n2 -d0.5 -o %CPU -w 512 | awk '/^ *PID/{n++;next} n==2{print $12\" \"$9; if(++c==3) exit}'", (out) => {
                d.top = out.split("\n").filter(l => l).map(l => { let p = l.split(" "); return [p[0], (parseFloat(p[1]) / (d.threads.length || 1)) || 0]; });
            });

        if (t % 5 === 0)
            this._sh(`ping -c1 -W2 ${GLib.shell_quote(this.pingHost || "1.1.1.1")} | sed -n 's/.*time=\\([0-9.]*\\).*/\\1/p'`,
                (out) => { d.ping = out ? Math.round(parseFloat(out)) + " ms" : "— ms"; });

        // external IP + country flag
        if (t % 600 === 0) this._sh("curl -s -m 8 https://ipinfo.io/json", (out) => {
            try {
                let j = JSON.parse(out); d.ext = j.ip || d.ext;
                let cc = (j.country || "").toLowerCase();
                if (/^[a-z]{2}$/.test(cc) && cc !== this.cc) {
                    let f = `${CACHE}/flag-${cc}.png`;
                    let load = () => { try { this.flag = Cairo.ImageSurface.createFromPNG(f); this.cc = cc; } catch (e) { } };
                    if (GLib.file_test(f, GLib.FileTest.EXISTS)) load();
                    else this._sh(`curl -s -m 8 -o '${f}' https://flagcdn.com/w40/${cc}.png && echo ok`, (o) => { if (o === "ok") load(); });
                }
            } catch (e) { }
        });

        // weather (wttr.in JSON), every weatherMins minutes
        let wnow = Date.now(), period = (this.weatherMins || 30) * 60000;
        if (!this.weatherAt || wnow - this.weatherAt > period) {
            this.weatherAt = wnow;
            let loc = (this.weatherLoc || "").trim().replace(/\s*,\s*/g, ",").replace(/\s+/g, "+");
            this._sh(`curl -s -m 15 'https://wttr.in/${encodeURI(loc)}?format=j1&lang=en'`, (out) => {
                try { this.wx = this._parseWeather(JSON.parse(out)); }
                catch (e) { this.weatherAt = wnow - period + 60000; }   // retry in a minute
            });
        }

        this.canvas.queue_repaint();
    }
    _hm(h) { let m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; }

    _parseWeather(j) {
        let c = j.current_condition[0], a = (j.nearest_area || [{}])[0], astro = j.weather[0].astronomy[0];
        // next 12 h from the 3-hourly forecast of today + tomorrow
        let nowH = GLib.DateTime.new_now_local().get_hour(), hours = [];
        j.weather.slice(0, 2).forEach((w, di) => w.hourly.forEach(h => {
            let hh = +h.time / 100 + di * 24;
            if (hh >= nowH - 1 && hours.length < 6) hours.push({ h: hh % 24, t: +h.tempC, rain: +h.chanceofrain, code: +h.weatherCode });
        }));
        return {
            place: this.weatherLoc ? this.weatherLoc.split(",")[0].trim() : (a.areaName ? a.areaName[0].value : ""),
            temp: +c.temp_C, feels: +c.FeelsLikeC, hum: +c.humidity, wind: +c.windspeedKmph, dir: c.winddir16Point,
            desc: c.weatherDesc[0].value.trim(), code: +c.weatherCode,
            sunrise: to24(astro.sunrise), sunset: to24(astro.sunset), moon: astro.moon_phase, illum: +astro.moon_illumination,
            hours,
            days: j.weather.slice(0, 3).map(w => ({ date: w.date, max: +w.maxtempC, min: +w.mintempC, code: +(w.hourly[4] || w.hourly[0]).weatherCode, rain: Math.max(...w.hourly.map(h => +h.chanceofrain || 0)) })),
            at: GLib.DateTime.new_now_local().format("%H:%M"),
        };
    }
    _isNight() {
        let w = this.wx; if (!w || !w.sunrise) return false;
        let n = GLib.DateTime.new_now_local(), m = n.get_hour() * 60 + n.get_minute();
        return m < minutesOf(w.sunrise) || m > minutesOf(w.sunset);
    }

    // ---------- clicks ----------
    _onClick(ev) {
        let [ex, ey] = ev.get_coords();
        let [ax, ay] = this.canvas.get_transformed_position();
        let y = (ey - ay) / (this._sc || 1);
        if (y < 55) { this.collapsed = !this.collapsed; this._onSettings(); return true; }
        if (this.collapsed) return false;
        let o = this.off;
        if (y < 360) Util.spawnCommandLine("gnome-system-monitor");
        else if (this.bat && y > 380 && y < 445) Util.spawnCommandLine("cinnamon-settings power");
        else if (y > 580 - o && y < 715 - o) Util.spawnCommandLine("nemo /");
        else if (y > 720 - o && y < this.MH) Util.spawnCommandLine("cinnamon-settings network");
        else if (y > this.MH + GAP) Util.spawnCommandLine("xdg-open https://wttr.in/" + encodeURI((this.weatherLoc || "").replace(/\s+/g, "+")));
        return false;
    }

    // ---------- drawing primitives ----------
    _col(cr, c, a) { cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, a === undefined ? (c[3] === undefined ? 1 : c[3]) : a); }
    _font(cr, size, bold) { cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL); cr.setFontSize(size); }
    _text(cr, s, x, y, align, col, size, bold) {
        this._font(cr, size, bold); this._col(cr, col);
        let w = cr.textExtents(s).xAdvance;
        cr.moveTo(align === "r" ? x - w : align === "c" ? x - w / 2 : x, y);
        cr.showText(s);
        return w;
    }
    _fit(cr, s, maxw, size, bold) {
        this._font(cr, size, bold);
        if (cr.textExtents(s).xAdvance <= maxw) return s;
        while (s.length > 1 && cr.textExtents(s + "…").xAdvance > maxw) s = s.slice(0, -1);
        return s + "…";
    }
    _rrect(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }
    _grad(x0, x1, c0, c1) {
        let g = new Cairo.LinearGradient(x0, 0, x1, 0);
        g.addColorStopRGBA(0, c0[0] / 255, c0[1] / 255, c0[2] / 255, 1);
        g.addColorStopRGBA(1, c1[0] / 255, c1[1] / 255, c1[2] / 255, 1);
        return g;
    }
    _card(cr, y, h, top) {
        let C = this.C;
        cr.newPath(); this._rrect(cr, 0.5, y + 0.5, W - 1, h - 1, 16);
        let bg = new Cairo.LinearGradient(0, y, 0, y + h);
        bg.addColorStopRGBA(0, top[0] / 255, top[1] / 255, top[2] / 255, this.bgAlpha);
        bg.addColorStopRGBA(1, C.bg[0] / 255, C.bg[1] / 255, C.bg[2] / 255, this.bgAlpha);
        cr.setSource(bg); cr.fillPreserve();
        this._col(cr, C.border); cr.setLineWidth(1); cr.stroke();
    }
    // usage colour: accent gradient, then amber / red when nearly full
    _bar(cr, x, y, w, h, pct, warnAt) {
        let C = this.C;
        cr.newPath(); this._rrect(cr, x, y, w, h, h / 2); this._col(cr, C.track); cr.fill();
        let fw = Math.max(0, Math.min(1, pct / 100)) * w;
        if (fw < h) return;
        cr.newPath(); this._rrect(cr, x, y, fw, h, h / 2);
        if (warnAt && pct >= warnAt + 15) cr.setSource(this._grad(x, x + w, [255, 138, 60], C.hot));
        else if (warnAt && pct >= warnAt) cr.setSource(this._grad(x, x + w, C.warn, [255, 138, 60]));
        else cr.setSource(this._grad(x, x + w, C.a2, C.a1));
        cr.fill();
    }
    _pctColor(pct, warnAt) { return pct >= warnAt + 15 ? this.C.hot : pct >= warnAt ? this.C.warn : this.C.text; }
    _ring(cr, cx, cy, r, pct, label, value, color, lw = 9) {
        let C = this.C;
        cr.setLineCap(Cairo.LineCap.ROUND);
        if (label) this._text(cr, label, cx, cy - r - 14, "c", C.text, 12, true);
        cr.newPath(); cr.setLineWidth(lw); this._col(cr, C.track); cr.arc(cx, cy, r, 0, 2 * Math.PI); cr.stroke();
        let p = Math.max(0, Math.min(1, (pct || 0) / 100));
        if (p > 0.005) {
            let a0 = -Math.PI / 2, a1 = a0 + p * 2 * Math.PI;
            cr.setLineWidth(lw * 1.8);
            this._col(cr, color || C.a1, 0.16);
            cr.newPath(); cr.arc(cx, cy, r, a0, a1); cr.stroke();
            cr.setLineWidth(lw);
            if (color) this._col(cr, color); else cr.setSource(this._grad(cx - r, cx + r, C.a1, C.a2));
            cr.newPath(); cr.arc(cx, cy, r, a0, a1); cr.stroke();
        }
        if (value) this._text(cr, value, cx, cy + r * 0.22, "c", C.text, r * 0.62, false);
    }
    _arrow(cr, x, y, up, col, size) {
        let h = size * 0.8, w = size * 0.55, top = y - h, mid = x + w / 2;
        this._col(cr, col); cr.setLineWidth(size / 8); cr.setLineCap(Cairo.LineCap.ROUND); cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.newPath(); cr.moveTo(mid, top); cr.lineTo(mid, y); cr.stroke();
        cr.newPath();
        if (up) { cr.moveTo(x, top + w / 2); cr.lineTo(mid, top); cr.lineTo(x + w, top + w / 2); }
        else { cr.moveTo(x, y - w / 2); cr.lineTo(mid, y); cr.lineTo(x + w, y - w / 2); }
        cr.stroke();
        return w + size * 0.35;
    }
    _divider(cr, y) { this._col(cr, this.C.divider); cr.newPath(); cr.rectangle(20, y, W - 40, 1); cr.fill(); }
    _h4(cr, s, y) { this._text(cr, s, 20, y, "l", this.C.label, 11, true); }
    // area/line graph of a ring buffer (logy = logarithmic scale)
    _graph(cr, x, y, w, h, data, col, fill, maxv, logy) {
        let n = data.length, first = data.findIndex(v => !isNaN(v));
        if (first < 0) return;
        let lmax = Math.log1p(maxv);
        let norm = v => Math.min(1, logy ? Math.log1p(Math.max(0, v)) / lmax : Math.max(0, v) / maxv);
        cr.newPath();
        for (let i = first; i < n; i++) {
            let v = isNaN(data[i]) ? 0 : data[i];
            let px = x + i * w / (n - 1), py = y + h - norm(v) * h;
            if (i === first) cr.moveTo(px, py); else cr.lineTo(px, py);
        }
        if (fill) {
            cr.lineTo(x + w, y + h); cr.lineTo(x + first * w / (n - 1), y + h); cr.closePath();
            let g = new Cairo.LinearGradient(0, y, 0, y + h);
            g.addColorStopRGBA(0, col[0] / 255, col[1] / 255, col[2] / 255, 0.45);
            g.addColorStopRGBA(1, col[0] / 255, col[1] / 255, col[2] / 255, 0.02);
            cr.setSource(g); cr.fill();
        } else { cr.setLineWidth(1.2); cr.setLineJoin(Cairo.LineJoin.ROUND); this._col(cr, col); cr.stroke(); }
    }
    _ioGraph(cr, x, y, w, h, a, b) {
        let A = ordered(a), B = ordered(b);
        let mx = Math.max(1024, ...A.filter(v => !isNaN(v)), ...B.filter(v => !isNaN(v)));
        this._col(cr, this.C.track); cr.newPath(); cr.rectangle(x, y + h, w, 1); cr.fill();
        this._graph(cr, x, y, w, h, A, this.C.a1, true, mx);
        this._graph(cr, x, y, w, h, A, this.C.a1, false, mx);
        this._graph(cr, x, y, w, h, B, this.C.a2, false, mx);
    }

    // ---------- weather icons ----------
    _cloud(cr, x, y, r, col) {
        this._col(cr, col);
        cr.newPath(); cr.arc(x - r * 0.55, y + r * 0.1, r * 0.5, 0, 2 * Math.PI); cr.fill();
        cr.newPath(); cr.arc(x + r * 0.05, y - r * 0.25, r * 0.65, 0, 2 * Math.PI); cr.fill();
        cr.newPath(); cr.arc(x + r * 0.62, y + r * 0.12, r * 0.45, 0, 2 * Math.PI); cr.fill();
        cr.newPath(); this._rrect(cr, x - r * 0.95, y + r * 0.05, r * 1.95, r * 0.55, r * 0.27); cr.fill();
    }
    _sun(cr, x, y, r) {
        this._col(cr, this.C.sun); cr.newPath(); cr.arc(x, y, r * 0.5, 0, 2 * Math.PI); cr.fill();
        cr.setLineWidth(r * 0.12); cr.setLineCap(Cairo.LineCap.ROUND);
        for (let i = 0; i < 8; i++) {
            let a = i * Math.PI / 4;
            cr.newPath(); cr.moveTo(x + Math.cos(a) * r * 0.68, y + Math.sin(a) * r * 0.68);
            cr.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9); cr.stroke();
        }
    }
    // moon disc lit by illumination % (waxing = lit on the right)
    _moon(cr, x, y, r, illum, waxing) {
        let lit = [235, 232, 210, 1];
        this._col(cr, this.C.track[0] > 128 ? [70, 74, 90, 1] : [200, 204, 214, 1]); cr.newPath(); cr.arc(x, y, r, 0, 2 * Math.PI); cr.fill();
        let k = 1 - 2 * Math.max(0, Math.min(100, illum)) / 100;   // terminator x-scale: 1 new .. -1 full
        cr.save(); cr.translate(x, y); if (!waxing) cr.scale(-1, 1);
        cr.newPath(); cr.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
        cr.save(); cr.scale(k || 0.001, 1); cr.arcNegative(0, 0, r, Math.PI / 2, -Math.PI / 2); cr.restore();
        cr.closePath(); this._col(cr, lit); cr.fill();
        cr.restore();
    }
    _wicon(cr, x, y, r, code, night) {
        const rain = [176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359];
        const snow = [179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377];
        const storm = [200, 386, 389, 392, 395];
        const fog = [143, 248, 260];
        let C = this.C, w = this.wx;
        let sky = (cx, cy, rr) => night ? this._moon(cr, cx, cy, rr * 0.5, w ? w.illum : 60, w ? /waxing|first/i.test(w.moon) : true) : this._sun(cr, cx, cy, rr);
        if (code === 113) return sky(x, y, r);
        if (code === 116) { sky(x - r * 0.35, y - r * 0.35, r * 0.75); return this._cloud(cr, x + r * 0.1, y + r * 0.15, r * 0.75, C.cloud); }
        if (fog.includes(code)) {
            cr.setLineWidth(r * 0.14); cr.setLineCap(Cairo.LineCap.ROUND); this._col(cr, C.cloud);
            for (let i = 0; i < 3; i++) { cr.newPath(); cr.moveTo(x - r * 0.8 + i * r * 0.15, y - r * 0.4 + i * r * 0.4); cr.lineTo(x + r * 0.8 - i * r * 0.1, y - r * 0.4 + i * r * 0.4); cr.stroke(); }
            return;
        }
        let wet = rain.includes(code), cold = snow.includes(code), zap = storm.includes(code);
        this._cloud(cr, x, y - (wet || cold || zap ? r * 0.25 : 0), r * 0.85, wet || zap ? C.cloudDark : C.cloud);
        if (wet) {
            cr.setLineWidth(r * 0.1); cr.setLineCap(Cairo.LineCap.ROUND); this._col(cr, C.a1);
            for (let i = -1; i <= 1; i++) { cr.newPath(); cr.moveTo(x + i * r * 0.4, y + r * 0.45); cr.lineTo(x + i * r * 0.4 - r * 0.12, y + r * 0.8); cr.stroke(); }
        } else if (cold) {
            this._col(cr, [200, 215, 255, 1]);
            for (let i = -1; i <= 1; i++) { cr.newPath(); cr.arc(x + i * r * 0.4, y + r * 0.62, r * 0.09, 0, 2 * Math.PI); cr.fill(); }
        } else if (zap) {
            this._col(cr, C.sun); cr.newPath();
            cr.moveTo(x + r * 0.05, y + r * 0.3); cr.lineTo(x - r * 0.2, y + r * 0.65); cr.lineTo(x, y + r * 0.65);
            cr.lineTo(x - r * 0.12, y + r * 0.95); cr.lineTo(x + r * 0.25, y + r * 0.55); cr.lineTo(x + r * 0.05, y + r * 0.55); cr.closePath(); cr.fill();
        }
    }

    // ---------- panels ----------
    _draw(area) {
        try { this._drawInner(area); } catch (e) { global.log("COREGLOW DRAW ERROR: " + e + "\n" + e.stack); }
    }
    _drawInner(area) {
        let cr = area.get_context();
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
        let sc = this._sc || 1;
        cr.scale(sc, sc);
        if (this.collapsed) this._drawCollapsed(cr);
        else { this._drawMain(cr); this._drawWeather(cr, this.MH + GAP); }
        cr.restore();
        cr.$dispose();
    }

    _drawHeader(cr) {
        let C = this.C, d = this.d;
        this._col(cr, C.a1); cr.newPath(); cr.arc(24, 23, 4, 0, 2 * Math.PI); cr.fill();
        let nowd = GLib.DateTime.new_now_local();
        let tw = this._text(cr, nowd.format("%H:%M  ·  %a %d %b"), W - 20, 28, "r", C.text, 14, true);
        let hs = 14, hmax = W - 20 - tw - 10 - 34;
        while (hs > 9) { this._font(cr, hs, true); if (cr.textExtents(d.host).xAdvance <= hmax) break; hs -= 0.5; }
        this._text(cr, this._fit(cr, d.host, hmax, hs, true), 34, 28, "l", C.text, hs, true);
    }

    _drawCollapsed(cr) {
        let C = this.C, d = this.d, w = this.wx;
        this._card(cr, 0, COLH, C.bgTop);
        this._drawHeader(cr);
        let tc = d.temp >= 80 ? C.hot : d.temp >= 60 ? C.warn : C.ok;
        this._ring(cr, 40, 64, 16, d.cpu, null, Math.round(d.cpu) + "", this.alert ? C.hot : null, 5);
        this._ring(cr, 86, 64, 16, d.temp, null, isNaN(d.temp) ? "—" : Math.round(d.temp) + "°", tc, 5);
        this._text(cr, "CPU · TEMP", 63, 88, "c", C.label, 8, true);
        if (w) {
            this._wicon(cr, 140, 62, 14, w.code, this._isNight());
            this._text(cr, Math.round(w.temp) + "°", 160, 70, "l", C.text, 20);
            this._text(cr, this._fit(cr, w.place + " · " + w.desc, W - 20 - 205, 10), W - 20, 60, "r", C.label, 10);
            this._text(cr, `${w.days[0].min}° / ${w.days[0].max}°`, W - 20, 76, "r", C.a1, 10);
        }
    }

    _drawMain(cr) {
        let C = this.C, d = this.d;
        this._card(cr, 0, this.MH, C.bgTop);
        this._drawHeader(cr);
        this._text(cr, d.cpuName, 20, 47, "l", C.label, 11);
        this._text(cr, d.uptime, W - 20, 47, "r", C.label, 11);

        // rings + 1 h min/avg/max
        let tc = d.temp >= 80 ? C.hot : d.temp >= 60 ? C.warn : C.ok;
        this._ring(cr, 55, 120, 34, d.cpu, "CPU", Math.round(d.cpu) + "%", this.alert ? C.hot : null);
        this._ring(cr, 150, 120, 38, d.temp, "MAX TEMP", isNaN(d.temp) ? "—" : Math.round(d.temp) + "°", tc);
        this._ring(cr, 245, 120, 34, d.gpu, "GPU", isNaN(d.gpu) ? (d.gpuState || "—") : Math.round(d.gpu) + "%", null);
        let sc = stats(this.hourCpu), st = stats(this.hourTemp);
        let mm = (s, u) => s ? `${Math.round(s.min)} · ${Math.round(s.avg)} · ${Math.round(s.max)}${u}` : "—";
        this._text(cr, mm(sc, "%"), 55, 176, "c", C.label, 9);
        this._text(cr, mm(st, "°"), 150, 176, "c", C.label, 9);
        this._text(cr, isNaN(d.vram) ? "VRAM —" : "VRAM " + fmtBytes(d.vram), 245, 176, "c", C.label, 9);

        // cpu / temp sparkline (10 min)
        let gx = 20, gy = 186, gw = W - 40, gh = 36;
        this._col(cr, C.track); cr.newPath(); cr.rectangle(gx, gy + gh, gw, 1); cr.fill();
        let cpuS = ordered(this.sCpu), tmpS = ordered(this.sTemp).map(v => isNaN(v) ? NaN : Math.max(0, v - 30));
        this._graph(cr, gx, gy, gw, gh, cpuS, C.a1, true, 100, true);
        // temperature: dynamic window range, so 1-2° changes are actually visible
        let tvals = tmpS.filter(v => !isNaN(v));
        let tlo = tvals.length ? Math.min(...tvals) : 0, thi = tvals.length ? Math.max(...tvals) : 70;
        let tspan = Math.max(4, thi - tlo);
        this._graph(cr, gx, gy, gw, gh, tmpS.map(v => isNaN(v) ? NaN : v - tlo), tc, false, tspan);
        this._text(cr, "CPU (log) & TEMP · 10 MIN", gx, gy + gh + 12, "l", C.label, 8.5, true);
        this._text(cr, "1h  min · avg · max", W - 20, gy + gh + 12, "r", C.label, 8.5);

        // per-thread bars
        let n = d.threads.length;
        if (n) {
            let step = gw / n, bw = Math.max(step - 2, 1), top = 244, bh = 30;
            for (let i = 0; i < n; i++) {
                let x = gx + i * step, v = d.threads[i];
                this._col(cr, C.track); cr.newPath(); cr.rectangle(x, top, bw, bh); cr.fill();
                let h = Math.max(1.5, v / 100 * bh);
                this._col(cr, v >= 80 ? C.hot : v >= 50 ? C.warn : C.a1); cr.newPath(); cr.rectangle(x, top + bh - h, bw, h); cr.fill();
            }
        }

        // clock / fan / load
        let kv = (k, v, x, align) => {
            if (align === "r") { let vw = this._text(cr, v, x, 298, "r", C.text, 13); this._text(cr, k + " ", x - vw, 298, "r", C.label, 9.5, true); }
            else { let kw = this._text(cr, k + " ", x, 298, "l", C.label, 9.5, true); this._text(cr, v, x + kw, 298, "l", C.text, 13); }
        };
        kv("CLK", Math.round(d.mhz) + " MHz", 20);
        if (!isNaN(d.fan)) kv("FAN", Math.round(d.fan) + " rpm", 130);
        else kv("GPU", d.gpuTemp !== undefined ? Math.round(d.gpuTemp) + "°" : "—", 130);
        kv("LOAD", d.load, W - 20, "r");
        this._text(cr, "TOP", 20, 322, "l", C.label, 9.5, true);
        d.top.forEach((p, i) => {
            let y = 322 + i * 16, col = i ? C.label : C.text;
            this._text(cr, this._fit(cr, p[0], 170, 11), 56, y, "l", col, 11);
            this._text(cr, p[1].toFixed(1) + "%", W - 20, y, "r", col, 11);
        });
        this._divider(cr, 364);

        // battery (desktops without a battery skip the panel and the rest shifts up)
        let b = d.bat;
        if (b) {
            this._h4(cr, "BATTERY", 388);
            let low = b.cap <= 20 && b.st === "Discharging";
            this._text(cr, b.st === "Discharging" ? "BAT" : "AC", 20, 414, "l", C.text, 13);
            cr.newPath(); this._rrect(cr, 72, 407, 176, 6, 3); this._col(cr, C.track); cr.fill();
            let fw = Math.max(6, b.cap / 100 * 176);
            cr.newPath(); this._rrect(cr, 72, 407, fw, 6, 3);
            if (low) this._col(cr, C.hot); else if (b.st === "Charging") cr.setSource(this._grad(72, 248, C.ok, C.a1)); else cr.setSource(this._grad(72, 248, C.a2, C.a1));
            cr.fill();
            this._text(cr, Math.round(b.cap) + "%", W - 20, 414, "r", low ? C.hot : C.text, 13);
            let state = b.st === "Discharging" ? `Discharging · ${b.w.toFixed(1)} W` : b.st === "Charging" ? `Charging · ${b.w.toFixed(1)} W` : (b.st || "On AC");
            this._text(cr, state, 72, 432, "l", C.label, 10);
            this._text(cr, b.left, W - 20, 432, "r", C.label, 10);
            this._divider(cr, 446);
        } else cr.save(), cr.translate(0, -this.off);

        // memory
        this._h4(cr, "MEMORY", 472);
        let mp = d.memTot ? 100 * d.memUsed / d.memTot : 0, sp = d.swapTot ? 100 * d.swapUsed / d.swapTot : 0;
        this._text(cr, "RAM", 20, 498, "l", C.text, 13);
        this._bar(cr, 72, 491, 176, 6, mp, 75);
        this._text(cr, Math.round(mp) + "%", W - 20, 498, "r", this._pctColor(mp, 75), 13);
        this._text(cr, `${fmtBytes(d.memUsed)} / ${fmtBytes(d.memTot)}`, 72, 516, "l", C.label, 10);
        this._text(cr, "SWAP", 20, 542, "l", C.text, 13);
        this._bar(cr, 72, 535, 176, 6, sp, 75);
        this._text(cr, Math.round(sp) + "%", W - 20, 542, "r", this._pctColor(sp, 75), 13);
        this._text(cr, `${fmtBytes(d.swapUsed)} / ${fmtBytes(d.swapTot)}`, 72, 560, "l", C.label, 10);
        this._divider(cr, 574);

        // storage
        this._h4(cr, "STORAGE", 600);
        let dp = d.diskTot ? 100 * d.diskUsed / d.diskTot : 0;
        this._text(cr, "/", 20, 626, "l", C.text, 13);
        this._bar(cr, 72, 619, 176, 6, dp, 80);
        this._text(cr, Math.round(dp) + "%", W - 20, 626, "r", this._pctColor(dp, 80), 13);
        this._text(cr, `${fmtBytes(d.diskUsed)} / ${fmtBytes(d.diskTot)}`, 72, 644, "l", C.label, 10);
        if (!isNaN(d.nvmeTemp)) {
            let nt = d.nvmeTemp, ncol = nt >= 70 ? C.hot : nt >= 55 ? C.warn : C.ok;
            let vw = this._text(cr, Math.round(nt) + "°", W - 20, 644, "r", ncol, 10, true);
            this._text(cr, "NVMe ", W - 20 - vw, 644, "r", C.label, 10);
        }
        this._ioGraph(cr, 20, 652, W - 40, 38, this.hRd, this.hWr);
        this._text(cr, "R " + fmtBytes(d.rd, "/s"), 20, 706, "l", C.a1, 11);
        this._text(cr, "W " + fmtBytes(d.wr, "/s"), W - 20, 706, "r", C.a2, 11);
        this._divider(cr, 718);

        // network
        this._h4(cr, "NETWORK", 744);
        let pw = this._text(cr, (d.iface ? d.iface + "   " : "") + (d.ping || "—"), W - 20, 744, "r", C.text, 11);
        cr.setLineWidth(1.4); this._col(cr, C.text); cr.newPath(); cr.arc(W - 26 - pw, 740, 4.5, 0, 2 * Math.PI); cr.stroke();
        cr.newPath(); cr.arc(W - 26 - pw, 740, 2, 0, 2 * Math.PI); cr.fill();

        // wifi + vpn chips
        let chip = (x, label, col, iconW, align) => {
            this._font(cr, 10, false);
            let tw = cr.textExtents(label).xAdvance, cw = tw + iconW + 14, cx = align === "r" ? x - cw : x;
            cr.newPath(); this._rrect(cr, cx, 757, cw, 16, 8); this._col(cr, C.track); cr.fill();
            this._text(cr, label, cx + 7 + iconW, 769, "l", col, 10);
            return cx + 7;
        };
        if (d.wifi) {
            let q = d.wifi.dbm, bars = q >= -55 ? 4 : q >= -65 ? 3 : q >= -75 ? 2 : 1;
            let ix = chip(20, this._fit(cr, `${d.wifi.ssid} · ${Math.round(q)} dBm`, 150, 10), C.text, 16, "l");
            for (let i = 0; i < 4; i++) { this._col(cr, i < bars ? C.a1 : C.track); cr.newPath(); cr.rectangle(ix + i * 3.5, 769 - 3 - i * 2.2, 2.4, 3 + i * 2.2); cr.fill(); }
        }
        if (d.vpn) {
            let ix = chip(W - 20, this._fit(cr, "VPN " + d.vpn, 170, 9.5), C.ok, 10, "r");
            this._col(cr, C.ok); cr.newPath(); cr.arc(ix + 3, 765, 3, 0, 2 * Math.PI); cr.fill();
        }

        let ew = this._text(cr, "Ext ", 20, 792, "l", C.label, 11);
        if (this.flag) {
            let fw = this.flag.getWidth(), fh = this.flag.getHeight(), k = 11 / fh;
            cr.save(); cr.translate(20 + ew, 782); cr.scale(k, k);
            cr.setSourceSurface(this.flag, 0, 0); cr.newPath(); this._rrect(cr, 0, 0, fw, fh, 2 / k); cr.fill(); cr.restore();
            ew += fw * k + 5;
        }
        this._text(cr, d.ext || "—", 20 + ew, 792, "l", C.text, 11);
        let lw = this._text(cr, d.lan || "—", W - 20, 792, "r", C.text, 11);
        this._text(cr, "LAN ", W - 20 - lw, 792, "r", C.label, 11);

        let dx = 20 + this._arrow(cr, 20, 814, false, C.down, 14);
        this._text(cr, fmtBytes(d.down, "/s"), dx, 814, "l", C.down, 14);
        let uw = this._text(cr, fmtBytes(d.upl, "/s"), W - 20, 814, "r", C.up, 14);
        this._arrow(cr, W - 20 - uw - 13, 814, true, C.up, 14);
        this._ioGraph(cr, 20, 824, W - 40, 50, this.hDown, this.hUp);

        let tx = 20 + this._text(cr, "Total:  ", 20, 894, "l", C.label, 11);
        tx += this._arrow(cr, tx, 894, false, C.down, 11);
        tx += this._text(cr, fmtBytes(d.totDown) + "    ", tx, 894, "l", C.label, 11);
        tx += this._arrow(cr, tx, 894, true, C.up, 11);
        this._text(cr, fmtBytes(d.totUp), tx, 894, "l", C.label, 11);
        if (!b) cr.restore();
    }

    _drawWeather(cr, y0) {
        let C = this.C, w = this.wx;
        this._card(cr, y0, WH, C.wxTop);
        this._h4(cr, "WEATHER", y0 + 26);
        if (!w) { this._text(cr, "loading…", W / 2, y0 + 120, "c", C.label, 12); return; }
        this._text(cr, w.place + "  ·  " + w.at, W - 20, y0 + 26, "r", C.label, 10);
        let night = this._isNight();

        this._wicon(cr, 50, y0 + 70, 28, w.code, night);
        this._text(cr, Math.round(w.temp) + "°", 90, y0 + 84, "l", C.text, 34);
        this._text(cr, this._fit(cr, w.desc, 110, 11), 92, y0 + 104, "l", C.a1, 11);
        [["Feels", w.feels + "°"], ["Humidity", w.hum + "%"], ["Wind", `${w.wind} km/h ${w.dir}`]].forEach((r, i) => {
            let y = y0 + 58 + i * 18;
            let vw = this._text(cr, r[1], W - 20, y, "r", C.text, 11);
            this._text(cr, r[0] + "  ", W - 20 - vw, y, "r", C.label, 10);
        });

        // sunrise / sunset / moon
        let sy = y0 + 128;
        this._sun(cr, 27, sy - 4, 8); let x = 38 + this._arrow(cr, 38, sy, true, C.label, 9);
        this._text(cr, w.sunrise, x, sy, "l", C.text, 10);
        this._sun(cr, 108, sy - 4, 8); x = 119 + this._arrow(cr, 119, sy, false, C.label, 9);
        this._text(cr, w.sunset, x, sy, "l", C.text, 10);
        let mw = this._text(cr, `${w.moon} ${w.illum}%`, W - 20, sy, "r", C.label, 9.5);
        this._moon(cr, W - 28 - mw, sy - 4, 5.5, w.illum, /waxing|first/i.test(w.moon));

        // hourly: temperature line + rain bars
        let hs = w.hours, gx = 28, gy = y0 + 142, gw = W - 56, gh = 34;
        if (hs.length > 1) {
            let tmin = Math.min(...hs.map(h => h.t)) - 1, tmax = Math.max(...hs.map(h => h.t)) + 1, step = gw / (hs.length - 1);
            hs.forEach((h, i) => {
                let bh = h.rain / 100 * gh;
                this._col(cr, C.a1, 0.35); cr.newPath(); cr.rectangle(gx + i * step - 5, gy + gh - bh, 10, bh); cr.fill();
            });
            cr.newPath();
            hs.forEach((h, i) => { let px = gx + i * step, py = gy + gh - 4 - (h.t - tmin) / (tmax - tmin) * (gh - 8); i ? cr.lineTo(px, py) : cr.moveTo(px, py); });
            cr.setLineWidth(1.6); this._col(cr, C.warn); cr.stroke();
            hs.forEach((h, i) => {
                let px = gx + i * step, py = gy + gh - 4 - (h.t - tmin) / (tmax - tmin) * (gh - 8);
                this._col(cr, C.warn); cr.newPath(); cr.arc(px, py, 2, 0, 2 * Math.PI); cr.fill();
                this._text(cr, h.t + "°", px, py - 5, "c", C.text, 8.5);
                this._text(cr, String(h.h).padStart(2, "0") + "h", px, gy + gh + 12, "c", C.label, 8.5);
            });
        }
        this._divider(cr, y0 + 196);

        let cw = (W - 40) / 3;
        w.days.forEach((dd, i) => {
            let cx = 20 + cw * i + cw / 2;
            let dt = GLib.DateTime.new_from_iso8601(dd.date + "T12:00:00Z", null);
            let name = i === 0 ? "Today" : (dt ? dt.format("%a") : dd.date.slice(5));
            this._text(cr, name, cx, y0 + 216, "c", C.label, 10, true);
            this._wicon(cr, cx - 26, y0 + 235, 11, dd.code, false);
            this._text(cr, `${dd.min}° / ${dd.max}°`, cx + 8, y0 + 240, "c", C.text, 11);
            this._text(cr, `rain ${dd.rain}%`, cx, y0 + 256, "c", dd.rain >= 50 ? C.a1 : C.label, 9);
        });
    }
}

function main(metadata, deskletId) {
    return new CoreglowDesklet(metadata, deskletId);
}
