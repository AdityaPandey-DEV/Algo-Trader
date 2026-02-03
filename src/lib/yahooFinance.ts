/**
 * Yahoo Finance API Integration using direct HTTP fetch
 * This approach works reliably in serverless environments like Vercel
 */

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

// Map NSE symbols to Yahoo Finance format (e.g., RELIANCE -> RELIANCE.NS)
function toYahooSymbol(symbol: string): string {
    return `${symbol}.NS`;
}

/**
 * Fetch a single quote from Yahoo Finance using the chart API
 */
async function fetchSingleQuote(yahooSymbol: string): Promise<YahooQuote | null> {
    try {
        // Use Yahoo's chart API which is more reliable
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            console.error(`Yahoo HTTP error for ${yahooSymbol}: ${response.status}`);
            return null;
        }

        const data = await response.json();

        if (!data.chart?.result?.[0]) {
            console.error(`Yahoo no data for ${yahooSymbol}`);
            return null;
        }

        const result = data.chart.result[0];
        const meta = result.meta;
        const quote = result.indicators?.quote?.[0];

        // Extract the original NSE symbol
        const nseSymbol = yahooSymbol.replace('.NS', '');

        return {
            symbol: nseSymbol,
            lastPrice: meta.regularMarketPrice || 0,
            open: meta.regularMarketDayOpen || meta.previousClose || 0,
            high: meta.regularMarketDayHigh || meta.regularMarketPrice || 0,
            low: meta.regularMarketDayLow || meta.regularMarketPrice || 0,
            close: meta.previousClose || 0,
            change: (meta.regularMarketPrice || 0) - (meta.previousClose || 0),
            changePercent: meta.previousClose
                ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100
                : 0,
            volume: meta.regularMarketVolume || 0
        };
    } catch (error) {
        console.error(`Yahoo Finance error for ${yahooSymbol}:`, error);
        return null;
    }
}

/**
 * Fetch quotes from Yahoo Finance for a list of NSE symbols
 */
export async function fetchYahooQuotes(symbols: string[]): Promise<Record<string, YahooQuote>> {
    if (symbols.length === 0) return {};

    const result: Record<string, YahooQuote> = {};

    try {
        const yahooSymbols = symbols.map(toYahooSymbol);

        // Fetch all quotes in parallel
        const quotePromises = yahooSymbols.map(fetchSingleQuote);
        const quotes = await Promise.all(quotePromises);

        for (const quote of quotes) {
            if (quote) {
                result[quote.symbol] = quote;
            }
        }

        console.log(`✅ Yahoo Finance: Fetched ${Object.keys(result).length}/${symbols.length} quotes`);

        // Log first price for debugging
        if (Object.keys(result).length > 0) {
            const firstSymbol = Object.keys(result)[0];
            console.log(`📊 Sample: ${firstSymbol} = ₹${result[firstSymbol].lastPrice}`);
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
