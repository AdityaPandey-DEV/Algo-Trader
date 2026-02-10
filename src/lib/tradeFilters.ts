// ============================================
// Trade Filters
// ============================================
// Filters to skip low-quality trading days and setups
// Implements: No-Trade Day Filter, Trend Gate, Quality Scoring

import { OHLCV, getCurrentATR } from './indicators';
import { calculateEMA } from './trendStrategy';
import { RISK_CONFIG } from './riskEngine';

// ============================================
// No-Trade Day Filter (Upgrade #2)
// ============================================

/**
 * Check if today should be skipped due to low volatility
 * Uses first hour's range vs ATR to determine if market is choppy
 */
export function shouldSkipToday(candles: OHLCV[]): { skip: boolean; reason: string } {
    if (candles.length < 5) {
        return { skip: false, reason: 'Insufficient data, allowing trade' };
    }

    // Get ATR (14-period)
    const atr = getCurrentATR(candles, 14);
    if (!atr || atr <= 0) {
        return { skip: false, reason: 'ATR unavailable, proceeding cautiously' };
    }

    // Calculate first hour range (assuming 5-min candles = 12 candles in first hour)
    // For intraday: first 12 candles of the day
    // For daily: use previous day's range
    const recentCandles = candles.slice(-12);
    const firstHourHigh = Math.max(...recentCandles.map(c => c.high));
    const firstHourLow = Math.min(...recentCandles.map(c => c.low));
    const firstHourRange = firstHourHigh - firstHourLow;

    const rangeRatio = firstHourRange / atr;

    if (rangeRatio < RISK_CONFIG.MIN_FIRST_HOUR_RANGE_ATR) {
        return {
            skip: true,
            reason: `Low volatility day: Range ${rangeRatio.toFixed(2)}x ATR < ${RISK_CONFIG.MIN_FIRST_HOUR_RANGE_ATR}x`
        };
    }

    return { skip: false, reason: 'Volatility OK' };
}

// ============================================
// Trend Regime Gate (Upgrade #3)
// ============================================

/**
 * Check if the trend is strong enough to trade
 * Uses EMA slope to filter weak/choppy trends
 */
export function isTrendStrong(candles: OHLCV[], emaPeriod: number = 25): { strong: boolean; slope: number; reason: string } {
    if (candles.length < emaPeriod + 10) {
        return { strong: true, slope: 0, reason: 'Insufficient data, allowing trade' };
    }

    // Current EMA - extract close prices
    const closes = candles.map(c => c.close);
    const currentEMA = calculateEMA(closes, emaPeriod);

    // EMA 10 bars ago
    const pastCloses = candles.slice(0, -10).map(c => c.close);
    const pastEMA = calculateEMA(pastCloses, emaPeriod);

    // Calculate slope as percentage change
    const slope = (currentEMA - pastEMA) / pastEMA;

    if (Math.abs(slope) < RISK_CONFIG.MIN_EMA_SLOPE) {
        return {
            strong: false,
            slope,
            reason: `Weak trend: Slope ${(slope * 100).toFixed(3)}% < ${(RISK_CONFIG.MIN_EMA_SLOPE * 100).toFixed(3)}%`
        };
    }

    return {
        strong: true,
        slope,
        reason: `Strong ${slope > 0 ? 'uptrend' : 'downtrend'}: Slope ${(slope * 100).toFixed(3)}%`
    };
}

// ============================================
// Trade Quality Scoring (Upgrade #7)
// ============================================

interface TradeSetup {
    trendStrength: number;      // 0-1: How strong is the trend
    pullbackDepth: number;      // 0-1: How deep is the pullback (deeper = better)
    volumeExpansion: number;    // 0-1: Is volume expanding on the move
}

/**
 * Calculate overall trade quality score
 * Returns 0-1 score; only take trades with score >= MIN_TRADE_SCORE
 */
export function getTradeScore(setup: TradeSetup): { score: number; passed: boolean } {
    const score =
        setup.trendStrength * 0.4 +
        setup.pullbackDepth * 0.4 +
        setup.volumeExpansion * 0.2;

    return {
        score,
        passed: score >= RISK_CONFIG.MIN_TRADE_SCORE
    };
}

