import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
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

// Fungsi untuk mendapatkan sesi dari Redis dengan validasi
async function getSession(nomor) {
  try {
    const authState = await redis.get(`whatsapp:session:${nomor}`);
    
    if (authState) {
      try {
        // Cek jika data adalah object string
        if (typeof authState === 'string') {
          // Coba parse JSON
          const parsed = JSON.parse(authState);
          
          // Validasi struktur
          if (parsed && (parsed.creds || parsed.keys)) {
            return parsed;
          } else {
            console.error(`Invalid session structure for ${nomor}:`, parsed);
            // Hapus data yang tidak valid
            await redis.del(`whatsapp:session:${nomor}`);
            return null;
          }
        } else {
          console.error(`Auth state is not a string for ${nomor}:`, typeof authState);
          await redis.del(`whatsapp:session:${nomor}`);
          return null;
        }
      } catch (e) {
        console.error(`Error parsing auth state for ${nomor}:`, e.message);
        console.error('Raw auth state:', authState);
        
        // Jika parsing gagal, hapus data yang korup
        try {
          await redis.del(`whatsapp:session:${nomor}`);
          await redis.srem('whatsapp:sessions:list', nomor);
        } catch (delError) {
          console.error('Failed to delete corrupted session:', delError.message);
        }
        
        return null;
      }
    }
    return null;
  } catch (err) {
    console.error(`Error in getSession for ${nomor}:`, err.message);
    return null;
  }
}

// Fungsi untuk menyimpan sesi ke Redis dengan validasi
async function saveSession(nomor, state) {
  try {
    // Validasi state sebelum disimpan
    if (!state || typeof state !== 'object') {
      console.error(`Invalid state for ${nomor}:`, state);
      return;
    }
    
    // Pastikan state memiliki struktur yang benar
    const stateToSave = {
      creds: state.creds || {},
      keys: state.keys || {}
    };
    
    // Simpan dengan TTL 30 hari
    await redis.set(`whatsapp:session:${nomor}`, JSON.stringify(stateToSave), {
      ex: 2592000,
    });
    
    // Simpan juga ke set untuk tracking semua session
    await redis.sadd('whatsapp:sessions:list', nomor);
    
    console.log(`Session saved for ${nomor}`);
  } catch (err) {
    console.error(`Error in saveSession for ${nomor}:`, err.message);
  }
}

