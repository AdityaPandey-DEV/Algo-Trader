// Mean Reversion Strategy (TypeScript Port)
import { CONFIG } from './config';

interface OHLCV {
    symbol: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface Signal {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entry: number;
    target: number;
    stop: number;
    current?: number;
    reason: string;
}

// Check for rejection candle (wick > body)
function checkRejectionCandle(data: OHLCV, side: 'LONG' | 'SHORT'): boolean {
    const body = Math.abs(data.close - data.open);
    if (body === 0) return false;

    if (side === 'SHORT') {
        const upperWick = data.high - Math.max(data.open, data.close);
        return upperWick > (CONFIG.WICK_RATIO * body);
    } else {
        const lowerWick = Math.min(data.open, data.close) - data.low;
        return lowerWick > (CONFIG.WICK_RATIO * body);
    }
}

// Check volume confirmation
function checkVolumeFilter(currentVolume: number, priorVolume: number): boolean {
    if (!priorVolume) return true; // No prior data, pass
    return currentVolume >= (priorVolume * CONFIG.VOLUME_RATIO);
}

// Generate trading signal
export function generateSignal(
    data: OHLCV,
    priorData: OHLCV | null,
    support: number,
    resistance: number,
    regime: string
): Signal | null {
    // No signals in established trend
    if (regime === 'ESTABLISHED_TREND') return null;

    const baseRange = data.high - data.low;
    const priorVolume = priorData?.volume ?? 0;

    // Counter-Trend SHORT
    if (data.close >= resistance) {
        const wickOk = checkRejectionCandle(data, 'SHORT');
        const volOk = checkVolumeFilter(data.volume, priorVolume);

        if (wickOk && volOk) {
            return {
                symbol: data.symbol,
                side: 'SHORT',
                entry: data.close,
                target: Number((resistance - baseRange * 1.5).toFixed(2)),
                stop: Number((data.high * 1.005).toFixed(2)),  // 0.5% stop (was 0.2%)
                current: data.close,
                reason: 'Resistance Rejection'
            };
        }
    }

    // Counter-Trend LONG
    if (data.close <= support) {
        const wickOk = checkRejectionCandle(data, 'LONG');
        const volOk = checkVolumeFilter(data.volume, priorVolume);

        if (wickOk && volOk) {
            return {
                symbol: data.symbol,
                side: 'LONG',
                entry: data.close,
                target: Number((support + baseRange * 1.5).toFixed(2)),
                stop: Number((data.low * 0.995).toFixed(2)),  // 0.5% stop (was 0.2%)
                current: data.close,
                reason: 'Support Rejection'
            };
        }
    }

    return null;
}

// Calculate potential entry levels (for planned trades display)
export function calculatePlannedTrade(data: OHLCV, support: number, resistance: number): Signal[] {
    const trades: Signal[] = [];
    const baseRange = data.high - data.low;

    // Potential SHORT at resistance
    trades.push({
        symbol: data.symbol,
        side: 'SHORT',
        entry: Number(resistance.toFixed(2)),
        target: Number((resistance - baseRange * 1.5).toFixed(2)),
        stop: Number((resistance * 1.003).toFixed(2)),
        current: data.close,
        reason: 'Resistance Level'
    });

    // Potential LONG at support
    trades.push({
        symbol: data.symbol,
        side: 'LONG',
        entry: Number(support.toFixed(2)),
        target: Number((support + baseRange * 1.5).toFixed(2)),
        stop: Number((support * 0.997).toFixed(2)),
        current: data.close,
        reason: 'Support Level'
    });

    return trades;
}
