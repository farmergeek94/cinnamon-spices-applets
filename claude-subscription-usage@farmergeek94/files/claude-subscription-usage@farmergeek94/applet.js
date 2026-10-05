const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const ByteArray = imports.byteArray;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const St = imports.gi.St;

const Usage = require('./usage');

const UUID = "claude-subscription-usage@farmergeek94";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_PAGE = "https://claude.ai/settings/usage";

const TICK_SECONDS = 30;
// A token this close to expiring is treated as expired, so that a request is
// never sent with a token that lapses mid-flight.
const EXPIRY_SKEW_SECONDS = 60;
const PLAN_TTL_SECONDS = 3600;
const RATE_LIMIT_BACKOFF_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 3600;

// Bar widths, in CSS pixels. They must match the widths in stylesheet.css.
const PANEL_BAR_WIDTH = 36;
const MENU_BAR_WIDTH = 270;

const DIM_OPACITY = 150;
const STALE_OPACITY = 120;

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    return Gettext.dgettext(UUID, text);
}

function nowSeconds() {
    return Math.floor(GLib.get_real_time() / 1000000);
}

class ClaudeSubscriptionUsageApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_path(metadata.path + "/icons/claude-subscription-usage-symbolic.svg");

        this._vertical = orientation === St.Side.LEFT || orientation === St.Side.RIGHT;

        // The last good reading, kept on screen while a later check fails.
        this._reading = null;
        this._plan = null;
        // Why the last check failed, or null if it succeeded.
        this._problem = null;
        this._nextPollAt = 0;
        this._throttleStreak = 0;
        this._rejectedToken = null;
        this._polling = false;

        this._monitor = null;
        this._tickId = 0;
        this._menuTickId = 0;
        this._countdowns = [];
        this._ageLabel = null;

        this._cancellable = new Gio.Cancellable();
        this._httpSession = new Soup.Session();
        this._httpSession.timeout = 20;
        this._httpSession.user_agent = "cinnamon-applet-" + UUID;
        this._desktopSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });

        this._panelTrack = new St.BoxLayout({ style_class: "csu-track csu-panel-track" });
        this._panelFill = new St.Widget({ style_class: "csu-fill" });
        this._panelTrack.add_child(this._panelFill);
        this.actor.add(this._panelTrack, { y_align: St.Align.MIDDLE, y_fill: false });

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => this._onMenuToggled(open));

        this._card = new St.BoxLayout({ vertical: true, style_class: "csu-card" });
        this.menu.addActor(this._card);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const usagePageItem = new PopupMenu.PopupMenuItem(_("Open the usage page"));
        usagePageItem.connect("activate", () => this._openUsagePage());
        this.menu.addMenuItem(usagePageItem);

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("panel-limit", "panelLimit", () => this._update());
        this.settings.bind("show-percentage", "showPercentage", () => this._update());
        this.settings.bind("show-countdown", "showCountdown", () => this._update());
        this.settings.bind("show-bar", "showBar", () => this._update());
        this.settings.bind("show-inactive", "showInactive", () => this._update());
        this.settings.bind("show-credits", "showCredits", () => this._update());
        this.settings.bind("update-interval", "updateInterval", () => this._onIntervalChanged());
        this.settings.bind("credentials-path", "credentialsPath", () => this._onCredentialsPathChanged());

        this._restoreState();
        this._watchCredentials();
        this._update();

        this._onTick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => this._onTick());
    }

    // --- Polling ---

    _onTick() {
        const now = nowSeconds();
        if (now >= this._nextPollAt || this._windowRolledOver(now)) {
            this._poll();
        }
        this._updatePanel(now);
        return GLib.SOURCE_CONTINUE;
    }

    // A limit window has ended since the last reading, so its figure is out of date.
    _windowRolledOver(now) {
        if (this._problem !== null || this._reading === null) {
            return false;
        }
        const fetchedAt = this._reading.fetchedAt;
        return this._reading.bars.some((bar) => bar.resetsAt !== null && bar.resetsAt <= now && bar.resetsAt > fetchedAt);
    }

    _poll() {
        if (this._polling) {
            return;
        }
        this._polling = true;

        this._readCredentials((credentials) => {
            if (credentials === null) {
                this._finishPoll({ kind: "no-auth" });
            } else if (credentials.token === this._rejectedToken) {
                this._finishPoll({ kind: "rejected" });
            } else if (credentials.expiresAt !== null && nowSeconds() >= credentials.expiresAt - EXPIRY_SKEW_SECONDS) {
                this._finishPoll({ kind: "expired" });
            } else {
                this._getJson(USAGE_URL, credentials.token, (status, payload, headers) => {
                    this._onUsageResponse(credentials, status, payload, headers);
                });
            }
        });
    }

    _onUsageResponse(credentials, status, payload, headers) {
        if (status === 200) {
            const reading = Usage.normaliseUsage(payload, nowSeconds());
            if (reading === null) {
                this._finishPoll({ kind: "bad-response" });
                return;
            }
            this._reading = reading;
            this._rejectedToken = null;
            this._refreshPlan(credentials, () => this._finishPoll(null));
        } else if (status === 401 || status === 403) {
            // Asking again with the same token would only be refused again.
            this._rejectedToken = credentials.token;
            this._finishPoll({ kind: "rejected" });
        } else if (status === 429) {
            this._finishPoll({ kind: "rate-limited" }, Usage.retryAfterSeconds(headers.get_one("Retry-After")));
        } else if (status === 0) {
            this._finishPoll({ kind: "offline" });
        } else {
            this._finishPoll({ kind: "http", status: status });
        }
    }

    // The plan is read from the account, at most once per PLAN_TTL_SECONDS. The
    // credentials file also names one, but it is only written at sign-in and so
    // can be out of date; it is the fallback.
    _refreshPlan(credentials, done) {
        const now = nowSeconds();
        if (this._plan !== null && now - this._plan.checkedAt < PLAN_TTL_SECONDS) {
            done();
            return;
        }

        this._getJson(PROFILE_URL, credentials.token, (status, payload) => {
            const known = this._plan !== null ? this._plan.label : null;
            this._plan = {
                label: Usage.planFromProfile(payload) || known || credentials.plan,
                checkedAt: now
            };
            done();
        });
    }

    _finishPoll(problem, retryAfter = null) {
        let delay = this.updateInterval * 60;
        if (problem !== null && problem.kind === "rate-limited") {
            this._throttleStreak++;
            delay = Math.max(delay, retryAfter !== null ? retryAfter : RATE_LIMIT_BACKOFF_SECONDS);
            delay = Math.min(delay * Math.pow(2, this._throttleStreak - 1), Math.max(delay, MAX_BACKOFF_SECONDS));
        } else {
            this._throttleStreak = 0;
        }

        this._problem = problem;
        this._nextPollAt = nowSeconds() + delay;
        this._polling = false;

        // Kept across restarts so that restarting Cinnamon neither blanks the
        // applet nor sends a burst of requests.
        this.settings.setValue("state", {
            reading: this._reading,
            plan: this._plan,
            nextPollAt: this._nextPollAt
        });
        this._update();
    }

    _restoreState() {
        const saved = this.settings.getValue("state");
        if (saved === null || typeof saved !== "object") {
            return;
        }
        if (saved.reading && Array.isArray(saved.reading.bars)) {
            this._reading = saved.reading;
        }
        if (saved.plan && typeof saved.plan.checkedAt === "number") {
            this._plan = saved.plan;
        }
        if (typeof saved.nextPollAt === "number") {
            this._nextPollAt = Math.min(saved.nextPollAt, nowSeconds() + MAX_BACKOFF_SECONDS);
        }
    }

    _refreshNow() {
        this._rejectedToken = null;
        this._poll();
        this._tickMenu();
    }

    // --- Credentials and network ---

    _credentialsPath() {
        const path = this.credentialsPath;
        if (!path) {
            return GLib.build_filenamev([GLib.get_home_dir(), ".claude", ".credentials.json"]);
        }
        return path.startsWith("file://") ? Gio.File.new_for_uri(path).get_path() : path;
    }

    // The credentials file is only ever read. Claude Code owns it and is the
    // one to refresh the sign-in.
    _readCredentials(callback) {
        const file = Gio.File.new_for_path(this._credentialsPath());
        file.load_contents_async(this._cancellable, (source, result) => {
            let credentials = null;
            try {
                const [, contents] = source.load_contents_finish(result);
                credentials = Usage.parseCredentials(ByteArray.toString(contents));
            } catch (e) {
                // A missing or unreadable file is reported as "not signed in".
            }
            if (!this._cancellable.is_cancelled()) {
                callback(credentials);
            }
        });
    }

    // Once the sign-in is missing or no longer valid, only a change to the
    // credentials file can fix it, so that is what triggers the next check.
    _watchCredentials() {
        if (this._monitor !== null) {
            this._monitor.cancel();
            this._monitor = null;
        }

        try {
            const file = Gio.File.new_for_path(this._credentialsPath());
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect("changed", (monitor, changed, other, event) => {
                if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT && this._waitingForSignIn()) {
                    this._poll();
                }
            });
        } catch (e) {
            global.logError(UUID + ": could not watch the credentials file: " + e);
        }
    }

    _waitingForSignIn() {
        return this._problem !== null && ["no-auth", "expired", "rejected"].includes(this._problem.kind);
    }

    // Calls back with (status, payload, headers). The status is 0 if the
    // request never got a response, and the payload is null unless the response
    // was a 200 with a JSON body.
    _getJson(url, token, callback) {
        const message = Soup.Message.new("GET", url);
        message.request_headers.append("Authorization", "Bearer " + token);
        message.request_headers.append("anthropic-beta", "oauth-2025-04-20");
        message.request_headers.append("Accept", "application/json");

        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            let payload = null;
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.status_code === 200) {
                    payload = JSON.parse(ByteArray.toString(bytes.get_data()));
                }
            } catch (e) {
                // Reported through the status and the null payload.
            }
            if (!this._cancellable.is_cancelled()) {
                callback(message.status_code, payload, message.response_headers);
            }
        });
    }

    // --- Display ---

    _update() {
        const now = nowSeconds();
        this._updatePanel(now);
        this._renderCard(now);
    }

    _visibleBars() {
        if (this._reading === null) {
            return [];
        }
        return this._reading.bars.filter((bar) => this.showInactive || bar.active);
    }

    _isStale(now) {
        return this._problem !== null || this._reading === null ||
            now - this._reading.fetchedAt > 3 * this.updateInterval * 60;
    }

    _updatePanel(now) {
        const bar = Usage.pickBar(this._reading !== null ? this._reading.bars : [], this.panelLimit);

        const parts = [];
        if (this.showPercentage) {
            parts.push(bar !== null ? Math.round(bar.percent) + "%" : "--%");
        }
        if (this.showCountdown && !this._vertical && bar !== null && bar.resetsAt !== null && bar.resetsAt > now) {
            parts.push(this._formatDuration(bar.resetsAt - now, false));
        }
        this.set_applet_label(parts.join(" · "));
        this._applet_label.set_style_class_name("applet-label csu-" + (bar !== null ? bar.severity : "normal"));

        this._panelTrack.visible = this.showBar && !this._vertical;
        this._setFill(this._panelFill, bar, PANEL_BAR_WIDTH);

        const opacity = this._isStale(now) ? STALE_OPACITY : 255;
        this._applet_label.opacity = opacity;
        this._panelTrack.opacity = opacity;

        this.set_applet_tooltip(this._tooltipText(now));
    }

    _setFill(fill, bar, trackWidth) {
        const percent = bar !== null ? bar.percent : 0;
        const width = percent > 0 ? Math.max(2, Math.round(trackWidth * percent / 100)) : 0;
        fill.visible = width > 0;
        fill.set_style("width: " + width + "px;");
        fill.set_style_class_name("csu-fill csu-" + (bar !== null ? bar.severity : "normal"));
    }

    _tooltipText(now) {
        const lines = [this._title()];
        this._visibleBars().forEach((bar) => {
            const percent = Math.round(bar.percent);
            if (bar.resetsAt !== null && bar.resetsAt > now) {
                lines.push(_("%s: %d%%, resets in %s").format(
                    this._barLabel(bar), percent, this._formatDuration(bar.resetsAt - now, false)));
            } else {
                lines.push(_("%s: %d%%").format(this._barLabel(bar), percent));
            }
        });

        if (this._problem !== null) {
            lines.push(this._problemText());
        } else if (this._reading === null) {
            lines.push(_("Waiting for the first reading…"));
        }
        return lines.join("\n");
    }

    _renderCard(now) {
        this._card.destroy_all_children();
        this._countdowns = [];
        this._ageLabel = null;

        const header = new St.BoxLayout({ style_class: "csu-row" });
        header.add(this._label(this._title(), "csu-title"), { expand: true });
        if (this._problem !== null) {
            header.add(this._label(this._problemPill(), "csu-pill"), { y_fill: false, y_align: St.Align.MIDDLE });
        }
        this._card.add(header);

        if (this._problem !== null || this._reading === null) {
            const text = this._problem !== null ? this._problemText() : _("Waiting for the first reading…");
            const message = this._label(text, "csu-small");
            message.clutter_text.line_wrap = true;
            this._card.add(message);
        }

        const stale = this._isStale(now);
        this._visibleBars().forEach((bar) => this._card.add(this._barGroup(bar, stale)));

        if (this.showCredits && this._reading !== null && this._reading.credits !== null) {
            const credits = this._reading.credits;
            const row = new St.BoxLayout({ style_class: "csu-row" });
            row.add(this._label(_("Extra usage")), { expand: true });
            row.add(this._label(this._creditsText(credits), "csu-value csu-" + credits.severity));
            this._card.add(row);
        }

        const footer = new St.BoxLayout({ style_class: "csu-row" });
        this._ageLabel = this._label("", "csu-small", DIM_OPACITY);
        footer.add(this._ageLabel, { expand: true, y_fill: false, y_align: St.Align.MIDDLE });
        const refresh = new St.Button({
            style_class: "csu-refresh",
            can_focus: true,
            child: new St.Icon({
                style_class: "popup-menu-icon",
                icon_name: "view-refresh",
                icon_type: St.IconType.SYMBOLIC
            })
        });
        refresh.connect("clicked", () => this._refreshNow());
        footer.add(refresh);
        this._card.add(footer);

        this._tickMenu();
    }

    _barGroup(bar, stale) {
        const group = new St.BoxLayout({ vertical: true, style_class: "csu-bar-group" });
        group.opacity = stale ? STALE_OPACITY : 255;

        const top = new St.BoxLayout({ style_class: "csu-row" });
        top.add(this._label(this._barLabel(bar)), { expand: true });
        top.add(this._label(Math.round(bar.percent) + "%", "csu-value csu-" + bar.severity));
        group.add(top);

        const track = new St.BoxLayout({ style_class: "csu-track" });
        const fill = new St.Widget();
        this._setFill(fill, bar, MENU_BAR_WIDTH);
        track.add_child(fill);
        group.add(track);

        const bottom = new St.BoxLayout({ style_class: "csu-row" });
        const countdown = this._label("", "csu-small", DIM_OPACITY);
        bottom.add(countdown, { expand: true });
        if (bar.resetsAt !== null) {
            bottom.add(this._label(this._formatClock(bar.resetsAt), "csu-small", DIM_OPACITY));
        }
        group.add(bottom);

        this._countdowns.push({ label: countdown, resetsAt: bar.resetsAt });
        return group;
    }

    _label(text, styleClass = null, opacity = 255) {
        const label = new St.Label({ text: text, style_class: styleClass });
        label.opacity = opacity;
        return label;
    }

    // While the menu is open its countdowns are kept live, once a second.
    _onMenuToggled(open) {
        this._stopMenuTick();
        if (open) {
            this._tickMenu();
            this._menuTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tickMenu();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _stopMenuTick() {
        if (this._menuTickId > 0) {
            GLib.source_remove(this._menuTickId);
            this._menuTickId = 0;
        }
    }

    _tickMenu() {
        const now = nowSeconds();
        this._countdowns.forEach((entry) => entry.label.set_text(this._countdownText(entry.resetsAt, now)));
        if (this._ageLabel !== null) {
            this._ageLabel.set_text(this._ageText(now));
        }
    }

    // --- Wording ---

    _title() {
        const plan = this._plan !== null ? this._plan.label : null;
        return plan ? "Claude · " + plan : "Claude";
    }

    _barLabel(bar) {
        if (bar.kind === "session") {
            return _("Current session");
        }
        if (bar.kind === "weekly_all") {
            return _("Current week");
        }
        if (bar.kind.startsWith("weekly") && bar.model !== null) {
            return _("Current week (%s)").format(bar.model);
        }
        return bar.model || (bar.kind ? Usage.titleCase(bar.kind) : _("Limit"));
    }

    _countdownText(resetsAt, now) {
        if (resetsAt === null) {
            return _("not started");
        }
        if (now >= resetsAt) {
            return _("resetting…");
        }
        return _("resets in %s").format(this._formatDuration(resetsAt - now, true));
    }

    _ageText(now) {
        if (this._polling) {
            return _("checking…");
        }
        if (this._reading === null) {
            return "";
        }
        return _("updated %s ago").format(this._formatDuration(now - this._reading.fetchedAt, true));
    }

    _creditsText(credits) {
        if (!credits.enabled) {
            return _("off");
        }
        return credits.limit !== null ? _("%s of %s").format(credits.used, credits.limit) : credits.used;
    }

    _problemPill() {
        switch (this._problem.kind) {
            case "no-auth":
                return _("not signed in");
            case "expired":
                return _("sign-in expired");
            case "rejected":
                return _("sign-in rejected");
            case "rate-limited":
                return _("rate limited");
            case "bad-response":
                return _("bad response");
            case "http":
                return "HTTP " + this._problem.status;
            default:
                return _("offline");
        }
    }

    _problemText() {
        const nextAttempt = this._formatClock(this._nextPollAt);
        switch (this._problem.kind) {
            case "no-auth":
                return _("No Claude Code sign-in was found. Sign in with Claude Code and this recovers on its own.");
            case "expired":
                return _("The Claude Code sign-in has expired. Use Claude Code again and this recovers on its own.");
            case "rejected":
                return _("Claude did not accept the stored sign-in. Run /login in Claude Code to sign in again.");
            case "rate-limited":
                return _("Claude is limiting how often usage can be checked. Next attempt at %s.").format(nextAttempt);
            case "bad-response":
                return _("The usage response was not understood. Next attempt at %s.").format(nextAttempt);
            default:
                return _("Could not reach Claude. Next attempt at %s.").format(nextAttempt);
        }
    }

    // Below a minute, @precise gives the seconds; otherwise it says "<1m".
    _formatDuration(seconds, precise) {
        const total = Math.max(0, Math.floor(seconds));
        if (total < 60) {
            return precise ? _("%ds").format(total) : _("<1m");
        }
        if (total < 3600) {
            return _("%dm").format(Math.floor(total / 60));
        }
        if (total < 86400) {
            return _("%dh %dm").format(Math.floor(total / 3600), Math.floor((total % 3600) / 60));
        }
        return _("%dd %dh").format(Math.floor(total / 86400), Math.floor((total % 86400) / 3600));
    }

    // A local time of day, with the weekday if it is not today. Reset times
    // arrive a fraction of a second either side of the minute they mean, so the
    // time is rounded to the nearest minute rather than cut off.
    _formatClock(epoch) {
        const date = GLib.DateTime.new_from_unix_local(Math.round(epoch / 60) * 60);
        let pattern = this._desktopSettings.get_boolean("clock-use-24h") ? "%H:%M" : "%l:%M %p";
        if (date.format("%F") !== GLib.DateTime.new_now_local().format("%F")) {
            pattern = "%a " + pattern;
        }
        return date.format(pattern).replace(/\s+/g, " ").trim();
    }

    // --- Applet events ---

    _openUsagePage() {
        try {
            Gio.app_info_launch_default_for_uri(USAGE_PAGE, global.create_app_launch_context());
        } catch (e) {
            global.logError(UUID + ": could not open the usage page: " + e);
        }
    }

    _onIntervalChanged() {
        if (this._problem === null) {
            this._nextPollAt = Math.min(this._nextPollAt, nowSeconds() + this.updateInterval * 60);
        }
        this._update();
    }

    _onCredentialsPathChanged() {
        this._rejectedToken = null;
        this._watchCredentials();
        this._poll();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_middle_clicked() {
        this._refreshNow();
    }

    on_orientation_changed(orientation) {
        this._vertical = orientation === St.Side.LEFT || orientation === St.Side.RIGHT;
        this._updatePanel(nowSeconds());
    }

    on_applet_removed_from_panel() {
        if (this._tickId > 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._stopMenuTick();
        if (this._monitor !== null) {
            this._monitor.cancel();
            this._monitor = null;
        }
        this._cancellable.cancel();
        this.settings.finalize();
        this.menu.destroy();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new ClaudeSubscriptionUsageApplet(metadata, orientation, panel_height, instance_id);
}
