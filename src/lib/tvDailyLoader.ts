// Daily Data Loader for Extended Historical Testing
// Loads TVDatafeed DAILY data (2005-2026, 20 years)

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { OHLCV } from './indicators';

const TV_DAILY_DIR = join(process.cwd(), 'data', 'tv_data_daily');

interface DailySummary {
    available: boolean;
    symbols: string[];
    totalCandles: number;
    interval: string;
    fetchedAt?: string;
}

interface SymbolData {
    symbol: string;
    candles: Array<{
        symbol: string;
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
}

export function getTVDailySummary(): DailySummary {
    const summaryPath = join(TV_DAILY_DIR, 'summary.json');

    if (!existsSync(summaryPath)) {
        return { available: false, symbols: [], totalCandles: 0, interval: 'daily' };
    }

    try {
        const data = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        return {
            available: true,
            symbols: Object.keys(data.symbols || {}),
            totalCandles: data.total_candles || 0,
            interval: data.interval || 'daily',
            fetchedAt: data.fetched_at
        };
    } catch {
        return { available: false, symbols: [], totalCandles: 0, interval: 'daily' };
    }
}

export function loadDailySymbolData(symbol: string): OHLCV[] {
    const filePath = join(TV_DAILY_DIR, `${symbol}.json`);

    if (!existsSync(filePath)) {
        console.log(`No daily data found for ${symbol}`);
        return [];
    }

    try {
        const rawData: SymbolData = JSON.parse(readFileSync(filePath, 'utf-8'));

        return rawData.candles.map(c => ({
            symbol: c.symbol,
            timestamp: new Date(c.timestamp),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
        }));
    } catch (error) {
        console.error(`Error loading daily data for ${symbol}:`, error);
        return [];
    }
}

export function loadAllDailyData(): Map<string, OHLCV[]> {
    const data = new Map<string, OHLCV[]>();

    if (!existsSync(TV_DAILY_DIR)) {
        console.log('Daily data directory not found');
        return data;
    }

    const files = readdirSync(TV_DAILY_DIR).filter(f =>
        f.endsWith('.json') && f !== 'summary.json'
    );

    for (const file of files) {
        const symbol = file.replace('.json', '');
        const candles = loadDailySymbolData(symbol);
        if (candles.length > 0) {
            data.set(symbol, candles);
        }
    }

    return data;
}

// Split data by year for year-over-year validation
export function splitDataByYear(candles: OHLCV[]): Map<number, OHLCV[]> {
    const byYear = new Map<number, OHLCV[]>();

    for (const candle of candles) {
        const ts = candle.timestamp;
        if (!ts) continue;
        const year = (ts instanceof Date ? ts : new Date(ts)).getFullYear();
        if (!byYear.has(year)) {
            byYear.set(year, []);
        }
        byYear.get(year)!.push(candle);
    }

    return byYear;
}
