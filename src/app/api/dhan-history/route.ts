// Dhan Historical Data API Endpoint
// Tests Dhan data access and runs parameter sweep with real 5-min data

import { NextResponse } from 'next/server';
import {
    isDhanConfigured,
    checkDhanHistoricalAccess,
    fetchDhanDailyHistory,
    fetchDhanIntradayHistory,
    getAvailableSymbols,
    DhanOHLCV
} from '@/lib/dhanApi';
import { OHLCV, getCurrentATR, calculateSMA } from '@/lib/indicators';
import { MarketRegime, determineRegime, getRegimePermissions } from '@/lib/regimeEngine';

// ============================================
// Constants
// ============================================

const INITIAL_CAPITAL = 100000;
const RISK_PER_TRADE = 0.01;
const SLIPPAGE_BPS = 5;
const BROKERAGE = 20;
const STT = 0.00025;

// Validation filters
const MAX_DD = 0.20;
const MIN_TRADES = 10;
const MIN_PF = 1.0;
const MIN_WIN = 0.35;

// Parameters to sweep
const ATR_DEVS = [0.8, 1.0, 1.2, 1.5];
const WICK_RATIOS = [0.3, 0.4, 0.5];
const MAX_TRADES = [1, 2];

// ============================================
// Types
// ============================================

interface SweepConfig {
    atrDev: number;
    wickRatio: number;
    maxTrades: number;
}

interface SweepResult {
    config: SweepConfig;
    trades: number;
    wins: number;
    pnl: number;
    dd: number;
    pf: number;
    winRate: number;
    score: number;
    valid: boolean;
    reason?: string;
}

// ============================================
// Convert Dhan to OHLCV
// ============================================

function toOHLCV(candle: DhanOHLCV): OHLCV {
    return {
        symbol: candle.symbol,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        timestamp: candle.timestamp
    };
}

// ============================================
// Signal Detection (Intraday)
// ============================================

function detectSignal(
    candles: OHLCV[],
    regime: MarketRegime,
    atrDev: number,
    wickRatio: number
): { signal: 'LONG' | 'SHORT' | null; entry: number; stop: number; target: number } {
    if (candles.length < 20) return { signal: null, entry: 0, stop: 0, target: 0 };

    const perms = getRegimePermissions(regime);
    if (!perms.allowMeanReversion) return { signal: null, entry: 0, stop: 0, target: 0 };

    const closes = candles.map(c => c.close);
    const sma = calculateSMA(closes, 20);
    const atr = getCurrentATR(candles, 14);
    const last = candles[candles.length - 1];

    const dev = Math.abs(last.close - sma) / atr;
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const wick = range > 0 ? (range - body) / range : 0;

    if (dev < atrDev || wick < wickRatio) return { signal: null, entry: 0, stop: 0, target: 0 };

    if (last.close < sma) {
        return { signal: 'LONG', entry: last.close, stop: last.low - atr * 0.5, target: sma };
    } else {
        return { signal: 'SHORT', entry: last.close, stop: last.high + atr * 0.5, target: sma };
    }
}

// ============================================
// Run Sweep with Dhan Data
// ============================================

