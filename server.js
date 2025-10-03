import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

let accessToken = null;
let tokenExpiresAt = 0;

// 🔄 Aggiorna automaticamente il token
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

    console.log("✅ Nuovo token Strava ottenuto, valido fino a:", new Date(tokenExpiresAt * 1000));
  } catch (err) {
    console.error("❌ Errore refresh token:", err.response?.data || err.message);
  }
}

// 🔹 Middleware: controlla token valido
async function ensureToken(req, res, next) {
  const now = Math.floor(Date.now() / 1000);
  if (!accessToken || now >= tokenExpiresAt) {
    await refreshAccessToken();
  }
  next();
}

// 📌 Endpoint: ultime attività
app.get("/strava/activities", ensureToken, async (req, res) => {
  try {
    const response = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { per_page: 10 }, // Ultime 10 attività
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore fetch attività:", err.response?.data || err.message);
    res.status(500).json({ error: "Errore fetch attività", details: err.response?.data || err.message });
  }
});

// 📌 Endpoint: dettagli di una singola attività (incluse mappe e grafici)
app.get("/strava/activity/:id", ensureToken, async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`https://www.strava.com/api/v3/activities/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { include_all_efforts: true }, // Più dettagli
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore fetch dettagli attività:", err.response?.data || err.message);
    res.status(500).json({ error: "Errore fetch dettagli attività", details: err.response?.data || err.message });
  }
});

// 📌 Endpoint: stream per grafici (cadenza, velocità, altitudine, ecc.)
app.get("/strava/activity/:id/streams", ensureToken, async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`https://www.strava.com/api/v3/activities/${id}/streams`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { keys: "time,altitude,velocity_smooth,heartrate,cadence,watts", key_by_type: true },
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore fetch streams:", err.response?.data || err.message);
    res.status(500).json({ error: "Errore fetch streams", details: err.response?.data || err.message });
  }
});

// 📌 Endpoint: singola attività (versione /strava/activities/:id)
app.get("/strava/activities", ensureToken, async (req, res) => {
  try {
    const activitiesRes = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { per_page: 10 },
    });

    const activities = activitiesRes.data;

    // 🔁 Per ogni attività, recupera gli stream biomeccanici
    const enrichedActivities = await Promise.all(
      activities.map(async (activity) => {
        try {
          const streamRes = await axios.get(`https://www.strava.com/api/v3/activities/${activity.id}/streams`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
              keys: "velocity_smooth,altitude,heartrate",
              key_by_type: true,
            },
          });

          const streams = streamRes.data;

          // 🔧 Inserisci gli stream nell’attività
          activity.velocity_stream = streams.velocity_smooth?.data || [];
          activity.altitude_stream = streams.altitude?.data || [];
          activity.heartrate_stream = streams.heartrate?.data || [];

          return activity;
        } catch (streamErr) {
          console.warn(`⚠️ Stream non disponibili per attività ${activity.id}`);
          activity.velocity_stream = [];
          activity.altitude_stream = [];
          activity.heartrate_stream = [];
          return activity;
        }
      })
    );

    res.json(enrichedActivities);
  } catch (err) {
    console.error("❌ Errore fetch attività:", err.response?.data || err.message);
    res.status(500).json({ error: "Errore fetch attività", details: err.response?.data || err.message });
  }
});


