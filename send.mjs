import makeWASocket, {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,
  jidDecode,
  delay,
  getAggregateVotesInPollMessage,
  downloadContentFromMessage,
  getContentType,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Redis } from '@upstash/redis';
import QRCode from 'qrcode';
import pino from 'pino';
import axios from 'axios';

// Konfigurasi Redis Upstash
const redis = new Redis({
  url: process.env.REDIS_URL || 'https://your-redis.upstash.io',
  token: process.env.REDIS_TOKEN || 'your-redis-token',
});

// Fungsi untuk mendapatkan sesi dari Redis
async function getSession(nomor) {
  try {
    const authState = await redis.get(`whatsapp:session:${nomor}`);
    
    if (authState) {
      try {
        return JSON.parse(authState);
      } catch (e) {
        console.error(`Error parsing auth state for ${nomor}:`, e.message);
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
async function saveSession(nomor, state) {
  try {
    // Simpan dengan TTL 30 hari
    await redis.set(`whatsapp:session:${nomor}`, JSON.stringify(state), {
      ex: 2592000,
    });
    
    // Simpan juga ke set untuk tracking semua session
    await redis.sadd('whatsapp:sessions:list', nomor);
  } catch (err) {
    console.error(`Error in saveSession:`, err.message);
  }
}

// Fungsi untuk mengunduh gambar dari URL
async function downloadImage(url) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer'
    });
    
    return response.data;
  } catch (error) {
    console.error('Error downloading image:', error.message);
    throw error;
  }
}

async function handleConnect(req, res, nomor) {
  if (!nomor) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "nomor" diperlukan untuk koneksi',
    });
  }

  const usePairingCode = true;

  try {
    const savedState = await getSession(nomor);
    const authState = savedState || {};

    const sock = makeWASocket({
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: authState.creds || {},
        keys: authState.keys || makeCacheableSignalKeyStore({}),
      },
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: true,
      fireInitQueries: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false, // Ubah ke false
      markOnlineOnConnect: true,
      browser: ["iOS", "Safari", "16.5.1"],
      getMessage: async () => undefined,
    });

    sock.ev.on('connection.update', async (update) => {
      try {
        const { qr, connection, lastDisconnect, pairingCode } = update;

        if (qr) {
          const qrImage = await QRCode.toDataURL(qr);
          if (!res.headersSent) {
            return res.status(200).json({
              status: 'success',
              qrCode: qrImage,
              message: `QR code for ${nomor} generated successfully`,
            });
          }
          return;
        }

        if (pairingCode) {
          if (!res.headersSent) {
            return res.status(200).json({
              status: 'success',
              pairingCode,
              message: `Pairing code for ${nomor} generated successfully`,
            });
          }
          return;
        }

        if (connection === 'open') {
          console.log(`Connected to WhatsApp for nomor: ${nomor}`);
          await redis.set(`whatsapp:connected:${nomor}`, 'true', { ex: 86400 });
          
          // Simpan informasi user
          if (sock?.user) {
            await redis.set(`whatsapp:user:${nomor}`, JSON.stringify(sock.user), { ex: 86400 });
          }
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
          console.log(`Connection closed for nomor: ${nomor} - Reason: ${reason}`);
          
          await redis.del(`whatsapp:connected:${nomor}`);
          await redis.del(`whatsapp:user:${nomor}`);

          if (reason === DisconnectReason.loggedOut) {
            console.log('User logged out, clearing session');
            await redis.del(`whatsapp:session:${nomor}`);
            await redis.srem('whatsapp:sessions:list', nomor);
          }
        }
      } catch (error) {
        console.error('Error in connection.update handler:', error.message);
      }
    });

    sock.ev.on('creds.update', async (newState) => {
      try {
        const stateToSave = {
          creds: newState,
          keys: sock.authState.keys
        };
        await saveSession(nomor, stateToSave);
      } catch (err) {
        console.error(`Failed to save session for ${nomor}:`, err.message);
      }
    });

    if (usePairingCode && sock.requestPairingCode) {
      try {
        const code = await sock.requestPairingCode(nomor);
        console.log(`Pairing code for ${nomor}: ${code}`);
        if (!res.headersSent) {
          return res.status(200).json({
            status: 'success',
            pairingCode: code,
            message: `Pairing code for ${nomor} generated successfully`,
          });
        }
      } catch (error) {
        console.error('Error getting pairing code:', error.message);
        if (!res.headersSent) {
          return res.status(500).json({
            status: 'error',
            message: 'Failed to get pairing code'
          });
        }
      }
    }

    // Jika tidak ada QR atau pairing code, return status
    setTimeout(() => {
      if (!res.headersSent) {
        return res.status(200).json({
          status: 'waiting',
          message: 'Waiting for QR code or pairing code...'
        });
      }
    }, 30000);

  } catch (error) {
    console.error(`Error during WhatsApp connection:`, error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to connect to WhatsApp',
      });
    }
  }
}

// ... (sisanya tetap sama seperti sebelumnya)

