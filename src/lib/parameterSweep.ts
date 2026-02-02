// Parameter Sweep Engine for Strategy Optimization
// Systematically tests parameter combinations and ranks by risk-adjusted performance

import { OHLCV, getCurrentATR } from './indicators';
import { MarketRegime, determineRegime, getRegimePermissions } from './regimeEngine';
import { fetchHistoricalDataForBacktest } from './historicalData';
import { calculateSMA } from './indicators';

// ============================================
// Types & Interfaces
// ============================================

export interface SweepConfig {
    atrMultiplier: number;
    wickRatio: number;
    maxTradesPerDay: number;
}

export interface SweepResult {
    config: SweepConfig;
    totalTrades: number;
    profitableDays: number;
    losingDays: number;
    flatDays: number;
    netPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    expectancyPerTrade: number;
    expectancyPerDay: number;
    riskAdjustedScore: number;
    isValid: boolean;
    invalidReason?: string;
}

export interface SweepReport {
    allResults: SweepResult[];
    validResults: SweepResult[];
    rankedResults: SweepResult[];
    bestConfig: SweepConfig | null;
    validationResult?: ValidationResult;
}

export interface ValidationResult {
    config: SweepConfig;
    originalScore: number;
    validationScore: number;
    degradation: number;
    passed: boolean;
}

// ============================================
// Constants
// ============================================

const INITIAL_CAPITAL = 100000;
const RISK_PER_TRADE = 0.01;
const SLIPPAGE_BPS = 5;
const BROKERAGE_PER_TRADE = 20;
const STT_PERCENTAGE = 0.00025;

// Validation filters
const MAX_ALLOWED_DRAWDOWN = 0.20;
const MIN_PROFITABLE_DAYS_PCT = 0.40;
const MIN_TOTAL_TRADES = 10;
const MIN_PROFIT_FACTOR = 1.1;

// EXPANDED test matrix
const ATR_MULTIPLIERS = [0.5, 0.8, 1.0, 1.2, 1.5];
const WICK_RATIOS = [0.2, 0.3, 0.4, 0.5];
const MAX_TRADES_OPTIONS = [1, 2, 3];

const TEST_SYMBOLS = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'AXISBANK'
];

const STOCK_PRICES: Record<string, number> = {
    'RELIANCE': 2500, 'TCS': 4200, 'HDFCBANK': 1650, 'INFY': 1800,
    'ICICIBANK': 1100, 'SBIN': 780, 'BHARTIARTL': 1400, 'ITC': 480,
    'LT': 3600, 'AXISBANK': 1150
};

// ============================================
// Simulated Data Generator
// ============================================

function generateSimulatedData(
    symbol: string,
    basePrice: number,
    days: number,
    candlesPerDay: number = 75
): OHLCV[][] {
    const allDays: OHLCV[][] = [];
    let currentPrice = basePrice;

    let seedState = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const random = () => {
        seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
        return seedState / 0x7fffffff;
    };

    for (let day = 0; day < days; day++) {
        const dailyCandles: OHLCV[] = [];
        const dailyVol = 0.01 + random() * 0.02;
        const dayType = random();
        const trendBias = dayType < 0.3 ? -0.001 : dayType > 0.7 ? 0.001 : 0;

        for (let candle = 0; candle < candlesPerDay; candle++) {
            let move = 0;

            if (candle < 15) {
                move = (random() - 0.5 + trendBias * 3) * dailyVol * currentPrice * 0.1;
            } else if (candle < 50) {
                if (candle % 12 === 0 && random() > 0.6) {
                    move = (random() > 0.5 ? 1 : -1) * dailyVol * currentPrice * 0.3;
                } else {
                    move = (random() - 0.5) * dailyVol * currentPrice * 0.05;
                }
            } else {
                move = (random() - 0.5 + trendBias) * dailyVol * currentPrice * 0.05;
            }

            const open = currentPrice;
            const close = currentPrice + move;
            const wickMult = random() > 0.7 ? 2 : 0.5;
            const upperWick = random() * dailyVol * currentPrice * 0.05 * wickMult;
            const lowerWick = random() * dailyVol * currentPrice * 0.05 * wickMult;
            const high = Math.max(open, close) + upperWick;
            const low = Math.min(open, close) - lowerWick;
            const volume = Math.floor((50000 + random() * 100000) * (candle < 15 || candle > 60 ? 1.5 : 1));

            dailyCandles.push({
                symbol,
                open: Math.round(open * 100) / 100,
                high: Math.round(high * 100) / 100,
                low: Math.round(low * 100) / 100,
                close: Math.round(close * 100) / 100,
                volume
            });

            currentPrice = close;
            if (currentPrice > basePrice * 1.1) currentPrice = basePrice * 1.05;
            if (currentPrice < basePrice * 0.9) currentPrice = basePrice * 0.95;
        }

        allDays.push(dailyCandles);
    }

    return allDays;
}

