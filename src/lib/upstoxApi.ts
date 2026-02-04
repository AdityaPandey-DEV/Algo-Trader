
import * as fs from 'fs';
import * as path from 'path';
import { saveToken as saveTokenToRedis, loadToken as loadTokenFromRedis } from './redis';

const UPSTOX_API_KEY = process.env.UPSTOX_API_KEY!;
const UPSTOX_API_SECRET = process.env.UPSTOX_API_SECRET!;
const UPSTOX_REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI || 'http://localhost:3000/api/upstox/callback';

// Token persistence path (fallback for local dev)
const TOKEN_FILE_PATH = path.join('/tmp', 'upstox_token.json');

// In-memory cache (fast access)
let accessToken: string | null = null;
let tokenExpiry: number | null = null;
let redisCheckDone = false;

/**
 * Load token from Redis first, then file fallback
 */
export async function loadTokenAsync(): Promise<void> {
    if (accessToken) return; // Already in memory

    // Try Redis first
    try {
        const redisToken = await loadTokenFromRedis();
        if (redisToken) {
            accessToken = redisToken;
            return;
        }
    } catch (e) {
        console.error('Redis load failed, trying file fallback:', e);
    }

    // File fallback
    try {
        if (fs.existsSync(TOKEN_FILE_PATH)) {
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE_PATH, 'utf-8'));
            if (data.token && data.expiry && Date.now() < data.expiry) {
                accessToken = data.token;
                tokenExpiry = data.expiry;
                console.log('✅ Loaded Upstox token from file storage');
            } else {
                fs.unlinkSync(TOKEN_FILE_PATH);
            }
        }
    } catch (e) {
        console.error('Failed to load token from file:', e);
    }
}

/**
 * Sync version for backwards compatibility (checks file only)
 */
function loadTokenFromFile(): void {
    if (accessToken) return;

    try {
        if (fs.existsSync(TOKEN_FILE_PATH)) {
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE_PATH, 'utf-8'));
            if (data.token && data.expiry && Date.now() < data.expiry) {
                accessToken = data.token;
                tokenExpiry = data.expiry;
            } else {
                fs.unlinkSync(TOKEN_FILE_PATH);
            }
        }
    } catch (e) {
        // Silent fail
    }
}

/**
 * Save token to Redis (primary) and file (fallback)
 */
async function saveTokenToStorage(token: string): Promise<void> {
    accessToken = token;
    tokenExpiry = Date.now() + 24 * 60 * 60 * 1000;

    // Save to Redis (primary)
    try {
        await saveTokenToRedis(token);
    } catch (e) {
        console.error('Redis save failed:', e);
    }

    // Also save to file (fallback)
    try {
        fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify({ token, expiry: tokenExpiry }));
        console.log('💾 Saved Upstox token to file storage');
    } catch (e) {
        console.error('File save failed:', e);
    }
}

/**
 * Get Login URL for OAuth2
 * Manual implementation to avoid SDK issues
 */
export function getUpstoxLoginUrl(): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: UPSTOX_API_KEY,
        redirect_uri: UPSTOX_REDIRECT_URI
    });
    return `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}`;
}

/**
 * Exchange Authorization Code for Access Token
 * Using fetch instead of SDK
 */
export async function handleUpstoxCallback(code: string): Promise<string> {
    try {
        console.log('🔄 Exchanging Upstox code for token...');

        const params = new URLSearchParams();
        params.append('code', code);
        params.append('client_id', UPSTOX_API_KEY);
        params.append('client_secret', UPSTOX_API_SECRET);
        params.append('redirect_uri', UPSTOX_REDIRECT_URI);
        params.append('grant_type', 'authorization_code');

        const response = await fetch('https://api.upstox.com/v2/login/authorization/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: params
        });

        const json = await response.json();

        if (!response.ok) {
            console.error('❌ Upstox Token Error Response:', json);
            throw new Error(json.message || json.error || 'Failed to exchange token');
        }

        if (json.access_token) {
            // Save to Redis (primary) and file (fallback)
            await saveTokenToStorage(json.access_token);
            console.log('✅ Upstox Login Successful. Token:', json.access_token.substring(0, 10) + '...');
            return json.access_token;
        } else {
            throw new Error('No access_token in response');
        }

    } catch (error) {
        console.error('❌ Upstox Login Failed:', error);
        throw error;
    }
}