async function runDhanSweep(symbols: string[]): Promise<SweepResult[]> {
    const results: SweepResult[] = [];

    // Fetch intraday data for all symbols
    console.log('Fetching Dhan intraday data...');
    const allData: Map<string, OHLCV[][]> = new Map();

    for (const symbol of symbols) {
        const intradayRaw = await fetchDhanIntradayHistory(symbol, 30, '5');
        if (intradayRaw.length > 0) {
            const converted = intradayRaw.map(day => day.map(toOHLCV));
            allData.set(symbol, converted);
        }
    }

    if (allData.size === 0) {
        console.log('No Dhan data available');
        return [];
    }

    console.log(`Loaded ${allData.size} symbols with intraday data`);

    // Generate all configs
    const configs: SweepConfig[] = [];
    for (const atrDev of ATR_DEVS) {
        for (const wickRatio of WICK_RATIOS) {
            for (const maxTrades of MAX_TRADES) {
                configs.push({ atrDev, wickRatio, maxTrades });
            }
        }
    }

    // Run each config
    for (const config of configs) {
        let totalTrades = 0;
        let wins = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        const dailyPnl: number[] = [];

        for (const [, days] of allData) {
            let tsd = 0;

            for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
                const dayCandles = days[dayIdx];
                while (dailyPnl.length <= dayIdx) dailyPnl.push(0);

                // Regime calculation
                const allCandles = days.slice(0, dayIdx + 1).flat();
                const recent = allCandles.slice(-200);
                if (recent.length >= 20) {
                    const atr = getCurrentATR(recent, 20);
                    const closes = recent.map(c => c.close);
                    const ema5 = closes.slice(-5).reduce((a, b) => a + b) / 5;
                    const ema20 = calculateSMA(closes, 20);
                    if (Math.abs(ema5 - ema20) > 0.7 * atr) tsd = Math.min(tsd + 1, 10);
                    else tsd = Math.max(0, tsd - 1);
                }
                const regime = determineRegime(tsd);

                let dayTrades = 0;
                let dayPnl = 0;

                // Skip first 3 candles (~15 min)
                for (let i = 3; i < dayCandles.length - 5; i++) {
                    if (dayTrades >= config.maxTrades) break;

                    const signal = detectSignal(dayCandles.slice(0, i + 1), regime, config.atrDev, config.wickRatio);
                    if (!signal.signal) continue;

                    const slip = signal.entry * (SLIPPAGE_BPS / 10000);
                    const entry = signal.signal === 'LONG' ? signal.entry + slip : signal.entry - slip;
                    const risk = Math.abs(signal.entry - signal.stop);
                    const qty = Math.floor((INITIAL_CAPITAL * RISK_PER_TRADE) / risk);
                    if (qty <= 0) continue;

                    let exit = dayCandles[dayCandles.length - 1].close;
                    for (let j = i + 1; j < dayCandles.length; j++) {
                        const c = dayCandles[j];
                        if (signal.signal === 'LONG') {
                            if (c.low <= signal.stop) { exit = signal.stop - slip; break; }
                            if (c.high >= signal.target) { exit = signal.target - slip; break; }
                        } else {
                            if (c.high >= signal.stop) { exit = signal.stop + slip; break; }
                            if (c.low <= signal.target) { exit = signal.target + slip; break; }
                        }
                    }

                    const pnl = signal.signal === 'LONG' ? (exit - entry) * qty : (entry - exit) * qty;
                    const costs = BROKERAGE * 2 + Math.abs(pnl) * STT;
                    const net = pnl - costs;

                    totalTrades++;
                    dayTrades++;
                    dayPnl += net;

                    if (net > 0) { wins++; grossProfit += net; }
                    else grossLoss += Math.abs(net);

                    i += 5; // Skip to next window
                }

                dailyPnl[dayIdx] += dayPnl;
            }
        }

        // Calculate metrics
        const pnl = grossProfit - grossLoss;
        const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;

        let peak = INITIAL_CAPITAL, dd = 0, equity = INITIAL_CAPITAL;
        for (const p of dailyPnl) {
            equity += p;
            peak = Math.max(peak, equity);
            dd = Math.max(dd, (peak - equity) / peak);
        }

        const score = dd > 0 ? pnl / (dd * INITIAL_CAPITAL) : (pnl > 0 ? 999 : 0);

        let valid = true, reason: string | undefined;
        if (dd > MAX_DD) { valid = false; reason = `DD>${(MAX_DD * 100)}%`; }
        else if (totalTrades < MIN_TRADES) { valid = false; reason = `Trades<${MIN_TRADES}`; }
        else if (pf < MIN_PF) { valid = false; reason = `PF<${MIN_PF}`; }
        else if (winRate < MIN_WIN) { valid = false; reason = `Win<${(MIN_WIN * 100)}%`; }

        results.push({
            config,
            trades: totalTrades,
            wins,
            pnl,
            dd,
            pf,
            winRate,
            score,
            valid,
            reason
        });
    }

    return results.sort((a, b) => b.score - a.score);
}

// ============================================
// API Handler
// ============================================

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const action = searchParams.get('action') || 'check';

        if (action === 'check') {
            // Check Dhan access
            const status = await checkDhanHistoricalAccess();
            const symbols = getAvailableSymbols();

            return NextResponse.json({
                status: isDhanConfigured() ? 'configured' : 'not_configured',
                ...status,
                symbols: symbols.map(s => s.symbol)
            });
        }

        if (action === 'sweep') {
            // Run parameter sweep
            console.log('Starting Dhan parameter sweep...');
            const startTime = Date.now();

            const symbols = getAvailableSymbols().slice(0, 10).map(s => s.symbol);
            const results = await runDhanSweep(symbols);

            const duration = (Date.now() - startTime) / 1000;
            const validResults = results.filter(r => r.valid);

            return NextResponse.json({
                status: 'success',
                duration: `${duration.toFixed(1)}s`,
                total: results.length,
                valid: validResults.length,
                results: results.slice(0, 15).map(r => ({
                    atr: r.config.atrDev,
                    wick: r.config.wickRatio,
                    max: r.config.maxTrades,
                    trades: r.trades,
                    pnl: Math.round(r.pnl),
                    dd: `${(r.dd * 100).toFixed(1)}%`,
                    pf: r.pf.toFixed(2),
                    win: `${(r.winRate * 100).toFixed(0)}%`,
                    score: r.score.toFixed(2),
                    valid: r.valid,
                    reason: r.reason
                })),
                best: validResults.length > 0 ? {
                    atr: validResults[0].config.atrDev,
                    wick: validResults[0].config.wickRatio,
                    max: validResults[0].config.maxTrades,
                    score: validResults[0].score.toFixed(2)
                } : null
            });
        }

        if (action === 'sample') {
            // Get sample data for one symbol
            const symbol = searchParams.get('symbol') || 'RELIANCE';
            const daily = await fetchDhanDailyHistory(symbol, 10);
            const intraday = await fetchDhanIntradayHistory(symbol, 5, '5');

            return NextResponse.json({
                symbol,
                daily: {
                    count: daily.length,
                    sample: daily.slice(-5)
                },
                intraday: {
                    days: intraday.length,
                    candlesPerDay: intraday[0]?.length || 0,
                    sample: intraday[0]?.slice(0, 5) || []
                }
            });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    } catch (error) {
        console.error('Dhan history error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