// Fungsi untuk menghapus sesi
async function deleteSession(nomor) {
  try {
    await redis.del(`whatsapp:session:${nomor}`);
    await redis.del(`whatsapp:connected:${nomor}`);
    await redis.del(`whatsapp:user:${nomor}`);
    await redis.srem('whatsapp:sessions:list', nomor);
    console.log(`Session deleted for ${nomor}`);
  } catch (err) {
    console.error(`Error in deleteSession for ${nomor}:`, err.message);
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
      ttl: ttl,
      expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} hari ${Math.floor((ttl % 86400) / 3600)} jam` : 'tidak ada expiry'
    };
  } catch (err) {
    console.error(`Error in getSessionInfo:`, err.message);
    return null;
  }
}

export default async (req, res) => {
  // Set timeout untuk response
  res.setTimeout(45000, () => {
    if (!res.headersSent) {
      res.status(408).json({
        status: 'error',
        message: 'Request timeout'
      });
    }
  });

  try {
    const nomor = req.query.nomor;
    const action = req.query.action || 'connect';
    
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
      let sock = null;
      let responseSent = false;
      
      const sendResponse = (data) => {
        if (!responseSent && !res.headersSent) {
          responseSent = true;
          res.status(200).json(data);
          return true;
        }
        return false;
      };
      
      const sendError = (message) => {
        if (!responseSent && !res.headersSent) {
          responseSent = true;
          res.status(500).json({
            status: 'error',
            message: message
          });
          return true;
        }
        return false;
      };
      
      try {
        // Ambil session dari Redis
        const savedState = await getSession(nomor);
        console.log(`Session state for ${nomor}:`, savedState ? 'found' : 'not found');
        
        const authState = savedState || {
          creds: {},
          keys: makeCacheableSignalKeyStore({})
        };
        
        const usePairingCode = true;

        sock = makeWASocket({
          logger: pino({ level: "silent" }),
          printQRInTerminal: false,
          auth: authState,
          connectTimeoutMs: 60000,
          defaultQueryTimeoutMs: 0,
          keepAliveIntervalMs: 10000,
          emitOwnEvents: true,
          fireInitQueries: false, // Set ke false dulu
          generateHighQualityLinkPreview: false,
          syncFullHistory: false,
          markOnlineOnConnect: false, // Set ke false dulu
          browser: Browsers.ubuntu('Chrome'),
          getMessage: async () => undefined,
        });

        // Event handler untuk koneksi
        sock.ev.on('connection.update', async (update) => {
          try {
            console.log('Connection update:', update.connection, update.qr ? 'QR received' : '', update.pairingCode ? 'Pairing code received' : '');
            
            const { qr, connection, lastDisconnect, pairingCode } = update;

            if (qr) {
              try {
                const qrImage = await QRCode.toDataURL(qr);
                sendResponse({
                  status: 'success',
                  qrCode: qrImage,
                  message: `QR code for ${nomor} generated successfully`,
                });
                return;
              } catch (qrError) {
                console.error('QR generation error:', qrError.message);
                sendResponse({
                  status: 'success',
                  qrCode: null,
                  qrRaw: qr,
                  message: `QR code for ${nomor} generated (base64 failed)`,
                });
                return;
              }
            }

            if (pairingCode) {
              sendResponse({
                status: 'success',
                pairingCode,
                message: `Pairing code for ${nomor} generated successfully`,
              });
              return;
            }

            if (connection === 'open') {
              console.log(`Connected to WhatsApp for nomor: ${nomor}`);
              
              // Simpan status connected
              await redis.set(`whatsapp:connected:${nomor}`, 'true', { ex: 86400 });
              
              // Simpan user info jika tersedia
              if (sock?.user) {
                await redis.set(`whatsapp:user:${nomor}`, JSON.stringify(sock.user), { ex: 86400 });
                console.log(`User info saved for ${nomor}`);
              }
              
              // Kirim response sukses jika belum dikirim
              if (!responseSent) {
                sendResponse({
                  status: 'success',
                  message: `Connected to WhatsApp for ${nomor}`,
                  user: sock?.user
                });
              }
            }

            if (connection === 'close') {
              const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.name || 'Unknown Reason';
              console.log(`Connection closed for nomor: ${nomor} - Reason: ${reason}`);
              
              // Hapus connected status
              await redis.del(`whatsapp:connected:${nomor}`);
              
              if (reason === DisconnectReason.loggedOut || reason === 401) {
                console.log('User logged out, clearing session');
                await deleteSession(nomor);
                sendError('User logged out. Please reconnect.');
              } else if (reason !== DisconnectReason.connectionClosed && reason !== 'Unknown Reason') {
                console.log('Reconnecting in 5 seconds...');
                // Tunggu sebentar sebelum reconnect
                setTimeout(async () => {
                  try {
                    await connectToWhatsApp();
                  } catch (reconnectError) {
                    console.error('Reconnect failed:', reconnectError.message);
                  }
                }, 5000);
              }
            }
          } catch (error) {
            console.error('Error in connection.update handler:', error.message);
            sendError(`Connection error: ${error.message}`);
          }
        });

        // Simpan kredensial saat diperbarui
        sock.ev.on('creds.update', async (newState) => {
          try {
            const stateToSave = {
              creds: newState,
              keys: sock.authState.keys
            };
            await saveSession(nomor, stateToSave);
            console.log(`Credentials updated for ${nomor}`);
          } catch (err) {
            console.error(`Failed to save session for ${nomor}:`, err.message);
          }
        });

        // Request pairing code jika diperlukan
        if (usePairingCode && sock && sock.requestPairingCode) {
          // Tunggu sebentar sebelum request pairing code
          setTimeout(async () => {
            try {
              const code = await sock.requestPairingCode(nomor);
              console.log(`Pairing code for ${nomor}: ${code}`);
              
              if (!responseSent) {
                sendResponse({
                  status: 'success',
                  pairingCode: code,
                  message: `Pairing code for ${nomor} generated successfully`,
                });
              }
            } catch (error) {
              console.error('Error getting pairing code:', error.message);
              // Tidak perlu kirim error karena mungkin QR akan muncul
            }
          }, 3000);
        }

        // Timeout handler
        setTimeout(() => {
          if (!responseSent) {
            sendResponse({
              status: 'waiting',
              message: 'Waiting for QR code or pairing code...'
            });
          }
        }, 10000);

      } catch (error) {
        console.error(`Error during WhatsApp connection setup:`, error.message);
        console.error(error.stack);
        sendError(`Failed to setup WhatsApp connection: ${error.message}`);
        
        // Coba bersihkan session jika ada error
        try {
          await deleteSession(nomor);
        } catch (cleanupError) {
          console.error('Cleanup error:', cleanupError.message);
        }
      }
    }

    await connectToWhatsApp();
  } catch (error) {
    console.error(`Error for nomor: ${req.query.nomor || 'unknown'} -`, error.message);
    console.error(error.stack);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        status: 'error', 
        message: `Server error: ${error.message}` 
      });
    }
  }
};
