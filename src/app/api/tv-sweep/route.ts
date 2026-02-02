// TVDatafeed Parameter Sweep API
// Runs optimization with real 5-minute NSE data from TradingView

import { NextResponse } from 'next/server';
import { loadCombinedTVData, getTVDataSummary } from '@/lib/tvDataLoader';
import { OHLCV, getCurrentATR, calculateSMA } from '@/lib/indicators';
import { MarketRegime, determineRegime, getRegimePermissions } from '@/lib/regimeEngine';

// Constants
const INITIAL_CAPITAL = 100000;
const RISK_PER_TRADE = 0.01;
const SLIPPAGE_BPS = 5;
const BROKERAGE = 20;
const STT = 0.00025;

// Validation filters
const MAX_DD = 0.20;
const MIN_TRADES = 15;
const MIN_PF = 1.1;
const MIN_WIN = 0.40;

// Parameter grid
const ATR_DEVS = [0.8, 1.0, 1.2, 1.5, 2.0];
const WICK_RATIOS = [0.25, 0.35, 0.45];
const MAX_TRADES_PER_DAY = [1, 2];

interface Config {
    atrDev: number;
    wickRatio: number;
    maxTrades: number;
}

interface Result {
    config: Config;
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
}

// Signal detection with real 5-min data
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

    if (atr <= 0) return { signal: null, entry: 0, stop: 0, target: 0 };

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

// Run single configuration
function runConfig(config: Config, data: Map<string, OHLCV[][]>): Result {
    let totalTrades = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    const dailyPnl: number[] = [];

    for (const [, days] of data) {
        let tsd = 0;

        for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
            const dayCandles = days[dayIdx];
            if (dayCandles.length < 30) continue;

            while (dailyPnl.length <= dayIdx) dailyPnl.push(0);

            // Regime calculation from historical data
            const allCandles = days.slice(0, dayIdx + 1).flat();
            const recent = allCandles.slice(-200);
            if (recent.length >= 20) {
                const atr = getCurrentATR(recent, 20);
                const closes = recent.map(c => c.close);
                const ema5 = closes.slice(-5).reduce((a, b) => a + b) / 5;
                const ema20 = calculateSMA(closes, 20);
                if (atr > 0 && Math.abs(ema5 - ema20) > 0.7 * atr) {
                    tsd = Math.min(tsd + 1, 10);
                } else {
                    tsd = Math.max(0, tsd - 1);
                }
            }
            const regime = determineRegime(tsd);

            let dayTrades = 0;
            let dayPnl = 0;

            // Skip first 15 mins (3 candles of 5-min)
            for (let i = 3; i < dayCandles.length - 5; i++) {
                if (dayTrades >= config.maxTrades) break;

                const signal = detectSignal(dayCandles.slice(0, i + 1), regime, config.atrDev, config.wickRatio);
                if (!signal.signal) continue;

                const slip = signal.entry * (SLIPPAGE_BPS / 10000);
                const entry = signal.signal === 'LONG' ? signal.entry + slip : signal.entry - slip;
                const risk = Math.abs(signal.entry - signal.stop);
                if (risk <= 0) continue;

                const qty = Math.floor((INITIAL_CAPITAL * RISK_PER_TRADE) / risk);
                if (qty <= 0) continue;

                // Find exit
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

    const pnl = grossProfit - grossLoss;
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? pnl / totalTrades : 0;

    let peak = INITIAL_CAPITAL, dd = 0, equity = INITIAL_CAPITAL;
    for (const p of dailyPnl) {
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

    return { config, trades: totalTrades, wins, pnl, dd, pf, winRate, avgPnl, score, valid, reason };
}

export async function GET() {
    try {
        // Check data availability
        const summary = getTVDataSummary();
        if (!summary.available) {
            return NextResponse.json({
                error: 'TVDatafeed data not available',
                hint: 'Run: source .venv/bin/activate && python3 scripts/fetch_tv_data.py'
            }, { status: 404 });
        }

        console.log('Loading TVDatafeed data...');
        const startTime = Date.now();
        const data = loadCombinedTVData();

        if (data.size === 0) {
            return NextResponse.json({ error: 'No data loaded' }, { status: 500 });
        }

        // Generate configs
        const configs: Config[] = [];
        for (const atrDev of ATR_DEVS) {
            for (const wickRatio of WICK_RATIOS) {
                for (const maxTrades of MAX_TRADES_PER_DAY) {
                    configs.push({ atrDev, wickRatio, maxTrades });
                }
            }
        }

        console.log(`Running ${configs.length} configurations...`);

        // Run all configs
        const results: Result[] = [];
        for (const config of configs) {
            const result = runConfig(config, data);
            results.push(result);
        }

        // Sort by score
        results.sort((a, b) => b.score - a.score);
        const validResults = results.filter(r => r.valid);

        const duration = (Date.now() - startTime) / 1000;

        return NextResponse.json({
            status: 'success',
            dataSource: 'TVDatafeed (TradingView)',
            dataSummary: summary,
            duration: `${duration.toFixed(1)}s`,
            total: results.length,
            valid: validResults.length,
            results: results.slice(0, 20).map(r => ({
                atr: r.config.atrDev,
                wick: r.config.wickRatio,
                max: r.config.maxTrades,
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
                atrDeviation: validResults[0].config.atrDev,
                wickRatio: validResults[0].config.wickRatio,
                maxTradesPerDay: validResults[0].config.maxTrades,
                netPnl: Math.round(validResults[0].pnl),
                maxDrawdown: `${(validResults[0].dd * 100).toFixed(1)}%`,
                profitFactor: validResults[0].pf.toFixed(2),
                winRate: `${(validResults[0].winRate * 100).toFixed(0)}%`,
                riskAdjustedScore: validResults[0].score.toFixed(2)
            } : null,
            conclusion: validResults.length > 0
                ? `✅ Found ${validResults.length} valid configurations. Best: ATR=${validResults[0].config.atrDev} WICK=${validResults[0].config.wickRatio}`
                : `❌ No configurations passed all validation filters`
        });

    } catch (error) {
        console.error('TV Sweep error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