// ============================================
// Signal Detection (Parameterized)
// ============================================

function detectSignal(
    candles: OHLCV[],
    regime: MarketRegime,
    atrMultiplier: number,
    wickRatio: number
): { signal: 'LONG' | 'SHORT' | null; entry: number; stop: number; target: number } {
    if (candles.length < 20) {
        return { signal: null, entry: 0, stop: 0, target: 0 };
    }

    const permissions = getRegimePermissions(regime);
    if (!permissions.allowMeanReversion) {
        return { signal: null, entry: 0, stop: 0, target: 0 };
    }

    const closes = candles.map(c => c.close);
    const sma20 = calculateSMA(closes, 20);
    const atr = getCurrentATR(candles, 14);
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;

    const deviation = Math.abs(currentPrice - sma20);
    const deviationRatio = atr > 0 ? deviation / atr : 0;

    const body = Math.abs(lastCandle.close - lastCandle.open);
    const range = lastCandle.high - lastCandle.low;
    const candleWickRatio = range > 0 ? (range - body) / range : 0;

    if (deviationRatio < atrMultiplier || candleWickRatio < wickRatio) {
        return { signal: null, entry: 0, stop: 0, target: 0 };
    }

    if (currentPrice < sma20) {
        return {
            signal: 'LONG',
            entry: currentPrice,
            stop: lastCandle.low - atr * 0.5,
            target: sma20
        };
    } else {
        return {
            signal: 'SHORT',
            entry: currentPrice,
            stop: lastCandle.high + atr * 0.5,
            target: sma20
        };
    }
}

// ============================================
// Single Configuration Backtest
// ============================================

