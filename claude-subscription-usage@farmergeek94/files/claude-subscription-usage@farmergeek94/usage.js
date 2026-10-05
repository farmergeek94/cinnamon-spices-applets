// Turns the responses of Claude's subscription usage endpoints into the small,
// display-ready shape the applet works with. Nothing in here touches the UI.

const GLib = imports.gi.GLib;

const SEVERITIES = ["normal", "warning", "critical"];
const WARNING_PERCENT = 75;
const CRITICAL_PERCENT = 90;

const PLAN_BY_RATE_LIMIT_TIER = {
    "default_claude_ai": "Pro",
    "default_claude_max_5x": "Max 5x",
    "default_claude_max_20x": "Max 20x"
};

const CURRENCY_SYMBOLS = {
    "AUD": "$",
    "CAD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "NZD": "$",
    "USD": "$"
};

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
    if (typeof value !== "number" && typeof value !== "string") {
        return null;
    }
    const parsed = typeof value === "number" ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value) {
    const parsed = finiteNumber(value);
    return parsed === null ? 0 : Math.min(100, Math.max(0, parsed));
}

function severityFor(value, percent) {
    if (typeof value === "string" && SEVERITIES.includes(value.toLowerCase())) {
        return value.toLowerCase();
    }
    if (percent >= CRITICAL_PERCENT) {
        return "critical";
    }
    return percent >= WARNING_PERCENT ? "warning" : "normal";
}

function epochFromIso(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }
    const date = GLib.DateTime.new_from_iso8601(value.trim(), null);
    return date ? Math.round(date.to_unix() + date.get_microsecond() / 1000000) : null;
}

