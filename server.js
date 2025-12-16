const express = require('express');
const cors = require('cors');
const db = require('./db');
const { getFreshVideoUrl } = require('./videoScraper');
const { updateVideoCache, getCachedVideo, getCacheStats } = require('./cacheService');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting tracker
const rateLimiter = {
    requests: new Map(), // Map<IP, {count, resetTime}>
    maxRequests: 10, // Max requests per window
    windowMs: 60000, // 1 minute window

    check: function (ip) {
        const now = Date.now();
        const record = this.requests.get(ip);

        if (!record || now > record.resetTime) {
            // Reset or create new record
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

    // Cleanup old entries every 5 minutes
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

// Facebook scraping rate limiter (more strict)
const fbRateLimiter = {
    lastScrapeTime: 0,
    minDelayMs: 3000, // Minimum 3 seconds between scrapes

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

// Middleware
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
        uptime: process.uptime()
    });
});

// Cache statistics endpoint
app.get('/api/cache/stats', async (req, res) => {
    try {
        const stats = await getCacheStats();

        res.json({
            success: true,
            statistics: {
                total_movies: stats.total,
                cached_movies: stats.cached,
                expired_cache: stats.expired,
                cache_hit_rate: stats.total > 0 ? ((stats.cached / stats.total) * 100).toFixed(2) + '%' : '0%'
            }
        });
    } catch (error) {
        console.error('Error fetching cache stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch cache statistics'
        });
    }
});

