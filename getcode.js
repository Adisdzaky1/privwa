import { DisconnectReason, useMultiFileAuthState } from 'baileys-york';
import {
  default as makeWASocket,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
  makeInMemoryStore,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,

  jidDecode,
  delay,
  getAggregateVotesInPollMessage,
  downloadContentFromMessage,
  getContentType
} from 'baileys-york';
import QRCode from 'qrcode';
import pino from 'pino';
import { Redis } from '@upstash/redis';

// Konfigurasi Redis Upstash
const redis = new Redis({
  url: process.env.REDIS_URL || 'https://YOUR_REDIS_URL.upstash.io',
  token: process.env.REDIS_TOKEN || 'YOUR_REDIS_TOKEN',
});

// Fungsi untuk mendapatkan sesi dari Redis
async function getSession(number) {
  try {
    const authState = await redis.get(`whatsapp:session:${number}`);
    
    if (authState) {
      try {
        return JSON.parse(authState);
      } catch (e) {
        console.error(`Error parsing auth state for ${number}:`, e.message);
        return null;
      }
    }
    return null;
  } catch (err) {
    console.error(`Error in getSession:`, err.message);
    return null;
  }
}

// Fungsi untuk menyimpan sesi ke Redis
async function saveSession(number, state) {
  try {
    // Simpan dengan TTL 7 hari (604800 detik)
    await redis.set(`whatsapp:session:${number}`, JSON.stringify(state), {
      ex: 2592000, // 30 hari dalam detik
    });
    
    // Simpan juga ke set untuk tracking semua session
    await redis.sadd('whatsapp:sessions:list', number);
  } catch (err) {
    console.error(`Error in saveSession:`, err.message);
  }
}

// Fungsi untuk menghapus sesi
async function deleteSession(number) {
  try {
    await redis.del(`whatsapp:session:${number}`);
    await redis.srem('whatsapp:sessions:list', number);
  } catch (err) {
    console.error(`Error in deleteSession:`, err.message);
  }
}

// Fungsi untuk mendapatkan semua sesi aktif
async function getAllSessions() {
  try {
    const sessions = await redis.smembers('whatsapp:sessions:list');
    return sessions;
  } catch (err) {
    console.error(`Error in getAllSessions:`, err.message);
    return [];
  }
}

// Fungsi untuk mendapatkan info sesi
async function getSessionInfo(number) {
  try {
    const ttl = await redis.ttl(`whatsapp:session:${number}`);
    const exists = await redis.exists(`whatsapp:session:${number}`);
    
    return {
      exists: exists === 1,
      ttl: ttl, // -2: key tidak ada, -1: no expiry, >=0: sisa waktu dalam detik
      expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} hari ${Math.floor((ttl % 86400) / 3600)} jam` : 'tidak ada expiry'
    };
  } catch (err) {
    console.error(`Error in getSessionInfo:`, err.message);
    return null;
  }
}

export default async (req, res) => {
  try {
    const number = req.query.number;
    const action = req.query.action || 'connect'; // connect, list, info, delete
    
    if (!number && !['list'].includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: 'Parameter "number" is required for this action',
      });
    }
    
    // Handle different actions
    switch (action) {
      case 'list':
        const sessions = await getAllSessions();
        const sessionsInfo = [];
        
        for (const sessionNumber of sessions) {
          const info = await getSessionInfo(sessionNumber);
          sessionsInfo.push({
            number: sessionNumber,
            ...info
          });
        }
        
        return res.status(200).json({
          status: 'success',
          total_sessions: sessions.length,
          sessions: sessionsInfo
        });
        
      case 'info':
        const info = await getSessionInfo(number);
        return res.status(200).json({
          status: 'success',
          number: number,
          ...info
        });
        
      case 'delete':
        await deleteSession(number);
        return res.status(200).json({
          status: 'success',
          message: `Session for ${number} deleted successfully`
        });
    }
    
    // Fungsi untuk koneksi ke WhatsApp (action = 'connect')
    async function connectToWhatsApp() {
      try {
        // Ambil session dari Redis
        const savedState = await getSession(number);
        const authState = savedState || {};
        const usePairingCode = true;

        const sock = makeWASocket({
          logger: pino({ level: "silent" }),
          printQRInTerminal: false,
          auth: authState,
          connectTimeoutMs: 60000,
          defaultQueryTimeoutMs: 0,
          keepAliveIntervalMs: 10000,
          emitOwnEvents: true,
          fireInitQueries: true,
          generateHighQualityLinkPreview: true,
          syncFullHistory: true,
          markOnlineOnConnect: true,
          browser: ["iOS", "Safari", "16.5.1"],
        });

        // Event handler untuk koneksi
        sock.ev.on('connection.update', async (update) => {
          const { qr, connection, lastDisconnect, pairingCode } = update;

          if (qr) {
            const qrImage = await QRCode.toDataURL(qr);
            return res.status(200).json({
              status: 'success',
              qrCode: qrImage,
              message: `QR code for ${number} generated successfully`,
            });
          }

          if (pairingCode) {
            return res.status(200).json({
              status: 'success',
              pairingCode,
              message: `Pairing code for ${number} generated successfully`,
            });
          }

          if (connection === 'open') {
            console.log(`Connected to WhatsApp for number: ${number}`);
            if (sock?.user) {
              console.log(`User: ${sock.user.id} connected`);
              // Update session info after successful connection
              await redis.set(`whatsapp:connected:${number}`, 'true', {
                ex: 86400, // 1 hari
              });
            } else {
              console.warn('User information is undefined');
            }
          }

          if (connection === 'close') {
            const reason =
              lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
            console.log(`Connection closed for number: ${number} - Reason: ${reason}`);

            // Hapus connected status
            await redis.del(`whatsapp:connected:${number}`);

            if (reason !== DisconnectReason.loggedOut) {
              console.log('Reconnecting...');
              await connectToWhatsApp();
            } else {
              console.log('User logged out, clearing session');
              await deleteSession(number);
            }
          }
        });

        // Simpan kredensial saat diperbarui
        sock.ev.on('creds.update', async (newState) => {
          try {
            await saveSession(number, newState);
          } catch (err) {
            console.error(`Failed to save session for ${number}:`, err.message);
          }
        });

        // Permintaan pairing code jika diperlukan
        if (usePairingCode) {
          const code = await sock.requestPairingCode(number);
          console.log(`Pairing code for ${number}: ${code}`);
        }
        
        return sock;
      } catch (error) {
        console.error(`Error during WhatsApp connection:`, error.message);
        res.status(500).json({
          status: 'error',
          message: 'Failed to connect to WhatsApp',
        });
      }
    }

    await connectToWhatsApp();
  } catch (error) {
    console.error(`Error for number: ${req.query.number || 'unknown'} -`, error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
};
