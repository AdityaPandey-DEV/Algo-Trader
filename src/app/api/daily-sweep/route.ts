// Daily Data Sweep - 20 Year Validation (2005-2026)
// Tests trend-following strategy on daily timeframe - CHUNKED PROCESSING

import { NextResponse } from 'next/server';
import { loadAllDailyData, getTVDailySummary } from '@/lib/tvDailyLoader';
import { OHLCV, getCurrentATR } from '@/lib/indicators';
import { calculateEMA } from '@/lib/trendStrategy';

// ============================================
// Constants
// ============================================

const INITIAL_CAPITAL = 100000;
const RISK_PER_TRADE = 0.01;
const SLIPPAGE_PCT = 0.001;
const BROKERAGE = 50;
const STT = 0.001;

// Validation filters
const MAX_DD = 0.25;
const MIN_TRADES = 50;
const MIN_PF = 1.1;
const MIN_WIN = 0.40;

// Parameters - Keep existing structure
const EMA_FAST = [13, 21];
const EMA_SLOW = [34, 55];
const PULLBACK_ATR = [1.5, 2.0, 2.5];
const MAX_TRADES_PER_WEEK = [2];

// Chunk size for processing
const CHUNK_SIZE = 100;

// ============================================
// Types
// ============================================

interface TrendConfig {
    emaFast: number;
    emaSlow: number;
    pullbackATR: number;
    maxTradesWeek: number;
}

interface ChunkResult {
    trades: number;
    wins: number;
    grossProfit: number;
    grossLoss: number;
    pnl: number;
}

interface Result {
    config: TrendConfig;
    trades: number;
    wins: number;
    pnl: number;
    dd: number;
    pf: number;
    winRate: number;
    avgPnl: number;
    score: number;
    valid: boolean;
    reason?: string;
    yearlyPnl: Record<string, number>;
}

// ============================================
// Signal Generation (unchanged logic)
// ============================================

function getSwingHigh(candles: OHLCV[], lookback: number): number {
    return Math.max(...candles.slice(-lookback).map(c => c.high));
}

function getSwingLow(candles: OHLCV[], lookback: number): number {
    return Math.min(...candles.slice(-lookback).map(c => c.low));
}

function detectTrendAndPullback(
    candles: OHLCV[],
    config: TrendConfig
): { trend: 'UP' | 'DOWN' | 'NEUTRAL'; isPullback: boolean } {
    if (candles.length < config.emaSlow + 10) {
        return { trend: 'NEUTRAL', isPullback: false };
    }

    const closes = candles.map(c => c.close);
    const fast = calculateEMA(closes, config.emaFast);
    const slow = calculateEMA(closes, config.emaSlow);
    const threshold = slow * 0.002;

    let trend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (fast > slow + threshold) trend = 'UP';
    else if (fast < slow - threshold) trend = 'DOWN';

    if (trend === 'NEUTRAL') return { trend, isPullback: false };

    // Pullback detection
    const atr = getCurrentATR(candles, 14);
    const current = candles[candles.length - 1].close;
    const required = config.pullbackATR * atr;

    let isPullback = false;
    if (trend === 'UP') {
        const swingHigh = getSwingHigh(candles, 20);
        isPullback = (swingHigh - current) >= required;
    } else {
        const swingLow = getSwingLow(candles, 20);
        isPullback = (current - swingLow) >= required;
    }

    return { trend, isPullback };
}

// ============================================
// Process One 100-Day Chunk
// ============================================

