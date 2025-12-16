const db = require('./db');

/**
 * Update video URL cache in database
 * @param {number} movieId - Movie ID
 * @param {string} videoUrl - Cached video URL
 * @param {Date} expiresAt - Expiration timestamp
 * @returns {Promise<boolean>} - True on success, false on failure
 */
async function updateVideoCache(movieId, videoUrl, expiresAt) {
    try {
        // Validate inputs
        if (!movieId || !videoUrl || !expiresAt) {
            console.error('❌ Invalid parameters for updateVideoCache');
            return false;
        }

        // Format date for MySQL
        const formattedExpiry = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

        // Execute UPDATE query with prepared statement
        const [result] = await db.query(
            'UPDATE movies SET cached_video_url = ?, url_expires_at = ? WHERE id = ?',
            [videoUrl, formattedExpiry, movieId]
        );

        // Check if any rows were affected
        if (result.affectedRows > 0) {
            console.log(`✅ Cache updated for movie ${movieId}. Expires: ${formattedExpiry}`);
            return true;
        } else {
            console.warn(`⚠️  No movie found with ID ${movieId}`);
            return false;
        }

    } catch (error) {
        console.error('❌ Error updating video cache:', error.message);
        return false;
    }
}

/**
 * Get cached video URL from database and validate expiration
 * @param {number} movieId - Movie ID
 * @returns {Promise<{valid: boolean, url: string|null, expiresAt: Date|null}>}
 */
async function getCachedVideo(movieId) {
    try {
        // Validate input
        if (!movieId) {
            console.error('❌ Invalid movie ID');
            return { valid: false, url: null, expiresAt: null };
        }

        // Execute SELECT query with prepared statement
        const [rows] = await db.query(
            'SELECT cached_video_url, url_expires_at FROM movies WHERE id = ?',
            [movieId]
        );

        // Check if movie exists
        if (rows.length === 0) {
            console.warn(`⚠️  No movie found with ID ${movieId}`);
            return { valid: false, url: null, expiresAt: null };
        }

        const movie = rows[0];

        // Check if cache exists
        if (!movie.cached_video_url || !movie.url_expires_at) {
            console.log(`📭 No cached URL for movie ${movieId}`);
            return { valid: false, url: null, expiresAt: null };
        }

        // Validate expiration
        const expiresAt = new Date(movie.url_expires_at);
        const now = new Date();

        if (expiresAt > now) {
            // Cache is still valid
            const timeUntilExpiry = Math.round((expiresAt - now) / 60000); // minutes
            console.log(`✅ Valid cache found for movie ${movieId}. Expires in ${timeUntilExpiry} minutes`);
            
            return {
                valid: true,
                url: movie.cached_video_url,
                expiresAt: expiresAt
            };
        } else {
            // Cache has expired
            console.log(`⏰ Cache expired for movie ${movieId}`);
            return {
                valid: false,
                url: movie.cached_video_url, // Still return URL for reference
                expiresAt: expiresAt
            };
        }

    } catch (error) {
        console.error('❌ Error getting cached video:', error.message);
        return { valid: false, url: null, expiresAt: null };
    }
}

/**
 * Clear expired cache entries (maintenance function)
 * @returns {Promise<number>} - Number of cleared entries
 */
async function clearExpiredCache() {
    try {
        const [result] = await db.query(
            'UPDATE movies SET cached_video_url = NULL, url_expires_at = NULL WHERE url_expires_at < NOW()'
        );

        const clearedCount = result.affectedRows;
        
        if (clearedCount > 0) {
            console.log(`🧹 Cleared ${clearedCount} expired cache entries`);
        }

        return clearedCount;

    } catch (error) {
        console.error('❌ Error clearing expired cache:', error.message);
        return 0;
    }
}

/**
 * Get cache statistics
 * @returns {Promise<{total: number, cached: number, expired: number}>}
 */
async function getCacheStats() {
    try {
        // Total movies
        const [totalRows] = await db.query('SELECT COUNT(*) as count FROM movies');
        const total = totalRows[0].count;

        // Cached movies
        const [cachedRows] = await db.query(
            'SELECT COUNT(*) as count FROM movies WHERE cached_video_url IS NOT NULL'
        );
        const cached = cachedRows[0].count;

        // Expired cache
        const [expiredRows] = await db.query(
            'SELECT COUNT(*) as count FROM movies WHERE cached_video_url IS NOT NULL AND url_expires_at < NOW()'
        );
        const expired = expiredRows[0].count;

        return { total, cached, expired };

    } catch (error) {
        console.error('❌ Error getting cache stats:', error.message);
        return { total: 0, cached: 0, expired: 0 };
    }
}

module.exports = {
    updateVideoCache,
    getCachedVideo,
    clearExpiredCache,
    getCacheStats
};
