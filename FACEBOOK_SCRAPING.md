# Facebook Video Scraper - Troubleshooting Guide

## Issue: Video Scraping Fails

If you're seeing errors like:
```
❌ Video element found but no src attribute
❌ Could not extract video URL using any strategy
```

This means Facebook is blocking the automated scraper. Here are solutions:

---

## Solution 1: Use Facebook Authentication Cookies (Recommended)

Facebook requires authentication to access most videos. Add your Facebook cookies to allow the scraper to access videos.

### Step 1: Get Your Facebook Cookies

1. **Open Facebook in Chrome/Firefox** and log in
2. **Install a Cookie Extension**:
   - Chrome: [EditThisCookie](https://chrome.google.com/webstore/detail/editthiscookie/)
   - Firefox: [Cookie-Editor](https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/)

3. **Visit Facebook** (facebook.com) while logged in
4. **Export cookies** as JSON using the extension
5. You'll get something like:
   ```json
   [
     {"name": "c_user", "value": "YOUR_USER_ID", "domain": ".facebook.com"},
     {"name": "xs", "value": "YOUR_XS_TOKEN", "domain": ".facebook.com"},
     {"name": "datr", "value": "...", "domain": ".facebook.com"}
   ]
   ```

### Step 2: Add Cookies to .env File

Open `backend/.env` and add:

```env
# Facebook Authentication Cookies (for video scraping)
FB_COOKIES=[{"name":"c_user","value":"YOUR_USER_ID","domain":".facebook.com"},{"name":"xs","value":"YOUR_XS_TOKEN","domain":".facebook.com"}]
```

**Important:** 
- Replace `YOUR_USER_ID` and `YOUR_XS_TOKEN` with your actual values
- Keep it as a single line (no line breaks)
- Use double quotes for JSON keys and values

### Step 3: Restart the Server

```bash
cd backend
npm start
```

Now the scraper will use your cookies to access Facebook videos!

---

## Solution 2: Use Public Facebook Video Posts

If you don't want to use cookies, make sure the videos you're trying to scrape are:

1. **Public** (not private or friends-only)
2. **Not from a private group**
3. **Not age-restricted**
4. **Not from a page with restricted access**

---

## Solution 3: Verify Facebook Video IDs

Make sure the `video_url` column in your database contains valid Facebook video IDs:

### Correct Format:
```
1552926345723615  ← Just the numeric ID
```

### Where to find the ID:
From a Facebook video URL like:
```
https://www.facebook.com/watch/?v=1552926345723615
                                    ↑
                          This is the video ID
```

Update your database:
```sql
UPDATE movies 
SET video_url = '1552926345723615' 
WHERE id = 8;
```

---

## Solution 4: Test the Scraper

Test if scraping works with a specific video ID:

```bash
cd backend
node -e "require('./videoScraper').testScraper('1552926345723615')"
```

You should see:
```
✅ SUCCESS:
URL: https://video.xx.fbcdn.net/...
Expires At: 2025-12-07T...
Time until expiry: 24 hours
```

---

## Solution 5: Check Logs for Detailed Errors

When running the server, watch for these log messages:

### Success Indicators:
```
📹 Found video URL in network: https://video.xx.fbcdn.net/...
✅ Found X video URL(s) from network interception
✅ Video URL extracted: https://video...
```

### Failure Indicators:
```
❌ Video element found but no src attribute
❌ Could not extract video URL using any strategy
```

If you see:
```
💡 Possible reasons:
   - Video is private or requires login
```

→ You need to add Facebook cookies (Solution 1)

---

## Solution 6: Alternative - Use Different Video Hosting

If Facebook scraping continues to fail, consider using alternative video hosting:

1. **YouTube** - More scraping-friendly
2. **Vimeo** - Provides direct embed URLs
3. **Direct MP4 links** - No scraping needed
4. **Your own CDN** - Upload videos to your server

---

## Testing Multiple Strategies

The scraper tries 4 different strategies:

1. **Network Interception** - Captures video URLs from network requests
2. **Video Element Extraction** - Reads src attribute from `<video>` tag
3. **Source Element Check** - Looks for `<source>` tags
4. **Mobile Version** - Tries mbasic.facebook.com (simpler HTML)

If all 4 fail, the video is likely private or requires authentication.

---

## Still Not Working?

### Debug Checklist:

- [ ] XAMPP MySQL is running
- [ ] Node.js server is running (`npm start`)
- [ ] Database has correct video IDs in `video_url` column
- [ ] Video IDs are numeric Facebook post IDs (not full URLs)
- [ ] Videos are public (or you've added Facebook cookies)
- [ ] No typos in `.env` configuration
- [ ] Puppeteer can access the internet (check firewall/proxy)

### Get More Help:

1. Check the full error logs in the terminal
2. Test with a known public Facebook video
3. Verify your Facebook account can view the video in a browser
4. Make sure the video hasn't been deleted or made private

---

## Example: Working Configuration

**Database (movies table):**
```
id: 8
title: Harry Potter
video_url: 1552926345723615
```

**backend/.env:**
```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=cinedrive
PORT=3000

# Optional: Add your Facebook cookies for private videos
FB_COOKIES=[{"name":"c_user","value":"100012345678","domain":".facebook.com"},{"name":"xs","value":"12%3Aabcd1234","domain":".facebook.com"}]
```

**Expected API Response:**
```json
{
  "success": true,
  "url": "https://video.xx.fbcdn.net/v/t42.1790-2/...",
  "cached": false,
  "expiresAt": "2025-12-07T10:30:00.000Z",
  "movie": {
    "id": 8,
    "title": "Harry Potter"
  }
}
```

---

## Security Note

⚠️ **Never commit your Facebook cookies to Git!**

Add to `.gitignore`:
```
.env
*.env.local
```

Your cookies give full access to your Facebook account. Keep them private!

---

## Summary

**Quick Fix:** Add Facebook authentication cookies to `.env` file and restart the server. This solves 90% of scraping failures.