/**
 * Check if we have a valid Upstox session (sync - checks memory/file only)
 * For API routes, use isUpstoxAuthenticatedAsync instead
 */
export function isUpstoxAuthenticated(): boolean {
    loadTokenFromFile(); // Try to load from file if not in memory
    return accessToken !== null;
}

/**
 * Check if we have a valid Upstox session (async - checks Redis too)
 */
export async function isUpstoxAuthenticatedAsync(): Promise<boolean> {
    if (accessToken) return true;

    // Try to load from Redis
    await loadTokenAsync();
    return accessToken !== null;
}

/**
 * Fetch LTP for a list of symbols
 */
// ISIN mapping for NSE stocks (Upstox requires ISIN, not trading symbol)
const ISIN_MAP: Record<string, string> = {
    'RELIANCE': 'INE002A01018',
    'TCS': 'INE467B01029',
    'INFY': 'INE009A01021',
    'HDFCBANK': 'INE040A01034',
    'ICICIBANK': 'INE090A01021',
    'HINDUNILVR': 'INE030A01027',
    'ITC': 'INE154A01025',
    'SBIN': 'INE062A01020',
    'BHARTIARTL': 'INE397D01024',
    'KOTAKBANK': 'INE237A01028',
    'LT': 'INE018A01030',
    'AXISBANK': 'INE238A01034',
    'ASIANPAINT': 'INE021A01026',
    'MARUTI': 'INE585B01010',
    'TITAN': 'INE280A01028',
    'BAJFINANCE': 'INE296A01024',
    'WIPRO': 'INE075A01022',
    'HCLTECH': 'INE860A01027',
    'ULTRACEMCO': 'INE481G01011',
    'SUNPHARMA': 'INE044A01036',
    // Missing from original - now added
    'NESTLEIND': 'INE239A01016',
    'ADANIENT': 'INE423A01024',
    'TATASTEEL': 'INE081A01020',
    'POWERGRID': 'INE752E01010',
    // ETFs - Correct ISINs
    'GOLDBEES': 'INF204KB17I5',
    'SILVERBEES': 'INF204KC1402',
    'NIFTYBEES': 'INF204KB14I2',
    'BANKBEES': 'INF204KB15I9',
    'LIQUIDBEES': 'INF732E01037'
};

export async function fetchUpstoxQuotes(symbols: string[]) {
    // Try to load token from Redis/file if not in memory (cold start recovery)
    await loadTokenAsync();

    if (!accessToken) {
        // console.warn('⚠️ No Upstox access token. Login required.');
        return {};
    }

    try {
        // Map symbols to Upstox Instrument Keys using ISIN
        // Format: NSE_EQ|ISIN (URL encoded)
        const instrumentKeys = symbols
            .filter(s => ISIN_MAP[s]) // Only include symbols we have ISINs for
            .map(s => encodeURIComponent(`NSE_EQ|${ISIN_MAP[s]}`))
            .join(',');

        if (!instrumentKeys) {
            console.warn('No valid ISINs found for symbols:', symbols);
            return {};
        }

        const url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${instrumentKeys}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            // Check if token expired
            if (response.status === 401) {
                console.error('Upstox Token Expired or Invalid');
                accessToken = null;
            }
            throw new Error(`Upstox API Error: ${response.statusText}`);
        }

        const json = await response.json();

        const result: Record<string, any> = {};

        // Create reverse ISIN map for lookup
        const ISIN_TO_SYMBOL: Record<string, string> = {};
        for (const [symbol, isin] of Object.entries(ISIN_MAP)) {
            ISIN_TO_SYMBOL[isin] = symbol;
        }

        if (json.data) {
            for (const key of Object.keys(json.data)) {
                // Key is "NSE_EQ|ISIN", extract the ISIN and map back to symbol
                const isin = key.split('|')[1];
                const symbol = ISIN_TO_SYMBOL[isin] || isin;
                const data = json.data[key];

                result[symbol] = {
                    lastPrice: data.last_price,
                    symbol: symbol
                };
            }
        }

        console.log(`✅ Upstox: Fetched ${Object.keys(result).length} quotes`);
        return result;

    } catch (error) {
        console.error('Error fetching Upstox quotes:', error);
        return {};
    }
}

