const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const fs = require("fs");

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

let accessToken = null;
let tokenExpiresAt = 0;

// 🔄 Refresh automatico del token
async function refreshAccessToken() {
  try {
    const response = await axios.post("https://www.strava.com/oauth/token", {
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      refresh_token: process.env.REFRESH_TOKEN,
      grant_type: "refresh_token",
    });

    accessToken = response.data.access_token;
    tokenExpiresAt = response.data.expires_at;

    console.log("✅ Token aggiornato, valido fino a:", new Date(tokenExpiresAt * 1000));
  } catch (err) {
    console.error("❌ Errore nel refresh token:", err.response?.data || err.message);
  }
}

// 🔐 Middleware: garantisce token valido
async function ensureToken(req, res, next) {
  const now = Math.floor(Date.now() / 1000);
  if (!accessToken || now >= tokenExpiresAt) {
    await refreshAccessToken();
  }
  next();
}

// 📌 Tutte le attività (paginazione completa)
app.get("/strava/activities", ensureToken, async (req, res) => {
  try {
    let allActivities = [];
    let page = 1;

    while (true) {
      const response = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { per_page: 200, page },
      });

      const data = response.data;
      if (data.length === 0) break;

      allActivities.push(...data);
      page++;
    }

    res.json(allActivities);
  } catch (err) {
    console.error("❌ Errore fetch attività:", err.message);
    res.status(500).json({ error: "Errore fetch attività", details: err.message });
  }
});

// 📌 Attività per pagina
app.get("/strava/activities/page/:page", ensureToken, async (req, res) => {
  try {
    const page = parseInt(req.params.page);
    const response = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { per_page: 200, page },
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore paginazione:", err.message);
    res.status(500).json({ error: "Errore paginazione", details: err.message });
  }
});

// 📊 Stream biomeccanici
app.get("/strava/activity/:id/streams", ensureToken, async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`https://www.strava.com/api/v3/activities/${id}/streams`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        keys: "time,altitude,velocity_smooth,heartrate,cadence,watts",
        key_by_type: true,
      },
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore fetch streams:", err.message);
    res.status(500).json({ error: "Errore fetch streams", details: err.message });
  }
});

