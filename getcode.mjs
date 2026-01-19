import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidDecode,
  BufferJSON,
  initAuthCreds,
  delay,
  getAggregateVotesInPollMessage,
  downloadContentFromMessage,
  getContentType
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { Redis } from '@upstash/redis';

// Konfigurasi Redis Upstash
const redis = new Redis({
  url: process.env.REDIS_URL || 'https://YOUR_REDIS_URL.upstash.io',
  token: process.env.REDIS_TOKEN || 'YOUR_REDIS_TOKEN',
});

// Fungsi untuk mendapatkan sesi dari Redis
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

// Fungsi untuk menyimpan sesi ke Redis
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

// Fungsi untuk menghapus sesi
async function deleteSession(nomor) {
  try {
    await redis.del(`whatsapp:session:${nomor}`);
    await redis.srem('whatsapp:sessions:list', nomor);
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
async function getSessionInfo(nomor) {
  try {
    const ttl = await redis.ttl(`whatsapp:session:${nomor}`);
    const exists = await redis.exists(`whatsapp:session:${nomor}`);
    
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
    const nomor = req.query.nomor;
    const action = req.query.action || 'connect'; // connect, list, info, delete
    
    if (!nomor && !['list'].includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: 'Parameter "nomor" is required for this action',
      });
    }
    
    // Handle different actions
    switch (action) {
      case 'list':
        const sessions = await getAllSessions();
        const sessionsInfo = [];
        
        for (const sessionNomor of sessions) {
          const info = await getSessionInfo(sessionNomor);
          sessionsInfo.push({
            nomor: sessionNomor,
            ...info
          });
        }
        
        return res.status(200).json({
          status: 'success',
          total_sessions: sessions.length,
          sessions: sessionsInfo
        });
        
      case 'info':
        const info = await getSessionInfo(nomor);
        return res.status(200).json({
          status: 'success',
          nomor: nomor,
          ...info
        });
        
      case 'delete':
        await deleteSession(nomor);
        return res.status(200).json({
          status: 'success',
          message: `Session for ${nomor} deleted successfully`
        });
    }
    
    // Fungsi untuk koneksi ke WhatsApp (action = 'connect')
    async function connectToWhatsApp() {
      try {
      const savedState = await getSession(nomor);
      
        // Ambil session dari Redis
        const { state, saveCreds } = {
        state: savedState || { creds: initAuthCreds(), keys: {} },
        saveCreds: async () => {
          // Fungsi ini akan dipanggil oleh event creds.update
        }
      };
      const { version } = await fetchLatestBaileysVersion();


        const usePairingCode = true;

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
connectTimeoutMs: 60000,
defaultQueryTimeoutMs: 0,
keepAliveIntervalMs: 10000,
emitOwnEvents: true,
fireInitQueries: true,
generateHighQualityLinkPreview: true,
syncFullHistory: true,
markOnlineOnConnect: true,
browser: ["iOS", "Safari", "16.5.1" ],
        });

        // Event handler untuk koneksi
        sock.ev.on('connection.update', async (update) => {
          try {
            const { qr, connection, lastDisconnect, pairingCode } = update;
/*
            if (qr) {
              const qrImage = await QRCode.toDataURL(qr);
              // Kirim response hanya jika belum dikirim
              
                return res.status(200).json({
                  status: 'success',
                  qrCode: qrImage,
                  message: `QR code for ${nomor} generated successfully`,
                });
              
              return;
            }

            if (pairingCode) {
             // if (!res.headersSent) {
                return res.status(200).json({
                  status: 'success',
                  pairingCode,
                  message: `Pairing code for ${nomor} generated successfully`,
                });
             // }
              return;
            }*/

            if (connection === 'open') {
              console.log(`Connected to WhatsApp for nomor: ${nomor}`);
         
              
              // Periksa dengan hati-hati
              if (sock && sock.user && sock.user.id) {
                console.log(`User connected: ${sock.user.id}`);
                // Update session info after successful connection
                await redis.set(`whatsapp:connected:${nomor}`, 'true', {
                  ex: 86400, // 1 hari
                });
              } else {
                console.log('Connected but user info not available yet');
                // Tetap simpan status connected
                await redis.set(`whatsapp:connected:${nomor}`, 'true', {
                  ex: 86400,
                });
              }
            }

            if (connection === 'close') {
              const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
              console.log(`Connection closed for nomor: ${nomor} - Reason: ${reason}`);

              // Hapus connected status
              await redis.del(`whatsapp:connected:${nomor}`);

              if (reason !== DisconnectReason.loggedOut) {
                console.log('Reconnecting...');
                // Hindari infinite loop dengan delay
                await connectToWhatsApp();
              } else {
                console.log('User logged out, clearing session');
                await deleteSession(nomor);
              }
            }
          } catch (error) {
            console.error('Error in connection.update handler:', error.message);
            // Jangan kirim response jika sudah dikirim
          //  if (!res.headersSent) {
              res.status(500).json({
                status: 'error',
                message: `Error in connection handler: ${error.message}`,
              });
           // }
          }
        });

      // Simpan session setiap ada update
      sock.ev.on('creds.update', async () => {
        await saveSession(nomor, { creds: sock.authState.creds, keys: state.keys });
      });

        // Tambahkan error handler untuk socket
        sock.ev.on('connection.update', (update) => {
          if (update.error) {
            console.error('Socket error:', update.error);
          }
        });

        // Permintaan pairing code jika diperlukan
             if (usePairingCode && !res.headersSent) {
             const code = await sock.requestPairingCode(nomor);
                return res.status(200).json({
                  status: 'success',
                  code,
                  message: `Pairing code for ${nomor} generated successfully`
                });
              return;
            }

        // Jika tidak ada response dalam 30 detik, kirim timeout
        
        
      } catch (error) {
        console.error(`Error during WhatsApp connection:`, error.message);
        if (!res.headersSent) {
          res.status(500).json({
            status: 'error',
            message: `Failed to connect to WhatsApp: ${error.message}`,
          });
        }
      }
    }

    await connectToWhatsApp();
  } catch (error) {
    console.error(`Error for nomor: ${req.query.nomor || 'unknown'} -`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        status: 'error', 
        message: error.message 
      });
    }
  }
};