function runSingleConfig(
    config: SweepConfig,
    historicalData: Map<string, OHLCV[][]>
): SweepResult {
    let totalTrades = 0;
    let winningTrades = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    const dailyPnl: number[] = [];

    for (const [, days] of historicalData) {
        let tsdCount = 0;

        for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
            const dayCandles = days[dayIdx];
            if (!dayCandles || dayCandles.length < 25) continue;

            while (dailyPnl.length <= dayIdx) dailyPnl.push(0);

            const allCandles = days.slice(0, dayIdx + 1).flat();
            const recentCandles = allCandles.slice(-200);

            if (recentCandles.length >= 20) {
                const atr = getCurrentATR(recentCandles, 20);
                const closes = recentCandles.map(c => c.close);
                const ema5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
                const ema20 = calculateSMA(closes, 20);
                const trendShift = Math.abs(ema5 - ema20);

                if (trendShift > 0.7 * atr) {
                    tsdCount = Math.min(tsdCount + 1, 10);
                } else {
                    tsdCount = Math.max(0, tsdCount - 1);
                }
            }

            const regime = determineRegime(tsdCount);
            let dailyTrades = 0;
            let dailyPnlValue = 0;

            for (let candleIdx = 23; candleIdx < dayCandles.length - 5; candleIdx++) {
                if (dailyTrades >= config.maxTradesPerDay) break;

                const candlesToNow = dayCandles.slice(0, candleIdx + 1);
                const signal = detectSignal(candlesToNow, regime, config.atrMultiplier, config.wickRatio);

                if (signal.signal) {
                    const slippage = signal.entry * (SLIPPAGE_BPS / 10000);
                    const entryPrice = signal.signal === 'LONG' ? signal.entry + slippage : signal.entry - slippage;

                    const riskAmount = INITIAL_CAPITAL * RISK_PER_TRADE;
                    const riskPerShare = Math.abs(signal.entry - signal.stop);
                    const qty = Math.floor(riskAmount / riskPerShare);

                    if (qty <= 0) continue;

                    let exitPrice = dayCandles[dayCandles.length - 1].close;

                    for (let i = candleIdx + 1; i < dayCandles.length; i++) {
                        const candle = dayCandles[i];
                        if (signal.signal === 'LONG') {
                            if (candle.low <= signal.stop) { exitPrice = signal.stop - slippage; break; }
                            if (candle.high >= signal.target) { exitPrice = signal.target - slippage; break; }
                        } else {
                            if (candle.high >= signal.stop) { exitPrice = signal.stop + slippage; break; }
                            if (candle.low <= signal.target) { exitPrice = signal.target + slippage; break; }
                        }
                    }

                    const tradePnl = signal.signal === 'LONG'
                        ? (exitPrice - entryPrice) * qty
                        : (entryPrice - exitPrice) * qty;

                    const costs = BROKERAGE_PER_TRADE * 2 + Math.abs(tradePnl) * STT_PERCENTAGE;
                    const netTradePnl = tradePnl - costs;

                    totalTrades++;
                    dailyTrades++;
                    dailyPnlValue += netTradePnl;

                    if (netTradePnl > 0) { winningTrades++; grossProfit += netTradePnl; }
                    else { grossLoss += Math.abs(netTradePnl); }

                    candleIdx += 5;
                }
            }

            dailyPnl[dayIdx] += dailyPnlValue;
        }
    }

    const netPnl = grossProfit - grossLoss;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

    let profitableDays = 0, losingDays = 0, flatDays = 0;
    for (const pnl of dailyPnl) {
        if (pnl > 0) profitableDays++;
        else if (pnl < 0) losingDays++;
        else flatDays++;
    }

    let peakEquity = INITIAL_CAPITAL, maxDrawdown = 0, runningEquity = INITIAL_CAPITAL;
    for (const pnl of dailyPnl) {
        runningEquity += pnl;
        peakEquity = Math.max(peakEquity, runningEquity);
        const dd = peakEquity > 0 ? (peakEquity - runningEquity) / peakEquity : 0;
        maxDrawdown = Math.max(maxDrawdown, dd);
    }

    const totalDays = dailyPnl.length;
    const expectancyPerTrade = totalTrades > 0 ? netPnl / totalTrades : 0;
    const expectancyPerDay = totalDays > 0 ? netPnl / totalDays : 0;
    const riskAdjustedScore = maxDrawdown > 0 ? netPnl / (maxDrawdown * INITIAL_CAPITAL) : (netPnl > 0 ? 999 : 0);

    let isValid = true;
    let invalidReason: string | undefined;

    if (maxDrawdown > MAX_ALLOWED_DRAWDOWN) {
        isValid = false;
        invalidReason = `Max DD ${(maxDrawdown * 100).toFixed(1)}% > 20%`;
    } else if (totalDays > 0 && profitableDays / totalDays < MIN_PROFITABLE_DAYS_PCT) {
        isValid = false;
        invalidReason = `Profitable days ${(profitableDays / totalDays * 100).toFixed(1)}% < 40%`;
    } else if (totalTrades < MIN_TOTAL_TRADES) {
        isValid = false;
        invalidReason = `Trades ${totalTrades} < 10`;
    } else if (profitFactor < MIN_PROFIT_FACTOR) {
        isValid = false;
        invalidReason = `Profit factor ${profitFactor.toFixed(2)} < 1.1`;
    }

    return {
        config,
        totalTrades,
        profitableDays,
        losingDays,
        flatDays,
        netPnl,
        maxDrawdown,
        profitFactor,
        expectancyPerTrade,
        expectancyPerDay,
        riskAdjustedScore,
        isValid,
        invalidReason
    };
}

// ============================================
// Parameter Sweep Runner
// ============================================