// 📌 Dettagli attività con segmenti e zone
app.get("/strava/activity/:id", ensureToken, async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`https://www.strava.com/api/v3/activities/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { include_all_efforts: true },
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore fetch dettagli attività:", err.message);
    res.status(500).json({ error: "Errore fetch dettagli attività", details: err.message });
  }
});

// 📦 Salva attività arricchite
app.get("/strava/save-enriched", ensureToken, async (req, res) => {
  try {
    let allActivities = [];
    let page = 1;

    while (true) {
      const response = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { per_page: 100, page },
      });

      const data = response.data;
      if (data.length === 0) break;

      allActivities.push(...data);
      page++;
    }

    const enriched = await Promise.all(
      allActivities.map(async (a) => {
        try {
          const [streams, details] = await Promise.all([
            axios.get(`https://www.strava.com/api/v3/activities/${a.id}/streams`, {
              headers: { Authorization: `Bearer ${accessToken}` },
              params: {
                keys: "time,altitude,velocity_smooth,heartrate,cadence,watts",
                key_by_type: true,
              },
            }),
            axios.get(`https://www.strava.com/api/v3/activities/${a.id}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
              params: { include_all_efforts: true },
            }),
          ]);

          return {
            ...a,
            streams: streams.data,
            efforts: details.data.segment_efforts,
            zones: details.data.zone_heartrate,
            splits: details.data.splits_metric,
          };
        } catch (err) {
          console.warn(`⚠️ Attività ${a.id} non arricchita`);
          return a;
        }
      })
    );

    fs.writeFileSync("attivita.json", JSON.stringify(enriched, null, 2));
    res.json({ status: "✅ Attività arricchite salvate", count: enriched.length });
  } catch (err) {
    console.error("❌ Errore salvataggio arricchito:", err.message);
    res.status(500).json({ error: "Errore salvataggio arricchito", details: err.message });
  }
});

// 🧠 Analisi settimanale
app.get("/analyze/week", (req, res) => {
  try {
    if (!fs.existsSync("attivita.json")) {
      return res.status(404).json({ error: "⚠️ attivita.json non trovato" });
    }

    const raw = fs.readFileSync("attivita.json");
    const activities = JSON.parse(raw);

    const weeks = {};

    for (const a of activities) {
      const start = new Date(a.start_date);
      const year = start.getFullYear();
      const week = Math.ceil((((start - new Date(year, 0, 1)) / 86400000) + new Date(year, 0, 1).getDay() + 1) / 7);
      const key = `${year}-W${week}`;

      if (!weeks[key]) {
        weeks[key] = { distance: 0, time: 0, elevation: 0, count: 0 };
      }

      weeks[key].distance += a.distance || 0;
      weeks[key].time += a.moving_time || 0;
      weeks[key].elevation += a.total_elevation_gain || 0;
      weeks[key].count++;
    }

    const sorted = Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b));
    const labels = sorted.map(([k]) => k);
    const km = sorted.map(([, v]) => (v.distance / 1000).toFixed(1));
    const ore = sorted.map(([, v]) => (v.time / 3600).toFixed(1));
    const dislivello = sorted.map(([, v]) => v.elevation.toFixed(0));

    const last = sorted.at(-1)?.[1] || {};
    const text = `Ultima settimana: ${((last.distance || 0) / 1000).toFixed(1)} km, ${(last.time / 3600).toFixed(1)} ore, ${last.elevation?.toFixed(0)} m di dislivello su ${last.count} attività.`;

    res.json({
      text,
      chart: {
        labels,
        datasets: [
          { label: "Distanza (km)", data: km, borderColor: "blue" },
          { label: "Tempo (h)", data: ore, borderColor: "green" },
          { label: "Dislivello (m)", data: dislivello, borderColor: "orange" }
        ]
      }
    });
  } catch (err) {
    console.error("❌ Errore analisi:", err.message);
    res.status(500).json({ error: "Errore analisi settimanale", details: err.message });
  }
});
// 🧠 Riconoscimento percorsi ricorrenti
app.get("/recognize/routes", (req, res) => {
  try {
    if (!fs.existsSync("attivita.json")) {
      return res.status(404).json({ error: "⚠️ attivita.json non trovato" });
    }

    const raw = fs.readFileSync("attivita.json");
    const activities = JSON.parse(raw);

    const routeMap = new Map();

    for (const a of activities) {
      const polyline = a.map?.summary_polyline;
      if (!polyline) continue;

      const key = polyline.slice(0, 30); // hash semplificato
      if (!routeMap.has(key)) {
        routeMap.set(key, { name: a.name, count: 0 });
      }
      routeMap.get(key).count++;
    }

    const routes = Array.from(routeMap.entries())
      .filter(([, v]) => v.count > 1)
      .map(([hash, v]) => ({ route: v.name, hash, count: v.count }));

    res.json({ routes });
  } catch (err) {
    console.error("❌ Errore riconoscimento percorsi:", err.message);
    res.status(500).json({ error: "Errore riconoscimento percorsi", details: err.message });
  }
});

app.get("/analyze/biometrics", (req, res) => {
  try {
    if (!fs.existsSync("attivita.json")) {
      return res.status(404).json({ error: "⚠️ attivita.json non trovato" });
    }

    const raw = fs.readFileSync("attivita.json");
    const activities = JSON.parse(raw);

    const result = [];

    for (const a of activities) {
      const id = a.id;
      const name = a.name;
      const date = a.start_date_local;
      const hr = a.heartrate_stream || a.streams?.heartrate?.data || [];
      const cadence = a.cadence_stream || a.streams?.cadence?.data || [];
      const watts = a.watts_stream || a.streams?.watts?.data || [];
      const velocity = a.velocity_stream || a.streams?.velocity_smooth?.data || [];
      const altitude = a.altitude_stream || a.streams?.altitude?.data || [];

      result.push({
        id,
        name,
        date,
        heartRate: hr,
        cadence,
        watts,
        velocity,
        altitude
      });
    }

    res.json({ count: result.length, activities: result });
  } catch (err) {
    console.error("❌ Errore analisi biometrica:", err.message);
    res.status(500).json({ error: "Errore analisi biometrica", details: err.message });
  }
});

app.get("/compare/activities/:metric", (req, res) => {
  try {
    const metric = req.params.metric;
    if (!fs.existsSync("attivita.json")) {
      return res.status(404).json({ error: "⚠️ attivita.json non trovato" });
    }

    const raw = fs.readFileSync("attivita.json");
    const activities = JSON.parse(raw);

    const result = activities.map((a) => {
      const stream = a[`${metric}_stream`] || a.streams?.[metric]?.data || [];
      const avg = stream.length ? (stream.reduce((s, v) => s + v, 0) / stream.length).toFixed(1) : null;
      return {
        id: a.id,
        name: a.name,
        date: a.start_date_local,
        average: avg
      };
    }).filter((r) => r.average !== null);

    res.json({ metric, count: result.length, comparison: result });
  } catch (err) {
    console.error("❌ Errore confronto attività:", err.message);
    res.status(500).json({ error: "Errore confronto attività", details: err.message });
  }
});

app.get("/export/csv", (req, res) => {
  try {
    if (!fs.existsSync("attivita.json")) {
      return res.status(404).json({ error: "⚠️ attivita.json non trovato" });
    }

    const raw = fs.readFileSync("attivita.json");
    const activities = JSON.parse(raw);

    const rows = [["id", "name", "date", "avg_heartRate", "avg_velocity", "avg_altitude"]];
    for (const a of activities) {
      const hr = a.heartrate_stream || a.streams?.heartrate?.data || [];
      const velocity = a.velocity_stream || a.streams?.velocity_smooth?.data || [];
      const altitude = a.altitude_stream || a.streams?.altitude?.data || [];

      const avgHR = hr.length ? (hr.reduce((s, v) => s + v, 0) / hr.length).toFixed(1) : "";
      const avgVel = velocity.length ? (velocity.reduce((s, v) => s + v, 0) / velocity.length).toFixed(2) : "";
      const avgAlt = altitude.length ? (altitude.reduce((s, v) => s + v, 0) / altitude.length).toFixed(1) : "";

      rows.push([a.id, a.name, a.start_date_local, avgHR, avgVel, avgAlt]);
    }

    const csv = rows.map((r) => r.join(",")).join("\n");
    fs.writeFileSync("biometric_export.csv", csv);
    res.json({ status: "✅ CSV esportato", rows: rows.length });
  } catch (err) {
    console.error("❌ Errore esportazione CSV:", err.message);
    res.status(500).json({ error: "Errore esportazione CSV", details: err.message });
  }
});

app.get("/analyze/intensity", (req, res) => {
  try {
    if (!fs.existsSync("attivita.json")) {
      return res.status(404).json({ error: "⚠️ attivita.json non trovato" });
    }

    const raw = fs.readFileSync("attivita.json");
    const activities = JSON.parse(raw);

    const result = activities.map((a) => {
      const hr = a.heartrate_stream || a.streams?.heartrate?.data || [];
      const watts = a.watts_stream || a.streams?.watts?.data || [];
      const duration = hr.length;

      const avgHR = hr.length ? (hr.reduce((s, v) => s + v, 0) / hr.length).toFixed(1) : null;
      const maxHR = hr.length ? Math.max(...hr) : null;
      const avgWatts = watts.length ? (watts.reduce((s, v) => s + v, 0) / watts.length).toFixed(1) : null;

      const zones = {
        zone1: hr.filter((v) => v < 120).length,
        zone2: hr.filter((v) => v >= 120 && v < 140).length,
        zone3: hr.filter((v) => v >= 140 && v < 160).length,
        zone4: hr.filter((v) => v >= 160 && v < 180).length,
        zone5: hr.filter((v) => v >= 180).length
      };

      return {
        id: a.id,
        name: a.name,
        date: a.start_date_local,
        avgHR,
        maxHR,
        avgWatts,
        duration,
        zones
      };
    });

    res.json({ count: result.length, intensity: result });
  } catch (err) {
    console.error("❌ Errore analisi intensità:", err.message);
    res.status(500).json({ error: "Errore analisi intensità", details: err.message });
  }
});

app.get("/strava/token-info", (req, res) => {
  try {
    if (!tokenData) {
      return res.status(404).json({ error: "Token non disponibile" });
    }
    res.json({
      valid: Date.now() < tokenData.expires_at * 1000,
      expires_at: tokenData.expires_at,
      access_token: tokenData.access_token?.slice(0, 10) + "...",
      athlete: tokenData.athlete || "N/D"
    });
  } catch (err) {
    res.status(500).json({ error: "Errore nel recupero token" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server attivo su http://localhost:${PORT}`);
});




