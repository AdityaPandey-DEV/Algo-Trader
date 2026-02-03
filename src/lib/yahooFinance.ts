/**
 * Yahoo Finance API Integration
 * Uses yahoo-finance2 or a direct fetch to Yahoo's public endpoints
 * for backup market data when Upstox/Dhan are unavailable.
 */

// Yahoo Finance API endpoint for quotes
const YAHOO_API_BASE = 'https://query1.finance.yahoo.com/v7/finance/quote';

// Map NSE symbols to Yahoo Finance format (e.g., RELIANCE -> RELIANCE.NS)
function toYahooSymbol(symbol: string): string {
    return `${symbol}.NS`;
}

export interface YahooQuote {
    symbol: string;
    lastPrice: number;
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
    changePercent: number;
    volume: number;
}

/**
 * Fetch quotes from Yahoo Finance for a list of NSE symbols
 */
export async function fetchYahooQuotes(symbols: string[]): Promise<Record<string, YahooQuote>> {
    if (symbols.length === 0) return {};

    try {
        const yahooSymbols = symbols.map(toYahooSymbol).join(',');
        const url = `${YAHOO_API_BASE}?symbols=${yahooSymbols}`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(5000) // 5 second timeout
        });

        if (!response.ok) {
            console.error('Yahoo Finance API error:', response.statusText);
            return {};
        }

        const data = await response.json();
        const result: Record<string, YahooQuote> = {};

        if (data.quoteResponse?.result) {
            for (const quote of data.quoteResponse.result) {
                // Extract the original NSE symbol from Yahoo format
                const nseSymbol = quote.symbol.replace('.NS', '');

                result[nseSymbol] = {
                    symbol: nseSymbol,
                    lastPrice: quote.regularMarketPrice || 0,
                    open: quote.regularMarketOpen || 0,
                    high: quote.regularMarketDayHigh || 0,
                    low: quote.regularMarketDayLow || 0,
                    close: quote.regularMarketPreviousClose || 0,
                    change: quote.regularMarketChange || 0,
                    changePercent: quote.regularMarketChangePercent || 0,
                    volume: quote.regularMarketVolume || 0
                };
            }
        }

        return result;
    } catch (error) {
        console.error('Yahoo Finance fetch error:', error);
        return {};
    }
}

/**
 * Transform Yahoo quotes to the standard OHLCV format used by the trading engine
 */
export function transformYahooToOHLCV(yahooQuotes: Record<string, YahooQuote>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [symbol, quote] of Object.entries(yahooQuotes)) {
        result[symbol] = {
            symbol,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            close: quote.lastPrice, // Use lastPrice as current close
            volume: quote.volume,
            lastPrice: quote.lastPrice,
            change: quote.change,
            changePercent: quote.changePercent
        };
    }

    return result;
}
