import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { Redis } from '@upstash/redis';

// Konfigurasi Redis Upstash
const redis = new Redis({
  url: process.env.REDIS_URL || 'https://your-redis.upstash.io',
  token: process.env.REDIS_TOKEN || 'your-redis-token',
});

// Fungsi untuk mendapatkan sesi dari Redis
async function getSession(number) {
  try {
    const sessionData = await redis.get(`whatsapp:session:${number}`);
    
    if (sessionData) {
      try {
        const parsed = JSON.parse(sessionData);
        return {
          creds: parsed.creds || {},
          keys: parsed.keys || makeCacheableSignalKeyStore({}, { logger: pino().child({ level: 'fatal' }) }),
        };
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
    if (!state || !state.creds) {
      console.error('Invalid state to save for', number);
      return;
    }

    // Simpan dengan TTL 30 hari (2592000 detik)
    await redis.set(`whatsapp:session:${number}`, JSON.stringify(state), {
      ex: 2592000,
    });
    
    // Simpan juga ke set untuk tracking semua session
    await redis.sadd('whatsapp:sessions:list', number);
    
    console.log(`Session saved for ${number}`);
  } catch (err) {
    console.error(`Error in saveSession:`, err.message);
  }
}

// Fungsi untuk menghapus sesi
async function deleteSession(number) {
  try {
    await redis.del(`whatsapp:session:${number}`);
    await redis.del(`whatsapp:connected:${number}`);
    await redis.srem('whatsapp:sessions:list', number);
    console.log(`Session deleted for ${number}`);
  } catch (err) {
    console.error(`Error in deleteSession:`, err.message);
  }
}

export default async (req, res) => {
  // Set timeout yang lebih panjang untuk Vercel
  res.setTimeout(120000); // 2 menit
  
  try {
    const number = req.query.number;
    const action = req.query.action || 'connect';
    
    if (!number && !['list'].includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: 'Parameter "number" is required',
      });
    }
    
    // Jika action bukan connect, handle terpisah
    if (action === 'list') {
      try {
        const sessions = await redis.smembers('whatsapp:sessions:list');
        const sessionsInfo = [];
        
        for (const sessionNumber of sessions) {
          const exists = await redis.exists(`whatsapp:session:${sessionNumber}`);
          const connected = await redis.exists(`whatsapp:connected:${sessionNumber}`);
          const ttl = await redis.ttl(`whatsapp:session:${sessionNumber}`);
          
          sessionsInfo.push({
            number: sessionNumber,
            has_session: exists === 1,
            is_connected: connected === 1,
            expires_in_days: ttl > 0 ? Math.floor(ttl / 86400) : 'never'
          });
        }
        
        return res.status(200).json({
          status: 'success',
          total_sessions: sessions.length,
          sessions: sessionsInfo
        });
      } catch (error) {
        return res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    }
    
    if (action === 'info') {
      try {
        const exists = await redis.exists(`whatsapp:session:${number}`);
        const connected = await redis.exists(`whatsapp:connected:${number}`);
        const ttl = await redis.ttl(`whatsapp:session:${number}`);
        
        return res.status(200).json({
          status: 'success',
          number: number,
          has_session: exists === 1,
          is_connected: connected === 1,
          ttl_seconds: ttl,
          expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} days` : 'never'
        });
      } catch (error) {
        return res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    }
    
    if (action === 'delete') {
      try {
        await deleteSession(number);
        return res.status(200).json({
          status: 'success',
          message: `Session for ${number} deleted successfully`
        });
      } catch (error) {
        return res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    }
    
    // Jika action = 'connect'
    console.log(`Starting WhatsApp connection for: ${number}`);
    
    // Ambil session dari Redis
    const savedState = await getSession(number);
    
    // Inisialisasi state
    let authState = savedState || {
      creds: {},
      keys: makeCacheableSignalKeyStore({}, { logger: pino().child({ level: 'fatal' }) })
    };
    
    console.log(`Session state for ${number}:`, savedState ? 'found' : 'not found');
    
    // Buat socket WhatsApp
    const sock = makeWASocket({
      logger: pino({ level: 'fatal' }),
      printQRInTerminal: false,
      auth: authState,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: true,
      fireInitQueries: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      browser: ["Chrome", "Ubuntu", "20.0.04"],
      getMessage: async () => {
        return undefined;
      },
    });
    
    console.log('Connection update: connecting');
    
    // Flag untuk mencegah multiple responses
    let responseSent = false;
    
    // Handler untuk update koneksi
    sock.ev.on('connection.update', async (update) => {
      try {
        console.log('Connection update:', update.connection || 'event');
        
        const { qr, connection, lastDisconnect, pairingCode } = update;
        
        // Handle QR Code
        if (qr && !responseSent) {
          console.log('QR Code generated');
          responseSent = true;
          
          const qrImage = await QRCode.toDataURL(qr);
          return res.status(200).json({
            status: 'success',
            qrCode: qrImage,
            message: `QR code for ${number} generated successfully`,
            qr: qr // Tambahkan raw QR untuk backup
          });
        }
        
        // Handle Pairing Code
        if (pairingCode && !responseSent) {
          console.log('Pairing code generated:', pairingCode);
          responseSent = true;
          
          return res.status(200).json({
            status: 'success',
            pairingCode,
            message: `Pairing code for ${number} generated successfully`,
          });
        }
        
        // Handle Connection Open
        if (connection === 'open') {
          console.log(`✅ Connected to WhatsApp for number: ${number}`);
          
          // Simpan status connected
          await redis.set(`whatsapp:connected:${number}`, 'true', { ex: 86400 });
          
          // Kirim response success jika belum dikirim
          if (!responseSent) {
            responseSent = true;
            return res.status(200).json({
              status: 'success',
              message: `Connected to WhatsApp successfully for ${number}`,
              user: sock.user ? { id: sock.user.id } : null
            });
          }
        }
        
        // Handle Connection Close
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = statusCode || 'Unknown Reason';
          
          console.log(`❌ Connection closed for ${number} - Reason: ${reason}`);
          
          // Hapus status connected
          await redis.del(`whatsapp:connected:${number}`);
          
          // Jika logged out, hapus session
          if (reason === DisconnectReason.loggedOut || statusCode === 401) {
            console.log('User logged out, clearing session');
            await deleteSession(number);
          }
          
          // Kirim error response jika belum ada response
          if (!responseSent) {
            responseSent = true;
            return res.status(500).json({
              status: 'error',
              message: `Connection closed: ${reason}`,
              reconnect: reason !== DisconnectReason.loggedOut && statusCode !== 401
            });
          }
        }
        
      } catch (error) {
        console.error('Error in connection.update handler:', error.message);
        
        if (!responseSent) {
          responseSent = true;
          return res.status(500).json({
            status: 'error',
            message: `Connection error: ${error.message}`
          });
        }
      }
    });
    
    // Handler untuk update credentials
    sock.ev.on('creds.update', async (creds) => {
      try {
        console.log('Credentials updated for', number);
        
        // Simpan state yang lengkap
        const stateToSave = {
          creds: creds,
          keys: sock.authState.keys
        };
        
        await saveSession(number, stateToSave);
      } catch (error) {
        console.error('Error saving credentials:', error.message);
      }
    });
    
    // Coba request pairing code jika fitur tersedia
    setTimeout(async () => {
      try {
        // Cek jika sudah terkoneksi
        if (sock.user) {
          console.log('Already connected, skipping pairing code request');
          return;
        }
        
        // Coba request pairing code
        if (sock.requestPairingCode && typeof sock.requestPairingCode === 'function') {
          console.log('Requesting pairing code for:', number);
          
          const pairingCode = await sock.requestPairingCode(number.replace(/[^0-9]/g, ''));
          
          if (pairingCode && !responseSent) {
            responseSent = true;
            console.log('Pairing code received:', pairingCode);
            
            return res.status(200).json({
              status: 'success',
              pairingCode,
              message: `Pairing code for ${number} generated successfully`,
            });
          }
        }
      } catch (error) {
        console.error('Error requesting pairing code:', error.message);
        // Tidak perlu kirim error karena mungkin QR code sudah dikirim
      }
    }, 2000);
    
    // Timeout handler
    setTimeout(() => {
      if (!responseSent) {
        responseSent = true;
        console.log('Connection timeout');
        
        return res.status(408).json({
          status: 'error',
          message: 'Connection timeout. Please try again.',
          suggestion: 'Make sure your number is valid and try again in 30 seconds'
        });
      }
    }, 45000); // 45 detik timeout
    
  } catch (error) {
    console.error(`Error for number: ${req.query.number || 'unknown'} -`, error.message);
    
    return res.status(500).json({ 
      status: 'error', 
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
