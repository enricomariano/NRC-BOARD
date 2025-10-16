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

// 📊 Stream biomeccanici per grafici
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

// 📦 Salva tutte le attività in attivita.json
app.get("/strava/save-activities", ensureToken, async (req, res) => {
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

    fs.writeFileSync("attivita.json", JSON.stringify(allActivities, null, 2));
    res.json({ status: "✅ Attività salvate", count: allActivities.length });
  } catch (err) {
    console.error("❌ Errore salvataggio attività:", err.message);
    res.status(500).json({ error: "Errore salvataggio attività", details: err.message });
  }
});

// 🧠 Analisi settimanale da attivita.json
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

// 📌 Dettagli singola attività
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
app.listen(PORT, () => {
  console.log(`🚀 Server attivo su http://localhost:${PORT}`);
});