/**
 * Fetch Full OHLC Quotes
 */
export async function fetchUpstoxFullQuotes(symbols: string[]) {
    if (!accessToken) {
        return {};
    }

    try {
        const instrumentKeys = symbols.map(s => `NSE_EQ|${s}`).join(',');
        const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${instrumentKeys}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(5000) // 5 second timeout to prevent hanging the server
        });

        const json = await response.json();
        const result: Record<string, any> = {};

        if (json.data) {
            for (const key of Object.keys(json.data)) {
                const symbol = key.split('|')[1];
                const d = json.data[key];

                result[symbol] = {
                    lastPrice: d.last_price,
                    open: d.ohlc.open,
                    high: d.ohlc.high,
                    low: d.ohlc.low,
                    close: d.ohlc.close,
                    volume: d.volume,
                    change: d.net_change
                };
            }
        }
        return result;
    } catch (error) {
        console.error('Error fetching Upstox full quotes:', error);
        return {};
    }
}

/**
 * Fetch Uptox Account Balance
 */
export async function getUpstoxBalance(): Promise<number | null> {
    if (!await isUpstoxAuthenticatedAsync()) {
        return null;
    }

    try {
        const response = await fetch('https://api.upstox.com/v2/user/profile/funds', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            console.error('Upstox balance fetch failed:', response.status);
            return null;
        }

        const data = await response.json();
        // Return available cash for trading
        return data.data?.equity?.available_margin || 0;
    } catch (error) {
        console.error('Error fetching Upstox balance:', error);
        return null;
    }
}

/**
 * Fetch Historical Candles (1minute)
 * @param symbol Trading symbol (e.g., RELIANCE)
 * @param fromDate ISO Date string (YYYY-MM-DD)
 * @param toDate ISO Date string (YYYY-MM-DD)
 */
export async function fetchHistoricalCandles(symbol: string, fromDate: string, toDate: string): Promise<any[]> {
    if (!await isUpstoxAuthenticatedAsync()) {
        console.error('Upstox not authenticated');
        return [];
    }

    const isin = ISIN_MAP[symbol];
    if (!isin) {
        console.error(`No ISIN found for ${symbol}`);
        return [];
    }

    const instrumentKey = `NSE_EQ|${isin}`;
    const interval = '1minute';
    // Upstox API format: /historical-candle/{instrumentKey}/{interval}/{to_date}/{from_date}

    const url = `https://api.upstox.com/v2/historical-candle/${instrumentKey}/${interval}/${toDate}/${fromDate}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            // console.error(`Upstox history fetch failed for ${symbol}:`, response.status);
            return [];
        }

        const json = await response.json();



        if (json.status === 'success' && json.data && Array.isArray(json.data.candles)) {
            // Data format: [timestamp, open, high, low, close, volume, oi]
            return json.data.candles.map((candle: any[]) => ({
                time: candle[0],
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5]
            })).reverse(); // Sort chronological
        }

        console.warn(`⚠️ Upstox History Unexpected Format (${symbol}):`, JSON.stringify(json).substring(0, 200));
        return [];
    } catch (error) {
        console.error(`Error fetching Upstox history for ${symbol}:`, error);
        return [];
    }
}
