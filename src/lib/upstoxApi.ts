
const UPSTOX_API_KEY = process.env.UPSTOX_API_KEY!;
const UPSTOX_API_SECRET = process.env.UPSTOX_API_SECRET!;
const UPSTOX_REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI || 'http://localhost:3000/api/upstox/callback';

// Singleton instance
let accessToken: string | null = null;

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
            accessToken = json.access_token;
            console.log('✅ Upstox Login Successful. Token:', accessToken!.substring(0, 10) + '...');
            return accessToken!;
        } else {
            throw new Error('No access_token in response');
        }

    } catch (error) {
        console.error('❌ Upstox Login Failed:', error);
        throw error;
    }
}

/**
 * Fetch LTP for a list of symbols
 */
export async function fetchUpstoxQuotes(symbols: string[]) {
    if (!accessToken) {
        // console.warn('⚠️ No Upstox access token. Login required.');
        return {};
    }

    try {
        // Map common symbols to Upstox Instrument Keys
        // Example: RELIANCE -> NSE_EQ|RELIANCE
        const instrumentKeys = symbols.map(s => `NSE_EQ|${s}`).join(',');

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

        if (json.data) {
            for (const key of Object.keys(json.data)) {
                // Key is "NSE_EQ|RELIANCE", extract "RELIANCE"
                const symbol = key.split('|')[1];
                const data = json.data[key];

                result[symbol] = {
                    lastPrice: data.last_price,
                    symbol: symbol
                };
            }
        }

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
            }
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
