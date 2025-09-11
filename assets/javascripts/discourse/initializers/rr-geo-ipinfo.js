import { ajax } from "discourse/lib/ajax";
import { withPluginApi } from "discourse/lib/plugin-api";

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

async function fetchIpinfo() {
  const res = await fetch("https://ipinfo.io/json", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ipinfo ${res.status}`);
  }
  return res.json(); // { city, region, country, ... }
}

export default {
  name: "rr-geo-ipinfo",
  initialize() {
    withPluginApi(async (api) => {
      const ss = api.container.lookup("service:site-settings");
      if (!ss.rr_geo_enabled) {
        return;
      }

      const currentUser = api.getCurrentUser?.();
      if (!currentUser) {
        return;
      }
      if (sessionStorage.getItem("geo.ipinfo.done") === "1") {
        return;
      }
      sessionStorage.setItem("geo.ipinfo.done", "1");
      if ((localStorage.getItem("geo.tokens") || "").trim()) {
        return;
      }

      let city, region, country;
      try {
        const j = await fetchIpinfo();
        city = j?.city;
        region = j?.region;
        country = j?.country; // ISO, e.g., "CA"
      } catch (_e) {
        localStorage.setItem("geo.tokens", "toronto,gta,ontario,canada");
        return;
      }

      // Build geo tokens for the sorter
      const tokens = tokenizePieces(city, region, country).filter(Boolean);
      if (tokens.length) {
        localStorage.setItem("geo.tokens", tokens.join(","));
      } else {
        localStorage.setItem("geo.tokens", "toronto,gta,ontario,canada");
      }
      if (
        ss.rr_set_profile_location_if_blank &&
        !currentUser.location &&
        (city || region)
      ) {
        try {
          await ajax(`/u/${encodeURIComponent(currentUser.username)}.json`, {
            type: "PUT",
            data: {
              location:
                city && region ? `${city}, ${region}` : city || region || "",
            },
          });
          currentUser.location =
            city && region ? `${city}, ${region}` : city || region || "";
        } catch {
          // ignore
        }
      }
    });
  },
};
