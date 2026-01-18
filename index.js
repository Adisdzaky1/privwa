const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Import route handlers
const sendHandler = require('./send.cjs');
const getcodeHandler = require('./getcode.cjs');

const app = express();

// ======================
// SECURITY MIDDLEWARES
// ======================

// 1. Helmet.js - Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// 2. CORS Configuration
const corsOptions = {
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 hours
};
app.use(cors(corsOptions));

// 3. Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 100 requests per windowMs
  message: {
    status: 'error',
    message: 'Terlalu banyak permintaan dari IP ini, coba lagi nanti.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // 10 requests per hour untuk auth endpoints
  message: {
    status: 'error',
    message: 'Terlalu banyak percobaan koneksi, coba lagi nanti.'
  }
});

// Apply rate limiting
app.use('/api/', apiLimiter);
app.use('/api/getcode', authLimiter);

// 4. Request parsing & compression
app.use(express.json({ limit: '10kb' })); // Batas ukuran JSON
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(compression());

// 5. Logging
const accessLogStream = fs.createWriteStream(
  path.join(__dirname, 'access.log'), 
  { flags: 'a' }
);

app.use(morgan('combined', { stream: accessLogStream }));
app.use(morgan('dev')); // Console logging untuk development

// ======================
// CUSTOM MIDDLEWARES
// ======================

// API Key Authentication Middleware
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({
      status: 'error',
      message: 'API key diperlukan'
    });
  }
  
  // Validate API key
  const validKeys = process.env.API_KEYS ? process.env.API_KEYS.split(',') : [];
  
  if (!validKeys.includes(apiKey)) {
    return res.status(403).json({
      status: 'error',
      message: 'API key tidak valid'
    });
  }
  
  next();
};

// Input Validation Middleware
const validateSendRequest = (req, res, next) => {
  const { message, nomor } = req.query;
  
  const errors = [];
  
  // Required fields check
  if (!message) errors.push('Parameter "message" diperlukan');
  if (!nomor) errors.push('Parameter "nomor" diperlukan');
  
  // Format validation
  if (nomor && !/^628\d{9,12}$/.test(nomor)) {
    errors.push('Format nomor tidak valid. Gunakan format 628xxxxxxxxxx');
  }
  
  
  if (errors.length > 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Validasi gagal',
      errors: errors
    });
  }
  
  next();
};

// ======================
// ROUTES
// ======================

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Protected Routes (require API key)
app.get('/api/send', apiKeyAuth, validateSendRequest, sendHandler);
app.get('/api/getcode', apiKeyAuth, getcodeHandler);

// Session Management Routes
app.get('/api/sessions', apiKeyAuth, async (req, res) => {
  try {
    const { Redis } = require('@upstash/redis');
    
    const redis = new Redis({
      url: process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN,
    });
    
    const sessions = await redis.smembers('whatsapp:sessions:list');
    
    const sessionDetails = [];
    for (const number of sessions) {
      const exists = await redis.exists(`whatsapp:session:${number}`);
      const connected = await redis.exists(`whatsapp:connected:${number}`);
      const ttl = await redis.ttl(`whatsapp:session:${number}`);
      
      sessionDetails.push({
        number,
        has_session: exists === 1,
        is_connected: connected === 1,
        expires_in: ttl > 0 ? Math.floor(ttl / 86400) : null,
        expires_days: ttl > 0 ? Math.floor(ttl / 86400) : 'permanent'
      });
    }
    
    res.status(200).json({
      status: 'success',
      total: sessions.length,
      sessions: sessionDetails
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

app.delete('/api/session/:number', apiKeyAuth, async (req, res) => {
  try {
    const { number } = req.params;
    
    if (!number) {
      return res.status(400).json({
        status: 'error',
        message: 'Parameter number diperlukan'
      });
    }
    
    const { Redis } = require('@upstash/redis');
    
    const redis = new Redis({
      url: process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN,
    });
    
    await redis.del(`whatsapp:session:${number}`);
    await redis.del(`whatsapp:connected:${number}`);
    await redis.del(`whatsapp:user:${number}`);
    await redis.srem('whatsapp:sessions:list', number);
    
    res.status(200).json({
      status: 'success',
      message: `Session untuk ${number} berhasil dihapus`
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Usage Statistics Endpoint (untuk monitoring)
app.get('/api/stats', apiKeyAuth, async (req, res) => {
  try {
    const { Redis } = require('@upstash/redis');
    
    const redis = new Redis({
      url: process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN,
    });
    
    const totalSessions = await redis.scard('whatsapp:sessions:list');
    
    // Hitung session aktif (connected dalam 24 jam terakhir)
    const sessions = await redis.smembers('whatsapp:sessions:list');
    let activeSessions = 0;
    
    for (const number of sessions) {
      const connected = await redis.exists(`whatsapp:connected:${number}`);
      if (connected === 1) activeSessions++;
    }
    
    res.status(200).json({
      status: 'success',
      data: {
        total_sessions: totalSessions,
        active_sessions: activeSessions,
        inactive_sessions: totalSessions - activeSessions,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// ======================
// ERROR HANDLING
// ======================

// 404 Handler
app.use('/api/*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint tidak ditemukan'
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Global Error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    timestamp: new Date().toISOString()
  });
  
  // Log to file
  const errorLogStream = fs.createWriteStream(
    path.join(__dirname, 'error.log'), 
    { flags: 'a' }
  );
  
  errorLogStream.write(`${new Date().toISOString()} - ${req.method} ${req.path} - ${err.message}\n${err.stack}\n\n`);
  
  res.status(err.status || 500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' 
      ? 'Terjadi kesalahan internal' 
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ======================
// SERVER CONFIGURATION
// ======================

const PORT = process.env.PORT || 3000;

// Only start server if not in Vercel
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`
    ============================================
    WhatsApp Gateway API
    ============================================
    Status: 🟢 Online
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    Redis: ${process.env.REDIS_URL ? '🟢 Connected' : '🔴 Not Configured'}
    ============================================
    Endpoints:
    GET  /api/health          - Health check
    GET  /api/send            - Send message (requires API key)
    GET  /api/getcode         - Get QR code (requires API key)
    GET  /api/sessions        - List all sessions
    DELETE /api/session/:number - Delete session
    GET  /api/stats           - Get statistics
    ============================================
    `);
  });
}

// Export for Vercel
module.exports = app;
