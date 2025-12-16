# CineDrive Backend API

Node.js Express server for CineDrive video streaming platform.

## Installation

```bash
cd backend
npm install
```

## Configuration

Update `.env` file with your database credentials:

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=sinhbtve_cinedrive
PORT=3000
```

## Database Schema

Ensure your `movies` table has these columns:

```sql
ALTER TABLE movies 
ADD COLUMN cached_video_url VARCHAR(255) DEFAULT NULL,
ADD COLUMN url_expires_at DATETIME DEFAULT NULL;
```

## Running the Server

### Development (with auto-restart)
```bash
npm run dev
```

### Production
```bash
npm start
```

## API Endpoints

### Health Check
```
GET /health
```

**Response:**
```json
{
  "status": "OK",
  "message": "CineDrive API is running"
}
```

### Get Video URL
```
GET /api/video/:id
```

**Parameters:**
- `id` (number) - Movie ID

**Response (Cached):**
```json
{
  "success": true,
  "url": "https://cached-url.com/video.mp4",
  "cached": true,
  "expires_at": "2025-12-31T23:59:59.000Z",
  "movie_id": 1,
  "title": "Movie Title"
}
```

**Response (Not Cached):**
```json
{
  "success": true,
  "url": "https://original-url.com/video.mp4",
  "cached": false,
  "movie_id": 1,
  "title": "Movie Title"
}
```

**Error Responses:**
- `400` - Invalid ID
- `404` - Video not found
- `500` - Server error

## Features

✅ MySQL connection pooling
✅ CORS enabled for all origins
✅ Automatic cache validation
✅ Proper error handling
✅ Graceful shutdown
✅ Environment variables support

## Dependencies

- **express** - Web framework
- **cors** - CORS middleware
- **mysql2** - MySQL client with Promise support
- **dotenv** - Environment variables
- **puppeteer** - Browser automation (for future use)