function processChunk(
    chunk: OHLCV[],
    config: TrendConfig,
    prevCandles: OHLCV[]
): ChunkResult {
    let trades = 0, wins = 0, grossProfit = 0, grossLoss = 0, pnl = 0;

    // Combine previous candles for indicator lookback
    const fullData = [...prevCandles, ...chunk];
    const startIdx = prevCandles.length;

    let weekTrades = 0;
    let lastTradeWeek = -1;

    for (let i = Math.max(startIdx, config.emaSlow + 30); i < fullData.length - 5; i++) {
        const currentWeek = Math.floor(i / 5);
        if (currentWeek !== lastTradeWeek) {
            weekTrades = 0;
            lastTradeWeek = currentWeek;
        }

        if (weekTrades >= config.maxTradesWeek) continue;

        const lookback = fullData.slice(Math.max(0, i - 60), i + 1);
        const { trend, isPullback } = detectTrendAndPullback(lookback, config);

        if (trend === 'NEUTRAL' || !isPullback) continue;

        // Confirmation candle
        const lastCandle = fullData[i];
        if (trend === 'UP' && lastCandle.close <= lastCandle.open) continue;
        if (trend === 'DOWN' && lastCandle.close >= lastCandle.open) continue;

        // Execute trade
        const entry = lastCandle.close;
        const slip = entry * SLIPPAGE_PCT;
        const entryPrice = trend === 'UP' ? entry + slip : entry - slip;

        const atr = getCurrentATR(lookback, 14);
        const stop = trend === 'UP'
            ? getSwingLow(lookback, 10) - atr * 0.5
            : getSwingHigh(lookback, 10) + atr * 0.5;

        const risk = Math.abs(entryPrice - stop);
        if (risk <= 0) continue;

        const qty = Math.floor((INITIAL_CAPITAL * RISK_PER_TRADE) / risk);
        if (qty <= 0) continue;

        // Find exit with trailing stop
        let exit = fullData[fullData.length - 1].close;
        let trailingStop = stop;
        const trailDist = atr * 1.5;

        for (let j = i + 1; j < Math.min(i + 20, fullData.length); j++) {
            const c = fullData[j];

            if (trend === 'UP') {
                if (c.high > entryPrice + trailDist) {
                    trailingStop = Math.max(trailingStop, c.high - trailDist);
                }
                if (c.low <= trailingStop) {
                    exit = Math.max(trailingStop, c.open) - slip;
                    break;
                }
            } else {
                if (c.low < entryPrice - trailDist) {
                    trailingStop = Math.min(trailingStop, c.low + trailDist);
                }
                if (c.high >= trailingStop) {
                    exit = Math.min(trailingStop, c.open) + slip;
                    break;
                }
            }
        }

        const tradePnl = trend === 'UP'
            ? (exit - entryPrice) * qty
            : (entryPrice - exit) * qty;
        const costs = BROKERAGE * 2 + Math.abs(tradePnl) * STT;
        const net = tradePnl - costs;

        trades++;
        weekTrades++;
        pnl += net;

        if (net > 0) {
            wins++;
            grossProfit += net;
        } else {
            grossLoss += Math.abs(net);
        }

        i += 4; // Skip a week
    }

    return { trades, wins, grossProfit, grossLoss, pnl };
}

// ============================================
// Run Config with Chunked Processing
// ============================================

function runConfigChunked(config: TrendConfig, data: Map<string, OHLCV[]>): Result {
    let totalTrades = 0;
    let totalWins = 0;
    let totalGrossProfit = 0;
    let totalGrossLoss = 0;
    const yearlyPnl: Record<string, number> = {};
    const allPnl: number[] = [];

    for (const [, candles] of data) {
        if (candles.length < config.emaSlow + 50) continue;

        // Process in 100-day chunks
        for (let start = 0; start < candles.length; start += CHUNK_SIZE) {
            const chunk = candles.slice(start, start + CHUNK_SIZE);
            const prevCandles = candles.slice(Math.max(0, start - 60), start);

            const result = processChunk(chunk, config, prevCandles);

            totalTrades += result.trades;
            totalWins += result.wins;
            totalGrossProfit += result.grossProfit;
            totalGrossLoss += result.grossLoss;
            allPnl.push(result.pnl);

            // Track yearly PnL
            if (chunk.length > 0 && chunk[0].timestamp) {
                const ts = chunk[0].timestamp;
                const year = (ts instanceof Date ? ts : new Date(ts)).getFullYear().toString();
                yearlyPnl[year] = (yearlyPnl[year] || 0) + result.pnl;
            }
        }
    }

    const pnl = totalGrossProfit - totalGrossLoss;
    const pf = totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : (totalGrossProfit > 0 ? 999 : 0);
    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? pnl / totalTrades : 0;

    // Calculate drawdown from chunk PnLs
    let peak = INITIAL_CAPITAL, dd = 0, equity = INITIAL_CAPITAL;
    for (const p of allPnl) {
        equity += p;
        peak = Math.max(peak, equity);
        dd = Math.max(dd, peak > 0 ? (peak - equity) / peak : 0);
    }

    const score = dd > 0 ? pnl / (dd * INITIAL_CAPITAL) : (pnl > 0 ? 999 : 0);

    let valid = true, reason: string | undefined;
    if (dd > MAX_DD) { valid = false; reason = `DD>${(MAX_DD * 100).toFixed(0)}%`; }
    else if (totalTrades < MIN_TRADES) { valid = false; reason = `Trades<${MIN_TRADES}`; }
    else if (pf < MIN_PF) { valid = false; reason = `PF<${MIN_PF}`; }
    else if (winRate < MIN_WIN) { valid = false; reason = `Win<${(MIN_WIN * 100).toFixed(0)}%`; }

    return {
        config,
        trades: totalTrades,
        wins: totalWins,
        pnl,
        dd,
        pf,
        winRate,
        avgPnl,
        score,
        valid,
        reason,
        yearlyPnl
    };
}

