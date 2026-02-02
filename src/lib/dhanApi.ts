// Dhan API Client for Real Market Data
// Uses REST API for quotes and order execution

interface DhanQuote {
    symbol: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    lastPrice: number;
}

interface DhanOrder {
    orderId: string;
    status: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
}

// Credentials from environment
const CLIENT_ID = process.env.DHAN_CLIENT_ID || '';
const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';

const DHAN_API_BASE = 'https://api.dhan.co/v2';

// Map NSE symbols to Dhan format
function formatSymbol(symbol: string): string {
    return `${symbol.replace('.NS', '')}-EQ`;
}

// Fetch real-time quotes from Dhan
export async function fetchQuotes(symbols: string[]): Promise<Record<string, DhanQuote>> {
    if (!CLIENT_ID || !ACCESS_TOKEN) {
        console.error('[DHAN] Missing credentials');
        return {};
    }

    try {
        const securities: Record<string, string> = {};
        const symbolMap: Record<string, string> = {};

        symbols.forEach(s => {
            const dhanSymbol = formatSymbol(s);
            securities[dhanSymbol] = 'NSE_EQ';
            symbolMap[dhanSymbol] = s;
        });

        const response = await fetch(`${DHAN_API_BASE}/marketfeed/quote`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'access-token': ACCESS_TOKEN,
                'client-id': CLIENT_ID
            },
            body: JSON.stringify({
                NSE_EQ: symbols.map(s => formatSymbol(s))
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('[DHAN] Quote fetch failed:', error);
            return {};
        }

        const data = await response.json();
        const results: Record<string, DhanQuote> = {};

        if (data.status === 'success' && data.data) {
            for (const [dhanSymbol, quoteData] of Object.entries(data.data as Record<string, any>)) {
                const originalSymbol = symbolMap[dhanSymbol];
                if (originalSymbol && quoteData) {
                    results[originalSymbol] = {
                        symbol: originalSymbol,
                        open: quoteData.open || 0,
                        high: quoteData.high || 0,
                        low: quoteData.low || 0,
                        close: quoteData.last_price || quoteData.lp || 0,
                        volume: quoteData.volume || 0,
                        lastPrice: quoteData.last_price || quoteData.lp || 0
                    };
                }
            }
        }

        return results;
    } catch (error) {
        console.error('[DHAN] Quote error:', error);
        return {};
    }
}

// Place order (PAPER mode = simulate, LIVE mode = real execution)
export async function placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    orderType: 'MARKET' | 'LIMIT' = 'MARKET',
    price?: number,
    paperMode: boolean = true
): Promise<DhanOrder | null> {

    // Paper mode - simulate order
    if (paperMode) {
        console.log(`[PAPER] ${side} ${quantity} ${symbol} @ ${orderType}`);
        return {
            orderId: `PAPER_${Date.now()}`,
            status: 'COMPLETE',
            symbol,
            side,
            quantity,
            price: price || 0
        };
    }

    // LIVE mode - real order execution
    if (!CLIENT_ID || !ACCESS_TOKEN) {
        console.error('[DHAN] Cannot place order: Missing credentials');
        return null;
    }

    try {
        const orderPayload = {
            dhanClientId: CLIENT_ID,
            transactionType: side,
            exchangeSegment: 'NSE_EQ',
            productType: 'INTRADAY',
            orderType: orderType,
            validity: 'DAY',
            tradingSymbol: formatSymbol(symbol),
            securityId: symbol, // This needs proper securityId mapping
            quantity: quantity,
            price: orderType === 'LIMIT' ? price : 0,
            triggerPrice: 0
        };

        const response = await fetch(`${DHAN_API_BASE}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'access-token': ACCESS_TOKEN,
                'client-id': CLIENT_ID
            },
            body: JSON.stringify(orderPayload)
        });

        const data = await response.json();

        if (data.status === 'success') {
            console.log(`[DHAN] Order placed: ${data.data?.orderId}`);
            return {
                orderId: data.data?.orderId || '',
                status: 'PENDING',
                symbol,
                side,
                quantity,
                price: price || 0
            };
        } else {
            console.error('[DHAN] Order failed:', data);
            return null;
        }
    } catch (error) {
        console.error('[DHAN] Order error:', error);
        return null;
    }
}

// Get account balance
export async function getBalance(): Promise<number> {
    if (!CLIENT_ID || !ACCESS_TOKEN) return 0;

    try {
        const response = await fetch(`${DHAN_API_BASE}/fundlimit`, {
            headers: {
                'access-token': ACCESS_TOKEN,
                'client-id': CLIENT_ID
            }
        });

        const data = await response.json();
        if (data.status === 'success') {
            return data.data?.availabelToTradeBalance || 0;
        }
        return 0;
    } catch (error) {
        console.error('[DHAN] Balance error:', error);
        return 0;
    }
}

// Get current positions
export async function getPositions(): Promise<any[]> {
    if (!CLIENT_ID || !ACCESS_TOKEN) return [];

    try {
        const response = await fetch(`${DHAN_API_BASE}/positions`, {
            headers: {
                'access-token': ACCESS_TOKEN,
                'client-id': CLIENT_ID
            }
        });

        const data = await response.json();
        if (data.status === 'success') {
            return data.data || [];
        }
        return [];
    } catch (error) {
        console.error('[DHAN] Positions error:', error);
        return [];
    }
}

// Check if Dhan API is configured
export function isDhanConfigured(): boolean {
    return !!(CLIENT_ID && ACCESS_TOKEN && ACCESS_TOKEN.length > 50);
}