export async function runParameterSweep(
    days: number = 60,
    useSimulatedData: boolean = true
): Promise<SweepReport> {
    console.log('='.repeat(60));
    console.log('PARAMETER SWEEP OPTIMIZATION');
    console.log(`Data: ${useSimulatedData ? 'SIMULATED' : 'REAL'}`);
    console.log('='.repeat(60));

    const historicalData = new Map<string, OHLCV[][]>();

    if (useSimulatedData) {
        console.log(`\nGenerating simulated data...`);
        for (const symbol of TEST_SYMBOLS) {
            const basePrice = STOCK_PRICES[symbol] || 1000;
            historicalData.set(symbol, generateSimulatedData(symbol, basePrice, days));
        }
    } else {
        console.log(`\nFetching real data...`);
        for (const symbol of TEST_SYMBOLS) {
            const data = await fetchHistoricalDataForBacktest(symbol, days);
            if (data.length > 0) historicalData.set(symbol, data);
        }
    }

    console.log(`Loaded ${historicalData.size} symbols`);

    const configs: SweepConfig[] = [];
    for (const atr of ATR_MULTIPLIERS) {
        for (const wick of WICK_RATIOS) {
            for (const maxTrades of MAX_TRADES_OPTIONS) {
                configs.push({ atrMultiplier: atr, wickRatio: wick, maxTradesPerDay: maxTrades });
            }
        }
    }

    console.log(`\nRunning ${configs.length} configurations...`);

    const allResults: SweepResult[] = [];

    for (let i = 0; i < configs.length; i++) {
        const config = configs[i];
        const result = runSingleConfig(config, historicalData);
        allResults.push(result);
        console.log(`[${i + 1}/${configs.length}] ATR=${config.atrMultiplier} WICK=${config.wickRatio} MAX=${config.maxTradesPerDay} | Trades: ${result.totalTrades} | P&L: ₹${result.netPnl.toFixed(0)} | Valid: ${result.isValid ? '✓' : '✗'}`);
    }

    const validResults = allResults.filter(r => r.isValid);
    const rankedResults = [...validResults].sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);

    console.log(`\nValid: ${validResults.length}/${allResults.length}`);

    return {
        allResults,
        validResults,
        rankedResults,
        bestConfig: rankedResults.length > 0 ? rankedResults[0].config : null
    };
}

// ============================================
// Validation
// ============================================

export async function validateConfiguration(
    config: SweepConfig,
    originalScore: number,
    validationDays: number = 20
): Promise<ValidationResult> {
    const historicalData = new Map<string, OHLCV[][]>();

    for (const symbol of TEST_SYMBOLS) {
        const basePrice = STOCK_PRICES[symbol] || 1000;
        historicalData.set(symbol, generateSimulatedData(symbol, basePrice, validationDays));
    }

    const result = runSingleConfig(config, historicalData);
    const degradation = originalScore > 0 ? (originalScore - result.riskAdjustedScore) / originalScore : 0;

    return {
        config,
        originalScore,
        validationScore: result.riskAdjustedScore,
        degradation,
        passed: degradation < 0.5 && result.riskAdjustedScore > 0
    };
}

// ============================================
// Report Generator
// ============================================

export function generateSweepReport(report: SweepReport): string {
    let output = `# PARAMETER SWEEP REPORT\n\n`;
    output += `## All Results\n\n`;
    output += `| ATR | Wick | Max | Trades | P&L | Max DD | PF | Score | Valid |\n`;
    output += `|-----|------|-----|--------|-----|--------|-----|-------|-------|\n`;

    for (const r of report.allResults) {
        output += `| ${r.config.atrMultiplier} | ${r.config.wickRatio} | ${r.config.maxTradesPerDay} | ${r.totalTrades} | ₹${r.netPnl.toFixed(0)} | ${(r.maxDrawdown * 100).toFixed(1)}% | ${r.profitFactor.toFixed(2)} | ${r.riskAdjustedScore.toFixed(2)} | ${r.isValid ? '✓' : '✗'} |\n`;
    }

    output += `\n## Ranked Valid Configurations\n\n`;
    for (let i = 0; i < report.rankedResults.length; i++) {
        const r = report.rankedResults[i];
        output += `${i + 1}. ATR=${r.config.atrMultiplier} WICK=${r.config.wickRatio} MAX=${r.config.maxTradesPerDay} | Score: ${r.riskAdjustedScore.toFixed(2)}\n`;
    }

    if (report.bestConfig) {
        output += `\n## OPTIMAL: ATR=${report.bestConfig.atrMultiplier} WICK=${report.bestConfig.wickRatio} MAX=${report.bestConfig.maxTradesPerDay}\n`;
    } else {
        output += `\n## NO VALID CONFIGURATION FOUND\n`;
    }

    return output;
}