// ============================================
// API Handler
// ============================================

export async function GET() {
    try {
        const summary = getTVDailySummary();
        if (!summary.available) {
            return NextResponse.json({
                error: 'Daily data not available',
                hint: 'Run: python3 scripts/fetch_tv_daily.py'
            }, { status: 404 });
        }

        console.log('='.repeat(70));
        console.log('DAILY SWEEP - 20 YEAR VALIDATION (100-DAY CHUNKS)');
        console.log('='.repeat(70));

        const startTime = Date.now();
        const data = loadAllDailyData();

        if (data.size === 0) {
            return NextResponse.json({ error: 'No data loaded' }, { status: 500 });
        }

        // Generate configs
        const configs: TrendConfig[] = [];
        for (const emaFast of EMA_FAST) {
            for (const emaSlow of EMA_SLOW) {
                if (emaFast >= emaSlow - 5) continue;
                for (const pullbackATR of PULLBACK_ATR) {
                    for (const maxTradesWeek of MAX_TRADES_PER_WEEK) {
                        configs.push({ emaFast, emaSlow, pullbackATR, maxTradesWeek });
                    }
                }
            }
        }

        console.log(`Testing ${configs.length} configurations with chunked processing...`);

        const results: Result[] = [];
        for (const config of configs) {
            const result = runConfigChunked(config, data);
            results.push(result);
            console.log(`EMA ${config.emaFast}/${config.emaSlow} PB=${config.pullbackATR} | Trades: ${result.trades} | PnL: ₹${result.pnl.toFixed(0)} | Valid: ${result.valid ? '✓' : '✗'}`);
        }

        results.sort((a, b) => b.score - a.score);
        const validResults = results.filter(r => r.valid);

        const duration = (Date.now() - startTime) / 1000;

        return NextResponse.json({
            status: 'success',
            strategy: 'TREND-FOLLOWING DAILY (CHUNKED)',
            dataSource: 'TVDatafeed Daily (2005-2026)',
            dataSummary: summary,
            duration: `${duration.toFixed(1)}s`,
            total: results.length,
            valid: validResults.length,

            results: results.slice(0, 15).map(r => ({
                ema: `${r.config.emaFast}/${r.config.emaSlow}`,
                pb: r.config.pullbackATR,
                maxWeek: r.config.maxTradesWeek,
                trades: r.trades,
                pnl: Math.round(r.pnl),
                dd: `${(r.dd * 100).toFixed(1)}%`,
                pf: r.pf.toFixed(2),
                win: `${(r.winRate * 100).toFixed(0)}%`,
                avgPnl: Math.round(r.avgPnl),
                score: r.score.toFixed(2),
                valid: r.valid,
                reason: r.reason
            })),

            bestConfig: validResults.length > 0 ? {
                emaFast: validResults[0].config.emaFast,
                emaSlow: validResults[0].config.emaSlow,
                pullbackATR: validResults[0].config.pullbackATR,
                maxTradesWeek: validResults[0].config.maxTradesWeek,
                metrics: {
                    netPnl: Math.round(validResults[0].pnl),
                    maxDrawdown: `${(validResults[0].dd * 100).toFixed(1)}%`,
                    profitFactor: validResults[0].pf.toFixed(2),
                    winRate: `${(validResults[0].winRate * 100).toFixed(0)}%`,
                    totalTrades: validResults[0].trades,
                    avgPnl: Math.round(validResults[0].avgPnl)
                },
                yearlyPerformance: validResults[0].yearlyPnl
            } : null,

            conclusion: validResults.length > 0
                ? `✅ Found ${validResults.length} valid configurations on 20 years of daily data!`
                : `❌ No valid configurations found on daily timeframe`
        });

    } catch (error) {
        console.error('Daily sweep error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