function titleCase(text) {
    return text.replace(/_/g, " ").trim().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function planLabel(raw) {
    return titleCase(raw.trim().toLowerCase().replace(/^claude_/, ""));
}

function formatMoney(amountMinor, currency, exponent) {
    const code = typeof currency === "string" ? currency.toUpperCase() : "";
    let digits = finiteNumber(exponent);
    digits = digits === null || digits < 0 || digits > 6 ? 2 : Math.trunc(digits);

    const amount = (finiteNumber(amountMinor) || 0) / Math.pow(10, digits);
    const text = amount.toFixed(digits);
    const symbol = Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : null;
    return symbol ? symbol + text : (code + " " + text).trim();
}

// One entry of the "limits" list the endpoint returns.
function limitBar(item) {
    if (!isObject(item)) {
        return null;
    }
    const percent = clampPercent(item.percent);
    const model = isObject(item.scope) && isObject(item.scope.model) ? item.scope.model.display_name : null;
    return {
        kind: typeof item.kind === "string" ? item.kind.toLowerCase() : "",
        model: typeof model === "string" && model.trim().length > 0 ? model.trim() : null,
        percent: percent,
        severity: severityFor(item.severity, percent),
        resetsAt: epochFromIso(item.resets_at),
        active: item.is_active !== false
    };
}

// Older responses carry one object per window instead ("five_hour",
// "seven_day", "seven_day_opus", ...), each with a "utilization" percentage.
function legacyBars(payload) {
    const bars = [];
    for (const key of Object.keys(payload)) {
        let kind;
        let model = null;
        if (key === "five_hour") {
            kind = "session";
        } else if (key === "seven_day") {
            kind = "weekly_all";
        } else if (key.startsWith("seven_day_")) {
            kind = "weekly_" + key.substring("seven_day_".length);
            model = titleCase(key.substring("seven_day_".length));
        } else {
            continue;
        }

        const item = payload[key];
        if (!isObject(item) || finiteNumber(item.utilization) === null) {
            continue;
        }
        const percent = clampPercent(item.utilization);
        bars.push({
            kind: kind,
            model: model,
            percent: percent,
            severity: severityFor(null, percent),
            resetsAt: epochFromIso(item.resets_at),
            active: true
        });
    }

    const order = (bar) => bar.kind === "session" ? 0 : (bar.kind === "weekly_all" ? 1 : 2);
    return bars.sort((a, b) => order(a) - order(b));
}

// Extra usage (pay-as-you-go spend on top of the subscription), if reported.
function credits(payload) {
    const spend = payload.spend;
    if (isObject(spend) && isObject(spend.used) && isObject(spend.limit)) {
        const percent = clampPercent(spend.percent);
        return {
            enabled: Boolean(spend.enabled),
            severity: severityFor(spend.severity, percent),
            used: formatMoney(spend.used.amount_minor, spend.used.currency, spend.used.exponent),
            limit: formatMoney(spend.limit.amount_minor, spend.limit.currency, spend.limit.exponent)
        };
    }

    const extra = payload.extra_usage;
    if (isObject(extra)) {
        const percent = clampPercent(extra.utilization);
        const currency = typeof extra.currency === "string" ? extra.currency : "USD";
        return {
            enabled: Boolean(extra.is_enabled),
            severity: severityFor(null, percent),
            used: formatMoney(extra.used_credits, currency, 2),
            limit: finiteNumber(extra.monthly_limit) === null ? null : formatMoney(extra.monthly_limit, currency, 2)
        };
    }

    return null;
}

// Returns { fetchedAt, bars, credits }, or null if the response holds no limits.
function normaliseUsage(payload, now) {
    if (!isObject(payload)) {
        return null;
    }
    let bars = Array.isArray(payload.limits) ? payload.limits.map(limitBar).filter((bar) => bar !== null) : [];
    if (bars.length === 0) {
        bars = legacyBars(payload);
    }
    if (bars.length === 0) {
        return null;
    }
    return {
        fetchedAt: now,
        bars: bars,
        credits: credits(payload)
    };
}

// The plan as the account reports it. The rate limit tier is tried first
// because it is the only field that tells the Max tiers apart.
function planFromProfile(payload) {
    if (!isObject(payload)) {
        return null;
    }
    const account = isObject(payload.account) ? payload.account : {};
    const organization = isObject(payload.organization) ? payload.organization : {};

    const tier = typeof organization.rate_limit_tier === "string" ? organization.rate_limit_tier.trim().toLowerCase() : "";
    if (Object.prototype.hasOwnProperty.call(PLAN_BY_RATE_LIMIT_TIER, tier)) {
        return PLAN_BY_RATE_LIMIT_TIER[tier];
    }
    if (account.has_claude_max) {
        return "Max";
    }
    const type = organization.organization_type;
    if (typeof type === "string" && type.trim().length > 0) {
        return planLabel(type);
    }
    return account.has_claude_pro ? "Pro" : null;
}

// Reads what the applet needs out of Claude Code's credentials file. Returns
// { token, expiresAt, plan }, or null if there is no usable sign-in in it.
function parseCredentials(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return null;
    }

    const oauth = isObject(data) ? data.claudeAiOauth : null;
    if (!isObject(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken.trim().length === 0) {
        return null;
    }

    // expiresAt is in milliseconds since the epoch.
    const expiresAt = finiteNumber(oauth.expiresAt);
    const plan = oauth.subscriptionType;
    return {
        token: oauth.accessToken.trim(),
        expiresAt: expiresAt === null ? null : expiresAt / 1000,
        plan: typeof plan === "string" && plan.trim().length > 0 ? planLabel(plan) : null
    };
}

function retryAfterSeconds(header) {
    const seconds = finiteNumber(header);
    return seconds === null || seconds < 0 ? null : Math.ceil(seconds);
}

// Picks the bar the panel shows: "session", "weekly" or "highest".
function pickBar(bars, which) {
    if (bars.length === 0) {
        return null;
    }
    if (which === "highest") {
        return bars.reduce((highest, bar) => bar.percent > highest.percent ? bar : highest);
    }
    const kind = which === "weekly" ? "weekly_all" : "session";
    return bars.find((bar) => bar.kind === kind) || bars[0];
}
