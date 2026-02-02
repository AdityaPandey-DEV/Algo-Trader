// TradingView Data Loader
// Loads 5-minute NSE data exported from TVDatafeed

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { OHLCV } from './indicators';

const TV_DATA_DIR = join(process.cwd(), 'data', 'tv_data');

interface TVCandle {
    symbol: string;
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface TVSymbolData {
    symbol: string;
    days: Record<string, TVCandle[]>;
}

/**
 * Check if TVDatafeed data is available
 */
export function isTVDataAvailable(): boolean {
    const summaryPath = join(TV_DATA_DIR, 'summary.json');
    return existsSync(summaryPath);
}

/**
 * Get TVDatafeed data summary
 */
export function getTVDataSummary(): {
    available: boolean;
    symbols: string[];
    totalCandles: number;
    totalDays: number;
    fetchedAt: string | null;
} {
    if (!isTVDataAvailable()) {
        return {
            available: false,
            symbols: [],
            totalCandles: 0,
            totalDays: 0,
            fetchedAt: null
        };
    }

    try {
        const summaryPath = join(TV_DATA_DIR, 'summary.json');
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        return {
            available: true,
            symbols: Object.keys(summary.symbols || {}),
            totalCandles: summary.total_candles || 0,
            totalDays: summary.total_days || 0,
            fetchedAt: summary.fetched_at || null
        };
    } catch {
        return {
            available: false,
            symbols: [],
            totalCandles: 0,
            totalDays: 0,
            fetchedAt: null
        };
    }
}

/**
 * Load 5-minute data for a specific symbol
 */
export function loadTVSymbolData(symbol: string): OHLCV[][] {
    const filePath = join(TV_DATA_DIR, `${symbol}.json`);

    if (!existsSync(filePath)) {
        console.log(`No TVDatafeed data for ${symbol}`);
        return [];
    }

    try {
        const rawData: TVSymbolData = JSON.parse(readFileSync(filePath, 'utf-8'));

        // Convert each day's candles to OHLCV format
        const days: OHLCV[][] = [];
        const sortedDays = Object.keys(rawData.days).sort();

        for (const dayKey of sortedDays) {
            const dayCandles = rawData.days[dayKey];

            // Only include complete trading days (at least 70 candles = 5.8 hours)
            if (dayCandles.length >= 70) {
                const ohlcvCandles: OHLCV[] = dayCandles.map(c => ({
                    symbol: c.symbol,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume,
                    timestamp: new Date(c.timestamp)
                }));

                days.push(ohlcvCandles);
            }
        }

        console.log(`Loaded ${days.length} trading days for ${symbol} from TVDatafeed`);
        return days;

    } catch (error) {
        console.error(`Error loading TVDatafeed data for ${symbol}:`, error);
        return [];
    }
}

/**
 * Load all symbols from TVDatafeed
 */
export function loadAllTVData(): Map<string, OHLCV[][]> {
    const data = new Map<string, OHLCV[][]>();
    const summary = getTVDataSummary();

    if (!summary.available) {
        console.log('TVDatafeed data not available');
        return data;
    }

    for (const symbol of summary.symbols) {
        const symbolData = loadTVSymbolData(symbol);
        if (symbolData.length > 0) {
            data.set(symbol, symbolData);
        }
    }

    console.log(`Loaded TVDatafeed data for ${data.size} symbols`);
    return data;
}

/**
 * Load combined data file (all symbols in one file)
 */
export function loadCombinedTVData(): Map<string, OHLCV[][]> {
    const filePath = join(TV_DATA_DIR, 'all_symbols.json');
    const data = new Map<string, OHLCV[][]>();

    if (!existsSync(filePath)) {
        return loadAllTVData(); // Fallback to individual files
    }

    try {
        const rawData: Record<string, Record<string, TVCandle[]>> =
            JSON.parse(readFileSync(filePath, 'utf-8'));

        for (const [symbol, daysData] of Object.entries(rawData)) {
            const days: OHLCV[][] = [];
            const sortedDays = Object.keys(daysData).sort();

            for (const dayKey of sortedDays) {
                const dayCandles = daysData[dayKey];

                if (dayCandles.length >= 70) {
                    const ohlcvCandles: OHLCV[] = dayCandles.map(c => ({
                        symbol: c.symbol,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                        volume: c.volume,
                        timestamp: new Date(c.timestamp)
                    }));

                    days.push(ohlcvCandles);
                }
            }

            if (days.length > 0) {
                data.set(symbol, days);
            }
        }

        console.log(`Loaded combined TVDatafeed data: ${data.size} symbols`);
        return data;

    } catch (error) {
        console.error('Error loading combined TVDatafeed data:', error);
        return loadAllTVData();
    }
}
