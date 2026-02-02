// Quick Intraday Test - Single Symbol
// Tests upgraded strategy on one symbol to avoid timeout

import { NextResponse } from 'next/server';
import { loadTVSymbolData, getTVDataSummary } from '@/lib/tvDataLoader';
import { OHLCV, getCurrentATR, getCurrentEMA } from '@/lib/indicators';
import { RISK_CONFIG } from '@/lib/riskEngine';

const INITIAL_CAPITAL = 500000;
const RISK_PER_TRADE = RISK_CONFIG.MAX_RISK_PER_TRADE;
const SLIPPAGE_PCT = 0.0005;
const BROKERAGE = 20;
const STT = 0.001;

const EMA_FAST = 13;
const EMA_SLOW = 34;
const PULLBACK_ATR = 2.0;
const TRAILING_ATR_MULT = 1.5;

function getSwingHigh(candles: OHLCV[], lookback: number): number {
    return Math.max(...candles.slice(-lookback).map(c => c.high));
}

function getSwingLow(candles: OHLCV[], lookback: number): number {
    return Math.min(...candles.slice(-lookback).map(c => c.low));
}

function detectTrend(candles: OHLCV[]): 'UP' | 'DOWN' | 'NEUTRAL' {
    if (candles.length < EMA_SLOW + 5) return 'NEUTRAL';

    const closes = candles.map(c => c.close);
    const fastEMA = getCurrentEMA(closes, EMA_FAST);
    const slowEMA = getCurrentEMA(closes, EMA_SLOW);
    const currentClose = closes[closes.length - 1];

    if (fastEMA > slowEMA && currentClose > slowEMA) return 'UP';
    if (fastEMA < slowEMA && currentClose < slowEMA) return 'DOWN';
    return 'NEUTRAL';
}

export async function GET(request: Request) {
    const startTime = Date.now();
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'RELIANCE';

    try {
        const summary = getTVDataSummary();

        if (!summary.available) {
            return NextResponse.json({
                error: 'No TradingView data available'
            }, { status: 400 });
        }

        console.log(`Loading data for ${symbol}...`);
        const dayData = loadTVSymbolData(symbol);

        if (dayData.length === 0) {
            return NextResponse.json({
                error: `No data for ${symbol}`
            }, { status: 404 });
        }

        console.log(`Processing ${dayData.length} days...`);

        let trades = 0, wins = 0, pnl = 0;
        let equity = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxDD = 0;
        const dailyReturns: Record<string, number> = {};

        for (let dayIdx = 0; dayIdx < dayData.length; dayIdx++) {
            const dayCandles = dayData[dayIdx];
            if (dayCandles.length < 75) continue;

            const dayKey = dayCandles[0].timestamp?.toISOString().split('T')[0] || '';
            let dayTrades = 0;

            for (let i = EMA_SLOW + 30; i < dayCandles.length - 5; i++) {
                if (dayTrades >= 2) break; // Max 2 trades/day

                const lookback = dayCandles.slice(Math.max(0, i - 60), i + 1);
                const trend = detectTrend(lookback);

                if (trend === 'NEUTRAL') continue;

                const lastCandle = dayCandles[i];
                const entry = lastCandle.close;
                const slip = entry * SLIPPAGE_PCT;
                const entryPrice = trend === 'UP' ? entry + slip : entry - slip;

                const atr = getCurrentATR(lookback, 14);
                const stop = trend === 'UP'
                    ? getSwingLow(lookback, 10) - atr * 0.5
                    : getSwingHigh(lookback, 10) + atr * 0.5;

                const risk = Math.abs(entryPrice - stop);
                if (risk <= 0) continue;

                const riskAmount = equity * RISK_PER_TRADE;
                const qty = Math.floor(riskAmount / risk);
                if (qty <= 0) continue;

                // Find exit with trailing stop
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

                trades++;
                dayTrades++;
                pnl += net;
                equity += net;

                if (equity > peak) peak = equity;
                const dd = (peak - equity) / peak;
                if (dd > maxDD) maxDD = dd;

                if (net > 0) wins++;

                dailyReturns[dayKey] = (dailyReturns[dayKey] || 0) + net;

                i += 2; // Skip a few candles
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const winRate = trades > 0 ? (wins / trades) * 100 : 0;
        const totalReturn = (pnl / INITIAL_CAPITAL) * 100;

        const dailySummary = Object.entries(dailyReturns)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, ret]) => ({
                day,
                pnl: Math.round(ret),
                return: ((ret / INITIAL_CAPITAL) * 100).toFixed(2) + '%'
            }));

        return NextResponse.json({
            status: 'success',
            elapsedSeconds: elapsed,
            symbol,
            dataInfo: {
                tradingDays: dayData.length,
                totalCandles: dayData.reduce((sum, day) => sum + day.length, 0)
            },
            result: {
                totalTrades: trades,
                wins,
                winRate: winRate.toFixed(1) + '%',
                totalPnL: Math.round(pnl),
                totalReturn: totalReturn.toFixed(1) + '%',
                maxDrawdown: (maxDD * 100).toFixed(1) + '%',
                avgTradeReturn: trades > 0 ? Math.round(pnl / trades) : 0,
                tradingDays: Object.keys(dailyReturns).length,
                avgDailyReturn: Object.keys(dailyReturns).length > 0
                    ? ((pnl / Object.keys(dailyReturns).length) / INITIAL_CAPITAL * 100).toFixed(2) + '%'
                    : '0%'
            },
            dailyPerformance: dailySummary.slice(0, 10) // First 10 days
        });
    } catch (error) {
        return NextResponse.json({
            error: 'Test failed',
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        }, { status: 500 });
    }
}