// Fungsi untuk handle status koneksi
async function handleStatus(res, nomor) {
  if (!nomor) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "nomor" diperlukan'
    });
  }

  try {
    const sessionExists = await redis.exists(`whatsapp:session:${nomor}`);
    const isConnected = await redis.exists(`whatsapp:connected:${nomor}`);
    const userInfo = await redis.get(`whatsapp:user:${nomor}`);
    
    const ttl = await redis.ttl(`whatsapp:session:${nomor}`);
    
    return res.status(200).json({
      status: 'success',
      data: {
        nomor,
        has_session: sessionExists === 1,
        is_connected: isConnected === 1,
        session_expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} hari` : 'tidak ada expiry',
        user_info: userInfo ? JSON.parse(userInfo) : null
      }
    });
  } catch (error) {
    console.error('Error checking status:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to check status'
    });
  }
}

// Fungsi utama untuk mengirim pesan
async function handleSendMessage(res, params) {
  const { message, nomor, image_url } = params;

  try {
    // Ambil sesi dari Redis
    const savedState = await getSession(nomor);
    if (!savedState) {
      return res.status(400).json({
        status: 'error',
        message: 'Nomor ini belum terhubung ke WhatsApp. Silakan lakukan pairing terlebih dahulu.',
      });
    }

    const sock = makeWASocket({
      auth: savedState,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      logger: pino({ level: 'error' }),
      connectTimeoutMs: 60000,
    });

    // Buat pesan teks
    const messageText = message;

    const formattednomor = `${nomor}@s.whatsapp.net`;

    return new Promise((resolve) => {
      sock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
          try {
            // Jika ada image_url, kirim gambar dengan caption
            if (image_url) {
              console.log('Mengirim gambar dengan caption...');
              
              try {
                // Download gambar dari URL
                const imageBuffer = await downloadImage(image_url);
                
                // Prepare media untuk dikirim
                const media = {
                  image: imageBuffer,
                  mimetype: 'image/jpeg' // Anda bisa deteksi mime type sebenarnya
                };
                
                // Upload media ke WhatsApp
                const preparedMedia = await prepareWAMessageMedia(
                  media, 
                  { upload: sock.authState.creds.mediaUpload }
                );
                
                // Gabungkan caption dengan teks pesan jika ada caption custom
                const finalCaption = messageText 
                  ? `${messageText}` 
                  : messageText;
                
                // Kirim gambar dengan caption
                await sock.sendMessage(formattednomor, {
                  ...preparedMedia,
                  caption: finalCaption
                });
                
                console.log('Gambar berhasil dikirim');
                
                res.status(200).json({ 
                  status: 'success', 
                  message: 'Pesan dan gambar berhasil dikirim' 
                });
                
              } catch (mediaError) {
                console.error('Error mengirim gambar:', mediaError.message);
                // Fallback ke pesan teks saja
                await sock.sendMessage(formattednomor, { text: messageText });
                res.status(200).json({ 
                  status: 'success', 
                  message: 'Pesan teks berhasil dikirim (gambar gagal)' 
                });
              }
            } else {
              // Kirim pesan teks saja
              await sock.sendMessage(formattednomor, { text: messageText });
              console.log('Pesan teks berhasil dikirim');
              res.status(200).json({ 
                status: 'success', 
                message: 'Pesan berhasil dikirim' 
              });
            }
            
            // Simpan kredensial terbaru
            sock.ev.on('creds.update', async (newState) => {
              await saveSession(nomor, newState);
            });
            
            // Tunggu sebentar sebelum menutup koneksi
            setTimeout(() => {
              sock.ws.close();
              resolve();
            }, 5000);
            
          } catch (sendError) {
            console.error('Error mengirim pesan:', sendError.message);
            res.status(500).json({ 
              status: 'error', 
              message: sendError.message 
            });
            sock.ws.close();
            resolve();
          }
        }

        if (update.connection === 'close') {
          console.log('Koneksi terputus:', update.lastDisconnect?.error);
          const reason = update.lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
          
          if (reason !== DisconnectReason.loggedOut) {
            console.log('Mencoba menyambung ulang...');
            // Tidak perlu reconnect karena ini one-time send
          } else {
            console.log('User logged out, clearing session');
            await redis.del(`whatsapp:session:${nomor}`);
            await redis.srem('whatsapp:sessions:list', nomor);
          }
          
          res.status(500).json({ 
            status: 'error', 
            message: 'Koneksi WhatsApp terputus' 
          });
          resolve();
        }
      });

      // Handle error koneksi timeout
      setTimeout(() => {
        if (!res.headersSent) {
          res.status(408).json({ 
            status: 'error', 
            message: 'Koneksi timeout' 
          });
          sock.ws.close();
          resolve();
        }
      }, 30000);
    });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
}

// Fungsi tambahan untuk mendapatkan semua sesi aktif
async function getAllSessions() {
  try {
    const sessions = await redis.smembers('whatsapp:sessions:list');
    return sessions;
  } catch (err) {
    console.error(`Error in getAllSessions:`, err.message);
    return [];
  }
}

export default async (req, res) => {
  try {
    const { 
      product, 
      id, 
      nominal, 
      tujuan, 
      tanggal, 
      nomor,
      image_url, // URL gambar yang akan dikirim
      caption,   // Caption untuk gambar
      action = 'send' // send, connect, status
    } = req.query;

    // Handle different actions
    switch (action) {
      case 'connect':
        return handleConnect(req, res, nomor);
      case 'status':
        return handleStatus(res, nomor);
      case 'send':
        // Validasi parameter untuk pengiriman pesan
        if (!nomor) {
          return res.status(400).json({
            status: 'error',
            message: 'Parameter "nomor" diperlukan',
          });
        }
        return handleSendMessage(res, { 
          message: caption || 'Pesan dari API', 
          nomor, 
          image_url 
        });
      default:
        return res.status(400).json({
          status: 'error',
          message: 'Action tidak valid. Gunakan: send, connect, atau status'
        });
    }
  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
};
