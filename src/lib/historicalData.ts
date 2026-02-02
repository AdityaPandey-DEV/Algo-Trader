// Historical Data Fetcher using Yahoo Finance API
// Provides real OHLCV data for backtesting

import { OHLCV } from './indicators';

// Yahoo Finance API endpoints
const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// NSE symbol mappings to Yahoo Finance format
const YAHOO_SYMBOLS: Record<string, string> = {
    'RELIANCE': 'RELIANCE.NS',
    'TCS': 'TCS.NS',
    'HDFCBANK': 'HDFCBANK.NS',
    'INFY': 'INFY.NS',
    'ICICIBANK': 'ICICIBANK.NS',
    'SBIN': 'SBIN.NS',
    'BHARTIARTL': 'BHARTIARTL.NS',
    'ITC': 'ITC.NS',
    'LT': 'LT.NS',
    'AXISBANK': 'AXISBANK.NS',
    'KOTAKBANK': 'KOTAKBANK.NS',
    'HINDUNILVR': 'HINDUNILVR.NS',
    'BAJFINANCE': 'BAJFINANCE.NS',
    'MARUTI': 'MARUTI.NS',
    'TATAMOTORS': 'TATAMOTORS.NS'
};

// Cache for historical data
const dataCache: Map<string, { data: OHLCV[][]; expiry: number }> = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Convert NSE symbol to Yahoo Finance format
 */
function toYahooSymbol(symbol: string): string {
    return YAHOO_SYMBOLS[symbol] || `${symbol}.NS`;
}

/**
 * Fetch daily OHLCV data from Yahoo Finance
 */
export async function fetchDailyData(
    symbol: string,
    days: number = 100
): Promise<OHLCV[]> {
    const yahooSymbol = toYahooSymbol(symbol);

    // Calculate date range
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (days * 24 * 60 * 60);

    const url = `${YAHOO_BASE_URL}/${yahooSymbol}?period1=${startDate}&period2=${endDate}&interval=1d`;

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            console.error(`Yahoo Finance error for ${symbol}: ${response.status}`);
            return [];
        }

        const data = await response.json();
        const result = data.chart?.result?.[0];

        if (!result) {
            console.error(`No data returned for ${symbol}`);
            return [];
        }

        const timestamps = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0] || {};

        const candles: OHLCV[] = [];

        for (let i = 0; i < timestamps.length; i++) {
            if (quotes.open?.[i] != null && quotes.close?.[i] != null) {
                candles.push({
                    symbol,
                    open: quotes.open[i],
                    high: quotes.high[i],
                    low: quotes.low[i],
                    close: quotes.close[i],
                    volume: quotes.volume[i] || 0,
                    timestamp: new Date(timestamps[i] * 1000)
                });
            }
        }

        console.log(`Fetched ${candles.length} daily candles for ${symbol}`);
        return candles;

    } catch (error) {
        console.error(`Error fetching ${symbol}:`, error);
        return [];
    }
}

/**
 * Fetch intraday OHLCV data from Yahoo Finance
 * Yahoo allows 15m, 30m, 60m intervals for last 60 days
 */
export async function fetchIntradayData(
    symbol: string,
    days: number = 60,
    interval: '15m' | '30m' | '60m' = '15m'
): Promise<OHLCV[][]> {
    const yahooSymbol = toYahooSymbol(symbol);

    // Yahoo limits intraday data to 60 days
    const actualDays = Math.min(days, 60);

    // Calculate date range
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (actualDays * 24 * 60 * 60);

    const url = `${YAHOO_BASE_URL}/${yahooSymbol}?period1=${startDate}&period2=${endDate}&interval=${interval}`;

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            console.error(`Yahoo Finance error for ${symbol}: ${response.status}`);
            return [];
        }

        const data = await response.json();
        const result = data.chart?.result?.[0];

        if (!result) {
            console.error(`No intraday data returned for ${symbol}`);
            return [];
        }

        const timestamps = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0] || {};

        // Group candles by day
        const dayMap: Map<string, OHLCV[]> = new Map();

        for (let i = 0; i < timestamps.length; i++) {
            if (quotes.open?.[i] != null && quotes.close?.[i] != null) {
                const date = new Date(timestamps[i] * 1000);
                const dayKey = date.toISOString().split('T')[0];

                if (!dayMap.has(dayKey)) {
                    dayMap.set(dayKey, []);
                }

                dayMap.get(dayKey)!.push({
                    symbol,
                    open: quotes.open[i],
                    high: quotes.high[i],
                    low: quotes.low[i],
                    close: quotes.close[i],
                    volume: quotes.volume[i] || 0,
                    timestamp: date
                });
            }
        }

        // Convert to array of days
        const allDays = Array.from(dayMap.values())
            .filter(day => day.length >= 10) // Filter out incomplete days
            .sort((a, b) => a[0].timestamp!.getTime() - b[0].timestamp!.getTime());

        console.log(`Fetched ${allDays.length} intraday sessions for ${symbol}`);
        return allDays;

    } catch (error) {
        console.error(`Error fetching intraday ${symbol}:`, error);
        return [];
    }
}

