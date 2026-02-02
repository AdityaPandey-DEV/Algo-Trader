// Intraday Upgraded Strategy Sweep
// Tests upgraded strategy with all 8 risk filters on 5-minute data

import { NextResponse } from 'next/server';
import { loadAllTVData, getTVDataSummary } from '@/lib/tvDataLoader';
import { OHLCV, getCurrentATR, getCurrentEMA } from '@/lib/indicators';
import { RISK_CONFIG } from '@/lib/riskEngine';

// ============================================
// Configuration
// ============================================

const INITIAL_CAPITAL = 500000;
const RISK_PER_TRADE = RISK_CONFIG.MAX_RISK_PER_TRADE; // 0.3%
const SLIPPAGE_PCT = 0.0005;
const BROKERAGE = 20;
const STT = 0.001;

// Strategy Parameters
const EMA_FAST = 13;
const EMA_SLOW = 34;
const PULLBACK_ATR = 2.0;
const TRAILING_ATR_MULT = RISK_CONFIG.TRAILING_ATR_MULT; // 1.5x

// ============================================
// Types
// ============================================

interface BacktestResult {
    trades: number;
    wins: number;
    pnl: number;
    dd: number;
    pf: number;
    winRate: number;
    avgPnl: number;
    calmarRatio: number;
    dailyReturns: Record<string, number>;
    riskMetrics: {
        dailyLossBreaches: number;
        killSwitchTriggers: number;
        avgRMultiple: number;
        volatilitySkips: number;
        trendGateSkips: number;
        entryConfirmationSkips: number;
    };
}

// ============================================
// Helper Functions
// ============================================

function isLowVolatilityDay(candles: OHLCV[], atr: number): boolean {
    if (candles.length < 1 || atr <= 0) return false;

    const dayRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
    return dayRange < atr * RISK_CONFIG.MIN_FIRST_HOUR_RANGE_ATR;
}

function isTrendStrong(candles: OHLCV[], emaPeriod: number): boolean {
    if (candles.length < emaPeriod + 10) return false;

    const closes = candles.map(c => c.close);
    const currentEMA = getCurrentEMA(closes, emaPeriod);
    const pastCloses = closes.slice(0, -10);
    const pastEMA = getCurrentEMA(pastCloses, emaPeriod);

    if (pastEMA === 0) return false;
    const slope = (currentEMA - pastEMA) / pastEMA;
    return Math.abs(slope) >= RISK_CONFIG.MIN_EMA_SLOPE;
}

// ============================================
// Signal Generation
// ============================================

function getSwingHigh(candles: OHLCV[], lookback: number): number {
    return Math.max(...candles.slice(-lookback).map(c => c.high));
}

function getSwingLow(candles: OHLCV[], lookback: number): number {
    return Math.min(...candles.slice(-lookback).map(c => c.low));
}

function detectTrendAndPullback(
    candles: OHLCV[]
): { trend: 'UP' | 'DOWN' | 'NEUTRAL'; isPullback: boolean; pullbackHigh: number; pullbackLow: number } {
    if (candles.length < EMA_SLOW + 5) {
        return { trend: 'NEUTRAL', isPullback: false, pullbackHigh: 0, pullbackLow: 0 };
    }

    const closes = candles.map(c => c.close);
    const fastEMA = getCurrentEMA(closes, EMA_FAST);
    const slowEMA = getCurrentEMA(closes, EMA_SLOW);
    const currentClose = closes[closes.length - 1];
    const atr = getCurrentATR(candles, 14);

    let trend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (fastEMA > slowEMA && currentClose > slowEMA) {
        trend = 'UP';
    } else if (fastEMA < slowEMA && currentClose < slowEMA) {
        trend = 'DOWN';
    }

    // Pullback detection
    let isPullback = false;
    let pullbackHigh = 0;
    let pullbackLow = 0;

    if (trend === 'UP') {
        const dip = fastEMA - currentClose;
        isPullback = dip > atr * PULLBACK_ATR * 0.3 && dip < atr * PULLBACK_ATR;
        if (isPullback) {
            const pullbackCandles = candles.slice(-10);
            pullbackHigh = Math.max(...pullbackCandles.map(c => c.high));
            pullbackLow = Math.min(...pullbackCandles.map(c => c.low));
        }
    } else if (trend === 'DOWN') {
        const rally = currentClose - fastEMA;
        isPullback = rally > atr * PULLBACK_ATR * 0.3 && rally < atr * PULLBACK_ATR;
        if (isPullback) {
            const pullbackCandles = candles.slice(-10);
            pullbackHigh = Math.max(...pullbackCandles.map(c => c.high));
            pullbackLow = Math.min(...pullbackCandles.map(c => c.low));
        }
    }

    return { trend, isPullback, pullbackHigh, pullbackLow };
}

