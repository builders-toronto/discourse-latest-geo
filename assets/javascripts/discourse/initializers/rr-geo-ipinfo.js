import { ajax } from "discourse/lib/ajax";
import { withPluginApi } from "discourse/lib/plugin-api";

const GEO_TOKENS_KEY = "geo.tokens";
const GEO_LAST_IP_KEY = "geo.lastIp";
const GEO_CHECKED_AT_KEY = "geo.checkedAt";
const GEO_LAST_RELOAD_AT_KEY = "geo.lastReloadAt";

const GEO_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const GEO_POLL_INTERVAL_MS = 0; // set >0 to enable periodic checks
const GEO_RELOAD_MIN_INTERVAL_MS = 60 * 1000; // 60s

const IPINFO_URL = "https://ipinfo.io/json";

function nowMs() {
  return Date.now ? Date.now() : new Date().getTime();
}

function shouldCheckAgain() {
  const last = parseInt(localStorage.getItem(GEO_CHECKED_AT_KEY) || "0", 10);
  if (!last) {
    return true;
  }
  return nowMs() - last >= GEO_TTL_MS;
}

function tokenizePieces(...parts) {
  const out = new Set();
  for (const p of parts) {
    const clean = (p || "").toString().trim();
    if (!clean) {
      continue;
    }
    const low = clean.toLowerCase();
    out.add(low);
    out.add(low.replace(/\s+/g, "-")); // "north york" -> "north-york"
  }
  return Array.from(out);
}

function tokensChanged(newCsv) {
  const prev = (localStorage.getItem(GEO_TOKENS_KEY) || "").trim();
  return prev !== (newCsv || "").trim();
}

function dispatchGeoUpdated() {
  try {
    window.dispatchEvent(new CustomEvent("rr-geo-updated"));
  } catch {
    /* no-op */
  }
}

function hardReloadIfAllowed({ enabled = true } = {}) {
  if (!enabled) {
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }
  const last = parseInt(
    localStorage.getItem(GEO_LAST_RELOAD_AT_KEY) || "0",
    10
  );
  if (nowMs() - last < GEO_RELOAD_MIN_INTERVAL_MS) {
    return;
  }
  localStorage.setItem(GEO_LAST_RELOAD_AT_KEY, String(nowMs()));
  window.location.reload();
}

async function fetchSessionIp() {
  try {
    const r = await fetch("/session/current.json", {
      headers: { Accept: "application/json" },
    });
    if (r.ok) {
      const j = await r.json();
      return j.client_ip || null;
    }
  } catch {}
  try {
    const r2 = await fetch("/site.json", {
      headers: { Accept: "application/json" },
    });
    if (r2.ok) {
      const s = await r2.json();
      return s.client_ip || null;
    }
  } catch {}
  return null;
}

async function fetchIpinfo() {
  const res = await fetch(IPINFO_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ipinfo ${res.status}`);
  }
  // { ip, city, region, country, ... }
  return res.json();
}

async function updateProfileLocation(
  api,
  { city, region, onlyIfBlank = true }
) {
  const currentUser = api.getCurrentUser?.();
  if (!currentUser) {
    return;
  }
  if (onlyIfBlank && currentUser.location) {
    return;
  }

  const loc = city && region ? `${city}, ${region}` : city || region || "";
  if (!loc) {
    return;
  }

  try {
    await ajax(`/u/${encodeURIComponent(currentUser.username)}.json`, {
      type: "PUT",
      data: { location: loc },
    });
    currentUser.location = loc;
  } catch {}
}

function hasProfileLocation(api) {
  const currentUser = api.getCurrentUser?.();
  return !!currentUser?.location;
}

function setDefaultTokensIfMissing() {
  if ((localStorage.getItem(GEO_TOKENS_KEY) || "").trim()) {
    return;
  }
  localStorage.setItem(GEO_TOKENS_KEY, "toronto,gta,ontario,canada");
}

async function bootstrapFromIpinfo(api, { persistIp }) {
  const j = await fetchIpinfo();
  const city = j?.city;
  const region = j?.region;
  const country = j?.country;

  const toks = tokenizePieces(city, region, country).filter(Boolean);
  const csv = toks.length ? toks.join(",") : "toronto,gta,ontario,canada";

  if (tokensChanged(csv)) {
    localStorage.setItem(GEO_TOKENS_KEY, csv);
    dispatchGeoUpdated();
  }
  await updateProfileLocation(api, { city, region, onlyIfBlank: true });

  if (persistIp) {
    localStorage.setItem(GEO_LAST_IP_KEY, persistIp || j?.ip || "");
  }
}

async function refreshGeoIfNeeded(api, { force = false } = {}) {
  if (!force && !shouldCheckAgain()) {
    return;
  }

  setDefaultTokensIfMissing();

  const sessionIp = await fetchSessionIp();
  const lastIp = localStorage.getItem(GEO_LAST_IP_KEY) || "";
  const firstRun = !lastIp;
  const ipChanged = sessionIp && lastIp && sessionIp !== lastIp;

  const needsBootstrap = !hasProfileLocation(api);
  if (needsBootstrap || ipChanged || firstRun || force) {
    try {
      await bootstrapFromIpinfo(api, { persistIp: sessionIp });
      if (ipChanged && !firstRun) {
        hardReloadIfAllowed({
          enabled: true,
        });
      }
    } catch {
      if (!(localStorage.getItem(GEO_TOKENS_KEY) || "").trim()) {
        localStorage.setItem(GEO_TOKENS_KEY, "toronto,gta,ontario,canada");
        dispatchGeoUpdated();
      }
    }
  } else if (sessionIp && firstRun) {
    // runs on init?
    localStorage.setItem(GEO_LAST_IP_KEY, sessionIp);
  }

  localStorage.setItem(GEO_CHECKED_AT_KEY, String(nowMs()));
}

export default {
  name: "geo-ipinfo",
  initialize() {
    withPluginApi(async (api) => {
      const ss = api.container.lookup("service:site-settings");
      if (!ss?.rr_geo_enabled) {
        return;
      }
      await refreshGeoIfNeeded(api, { force: true });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          refreshGeoIfNeeded(api);
        }
      });
      window.addEventListener("online", () => refreshGeoIfNeeded(api));

      if (GEO_POLL_INTERVAL_MS > 0) {
        setInterval(() => refreshGeoIfNeeded(api), GEO_POLL_INTERVAL_MS);
      }
    });
  },
};
