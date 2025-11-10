# Redis Cache Layer Setup Guide

## Overview

The backend now includes a Redis caching layer using Upstash Redis to cache HTML/JSON responses and avoid redundant scraping. This significantly speeds up refresh requests when data is fresh.

## Features

- ✅ Automatic cache checking before scraping
- ✅ 5-minute TTL (Time To Live) for cached data
- ✅ User-specific cache keys (based on phone/adminId)
- ✅ Graceful fallback if Redis is unavailable
- ✅ Non-blocking cache writes (doesn't slow down responses)
- ✅ Error handling - doesn't cache errors or incomplete responses

## Setup Instructions

### 1. Create Upstash Redis Database

1. Go to [Upstash Console](https://console.upstash.com/)
2. Sign up or log in
3. Click "Create Database"
4. Choose a name (e.g., "linkify-cache")
5. Select a region close to your server
6. Click "Create"

### 2. Get Credentials

After creating the database:

1. Click on your database
2. Go to the "REST API" tab
3. Copy:
   - **UPSTASH_REDIS_REST_URL** (e.g., `https://your-db.upstash.io`)
   - **UPSTASH_REDIS_REST_TOKEN** (long token string)

### 3. Add to Environment Variables

Add these to your `.env` file in the `backend/` directory:

```env
UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
```

### 4. Install Dependencies

```bash
cd backend
npm install
```

This will install `@upstash/redis` package.

### 5. Restart Server

```bash
# If using PM2
pm2 restart linkify-backend

# Or if running directly
node server.js
```

## How It Works

### Cache Flow

1. **Request arrives** → Check Redis cache first
2. **Cache hit** (fresh data < 5 min old) → Return cached data immediately
3. **Cache miss** (no data or stale) → Scrape fresh data
4. **After scraping** → Store result in Redis with 5-minute TTL
5. **Next request** → Uses cached data if still fresh

### Cache Keys

- `user:{identifier}:data` - Stores the actual dashboard data
- `user:{identifier}:lastRefresh` - Stores timestamp of last refresh

Where `{identifier}` is the `adminId` or `phone` number.

### Example Flow

**First Request:**
```
1. Check cache → MISS
2. Scrape data → 18 seconds
3. Store in cache
4. Return data
```

**Second Request (within 5 minutes):**
```
1. Check cache → HIT
2. Return cached data → < 100ms
```

## API Response Changes

The `/api/alfa/fetch` endpoint now includes a `cached` field:

```json
{
  "success": true,
  "data": { ... },
  "duration": 0,
  "cached": true,
  "cachedAt": 1700000000000
}
```

- `cached: true` - Data came from cache
- `cached: false` - Data was freshly scraped

## Cache Management Endpoints

### Clear Cache for User

```bash
DELETE /api/cache/:identifier

# Example
curl -X DELETE http://localhost:3000/api/cache/nxErjzsICur47bN3RUwq
```

### Get Cache Stats

```bash
GET /api/cache/:identifier/stats

# Example
curl http://localhost:3000/api/cache/nxErjzsICur47bN3RUwq/stats
```

Response:
```json
{
  "enabled": true,
  "available": true,
  "hasData": true,
  "lastRefresh": 1700000000000,
  "age": 120000,
  "ttl": 300
}
```

## Health Check

The `/health` endpoint now includes cache status:

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "browserPool": { ... },
  "cache": {
    "enabled": true,
    "ttl": 300
  }
}
```

## Configuration

### Change Cache TTL

Edit `backend/services/cacheLayer.js`:

```javascript
this.cacheTTL = 5 * 60; // Change to desired seconds (default: 5 minutes)
```

### Disable Cache

Remove or comment out the environment variables:
```env
# UPSTASH_REDIS_REST_URL=
# UPSTASH_REDIS_REST_TOKEN=
```

The cache layer will automatically disable and fall back to scraping.

## Error Handling

- **Redis unavailable**: Falls back to scraping (no errors)
- **Cache errors**: Logged as warnings, don't crash the app
- **Invalid data**: Not cached (errors, incomplete responses)
- **Stale data**: Automatically refreshed if older than TTL

## Performance Benefits

- **First request**: Normal scraping time (~15-20 seconds)
- **Cached requests**: < 100ms response time
- **Reduced load**: Fewer browser scrapes = less resource usage
- **Better UX**: Instant responses for recent refreshes

## Monitoring

Check logs for cache activity:

```
✅ Cache hit for nxErjzsICur47bN3RUwq
💾 Cached data for nxErjzsICur47bN3RUwq (TTL: 300s)
⏰ Cache for nxErjzsICur47bN3RUwq is stale (350s old), will refresh
```

## Troubleshooting

### Cache Not Working

1. Check environment variables are set:
   ```bash
   echo $UPSTASH_REDIS_REST_URL
   echo $UPSTASH_REDIS_REST_TOKEN
   ```

2. Check server logs for initialization:
   ```
   ✅ Redis cache layer initialized
   ```

3. If you see warnings:
   ```
   ⚠️ Upstash Redis credentials not found. Caching disabled.
   ```
   → Add credentials to `.env` file

### Cache Always Misses

- Check Redis connection in Upstash console
- Verify credentials are correct
- Check network connectivity to Upstash

### Clear All Cache

Upstash console → Your database → "Flush Database" (use with caution!)

## Production Deployment

For Render.com or other platforms:

1. Add environment variables in your platform's dashboard
2. Restart the service
3. Verify cache is working via `/health` endpoint

The cache layer is production-ready and handles failures gracefully.

