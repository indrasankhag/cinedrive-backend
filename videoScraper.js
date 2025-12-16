const puppeteer = require('puppeteer');
const axios = require('axios');
require('dotenv').config();

/**
 * Extract quality from URL
 */
function extractQuality(url) {
    if (url.includes('1080p') || url.includes('hd')) return '1080p';
    if (url.includes('720p')) return '720p';
    if (url.includes('480p') || url.includes('sd')) return '480p';
    if (url.includes('360p')) return '360p';
    return 'unknown';
}

/**
 * Extract expiration timestamp from URL
 */
function extractExpiration(url) {
    try {
        const oeMatch = url.match(/[&?]oe=([A-F0-9]+)/i);
        if (oeMatch) {
            const timestamp = parseInt(oeMatch[1], 16);
            return new Date(timestamp * 1000);
        }
    } catch (e) {
        // console.warn('⚠️ Could not parse expiration from URL');
    }
    // Default: 24 hours
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
}

async function validateUrl(url) {
    try {
        const response = await axios.head(url, {
            timeout: 5000,
            maxRedirects: 5,
            validateStatus: (status) => status === 200 || status === 206
        });
        return response.status === 200 || response.status === 206;
    } catch (error) {
        return false;
    }
}

/**
 * OPTIMIZED: Network Interception with Resource Blocking and Early Exit
 */
async function scrapeWithNetworkInterception(facebookPostId) {
    let browser = null;

    try {
        console.log(`🔍 Scraping (Fast Mode): ${facebookPostId}`);

        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-notifications',
                '--disable-extensions'
            ]
        });

        const page = await browser.newPage();

        // Block heavy resources
        await page.setRequestInterception(true);

        const videoFoundPromise = new Promise((resolve) => {
            page.on('request', (request) => {
                const url = request.url();
                const resourceType = request.resourceType();

                // 1. Check if this request IS the video we want
                if (url.includes('fbcdn.net') && url.includes('.mp4') && !url.includes('plugins')) {
                    console.log('⚡ Fast Capture: Found video URL in request!');
                    resolve({
                        success: true,
                        url: url,
                        quality: extractQuality(url),
                        type: 'direct',
                        expiresAt: extractExpiration(url)
                    });
                    // Abort the actual download to save bandwidth!
                    request.abort();
                    return;
                }

                // 2. Block unnecessary resources to speed up page load
                // Only block images and fonts. 
                // CRITICAL: Do NOT block 'script', 'stylesheet', 'xhr', 'fetch' as they are needed for the player
                if (['image', 'font', 'media'].includes(resourceType)) {
                    // Note: 'media' type usually IS the video file, but if we haven't caught it in step 1 
                    // (maybe it doesn't match the url pattern?), we might abort it.
                    // However, the check in step 1 runs first. If it matches, we resolve and abort.
                    // If it doesn't match and it's media, we abort. This is risky if the video url format changed.
                    // Let's NOT block media for now, just in case.
                    if (resourceType === 'media' && !url.includes('fbcdn.net')) {
                        request.abort();
                    } else if (['image', 'font'].includes(resourceType)) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                } else {
                    request.continue();
                }
            });
        });

        const facebookUrl = `https://www.facebook.com/watch?v=${facebookPostId}`;

        // Race between navigating and finding the video
        // standard waiting for networkactivity might be safer if we want to ensure scripts run
        // but let's try domcontentloaded first as it is faster
        const navigationPromise = page.goto(facebookUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Add a timeout for the whole operation (longer)
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 30000));

        // Wait for video found OR navigation complete (then maybe wait scanning) OR timeout
        const result = await Promise.race([videoFoundPromise, timeoutPromise]);

        if (result) {
            return result;
        }

        // If we are here, it means timeout or navigation finished without triggering request yet.
        // Let's try to PLAY the video to trigger the request.
        try {
            await page.waitForSelector('video', { timeout: 5000 });
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                    video.click(); // Click might work better than play() due to autoplay policies
                    video.play();
                }
            });
            // Wait a bit more for request
            const extraWait = new Promise(resolve => setTimeout(() => resolve(null), 5000));
            const extraResult = await Promise.race([videoFoundPromise, extraWait]);
            if (extraResult) return extraResult;
        } catch (e) {
            // ignore
        }

        // Final fallback: check src attribute
        try {
            const videoResult = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video && video.src && video.src.includes('fbcdn.net')) {
                    return video.src;
                }
                return null;
            });

            if (videoResult) {
                return {
                    success: true,
                    url: videoResult,
                    quality: extractQuality(videoResult),
                    type: 'direct',
                    expiresAt: extractExpiration(videoResult)
                };
            }
        } catch (e) { }

        return { success: false, error: 'Fast scrape timed out or failed' };

    } catch (error) {
        return { success: false, error: error.message };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function getFreshVideoUrl(facebookPostId) {
    return await scrapeWithNetworkInterception(facebookPostId);
}

module.exports = {
    getFreshVideoUrl,
    validateUrl,
    extractExpiration,
    extractQuality
};