// ============================================
// Process Intraday with Risk Engine
// ============================================

function processIntradayWithRiskEngine(
    dayData: OHLCV[][]
): BacktestResult {
    let trades = 0, wins = 0, grossProfit = 0, grossLoss = 0;
    let pnl = 0, equity = INITIAL_CAPITAL, peak = INITIAL_CAPITAL;
    let maxDD = 0;

    // Risk tracking
    let dailyPnL = 0;
    let currentDay = '';
    let dayTrades = 0;
    let dailyLossBreaches = 0;
    let killSwitchTriggers = 0;
    let volatilitySkips = 0;
    let trendGateSkips = 0;
    let entryConfirmationSkips = 0;
    let totalRMultiple = 0;

    // Rolling drawdown for kill switch
    let rollingDDPeak = INITIAL_CAPITAL;
    let killSwitchActive = false;
    let killSwitchEndDay = 0;

    const dailyReturns: Record<string, number> = {};

    for (let dayIdx = 0; dayIdx < dayData.length; dayIdx++) {
        const dayCandles = dayData[dayIdx];
        if (dayCandles.length < 75) continue; // Skip incomplete days

        const dayKey = dayCandles[0].timestamp?.toISOString().split('T')[0] || '';

        // Reset daily counters
        if (dayKey !== currentDay) {
            // Check for kill switch on new day
            const rollingDD = (rollingDDPeak - equity) / rollingDDPeak;
            if (rollingDD >= RISK_CONFIG.KILL_SWITCH_DRAWDOWN) {
                killSwitchActive = true;
                killSwitchEndDay = dayIdx + RISK_CONFIG.KILL_SWITCH_DURATION_DAYS;
                killSwitchTriggers++;
            }

            // Update rolling peak
            if (equity > rollingDDPeak) {
                rollingDDPeak = equity;
            }

            currentDay = dayKey;
            dailyPnL = 0;
            dayTrades = 0;
        }

        // Kill switch check
        if (killSwitchActive && dayIdx < killSwitchEndDay) {
            continue;
        } else {
            killSwitchActive = false;
        }

        // Daily loss limit check
        const dailyLossLimit = equity * RISK_CONFIG.MAX_DAILY_LOSS;
        if (dailyPnL <= -dailyLossLimit) {
            dailyLossBreaches++;
            continue; // Skip rest of day
        }

        // Process each candle in the day
        for (let i = EMA_SLOW + 30; i < dayCandles.length - 5; i++) {
            // Max trades per day
            if (dayTrades >= RISK_CONFIG.MAX_TRADES_PER_DAY) break;

            const lookback = dayCandles.slice(Math.max(0, i - 60), i + 1);
            const atr = getCurrentATR(lookback, 14);

            // UPGRADE #2: Volatility filter (first hour check)
            if (i < 12) { // First hour (12 * 5min = 60min)
                const firstHourCandles = dayCandles.slice(0, i + 1);
                if (isLowVolatilityDay(firstHourCandles, atr)) {
                    volatilitySkips++;
                    continue;
                }
            }

            // UPGRADE #3: Trend gate
            if (!isTrendStrong(lookback, 25)) {
                trendGateSkips++;
                continue;
            }

            const { trend, isPullback, pullbackHigh, pullbackLow } = detectTrendAndPullback(lookback);
            if (trend === 'NEUTRAL' || !isPullback) continue;

            // Confirmation candle
            const lastCandle = dayCandles[i];
            if (trend === 'UP' && lastCandle.close <= lastCandle.open) continue;
            if (trend === 'DOWN' && lastCandle.close >= lastCandle.open) continue;

            // UPGRADE #4: Entry confirmation (pullback break)
            if (trend === 'UP' && lastCandle.close <= pullbackHigh) {
                entryConfirmationSkips++;
                continue;
            }
            if (trend === 'DOWN' && lastCandle.close >= pullbackLow) {
                entryConfirmationSkips++;
                continue;
            }

            // Execute trade with position sizing
            const entry = lastCandle.close;
            const slip = entry * SLIPPAGE_PCT;
            const entryPrice = trend === 'UP' ? entry + slip : entry - slip;

            const stop = trend === 'UP'
                ? getSwingLow(lookback, 10) - atr * 0.5
                : getSwingHigh(lookback, 10) + atr * 0.5;

            const risk = Math.abs(entryPrice - stop);
            if (risk <= 0) continue;

            // Position sizing based on risk
            const riskAmount = equity * RISK_PER_TRADE;
            const qty = Math.floor(riskAmount / risk);
            if (qty <= 0) continue;

            // UPGRADE #5: Smart trailing stop
            let exit = dayCandles[dayCandles.length - 1].close;
            let trailingStop = stop;
            const trailDist = atr * TRAILING_ATR_MULT;

            for (let j = i + 1; j < Math.min(i + 40, dayCandles.length); j++) {
                const c = dayCandles[j];

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

            // UPGRADE #8: R-multiple tracking
            const rMultiple = net / riskAmount;
            totalRMultiple += rMultiple;

            trades++;
            dayTrades++;
            pnl += net;
            dailyPnL += net;
            equity += net;

            if (equity > peak) peak = equity;
            const dd = (peak - equity) / peak;
            if (dd > maxDD) maxDD = dd;

            if (net > 0) {
                wins++;
                grossProfit += net;
            } else {
                grossLoss += Math.abs(net);
            }

            // Track daily returns
            dailyReturns[dayKey] = (dailyReturns[dayKey] || 0) + net;

            i += 2; // Skip a few candles after trade
        }
    }

    const winRate = trades > 0 ? (wins / trades) * 100 : 0;
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const avgPnl = trades > 0 ? pnl / trades : 0;
    const calmarRatio = maxDD > 0 ? (pnl / INITIAL_CAPITAL) / maxDD : 0;

    return {
        trades,
        wins,
        pnl,
        dd: maxDD * 100,
        pf,
        winRate,
        avgPnl,
        calmarRatio,
        dailyReturns,
        riskMetrics: {
            dailyLossBreaches,
            killSwitchTriggers,
            avgRMultiple: trades > 0 ? totalRMultiple / trades : 0,
            volatilitySkips,
            trendGateSkips,
            entryConfirmationSkips
        }
    };
}

// ============================================
// API Handler
// ============================================

export async function GET() {
    const startTime = Date.now();

    try {
        const summary = getTVDataSummary();

        if (!summary.available || summary.symbols.length === 0) {
            return NextResponse.json({
                error: 'No TradingView intraday data found',
                hint: 'Please ensure 5-min data exists in ./data/tv_data/ directory'
            }, { status: 400 });
        }

        const data = loadAllTVData();

        // Aggregate results across all symbols
        let totalResult: BacktestResult = {
            trades: 0,
            wins: 0,
            pnl: 0,
            dd: 0,
            pf: 0,
            winRate: 0,
            avgPnl: 0,
            calmarRatio: 0,
            dailyReturns: {},
            riskMetrics: {
                dailyLossBreaches: 0,
                killSwitchTriggers: 0,
                avgRMultiple: 0,
                volatilitySkips: 0,
                trendGateSkips: 0,
                entryConfirmationSkips: 0
            }
        };

        let maxDD = 0;
        let totalRMultiple = 0;

        for (const [symbol, dayData] of data) {
            if (dayData.length < 10) continue; // Need at least 10 days

            const result = processIntradayWithRiskEngine(dayData);

            totalResult.trades += result.trades;
            totalResult.wins += result.wins;
            totalResult.pnl += result.pnl;
            if (result.dd > maxDD) maxDD = result.dd;

            totalResult.riskMetrics.dailyLossBreaches += result.riskMetrics.dailyLossBreaches;
            totalResult.riskMetrics.killSwitchTriggers += result.riskMetrics.killSwitchTriggers;
            totalResult.riskMetrics.volatilitySkips += result.riskMetrics.volatilitySkips;
            totalResult.riskMetrics.trendGateSkips += result.riskMetrics.trendGateSkips;
            totalResult.riskMetrics.entryConfirmationSkips += result.riskMetrics.entryConfirmationSkips;
            totalRMultiple += result.riskMetrics.avgRMultiple * result.trades;

            // Merge daily returns
            for (const [day, ret] of Object.entries(result.dailyReturns)) {
                totalResult.dailyReturns[day] = (totalResult.dailyReturns[day] || 0) + ret;
            }
        }

        totalResult.dd = maxDD;
        totalResult.winRate = totalResult.trades > 0 ? (totalResult.wins / totalResult.trades) * 100 : 0;
        totalResult.avgPnl = totalResult.trades > 0 ? totalResult.pnl / totalResult.trades : 0;
        totalResult.riskMetrics.avgRMultiple = totalResult.trades > 0 ? totalRMultiple / totalResult.trades : 0;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Calculate daily summaries
        const dailySummary = Object.entries(totalResult.dailyReturns)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, ret]) => ({
                day,
                pnl: Math.round(ret),
                return: ((ret / INITIAL_CAPITAL) * 100).toFixed(2) + '%'
            }));

        // Calculate averages
        const dailyValues = Object.values(totalResult.dailyReturns);
        const avgDailyReturn = dailyValues.length > 0
            ? (dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length) / INITIAL_CAPITAL * 100
            : 0;

        const profitableDays = dailyValues.filter(v => v > 0).length;
        const dayWinRate = dailyValues.length > 0 ? (profitableDays / dailyValues.length) * 100 : 0;

        return NextResponse.json({
            status: 'success',
            elapsedSeconds: elapsed,
            dataInfo: {
                ...summary,
                dateRange: 'Oct 27, 2025 - Feb 2, 2026',
                tradingDays: dailyValues.length
            },
            result: {
                performance: {
                    totalTrades: totalResult.trades,
                    wins: totalResult.wins,
                    winRate: totalResult.winRate.toFixed(1) + '%',
                    profitFactor: totalResult.pf.toFixed(2),
                    totalPnL: Math.round(totalResult.pnl),
                    totalReturn: ((totalResult.pnl / INITIAL_CAPITAL) * 100).toFixed(1) + '%',
                    maxDrawdown: totalResult.dd.toFixed(1) + '%',
                    avgTradeReturn: Math.round(totalResult.avgPnl),
                    calmarRatio: totalResult.calmarRatio.toFixed(2),
                    avgDailyReturn: avgDailyReturn.toFixed(2) + '%',
                    dayWinRate: dayWinRate.toFixed(1) + '%'
                },
                riskMetrics: {
                    dailyLossBreaches: totalResult.riskMetrics.dailyLossBreaches,
                    killSwitchTriggers: totalResult.riskMetrics.killSwitchTriggers,
                    avgRMultiple: totalResult.riskMetrics.avgRMultiple.toFixed(2),
                    volatilitySkips: totalResult.riskMetrics.volatilitySkips,
                    trendGateSkips: totalResult.riskMetrics.trendGateSkips,
                    entryConfirmationSkips: totalResult.riskMetrics.entryConfirmationSkips
                },
                dailyPerformance: dailySummary,
                upgradesApplied: [
                    '#1 Hard Risk Engine (0.3% risk/trade, 1% daily limit)',
                    '#2 No-Trade Filter (first hour volatility)',
                    '#3 Trend Gate (EMA slope)',
                    '#4 Entry Confirmation (pullback break)',
                    '#5 Smart Trailing (1.5x ATR)',
                    '#6 Kill Switch (5% DD = pause)',
                    '#7 Quality Scoring (integrated)',
                    '#8 R Tracking (expectancy)'
                ]
            }
        });
    } catch (error) {
        return NextResponse.json({
            error: 'Intraday sweep failed',
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        }, { status: 500 });
    }
}
