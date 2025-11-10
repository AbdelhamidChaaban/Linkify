# Revised Caching Strategy

## Overview

The caching system has been revised to **always return fresh data** while using Redis to cache intermediate structures during scraping for performance optimization.

## Key Principles

✅ **Always Fresh Data**: Every refresh request performs a fresh scrape  
✅ **Performance Layer**: Redis caches intermediate HTML/JSON structures only  
❌ **No Response Caching**: Never return cached final responses to users  
❌ **No Pre-warming**: No background scraping  

## How It Works

### Request Flow

1. **User requests refresh** → Always triggers fresh scrape
2. **During scraping**:
   - Check Redis for cached HTML structure (for parsing hints)
   - Check Redis for cached API structures (for prioritization)
   - Navigate to dashboard (always fresh)
   - Fetch fresh API data
   - Cache new HTML/API structures for next scrape
3. **Return fresh data** → Always latest from current scrape

### What Gets Cached

**Intermediate Structures (TTL: 3 minutes default):**
- `user:{id}:html` - HTML page structure
- `user:{id}:api:getconsumption` - API response structure
- `user:{id}:api:getmyservices` - API response structure

**What Does NOT Get Cached:**
- Final dashboard data responses
- User-facing data

### Cache Usage During Scraping

1. **HTML Structure Cache**:
   - Used to understand page structure
   - Helps optimize parsing
   - Does NOT skip page navigation (always fresh)

2. **API Structure Cache**:
   - Used to prioritize which APIs to fetch first
   - Helps identify expected API endpoints
   - Does NOT skip API fetching (always fresh)

## Configuration

### Cache TTL

Default: **3 minutes** (configurable)

```env
# In backend/.env
CACHE_TTL=5  # 5 minutes (2-5 minutes recommended)
CACHE_TTL=0  # No expiration - structures never expire (always available)
CACHE_TTL=-1 # Same as 0 - no expiration
```

**Recommended Values:**
- `CACHE_TTL=0` or `CACHE_TTL=-1` - **No expiration** - Structures always available (best for first refresh speed)
- `CACHE_TTL=2` - Very fresh structures (more scraping)
- `CACHE_TTL=3` - Balanced (default)
- `CACHE_TTL=5` - Longer structures (less scraping, but may be less accurate)

**No Expiration Mode:**
When `CACHE_TTL=0` or `CACHE_TTL=-1`:
- HTML and JSON structures are cached **forever** (until manually deleted)
- Structures are always available for optimization hints
- **Best for speeding up first refresh** - structures persist across server restarts
- Data is still always fresh (we always scrape), but structures help optimize the process

## Performance Benefits

### What's Optimized

1. **Parsing Optimization**: Cached HTML structure helps optimize DOM parsing
2. **API Prioritization**: Cached API structures help prioritize which APIs to fetch
3. **Structure Hints**: Reduces guesswork during scraping

### What's NOT Optimized

- Page navigation (always happens)
- API fetching (always happens)
- Data extraction (always happens)

### Expected Performance

- **First request**: ~29 seconds (full scrape)
- **Subsequent requests**: ~29 seconds (full scrape, but with structure hints)
- **With cached structures**: Slightly faster parsing (~1-2 seconds saved)

## Code Changes

### Removed

- ❌ Final response caching (`get()`, `set()` methods)
- ❌ Pre-warming service (`cachePreWarmer.js`)
- ❌ Cache hit/miss logic in API endpoint
- ❌ Background refresh logic

### Added

- ✅ HTML structure caching (`getHtmlStructure()`, `setHtmlStructure()`)
- ✅ API structure caching (`getApiStructure()`, `setApiStructure()`)
- ✅ Always-fresh scraping logic

## API Response

**Before:**
```json
{
  "success": true,
  "data": {...},
  "cached": true,
  "cachedAt": 1234567890
}
```

**After:**
```json
{
  "success": true,
  "data": {...},
  "duration": 29000
}
```

Always fresh - no `cached` field.

## Monitoring

### Check Cache Stats

```bash
curl http://localhost:3000/api/cache/{identifier}/stats
```

Response:
```json
{
  "enabled": true,
  "available": true,
  "hasHtml": true,
  "hasConsumption": true,
  "hasServices": true,
  "lastRefresh": 1234567890,
  "age": 120000,
  "ttl": 180
}
```

### Logs

Look for:
- `🔄 Navigating to dashboard (always fresh)...` - Always scrapes
- `📄 Found cached HTML structure` - Using structure hints
- `📡 Found cached API structures` - Using API hints

## Benefits

1. **Always Fresh**: Users always get latest data
2. **Performance**: Structure caching speeds up parsing
3. **Reliability**: No stale data issues
4. **Transparency**: Clear that data is always fresh

## Trade-offs

- **Slightly slower**: Every request scrapes (no instant cache hits)
- **More server load**: More scraping operations
- **Better accuracy**: Always latest data

This strategy prioritizes **data freshness** over **response speed**.

