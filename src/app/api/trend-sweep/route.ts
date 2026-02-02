// Trend-Following Parameter Sweep API
// Tests pullback entries WITH the trend using real 5-min TVDatafeed data

import { NextResponse } from 'next/server';
import { loadCombinedTVData, getTVDataSummary } from '@/lib/tvDataLoader';
import { OHLCV, getCurrentATR } from '@/lib/indicators';
import { TrendConfig, generateTrendSignal } from '@/lib/trendStrategy';

// ============================================
// Constants
// ============================================

const INITIAL_CAPITAL = 100000;
const RISK_PER_TRADE = 0.005;  // 0.5% risk (reduced from 1%)
const SLIPPAGE_BPS = 5;
const BROKERAGE = 20;
const STT = 0.00025;

// Validation filters (RELAXED to find any edge)
const MAX_DD = 0.20;       // 20%
const MIN_TRADES = 15;     // Lower minimum
const MIN_PF = 1.0;        // Must be break-even
const MIN_WIN = 0.40;      // 40% win rate

// Parameter grid
const EMA_FAST = [5, 8, 13];
const EMA_SLOW = [20, 34, 50];
const PULLBACK_ATR = [0.5, 0.8, 1.0, 1.5];
const MAX_TRADES_PER_DAY = [1, 2];

// ============================================
// Types
// ============================================

interface Result {
    config: TrendConfig;
    trades: number;
    wins: number;
    pnl: number;
    dd: number;
    pf: number;
    winRate: number;
    avgPnl: number;
    avgWin: number;
    avgLoss: number;
    score: number;
    valid: boolean;
    reason?: string;
}

// ============================================
// Run Single Configuration
// ============================================

function runConfig(config: TrendConfig, data: Map<string, OHLCV[][]>): Result {
    let totalTrades = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    const dailyPnl: number[] = [];
    const allWins: number[] = [];
    const allLosses: number[] = [];

    for (const [, days] of data) {
        for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
            const dayCandles = days[dayIdx];
            if (dayCandles.length < config.emaSlow + 20) continue;

            while (dailyPnl.length <= dayIdx) dailyPnl.push(0);

            let dayTrades = 0;
            let dayPnl = 0;

            // Skip first 15 mins (3 candles)
            for (let i = config.emaSlow + 10; i < dayCandles.length - 10; i++) {
                if (dayTrades >= config.maxTrades) break;

                const candlesToNow = dayCandles.slice(0, i + 1);
                const signal = generateTrendSignal(candlesToNow, config);

                if (!signal.signal) continue;

                // Execute trade
                const slip = signal.entry * (SLIPPAGE_BPS / 10000);
                const entry = signal.signal === 'LONG' ? signal.entry + slip : signal.entry - slip;
                const risk = Math.abs(entry - signal.stop);
                if (risk <= 0) continue;

                const qty = Math.floor((INITIAL_CAPITAL * RISK_PER_TRADE) / risk);
                if (qty <= 0) continue;

                // Find exit using TRAILING STOP
                let exit = dayCandles[dayCandles.length - 1].close;
                let exitReason = 'EOD';
                let trailingStop = signal.stop;
                const trailAtr = risk * 0.8; // Use 80% of initial risk as trailing distance

                for (let j = i + 1; j < dayCandles.length; j++) {
                    const c = dayCandles[j];

                    if (signal.signal === 'LONG') {
                        // Move trailing stop up when price makes new highs
                        if (c.high > entry + trailAtr) {
                            const newStop = c.high - trailAtr * 1.2;
                            trailingStop = Math.max(trailingStop, newStop);
                        }

                        // Check if trailing stop hit
                        if (c.low <= trailingStop) {
                            exit = Math.max(trailingStop, c.open);
                            exitReason = 'TRAIL';
                            break;
                        }

                        // Check target hit
                        if (c.high >= signal.target) {
                            exit = signal.target - slip;
                            exitReason = 'TP';
                            break;
                        }
                    } else {
                        // Move trailing stop down when price makes new lows
                        if (c.low < entry - trailAtr) {
                            const newStop = c.low + trailAtr * 1.2;
                            trailingStop = Math.min(trailingStop, newStop);
                        }

                        // Check if trailing stop hit
                        if (c.high >= trailingStop) {
                            exit = Math.min(trailingStop, c.open);
                            exitReason = 'TRAIL';
                            break;
                        }

                        // Check target hit
                        if (c.low <= signal.target) {
                            exit = signal.target + slip;
                            exitReason = 'TP';
                            break;
                        }
                    }
                }

                const pnl = signal.signal === 'LONG'
                    ? (exit - entry) * qty
                    : (entry - exit) * qty;
                const costs = BROKERAGE * 2 + Math.abs(pnl) * STT;
                const net = pnl - costs;

                totalTrades++;
                dayTrades++;
                dayPnl += net;

                if (net > 0) {
                    wins++;
                    grossProfit += net;
                    allWins.push(net);
                } else {
                    grossLoss += Math.abs(net);
                    allLosses.push(Math.abs(net));
                }

                // Skip some candles to avoid overtrading same move
                i += 8;
            }

            dailyPnl[dayIdx] += dayPnl;
        }
    }

    // Calculate metrics
    const pnl = grossProfit - grossLoss;
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? pnl / totalTrades : 0;
    const avgWin = allWins.length > 0 ? allWins.reduce((a, b) => a + b, 0) / allWins.length : 0;
    const avgLoss = allLosses.length > 0 ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length : 0;

    // Calculate drawdown
    let peak = INITIAL_CAPITAL, dd = 0, equity = INITIAL_CAPITAL;
    for (const p of dailyPnl) {
        equity += p;
        peak = Math.max(peak, equity);
        dd = Math.max(dd, peak > 0 ? (peak - equity) / peak : 0);
    }

    const score = dd > 0 ? pnl / (dd * INITIAL_CAPITAL) : (pnl > 0 ? 999 : 0);

    // Validation
    let valid = true, reason: string | undefined;
    if (dd > MAX_DD) { valid = false; reason = `DD>${(MAX_DD * 100).toFixed(0)}%`; }
    else if (totalTrades < MIN_TRADES) { valid = false; reason = `Trades<${MIN_TRADES}`; }
    else if (pf < MIN_PF) { valid = false; reason = `PF<${MIN_PF}`; }
    else if (winRate < MIN_WIN) { valid = false; reason = `Win<${(MIN_WIN * 100).toFixed(0)}%`; }

    return {
        config,
        trades: totalTrades,
        wins,
        pnl,
        dd,
        pf,
        winRate,
        avgPnl,
        avgWin,
        avgLoss,
        score,
        valid,
        reason
    };
}

