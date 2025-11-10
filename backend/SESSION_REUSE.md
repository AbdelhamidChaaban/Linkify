# Session Reuse with Redis

## Overview

The backend now uses **Upstash Redis** to store and reuse user sessions, eliminating the need to log in on every refresh request. Sessions are persisted across server restarts and shared across all refresh requests for the same user.

## How It Works

### Session Storage

1. **After Successful Login:**
   - Cookies are extracted from the browser
   - Session data (cookies + tokens) is stored in Redis with key: `user:{adminId}:session`
   - Session is stored as JSON with structure:
     ```json
     {
       "cookies": [...],
       "tokens": {},
       "savedAt": 1234567890,
       "timestamp": 1234567890
     }
     ```

2. **On Refresh Request:**
   - System checks Redis for existing session
   - If found, cookies are injected into browser context **before any navigation**
   - Session validity is verified by navigating to dashboard
   - If valid, login is skipped entirely
   - If invalid/expired, session is deleted and fresh login is performed

### Session Injection Flow

```
1. Create browser context
2. Check Redis for session ← NEW: Session injection happens here
3. Inject cookies if found
4. Set up request interception
5. Call loginToAlfa() → Verifies session or logs in
6. Navigate to dashboard
7. Scrape data
```

## Configuration

### Session TTL

Default: **No expiration** (sessions never expire)

```env
# In backend/.env
SESSION_EXPIRY_DAYS=30  # 30 days TTL
SESSION_EXPIRY_DAYS=0   # No expiration (default)
SESSION_EXPIRY_DAYS=-1  # Same as 0 - no expiration
```

**Recommended Values:**
- `SESSION_EXPIRY_DAYS=0` or `-1` - **No expiration** - Sessions persist forever (best for long-term reuse)
- `SESSION_EXPIRY_DAYS=30` - 30 days TTL (good balance)
- `SESSION_EXPIRY_DAYS=7` - 7 days TTL (more frequent re-authentication)

## Benefits

### Performance

- **First refresh after login:** ~40 seconds (includes login)
- **Subsequent refreshes:** ~15-20 seconds (login skipped)
- **Time saved:** ~20-25 seconds per refresh

### User Experience

- Users only need to log in once
- Sessions persist across server restarts
- No repeated authentication prompts

### Scalability

- Sessions stored in Redis (not in-memory)
- Survives server crashes/restarts
- Can be shared across multiple server instances (future)

## Session Lifecycle

### 1. First Login

```
User → Refresh Request
  ↓
No session in Redis
  ↓
Login required
  ↓
Login successful
  ↓
Save cookies to Redis
  ↓
Continue with scraping
```

### 2. Subsequent Refreshes

```
User → Refresh Request
  ↓
Session found in Redis
  ↓
Inject cookies into browser
  ↓
Verify session (navigate to dashboard)
  ↓
Session valid → Skip login
  ↓
Continue with scraping
```

### 3. Session Expiration/Invalidation

```
User → Refresh Request
  ↓
Session found in Redis
  ↓
Inject cookies
  ↓
Verify session
  ↓
Session invalid/expired
  ↓
Delete session from Redis
  ↓
Perform fresh login
  ↓
Save new session to Redis
```

## Error Handling

### Redis Unavailable

- System gracefully falls back to login
- No crash or error thrown
- Logs warning: `⚠️ Redis not available, cannot retrieve session`
- Session save failures are logged but don't break login flow

### Invalid Sessions

- Sessions with `failed` or `error` flags are ignored
- Partial sessions (no cookies) are not saved
- Invalid sessions are automatically deleted

### Cookie Injection Errors

- Errors are logged but don't crash
- System falls back to login if injection fails

## Redis Keys

### Session Key Format

```
user:{adminId}:session
```

Example:
```
user:nxErjzsICur47bN3RUwq:session
```

### Key Sanitization

- Special characters are replaced with underscores
- Ensures valid Redis key format

## API Methods

### `getSession(adminId)`

Retrieves session from Redis.

```javascript
const session = await getSession(adminId);
// Returns: { cookies: [...], tokens: {}, savedAt: 1234567890 }
// Or: null if not found
```

### `saveSession(adminId, cookies, tokens)`

Saves session to Redis.

```javascript
await saveSession(adminId, cookies, tokens);
// Saves to Redis with configured TTL
```

### `deleteSession(adminId)`

Deletes session from Redis.

```javascript
await deleteSession(adminId);
// Removes session key from Redis
```

### `hasSession(adminId)`

Checks if session exists.

```javascript
const exists = await hasSession(adminId);
// Returns: true or false
```

## Monitoring

### Logs

Look for these log messages:

**Session Retrieval:**
- `✅ Retrieved session from Redis for {adminId} (N cookies)`
- `⚠️ Redis not available, cannot retrieve session`

**Session Injection:**
- `🔑 Injecting session cookies before navigation...`
- `✅ Injected N cookies from Redis session`

**Session Verification:**
- `✅ Session restored successfully from Redis!`
- `⚠️ Session expired or invalid. Need to login again.`

**Session Saving:**
- `✅ Session saved to Redis for {adminId} (no expiration, N cookies)`
- `✅ Session saved to Redis for {adminId} (TTL: 30 days, N cookies)`

## Troubleshooting

### Sessions Not Persisting

1. Check Redis connection:
   ```bash
   # Check health endpoint
   curl http://localhost:3000/health
   ```

2. Verify Redis credentials in `.env`:
   ```env
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   ```

3. Check logs for Redis errors:
   ```bash
   pm2 logs linkify-backend | grep Redis
   ```

### Sessions Expiring Too Quickly

- Check `SESSION_EXPIRY_DAYS` in `.env`
- Set to `0` for no expiration
- Verify Redis TTL is not being overridden

### Login Still Happening

1. Check if session exists:
   ```bash
   # Check Redis directly (if you have redis-cli access)
   GET user:{adminId}:session
   ```

2. Verify session structure is valid
3. Check logs for session retrieval errors

## Best Practices

1. **Use No Expiration for Production:**
   - Set `SESSION_EXPIRY_DAYS=0` for maximum reuse
   - Sessions rarely change, so no expiration is safe

2. **Monitor Session Health:**
   - Watch logs for session restoration success rate
   - Track login frequency (should decrease after implementation)

3. **Handle Session Invalidation:**
   - System automatically deletes invalid sessions
   - Users will re-login automatically if session expires

4. **Redis Availability:**
   - Ensure Redis is always available for best performance
   - System gracefully falls back if Redis is down

## Performance Impact

### Before Session Reuse

- Every refresh: ~40 seconds (includes login)
- Login overhead: ~25 seconds

### After Session Reuse

- First refresh: ~40 seconds (login + scrape)
- Subsequent refreshes: ~15-20 seconds (scrape only)
- **Time saved: ~20-25 seconds per refresh**

### Expected Improvement

- **~60% faster** refresh times after first login
- **~50% reduction** in server load (no login processing)
- **Better user experience** (no repeated logins)

