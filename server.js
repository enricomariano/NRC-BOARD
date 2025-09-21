import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

let accessToken = null;  // ❌ rimosso ": string | null"
let tokenExpiresAt = 0;

// 🔄 Funzione per aggiornare il token automaticamente
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

// 🔹 Middleware: controlla se il token è scaduto e lo aggiorna
async function ensureToken(req, res, next) {
  const now = Math.floor(Date.now() / 1000);
  if (!accessToken || now >= tokenExpiresAt) {
    await refreshAccessToken();
  }
  next();
}

// 🔹 Endpoint per attività Strava
app.get("/strava/activities", ensureToken, async (req, res) => {
  try {
    const response = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { per_page: 10 }, // Limitiamo a 10 attività
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Errore fetch attività:", err.response?.data || err.message);
    res.status(500).json({ error: "Errore fetch attività", details: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend Strava attivo su http://localhost:${PORT}`);
  refreshAccessToken(); // Aggiorna subito al primo avvio
});

