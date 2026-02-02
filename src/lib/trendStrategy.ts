// Trend-Following Pullback Strategy
// Enters WITH the trend on pullbacks, not against it

import { OHLCV, getCurrentATR, calculateSMA } from './indicators';

// ============================================
// Types
// ============================================

export interface TrendConfig {
    emaFast: number;      // Fast EMA period (5, 8, 13)
    emaSlow: number;      // Slow EMA period (20, 34, 50)
    pullbackATR: number;  // Pullback depth in ATR (0.5, 0.8, 1.0, 1.5)
    maxTrades: number;    // Max trades per day
}

export interface TrendSignal {
    signal: 'LONG' | 'SHORT' | null;
    trend: 'UPTREND' | 'DOWNTREND' | 'NEUTRAL';
    entry: number;
    stop: number;
    target: number;
    pullbackDepth: number;
}

export type Trend = 'UPTREND' | 'DOWNTREND' | 'NEUTRAL';

// ============================================
// EMA Calculation
// ============================================

export function calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
}

// ============================================
// Trend Detection
// ============================================

export function detectTrend(
    candles: OHLCV[],
    emaFast: number,
    emaSlow: number
): Trend {
    if (candles.length < emaSlow + 5) return 'NEUTRAL';

    const closes = candles.map(c => c.close);
    const fast = calculateEMA(closes, emaFast);
    const slow = calculateEMA(closes, emaSlow);

    // Require 0.1% separation to confirm trend
    const threshold = slow * 0.001;

    if (fast > slow + threshold) return 'UPTREND';
    if (fast < slow - threshold) return 'DOWNTREND';
    return 'NEUTRAL';
}

// ============================================
// Swing Point Detection
// ============================================

function findRecentSwingHigh(candles: OHLCV[], lookback: number = 10): number {
    const recent = candles.slice(-lookback);
    return Math.max(...recent.map(c => c.high));
}

function findRecentSwingLow(candles: OHLCV[], lookback: number = 10): number {
    const recent = candles.slice(-lookback);
    return Math.min(...recent.map(c => c.low));
}

// ============================================
// Pullback Detection
// ============================================

export function detectPullback(
    candles: OHLCV[],
    trend: Trend,
    pullbackATR: number
): { hasPullback: boolean; depth: number } {
    if (candles.length < 20) return { hasPullback: false, depth: 0 };

    const atr = getCurrentATR(candles, 14);
    const currentPrice = candles[candles.length - 1].close;
    const requiredPullback = pullbackATR * atr;

    if (trend === 'UPTREND') {
        // In uptrend, look for pullback FROM recent high
        const swingHigh = findRecentSwingHigh(candles, 15);
        const pullback = swingHigh - currentPrice;
        return {
            hasPullback: pullback >= requiredPullback,
            depth: atr > 0 ? pullback / atr : 0
        };
    }

    if (trend === 'DOWNTREND') {
        // In downtrend, look for pullback FROM recent low
        const swingLow = findRecentSwingLow(candles, 15);
        const pullback = currentPrice - swingLow;
        return {
            hasPullback: pullback >= requiredPullback,
            depth: atr > 0 ? pullback / atr : 0
        };
    }

    return { hasPullback: false, depth: 0 };
}

// ============================================
// Bullish/Bearish Candle Confirmation
// ============================================

function isBullishCandle(candle: OHLCV): boolean {
    return candle.close > candle.open;
}

function isBearishCandle(candle: OHLCV): boolean {
    return candle.close < candle.open;
}

// ============================================
// Signal Generation
// ============================================

export function generateTrendSignal(
    candles: OHLCV[],
    config: TrendConfig
): TrendSignal {
    const nullSignal: TrendSignal = {
        signal: null,
        trend: 'NEUTRAL',
        entry: 0,
        stop: 0,
        target: 0,
        pullbackDepth: 0
    };

    if (candles.length < config.emaSlow + 10) return nullSignal;

    // Step 1: Detect trend
    const trend = detectTrend(candles, config.emaFast, config.emaSlow);
    if (trend === 'NEUTRAL') return { ...nullSignal, trend };

    // Step 2: Detect pullback
    const { hasPullback, depth } = detectPullback(candles, trend, config.pullbackATR);
    if (!hasPullback) return { ...nullSignal, trend, pullbackDepth: depth };

    // Step 3: Confirmation candle (optional but helps)
    const lastCandle = candles[candles.length - 1];
    const atr = getCurrentATR(candles, 14);

    if (trend === 'UPTREND') {
        // Want bullish candle to confirm reversal of pullback
        if (!isBullishCandle(lastCandle)) {
            return { ...nullSignal, trend, pullbackDepth: depth };
        }

        const swingLow = findRecentSwingLow(candles, 10);
        const swingHigh = findRecentSwingHigh(candles, 15);

        return {
            signal: 'LONG',
            trend,
            entry: lastCandle.close,
            stop: swingLow - atr * 1.0,    // WIDER stop
            target: swingHigh + atr * 0.3, // TIGHTER target
            pullbackDepth: depth
        };
    }

    if (trend === 'DOWNTREND') {
        // Want bearish candle to confirm reversal of pullback
        if (!isBearishCandle(lastCandle)) {
            return { ...nullSignal, trend, pullbackDepth: depth };
        }

        const swingHigh = findRecentSwingHigh(candles, 10);
        const swingLow = findRecentSwingLow(candles, 15);

        return {
            signal: 'SHORT',
            trend,
            entry: lastCandle.close,
            stop: swingHigh + atr * 1.0,   // WIDER stop
            target: swingLow - atr * 0.3,  // TIGHTER target
            pullbackDepth: depth
        };
    }

    return nullSignal;
}

// ============================================
// Utility: Get current EMA values for display
// ============================================

export function getEMAValues(
    candles: OHLCV[],
    emaFast: number,
    emaSlow: number
): { fast: number; slow: number; diff: number; diffPct: number } {
    const closes = candles.map(c => c.close);
    const fast = calculateEMA(closes, emaFast);
    const slow = calculateEMA(closes, emaSlow);
    const diff = fast - slow;
    const diffPct = slow > 0 ? (diff / slow) * 100 : 0;

    return { fast, slow, diff, diffPct };
}
