import makeWASocket, {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  BufferJSON,
  initAuthCreds
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { Redis } from '@upstash/redis';

// Konfigurasi Redis Upstash
const redis = new Redis({
  url: process.env.REDIS_URL || 'https://YOUR_REDIS_URL.upstash.io',
  token: process.env.REDIS_TOKEN || 'YOUR_REDIS_TOKEN',
});

// --- FUNGSI HELPER (DIPERBAIKI DENGAN BufferJSON) ---

async function getSession(nomor) {
  try {
    const data = await redis.get(`whatsapp:session:${nomor}`);
    if (!data) return null;
    // Gunakan BufferJSON.reviver agar data binary/Buffer tidak rusak
    return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
  } catch (err) {
    return null;
  }
}

async function saveSession(nomor, state) {
  try {
    // Gunakan BufferJSON.replacer untuk simpan data binary
    await redis.set(`whatsapp:session:${nomor}`, JSON.stringify(state, BufferJSON.replacer), {
      ex: 2592000, // 30 hari
    });
    await redis.sadd('whatsapp:sessions:list', nomor);
  } catch (err) {
    console.error(`Error saveSession:`, err.message);
  }
}

async function deleteSession(nomor) {
  try {
    const keys = await redis.keys(`whatsapp:*:${nomor}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.srem('whatsapp:sessions:list', nomor);
  } catch (err) {
    console.error(`Error deleteSession:`, err.message);
  }
}

async function getAllSessions() {
  try {
    return await redis.smembers('whatsapp:sessions:list');
  } catch (err) {
    return [];
  }
}

async function getSessionInfo(nomor) {
  try {
    const ttl = await redis.ttl(`whatsapp:session:${nomor}`);
    const exists = await redis.exists(`whatsapp:session:${nomor}`);
    return {
      exists: exists === 1,
      ttl: ttl,
      expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} hari` : 'n/a'
    };
  } catch (err) {
    return null;
  }
}

// --- MAIN HANDLER ---

export default async (req, res) => {
  try {
    const nomor = req.query.nomor;
    const action = req.query.action || 'connect';

    if (!nomor && action !== 'list') {
      return res.status(400).json({ status: 'error', message: 'Parameter "nomor" is required' });
    }

    // Handle Actions (Fitur yang kamu minta jangan dihilangkan)
    switch (action) {
      case 'list':
        const sessions = await getAllSessions();
        return res.status(200).json({ status: 'success', sessions });
      case 'info':
        const info = await getSessionInfo(nomor);
        return res.status(200).json({ status: 'success', nomor, ...info });
      case 'delete':
        await deleteSession(nomor);
        return res.status(200).json({ status: 'success', message: `Deleted ${nomor}` });
    }

    // --- LOGIKA KONEKSI (FIX ERROR 'ME') ---
    async function connectToWhatsApp() {
      const savedState = await getSession(nomor);
      
      // FIX: Jika session kosong, buat initAuthCreds, jangan {}
      const { state, saveCreds } = {
        state: savedState || { creds: initAuthCreds(), keys: {} },
        saveCreds: async () => {
          // Fungsi ini akan dipanggil oleh event creds.update
        }
      };

      const { version } = await fetchLatestBaileysVersion();
      const pairingCode = true;

      const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: {
            get: (type, ids) => ids.reduce((acc, id) => {
              const value = state.keys[type]?.[id];
              if (value) acc[id] = value;
              return acc;
            }, {}),
            set: (data) => {
              for (const type in data) {
                state.keys[type] = { ...state.keys[type], ...data[type] };
              }
            }
          }
        },
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: 60000,
      });

      // Simpan session setiap ada update
      sock.ev.on('creds.update', async () => {
        await saveSession(nomor, { creds: sock.authState.creds, keys: state.keys });
      });

      sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

    /*    if (!pairingCode && !res.headersSent) {
          const qrImage = await QRCode.toDataURL(qr);
          return res.status(200).json({ status: 'success', qrCode: qrImage });
        }*/

        if (connection === 'open') {
          console.log(`Connected: ${nomor}`);
          await redis.set(`whatsapp:status:${nomor}`, 'connected', { ex: 86400 });
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            await deleteSession(nomor);
          } else {
            // Auto reconnect logic jika perlu di sini
          }
        }
      });

      // Logic Pairing Code (Sesuai script awalmu)
      if (pairingCode && !res.headersSent) {
        try {
          // Beri jeda sedikit agar socket siap
          
          const code = await sock.requestPairingCode(nomor);
          return res.status(200).json({
            status: 'success',
            pairingCode: code,
            message: `Pairing code generated for ${nomor}`
          });
        } catch (err) {
          console.error("Pairing Error:", err.message);
        }
      }
    }

    await connectToWhatsApp();

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }
};
