import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
  makeInMemoryStore,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidDecode,
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
    // Simpan dengan TTL 30 hari
    await redis.set(`whatsapp:session:${number}`, JSON.stringify(state), {
      ex: 2592000,
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
    
    // Hapus juga status connected dan user info
    await redis.del(`whatsapp:connected:${number}`);
    await redis.del(`whatsapp:user:${number}`);
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
    const connected = await redis.exists(`whatsapp:connected:${number}`);
    const userInfo = await redis.get(`whatsapp:user:${number}`);
    
    return {
      exists: exists === 1,
      connected: connected === 1,
      ttl: ttl,
      expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} hari ${Math.floor((ttl % 86400) / 3600)} jam` : 'tidak ada expiry',
      user_info: userInfo ? JSON.parse(userInfo) : null
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
          // Tambahkan options untuk mendapatkan user info
          getMessage: async () => undefined,
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
            
            // Simpan status connected
            await redis.set(`whatsapp:connected:${number}`, 'true', {
              ex: 86400, // 1 hari
            });
            
            // Simpan informasi user dengan cara yang lebih aman
            try {
              // Coba beberapa cara untuk mendapatkan user info
              let userInfo = null;
              
              if (sock.user && sock.user.id) {
                userInfo = sock.user;
              } else if (sock.authState && sock.authState.creds && sock.authState.creds.me) {
                // Alternatif: dapatkan dari creds
                userInfo = {
                  id: sock.authState.creds.me.id || number,
                  name: sock.authState.creds.me.name || 'Unknown'
                };
              } else {
                // Buat user info default
                userInfo = {
                  id: number,
                  name: 'WhatsApp User'
                };
              }
              
              await redis.set(`whatsapp:user:${number}`, JSON.stringify(userInfo), { ex: 86400 });
              console.log(`User info saved for ${number}:`, userInfo.id);
            } catch (userError) {
              console.error(`Error saving user info for ${number}:`, userError.message);
            }
          }

          if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
            console.log(`Connection closed for number: ${number} - Reason: ${reason}`);

            // Hapus connected status
            await redis.del(`whatsapp:connected:${number}`);

            if (reason !== DisconnectReason.loggedOut) {
              console.log('Reconnecting...');
              // Tunggu sebentar sebelum reconnect
              await new Promise(resolve => setTimeout(resolve, 5000));
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
            // Simpan state yang sudah digabungkan dengan existing state
            const existingState = await getSession(number) || {};
            const updatedState = {
              ...existingState,
              creds: newState
            };
            await saveSession(number, updatedState);
            console.log(`Session updated for ${number}`);
          } catch (err) {
            console.error(`Failed to save session for ${number}:`, err.message);
          }
        });

        // Permintaan pairing code jika diperlukan
        if (usePairingCode) {
          try {
            const code = await sock.requestPairingCode(number);
            console.log(`Pairing code for ${number}: ${code}`);
            
            // Jika pairing code berhasil, kembalikan response
            if (!res.headersSent) {
              return res.status(200).json({
                status: 'success',
                pairingCode: code,
                message: `Pairing code for ${number} generated successfully`,
              });
            }
          } catch (pairingError) {
            console.error(`Error getting pairing code for ${number}:`, pairingError.message);
          }
        }
        
        return sock;
      } catch (error) {
        console.error(`Error during WhatsApp connection:`, error.message);
        if (!res.headersSent) {
          res.status(500).json({
            status: 'error',
            message: 'Failed to connect to WhatsApp',
          });
        }
      }
    }

    await connectToWhatsApp();
  } catch (error) {
    console.error(`Error for number: ${req.query.number || 'unknown'} -`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }
};