// ============================================
// API Handler
// ============================================

export async function GET() {
    try {
        const summary = getTVDataSummary();
        if (!summary.available) {
            return NextResponse.json({
                error: 'TVDatafeed data not available',
                hint: 'Run: source .venv/bin/activate && python3 scripts/fetch_tv_data.py'
            }, { status: 404 });
        }

        console.log('='.repeat(60));
        console.log('TREND-FOLLOWING PARAMETER SWEEP');
        console.log('='.repeat(60));

        const startTime = Date.now();
        const data = loadCombinedTVData();

        if (data.size === 0) {
            return NextResponse.json({ error: 'No data loaded' }, { status: 500 });
        }

        // Generate all configs
        const configs: TrendConfig[] = [];
        for (const emaFast of EMA_FAST) {
            for (const emaSlow of EMA_SLOW) {
                // Only valid combinations where fast < slow
                if (emaFast >= emaSlow) continue;

                for (const pullbackATR of PULLBACK_ATR) {
                    for (const maxTrades of MAX_TRADES_PER_DAY) {
                        configs.push({ emaFast, emaSlow, pullbackATR, maxTrades });
                    }
                }
            }
        }

        console.log(`Testing ${configs.length} configurations...`);

        // Run all configs
        const results: Result[] = [];
        for (let i = 0; i < configs.length; i++) {
            const result = runConfig(configs[i], data);
            results.push(result);
            console.log(`[${i + 1}/${configs.length}] EMA ${result.config.emaFast}/${result.config.emaSlow} PB=${result.config.pullbackATR} | Trades: ${result.trades} | PnL: ₹${result.pnl.toFixed(0)} | Win: ${(result.winRate * 100).toFixed(0)}% | Valid: ${result.valid ? '✓' : '✗'}`);
        }

        // Sort by score
        results.sort((a, b) => b.score - a.score);
        const validResults = results.filter(r => r.valid);

        const duration = (Date.now() - startTime) / 1000;

        console.log('='.repeat(60));
        console.log(`Valid: ${validResults.length}/${results.length}`);
        if (validResults.length > 0) {
            const best = validResults[0];
            console.log(`BEST: EMA ${best.config.emaFast}/${best.config.emaSlow} PB=${best.config.pullbackATR}`);
            console.log(`  PnL: ₹${best.pnl.toFixed(0)} | DD: ${(best.dd * 100).toFixed(1)}% | PF: ${best.pf.toFixed(2)} | Win: ${(best.winRate * 100).toFixed(0)}%`);
        }

        return NextResponse.json({
            status: 'success',
            strategy: 'TREND-FOLLOWING PULLBACK',
            dataSource: 'TVDatafeed (TradingView)',
            dataSummary: summary,
            duration: `${duration.toFixed(1)}s`,
            total: results.length,
            valid: validResults.length,
            results: results.slice(0, 25).map(r => ({
                emaFast: r.config.emaFast,
                emaSlow: r.config.emaSlow,
                pullback: r.config.pullbackATR,
                maxTrades: r.config.maxTrades,
                trades: r.trades,
                pnl: Math.round(r.pnl),
                dd: `${(r.dd * 100).toFixed(1)}%`,
                pf: r.pf.toFixed(2),
                win: `${(r.winRate * 100).toFixed(0)}%`,
                avgPnl: Math.round(r.avgPnl),
                avgWin: Math.round(r.avgWin),
                avgLoss: Math.round(r.avgLoss),
                score: r.score.toFixed(2),
                valid: r.valid,
                reason: r.reason
            })),
            bestConfig: validResults.length > 0 ? {
                emaFast: validResults[0].config.emaFast,
                emaSlow: validResults[0].config.emaSlow,
                pullbackATR: validResults[0].config.pullbackATR,
                maxTradesPerDay: validResults[0].config.maxTrades,
                metrics: {
                    netPnl: Math.round(validResults[0].pnl),
                    maxDrawdown: `${(validResults[0].dd * 100).toFixed(1)}%`,
                    profitFactor: validResults[0].pf.toFixed(2),
                    winRate: `${(validResults[0].winRate * 100).toFixed(0)}%`,
                    totalTrades: validResults[0].trades,
                    avgWin: Math.round(validResults[0].avgWin),
                    avgLoss: Math.round(validResults[0].avgLoss),
                    riskAdjustedScore: validResults[0].score.toFixed(2)
                },
                readyForPaperTrading: validResults[0].pf >= 1.3 && validResults[0].winRate >= 0.48
            } : null,
            conclusion: validResults.length > 0
                ? `✅ Found ${validResults.length} valid configurations! Best: EMA ${validResults[0].config.emaFast}/${validResults[0].config.emaSlow} with ${validResults[0].pf.toFixed(2)} profit factor`
                : `❌ No configurations passed all validation filters`
        });

    } catch (error) {
        console.error('Trend sweep error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