/**
 * Expand daily data to simulated intraday candles
 * When real intraday data is not available
 */
export function expandDailyToIntraday(
    dailyCandles: OHLCV[],
    candlesPerDay: number = 25  // 15-min candles in 6.25hr session
): OHLCV[][] {
    const allDays: OHLCV[][] = [];

    for (const daily of dailyCandles) {
        const dayCandles: OHLCV[] = [];
        const { open, high, low, close, volume, symbol } = daily;

        // Simulate intraday using a pattern that respects daily OHLC
        const range = high - low;
        let price = open;

        // Determine if it's a bullish or bearish day
        const bullish = close > open;
        const midPoint = (high + low) / 2;

        for (let i = 0; i < candlesPerDay; i++) {
            const progress = i / candlesPerDay;

            // Morning: Move towards high/low
            // Afternoon: Move towards close
            let targetPrice: number;
            if (progress < 0.3) {
                // First 30%: Initial move
                targetPrice = bullish ? midPoint + range * 0.2 : midPoint - range * 0.2;
            } else if (progress < 0.5) {
                // 30-50%: Move to extreme
                targetPrice = bullish ? high - range * 0.1 : low + range * 0.1;
            } else if (progress < 0.7) {
                // 50-70%: Pullback
                targetPrice = midPoint;
            } else {
                // 70-100%: Move towards close
                targetPrice = close;
            }

            // Add some noise
            const noise = (Math.random() - 0.5) * range * 0.1;
            const candleClose = targetPrice + noise;

            // Ensure within daily range
            const candleHigh = Math.min(high, Math.max(price, candleClose) + range * 0.02);
            const candleLow = Math.max(low, Math.min(price, candleClose) - range * 0.02);

            dayCandles.push({
                symbol,
                open: Math.round(price * 100) / 100,
                high: Math.round(candleHigh * 100) / 100,
                low: Math.round(candleLow * 100) / 100,
                close: Math.round(candleClose * 100) / 100,
                volume: Math.floor(volume / candlesPerDay),
                timestamp: daily.timestamp
            });

            price = candleClose;
        }

        // Ensure last candle closes at daily close
        if (dayCandles.length > 0) {
            dayCandles[dayCandles.length - 1].close = close;
        }

        allDays.push(dayCandles);
    }

    return allDays;
}

/**
 * Fetch historical data for backtesting
 * Tries intraday first, falls back to expanded daily
 */
export async function fetchHistoricalDataForBacktest(
    symbol: string,
    days: number = 100
): Promise<OHLCV[][]> {
    const cacheKey = `${symbol}_${days}`;
    const cached = dataCache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
        console.log(`Using cached data for ${symbol}`);
        return cached.data;
    }

    // Try to fetch intraday data first (limited to 60 days)
    let data: OHLCV[][] = [];

    if (days <= 60) {
        data = await fetchIntradayData(symbol, days, '15m');
    }

    // If intraday failed or need more days, use daily expanded
    if (data.length < days * 0.5) {
        console.log(`Falling back to daily data for ${symbol}`);
        const dailyData = await fetchDailyData(symbol, days);
        data = expandDailyToIntraday(dailyData);
    }

    // Cache the result
    if (data.length > 0) {
        dataCache.set(cacheKey, {
            data,
            expiry: Date.now() + CACHE_TTL
        });
    }

    return data;
}

/**
 * Clear the data cache
 */
export function clearDataCache(): void {
    dataCache.clear();
}

/**
 * Get cache status
 */
export function getCacheStatus(): { symbols: string[]; size: number } {
    return {
        symbols: Array.from(dataCache.keys()),
        size: dataCache.size
    };
}
