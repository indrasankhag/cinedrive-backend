const express = require('express');
const cors = require('cors');
const { getFreshVideoUrl } = require('./videoScraper');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting tracker (in-memory, no database)
const rateLimiter = {
    requests: new Map(), // Map<IP, {count, resetTime}>
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 10,
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,

    check: function (ip) {
        const now = Date.now();
        const record = this.requests.get(ip);

        if (!record || now > record.resetTime) {
            this.requests.set(ip, {
                count: 1,
                resetTime: now + this.windowMs
            });
            return { allowed: true, remaining: this.maxRequests - 1 };
        }

        if (record.count >= this.maxRequests) {
            return {
                allowed: false,
                remaining: 0,
                retryAfter: Math.ceil((record.resetTime - now) / 1000)
            };
        }

        record.count++;
        return { allowed: true, remaining: this.maxRequests - record.count };
    },

    startCleanup: function () {
        setInterval(() => {
            const now = Date.now();
            for (const [ip, record] of this.requests.entries()) {
                if (now > record.resetTime + 60000) {
                    this.requests.delete(ip);
                }
            }
            console.log(`🧹 Cleaned up rate limiter. Active IPs: ${this.requests.size}`);
        }, 300000);
    }
};

// Facebook scraping rate limiter
const fbRateLimiter = {
    lastScrapeTime: 0,
    minDelayMs: parseInt(process.env.FB_SCRAPE_DELAY_MS) || 5000,

    canScrape: function () {
        const now = Date.now();
        const timeSinceLastScrape = now - this.lastScrapeTime;

        if (timeSinceLastScrape < this.minDelayMs) {
            const waitTime = Math.ceil((this.minDelayMs - timeSinceLastScrape) / 1000);
            return { allowed: false, waitTime };
        }

        this.lastScrapeTime = now;
        return { allowed: true };
    }
};

// CORS Configuration
app.use(cors({
    origin: [
        'https://zinema.lk',
        'https://www.zinema.lk',
        'http://localhost',
        'http://localhost:3000'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting middleware
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const result = rateLimiter.check(ip);

    if (!result.allowed) {
        console.log(`🚫 Rate limit exceeded for IP: ${ip}`);
        return res.status(429).json({
            success: false,
            error: 'Too many requests',
            message: `Please wait ${result.retryAfter} seconds before trying again`,
            retryAfter: result.retryAfter
        });
    }

    res.setHeader('X-RateLimit-Remaining', result.remaining);
    next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        service: 'CineDrive Video Scraper',
        version: '2.0-stateless'
    });
});

// MAIN ENDPOINT: Scrape video URL (stateless - no database)
app.post('/api/scrape-video', async (req, res) => {
    const { fbUrl, fbId } = req.body;

    try {
        // Validate input
        if (!fbUrl && !fbId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: fbUrl or fbId'
            });
        }

        const videoIdentifier = fbId || fbUrl;

        console.log(`🔄 Scraping request for: ${videoIdentifier}`);

        // Check Facebook scraping rate limit
        const fbLimit = fbRateLimiter.canScrape();
        if (!fbLimit.allowed) {
            console.log(`⏳ Facebook rate limit: waiting ${fbLimit.waitTime}s`);
            return res.status(429).json({
                success: false,
                error: 'Facebook scraping rate limit',
                message: `Please wait ${fbLimit.waitTime} seconds to avoid blocking`,
                retryAfter: fbLimit.waitTime
            });
        }

        // Scrape video URL
        const freshVideoData = await getFreshVideoUrl(videoIdentifier);

        if (freshVideoData && freshVideoData.success && freshVideoData.url) {
            console.log(`✅ Scraping successful`);
            console.log(`📊 Quality: ${freshVideoData.quality}`);
            console.log(`⏰ Expires: ${freshVideoData.expiresAt}`);

            return res.json({
                success: true,
                videoUrl: freshVideoData.url,
                quality: freshVideoData.quality || 'unknown',
                expiresAt: freshVideoData.expiresAt,
                type: 'direct',
                message: 'Video URL scraped successfully'
            });
        } else {
            console.error(`❌ Scraping failed for: ${videoIdentifier}`);

            return res.status(500).json({
                success: false,
                error: 'Failed to retrieve video URL from Facebook',
                message: 'The Facebook video may be private, deleted, or temporarily unavailable. Please check the video ID and try again.',
                videoId: videoIdentifier
            });
        }

    } catch (error) {
        console.error(`❌ SCRAPING ERROR:`, error.message);

        return res.status(500).json({
            success: false,
            error: 'Scraping failed',
            message: 'Unable to access Facebook video. The video may require authentication, be private, or be unavailable in your region.',
            details: error.message
        });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /api/health',
            'POST /api/scrape-video'
        ]
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 CineDrive Scraper API (Stateless)`);
    console.log(`📍 Running on: http://localhost:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 Rate Limit: ${rateLimiter.maxRequests} req/min`);
    console.log(`⏱️  FB Delay: ${fbRateLimiter.minDelayMs}ms`);
    console.log('='.repeat(50) + '\n');

    // Start background cleanup
    rateLimiter.startCleanup();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⏹️  Shutting down server...');
    process.exit(0);
});
