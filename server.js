import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());

// 🔹 Render fornisce la porta in process.env.PORT
const PORT = process.env.PORT || 5000;

let accessToken: string | null = null;
let tokenExpiresAt = 0;

// 🔄 Funzione per aggiornare il token Strava automaticamente
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
  } catch (err: any) {
    console.error("❌ Errore refresh token:", err.response?.data || err.message);
  }
}

// 🔹 Middleware per assicurarsi che il token sia valido
async function ensureToken(req: any, res: any, next: any) {
  const now = Math.floor(Date.now() / 1000);
  if (!accessToken || now >= tokenExpiresAt) {
    await refreshAccessToken();
  }
  next();
}

// 🔹 Endpoint per ottenere le attività Strava
app.get("/strava/activities", ensureToken, async (req, res) => {
  if (!accessToken) {
    return res.status(500).json({ error: "Token non disponibile" });
  }

  try {
    const response = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { per_page: 10, page: 1 }, // Puoi cambiare numero attività e pagina
    });
    res.json(response.data);
  } catch (err: any) {
    console.error("❌ Errore fetch attività:", err.response?.data || err.message);
    res.status(500).json({ error: "Errore fetch attività", details: err.response?.data || err.message });
  }
});

// 🔹 Endpoint per test rapido
app.get("/", (req, res) => res.send("✅ Server Strava attivo!"));

// 🔹 Avvio server
app.listen(PORT, () => {
  console.log(`✅ Backend Strava attivo su http://localhost:${PORT} o porta Render`);
  refreshAccessToken(); // Aggiorna subito al primo avvio
});