/**
 * Calculate trend strength from EMA separation
 */
export function calculateTrendStrength(candles: OHLCV[], emaFast: number, emaSlow: number): number {
    if (candles.length < emaSlow + 5) return 0;

    const closes = candles.map(c => c.close);
    const fastEMA = calculateEMA(closes, emaFast);
    const slowEMA = calculateEMA(closes, emaSlow);
    const currentPrice = candles[candles.length - 1].close;

    // Trend strength based on EMA separation
    const separation = Math.abs(fastEMA - slowEMA) / slowEMA;

    // Normalize to 0-1 (0.5% separation = 0.5, 1% = 1.0)
    return Math.min(separation * 100, 1);
}

/**
 * Calculate pullback depth relative to recent swing
 */
export function calculatePullbackDepth(candles: OHLCV[], lookback: number = 10): number {
    if (candles.length < lookback + 5) return 0;

    const recentCandles = candles.slice(-lookback);
    const current = candles[candles.length - 1].close;

    const swingHigh = Math.max(...recentCandles.map(c => c.high));
    const swingLow = Math.min(...recentCandles.map(c => c.low));
    const range = swingHigh - swingLow;

    if (range <= 0) return 0;

    // In uptrend: pullback from high
    const pullbackFromHigh = (swingHigh - current) / range;

    // In downtrend: pullback from low  
    const pullbackFromLow = (current - swingLow) / range;

    // Return the relevant pullback (whichever is larger = deeper pullback)
    const depth = Math.max(pullbackFromHigh, pullbackFromLow);

    // Ideal pullback is 0.3-0.5 of range, normalize
    // 0 pullback = 0 score, 0.5 pullback = 1.0 score, >0.5 = declining
    if (depth <= 0.5) {
        return depth * 2;  // 0.5 -> 1.0
    } else {
        return Math.max(0, 1 - (depth - 0.5) * 2);  // 0.75 -> 0.5, 1.0 -> 0
    }
}

/**
 * Calculate volume expansion
 */
export function calculateVolumeExpansion(candles: OHLCV[], lookback: number = 20): number {
    if (candles.length < lookback + 1) return 0.5;  // Neutral if no data

    const recentVolumes = candles.slice(-lookback, -1).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const currentVolume = candles[candles.length - 1].volume;

    if (avgVolume <= 0) return 0.5;

    const ratio = currentVolume / avgVolume;

    // 1x = 0.5, 2x = 1.0, 0.5x = 0.25
    return Math.min(ratio / 2, 1);
}

// ============================================
// Combined Pre-Trade Check
// ============================================

export interface PreTradeCheckResult {
    canTrade: boolean;
    reasons: string[];
    volatilityOK: boolean;
    trendOK: boolean;
    qualityScore: number;
}

/**
 * Run all pre-trade filters and return combined result
 */
export function runPreTradeChecks(
    candles: OHLCV[],
    emaFast: number = 13,
    emaSlow: number = 34
): PreTradeCheckResult {
    const reasons: string[] = [];

    // 1. Volatility check
    const volatility = shouldSkipToday(candles);
    if (volatility.skip) {
        reasons.push(volatility.reason);
    }

    // 2. Trend strength check
    const trend = isTrendStrong(candles, 25);
    if (!trend.strong) {
        reasons.push(trend.reason);
    }

    // 3. Quality score
    const trendStrength = calculateTrendStrength(candles, emaFast, emaSlow);
    const pullbackDepth = calculatePullbackDepth(candles);
    const volumeExpansion = calculateVolumeExpansion(candles);
    const { score, passed } = getTradeScore({ trendStrength, pullbackDepth, volumeExpansion });

    if (!passed) {
        reasons.push(`Low quality score: ${(score * 100).toFixed(0)}% < ${(RISK_CONFIG.MIN_TRADE_SCORE * 100).toFixed(0)}%`);
    }

    return {
        // Mean reversion works best WITHOUT strong trends, so we don't require trend.strong
        canTrade: !volatility.skip && passed,
        reasons,
        volatilityOK: !volatility.skip,
        trendOK: true,  // Not required for mean reversion strategy
        qualityScore: score
    };
}
