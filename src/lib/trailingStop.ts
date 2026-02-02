// ============================================
// Smart Trailing Stop (Upgrade #5)
// ============================================
// ATR-based trailing stop that lets winners run
// Key principle: No fixed targets, let trends pay

import { OHLCV, getCurrentATR } from './indicators';
import { RISK_CONFIG } from './riskEngine';

// ============================================
// Position State for Trailing
// ============================================

export interface TrailingPosition {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entryPrice: number;
    currentStop: number;
    highestHigh: number;    // For LONG: highest high since entry
    lowestLow: number;      // For SHORT: lowest low since entry
    entryTime: Date;
}

// In-memory position tracking
const activePositions: Map<string, TrailingPosition> = new Map();

// ============================================
// Core Trailing Functions
// ============================================

/**
 * Initialize a new trailing position
 */
export function initTrailingPosition(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    entryPrice: number,
    initialStop: number
): void {
    activePositions.set(symbol, {
        symbol,
        direction,
        entryPrice,
        currentStop: initialStop,
        highestHigh: entryPrice,
        lowestLow: entryPrice,
        entryTime: new Date()
    });

    console.log(`📍 Trailing initialized for ${symbol} (${direction}): Entry=${entryPrice.toFixed(2)}, Stop=${initialStop.toFixed(2)}`);
}

/**
 * Update trailing stop based on new price data
 * Returns true if stop is hit
 */
export function updateTrailingStop(
    symbol: string,
    candles: OHLCV[]
): { stopped: boolean; pnl: number; newStop: number } {
    const position = activePositions.get(symbol);

    if (!position) {
        return { stopped: false, pnl: 0, newStop: 0 };
    }

    const currentCandle = candles[candles.length - 1];
    const atr = getCurrentATR(candles, 14);
    const trailDistance = atr * RISK_CONFIG.TRAILING_ATR_MULT;

    if (position.direction === 'LONG') {
        // Update highest high
        if (currentCandle.high > position.highestHigh) {
            position.highestHigh = currentCandle.high;
        }

        // Calculate new trailing stop (only moves UP)
        const newTrailStop = position.highestHigh - trailDistance;
        if (newTrailStop > position.currentStop) {
            position.currentStop = newTrailStop;
        }

        // Check if stopped out
        if (currentCandle.low <= position.currentStop) {
            const exitPrice = position.currentStop;
            const pnl = exitPrice - position.entryPrice;

            console.log(`🛑 LONG ${symbol} stopped at ${exitPrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}`);
            activePositions.delete(symbol);

            return { stopped: true, pnl, newStop: position.currentStop };
        }
    }

    if (position.direction === 'SHORT') {
        // Update lowest low
        if (currentCandle.low < position.lowestLow) {
            position.lowestLow = currentCandle.low;
        }

        // Calculate new trailing stop (only moves DOWN)
        const newTrailStop = position.lowestLow + trailDistance;
        if (newTrailStop < position.currentStop) {
            position.currentStop = newTrailStop;
        }

        // Check if stopped out
        if (currentCandle.high >= position.currentStop) {
            const exitPrice = position.currentStop;
            const pnl = position.entryPrice - exitPrice;

            console.log(`🛑 SHORT ${symbol} stopped at ${exitPrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}`);
            activePositions.delete(symbol);

            return { stopped: true, pnl, newStop: position.currentStop };
        }
    }

    // Still in trade
    return { stopped: false, pnl: 0, newStop: position.currentStop };
}

/**
 * Get current trailing stop for a position
 */
export function getCurrentTrailingStop(symbol: string): number | null {
    const position = activePositions.get(symbol);
    return position ? position.currentStop : null;
}

/**
 * Get all active trailing positions
 */
export function getActiveTrailingPositions(): TrailingPosition[] {
    return Array.from(activePositions.values());
}

/**
 * Close a position manually (for end-of-day, etc.)
 */
export function closeTrailingPosition(symbol: string, exitPrice: number): { pnl: number } | null {
    const position = activePositions.get(symbol);

    if (!position) {
        return null;
    }

    let pnl: number;
    if (position.direction === 'LONG') {
        pnl = exitPrice - position.entryPrice;
    } else {
        pnl = position.entryPrice - exitPrice;
    }

    console.log(`📤 Closed ${position.direction} ${symbol} at ${exitPrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}`);
    activePositions.delete(symbol);

    return { pnl };
}

/**
 * Clear all positions (for testing/reset)
 */
export function clearAllTrailingPositions(): void {
    activePositions.clear();
}

/**
 * Get position summary
 */
export function getTrailingSummary(): {
    count: number;
    symbols: string[];
    unrealizedPnL: number;
} {
    const positions = Array.from(activePositions.values());
    let unrealizedPnL = 0;

    // Note: This is a simplified calculation
    // In production, you'd need current market prices

    return {
        count: positions.length,
        symbols: positions.map(p => p.symbol),
        unrealizedPnL
    };
}