// GET /api/video/:id - Fetch video URL with cache validation
app.get('/api/video/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid video ID'
            });
        }

        // Query movies table
        const [rows] = await db.query(
            'SELECT id, title, video_url, cached_video_url, url_expires_at FROM movies WHERE id = ?',
            [id]
        );

        // Check if movie exists
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Video not found'
            });
        }

        const movie = rows[0];

        // Step 1: Check cache using cache service
        const cachedVideo = await getCachedVideo(id);

        // ✅ IMPORTANT: Validate cached URL is a DIRECT URL (not plugin)
        const isDirectCachedUrl = cachedVideo.url &&
            cachedVideo.url.includes('fbcdn.net') &&
            !cachedVideo.url.includes('plugins');

        if (cachedVideo.valid && isDirectCachedUrl) {
            // Double-check URL is still accessible
            const { validateUrl } = require('./videoScraper');
            const urlWorks = await validateUrl(cachedVideo.url);

            if (urlWorks) {
                console.log(`💾 Using cached direct URL for: "${movie.title}"`);
                return res.json({
                    success: true,
                    url: cachedVideo.url,
                    cached: true,
                    expiresAt: cachedVideo.expiresAt,
                    quality: movie.quality || 'unknown',
                    movie: {
                        id: movie.id,
                        title: movie.title
                    }
                });
            } else {
                console.log('⚠️ Cached URL not working, fetching fresh...');
            }
        } else if (cachedVideo.url && !isDirectCachedUrl) {
            console.log('⚠️ Cached URL is plugin URL, need direct URL');
        }

        // ❌ CACHE MISS: Need to fetch fresh URL
        console.log(`⏰ Cache expired/missing for: "${movie.title}"`);

        // Step 2: Get video_url from database
        const videoUrl = movie.video_url;
        if (!videoUrl) {
            return res.status(400).json({
                success: false,
                error: 'No video URL found in database'
            });
        }

        // Check if it's a direct Facebook CDN URL (both video.fbcdn.net and scontent.fna.fbcdn.net)
        const isFacebookCDN = videoUrl.startsWith('https://') &&
            (videoUrl.includes('fbcdn.net') || videoUrl.includes('fna.fbcdn.net')) &&
            videoUrl.includes('.mp4');

        if (isFacebookCDN) {
            // Extract expiration from URL
            const { extractExpiration } = require('./videoScraper');
            const expiresAt = extractExpiration(videoUrl);
            const now = new Date();

            // If URL is still valid (not expired), return it
            if (expiresAt > now) {
                const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
                console.log(`✅ Direct CDN URL valid for ${hoursUntilExpiry.toFixed(1)} more hours: "${movie.title}"`);

                return res.json({
                    success: true,
                    url: videoUrl,
                    cached: false,
                    expiresAt: expiresAt.toISOString(),
                    movie: {
                        id: movie.id,
                        title: movie.title
                    }
                });
            }

            // URL is expired - need to re-scrape using the URL to find fresh one
            console.log(`⏰ CDN URL expired, re-scraping from Facebook for: "${movie.title}"`);

            // Try to extract Facebook post/video ID from the expired URL
            // Pattern examples: /videos/123456 or /video.php?v=123456 or /watch/?v=123456
            const videoIdMatch = videoUrl.match(/(?:videos?\/|[\?&]v=)(\d+)/);

            if (videoIdMatch) {
                const facebookId = videoIdMatch[1];
                console.log(`🔄 Re-scraping using extracted Facebook ID: ${facebookId}`);

                // Continue with scraping using the extracted ID
                // Fall through to scraping logic below by updating videoUrl variable
                movie.video_url = facebookId;
            } else {
                // Cannot extract ID from URL - admin needs to provide new URL
                return res.status(400).json({
                    success: false,
                    error: 'URL expired and cannot extract Facebook ID for re-scraping',
                    message: 'The video URL has expired. Please update it with a fresh CDN URL in the admin panel.',
                    videoUrl: videoUrl.substring(0, 100) + '...'
                });
            }
        }

        // If we reach here, we need to scrape (either it's a Facebook ID or we extracted ID from expired CDN URL)
        const scrapingId = movie.video_url;
        console.log(`🔄 Scraping Facebook video: ${scrapingId}`);

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

        try {
            // Step 3: Call getFreshVideoUrl() to scrape Facebook
            const freshVideoData = await getFreshVideoUrl(scrapingId);

            if (freshVideoData && freshVideoData.success && freshVideoData.url) {
                // ✅ CRITICAL: Verify we got a DIRECT URL
                if (!freshVideoData.url.includes('fbcdn.net') ||
                    freshVideoData.url.includes('plugins')) {
                    console.error('❌ Scraped URL is not a direct video URL!');
                    return res.status(500).json({
                        success: false,
                        error: 'Could not extract direct video URL',
                        scrapedUrl: freshVideoData.url
                    });
                }

                // Step 4: Save result using updateVideoCache()
                const cacheUpdated = await updateVideoCache(
                    id,
                    freshVideoData.url,
                    freshVideoData.expiresAt
                );

                if (cacheUpdated) {
                    console.log(`✅ Fresh direct URL cached until: ${freshVideoData.expiresAt}`);
                    console.log(`📊 Quality: ${freshVideoData.quality}`);
                } else {
                    console.warn(`⚠️  Cache update failed for movie ${id}`);
                }

                // Step 5: Return fresh URL to frontend
                return res.json({
                    success: true,
                    url: freshVideoData.url,
                    cached: false,
                    expiresAt: freshVideoData.expiresAt,
                    quality: freshVideoData.quality || 'unknown',
                    type: 'direct',
                    movie: {
                        id: movie.id,
                        title: movie.title
                    }
                });
            } else {
                // Scraping failed, return detailed error
                console.error(`❌ Scraping failed for movie ${id}`);

                return res.status(500).json({
                    success: false,
                    error: 'Failed to retrieve video URL from Facebook',
                    message: 'The Facebook video may be private, deleted, or temporarily unavailable. Please check the video ID and try again.',
                    videoId: scrapingId
                });
            }
        } catch (scrapingError) {
            console.error(`❌ SCRAPING ERROR for movie ${id}:`, scrapingError.message);

            // Return detailed error response
            return res.status(500).json({
                success: false,
                error: 'Scraping failed',
                message: 'Unable to access Facebook video. The video may require authentication, be private, or be unavailable in your region.',
                details: scrapingError.message,
                videoId: scrapingId
            });
        }

    } catch (error) {
        console.error('Error fetching video:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// POST /api/refresh/:id - Force refresh cache (bypass cache and re-scrape)
app.post('/api/refresh/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid video ID'
            });
        }

        console.log(`🔄 FORCE REFRESH requested for movie ${id}`);

        // Query movies table
        const [rows] = await db.query(
            'SELECT id, title, video_url FROM movies WHERE id = ?',
            [id]
        );

        // Check if movie exists
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Video not found'
            });
        }

        const movie = rows[0];
        const videoUrl = movie.video_url;

        if (!videoUrl) {
            return res.status(400).json({
                success: false,
                error: 'No video URL found in database'
            });
        }

        // Check if it's a direct video URL (MP4, etc.) or Facebook ID
        const isDirectUrl = videoUrl.startsWith('http://') || videoUrl.startsWith('https://');
        const isFacebookUrl = videoUrl.includes('facebook.com') || videoUrl.includes('fb.watch');

        // If it's a direct video URL, just return it (no scraping needed)
        if (isDirectUrl && !isFacebookUrl) {
            console.log(`🎬 Direct video URL (no scraping needed): "${movie.title}"`);
            return res.json({
                success: true,
                message: 'Direct video URL - no refresh needed',
                url: videoUrl,
                expiresAt: null,
                movie: {
                    id: movie.id,
                    title: movie.title
                }
            });
        }

        console.log(`🎬 Force scraping: "${movie.title}" (Post ID: ${videoUrl})`);

        // Force scrape fresh URL (bypass cache)
        const freshVideoData = await getFreshVideoUrl(videoUrl);

        if (freshVideoData && freshVideoData.url) {
            // Update cache with fresh URL
            const cacheUpdated = await updateVideoCache(
                id,
                freshVideoData.url,
                freshVideoData.expiresAt
            );

            if (cacheUpdated) {
                console.log(`✅ FORCE REFRESH SUCCESS: Movie ${id} - Cache updated`);
            } else {
                console.warn(`⚠️  Cache update failed after force refresh for movie ${id}`);
            }

            return res.json({
                success: true,
                message: 'Cache refreshed successfully',
                url: freshVideoData.url,
                expiresAt: freshVideoData.expiresAt,
                movie: {
                    id: movie.id,
                    title: movie.title
                }
            });
        } else {
            console.error(`❌ FORCE REFRESH FAILED: Scraping returned null for movie ${id}`);

            return res.status(500).json({
                success: false,
                error: 'Failed to scrape video URL'
            });
        }

    } catch (error) {
        console.error(`❌ Error during force refresh for movie ${id}:`, error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// GET /api/video/episode/:id - Fetch episode video URL with cache validation
app.get('/api/video/episode/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid episode ID'
            });
        }

        // Query episodes table with caching fields
        const [rows] = await db.query(
            'SELECT id, title, video_url, cached_video_url, url_expires_at, series_id FROM episodes WHERE id = ?',
            [id]
        );

        // Check if episode exists
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Episode not found'
            });
        }

        const episode = rows[0];
        const videoUrl = episode.video_url;

        if (!videoUrl) {
            return res.status(400).json({
                success: false,
                error: 'No video URL found for this episode'
            });
        }

        // Check if it's a direct Facebook CDN URL (both video.fbcdn.net and scontent.fna.fbcdn.net)
        const isFacebookCDN = videoUrl.startsWith('https://') &&
            (videoUrl.includes('fbcdn.net') || videoUrl.includes('fna.fbcdn.net')) &&
            videoUrl.includes('.mp4');

        if (isFacebookCDN) {
            // Extract expiration from URL
            const { extractExpiration } = require('./videoScraper');
            const expiresAt = extractExpiration(videoUrl);
            const now = new Date();

            // If URL is still valid (not expired), return it
            if (expiresAt > now) {
                const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
                console.log(`✅ Direct CDN URL valid for ${hoursUntilExpiry.toFixed(1)} more hours: "${episode.title}"`);

                return res.json({
                    success: true,
                    url: videoUrl,
                    cached: false,
                    expiresAt: expiresAt.toISOString(),
                    episode: {
                        id: episode.id,
                        title: episode.title
                    }
                });
            }

            // URL is expired - need to re-scrape
            console.log(`⏰ CDN URL expired, re-scraping from Facebook for episode: "${episode.title}"`);

            // Try to extract Facebook post/video ID from the expired URL
            const videoIdMatch = videoUrl.match(/(?:videos?\/|[\?&]v=)(\d+)/);

            if (videoIdMatch) {
                const facebookId = videoIdMatch[1];
                console.log(`🔄 Re-scraping using extracted Facebook ID: ${facebookId}`);

                // Continue with scraping using the extracted ID
                episode.video_url = facebookId;
            } else {
                // Cannot extract ID from URL
                return res.status(400).json({
                    success: false,
                    error: 'URL expired and cannot extract Facebook ID for re-scraping',
                    message: 'The episode video URL has expired. Please update it with a fresh CDN URL in the admin panel.',
                    videoUrl: videoUrl.substring(0, 100) + '...'
                });
            }
        }

        // If we reach here, we need to scrape (either it's a Facebook ID or we extracted ID from expired CDN URL)
        const scrapingId = episode.video_url;

        // It's a Facebook video ID - check cache first
        const cachedUrl = episode.cached_video_url;
        const expiresAt = episode.url_expires_at;

        // Check if cache is valid
        if (cachedUrl && expiresAt) {
            const now = new Date();
            const expiry = new Date(expiresAt);

            if (now < expiry) {
                console.log(`✅ Cache HIT for episode ${id}: "${episode.title}"`);
                return res.json({
                    success: true,
                    url: cachedUrl,
                    cached: true,
                    expiresAt: expiresAt,
                    episode: {
                        id: episode.id,
                        title: episode.title
                    }
                });
            } else {
                console.log(`⏰ Cache EXPIRED for episode ${id}: "${episode.title}"`);
            }
        } else {
            console.log(`❌ Cache MISS for episode ${id}: "${episode.title}"`);
        }

        // Cache is invalid/expired - scrape fresh URL
        console.log(`🔄 Scraping Facebook video for episode: "${episode.title}" (ID: ${scrapingId})`);

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

        try {
            // Scrape Facebook video
            const freshVideoData = await getFreshVideoUrl(scrapingId);

            if (freshVideoData && freshVideoData.success && freshVideoData.url) {
                // Verify we got a direct URL
                if (!freshVideoData.url.includes('fbcdn.net') ||
                    freshVideoData.url.includes('plugins')) {
                    console.error('❌ Scraped URL is not a direct video URL!');
                    return res.status(500).json({
                        success: false,
                        error: 'Could not extract direct video URL',
                        scrapedUrl: freshVideoData.url
                    });
                }

                console.log(`✅ Episode video URL retrieved: "${episode.title}"`);

                // Update cache in database
                const expiryTime = new Date(Date.now() + (4 * 60 * 60 * 1000)); // 4 hours
                await db.query(
                    'UPDATE episodes SET cached_video_url = ?, url_expires_at = ? WHERE id = ?',
                    [freshVideoData.url, expiryTime, id]
                );

                console.log(`💾 Cache UPDATED for episode ${id}`);

                // Return fresh URL
                return res.json({
                    success: true,
                    url: freshVideoData.url,
                    cached: false,
                    expiresAt: expiryTime,
                    quality: freshVideoData.quality || 'unknown',
                    episode: {
                        id: episode.id,
                        title: episode.title
                    }
                });
            } else {
                console.error(`❌ Scraping failed for episode ${id}`);

                return res.status(500).json({
                    success: false,
                    error: 'Failed to retrieve episode video URL from Facebook',
                    message: 'The Facebook video may be private, deleted, or temporarily unavailable.',
                    videoId: scrapingId
                });
            }
        } catch (scrapingError) {
            console.error(`❌ SCRAPING ERROR for episode ${id}:`, scrapingError.message);

            return res.status(500).json({
                success: false,
                error: 'Scraping failed',
                message: 'Unable to access Facebook video. The video may require authentication or be unavailable.',
                details: scrapingError.message,
                videoId: scrapingId
            });
        }

    } catch (error) {
        console.error('Error fetching episode video:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});


// 404 handler for undefined routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
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

// ========================================
// BACKGROUND URL REFRESH SYSTEM
// ========================================

const backgroundRefresh = {
    isRunning: false,
    intervalMs: 3600000, // Check every hour
    refreshBeforeExpiryHours: 2, // Refresh URLs that expire within 2 hours

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log('🔄 Background refresh system started');
        console.log(`⏰ Checking every ${this.intervalMs / 60000} minutes`);
        console.log(`📅 Refreshing URLs expiring within ${this.refreshBeforeExpiryHours} hours`);

        // Run immediately on startup
        await this.checkAndRefresh();

        // Then run periodically
        setInterval(() => this.checkAndRefresh(), this.intervalMs);
    },

    async checkAndRefresh() {
        try {
            console.log('\n🔍 Background refresh: Checking for expiring URLs...');

            const expiryThreshold = new Date();
            expiryThreshold.setHours(expiryThreshold.getHours() + this.refreshBeforeExpiryHours);
            const thresholdStr = expiryThreshold.toISOString().slice(0, 19).replace('T', ' ');

            // Find URLs that will expire soon
            const [expiring] = await db.query(`
                SELECT id, title, video_url, url_expires_at 
                FROM movies 
                WHERE cached_video_url IS NOT NULL 
                AND url_expires_at IS NOT NULL
                AND url_expires_at < ?
                AND url_expires_at > NOW()
                ORDER BY url_expires_at ASC
                LIMIT 5
            `, [thresholdStr]);

            if (expiring.length === 0) {
                console.log('✅ No URLs need refresh');
                return;
            }

            console.log(`📋 Found ${expiring.length} URLs to refresh`);

            // Refresh each URL with rate limiting
            for (const movie of expiring) {
                try {
                    const expiresIn = Math.round((new Date(movie.url_expires_at) - new Date()) / 60000);
                    console.log(`\n🔄 Refreshing: "${movie.title}" (expires in ${expiresIn} minutes)`);

                    // Check Facebook rate limit
                    const fbLimit = fbRateLimiter.canScrape();
                    if (!fbLimit.allowed) {
                        console.log(`⏳ Rate limited, waiting ${fbLimit.waitTime}s...`);
                        await new Promise(resolve => setTimeout(resolve, fbLimit.waitTime * 1000));
                    }

                    // Scrape fresh URL
                    const freshVideoData = await getFreshVideoUrl(movie.video_url);

                    if (freshVideoData && freshVideoData.success && freshVideoData.url) {
                        // Validate it's a direct URL
                        if (freshVideoData.url.includes('fbcdn.net') && !freshVideoData.url.includes('plugins')) {
                            await updateVideoCache(movie.id, freshVideoData.url, freshVideoData.expiresAt);
                            console.log(`✅ Refreshed: "${movie.title}" | Quality: ${freshVideoData.quality}`);
                        } else {
                            console.log(`⚠️ Skipped: "${movie.title}" (not a direct URL)`);
                        }
                    } else {
                        console.log(`❌ Failed: "${movie.title}"`);
                    }

                    // Wait between scrapes to avoid blocking
                    await new Promise(resolve => setTimeout(resolve, 5000));

                } catch (error) {
                    console.error(`❌ Error refreshing movie ${movie.id}:`, error.message);
                }
            }

            console.log('\n✅ Background refresh completed');

        } catch (error) {
            console.error('❌ Background refresh error:', error);
        }
    },

    stop() {
        this.isRunning = false;
        console.log('⏹️ Background refresh system stopped');
    }
};

// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 CineDrive API server running on http://localhost:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Database: ${process.env.DB_NAME}`);
    console.log('='.repeat(50) + '\n');

    // Start background systems
    rateLimiter.startCleanup();
    backgroundRefresh.start();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n⏹️  Shutting down server...');
    backgroundRefresh.stop();
    await db.end();
    process.exit(0);
});
