// ============================================
// Professional Risk Engine
// ============================================
// Core risk management for 3-8% monthly returns
// Key principle: Prevent big losses, profits take care of themselves

// ============================================
// Risk Configuration
// ============================================

export const RISK_CONFIG = {
    // Per-Trade Risk
    MAX_RISK_PER_TRADE: 0.003,      // 0.3% of capital per trade

    // Daily Limits
    MAX_DAILY_LOSS: 0.01,           // 1% max loss per day
    MAX_TRADES_PER_DAY: 2,          // Max 2 trades per day

    // Kill Switch (Rolling Drawdown)
    KILL_SWITCH_DRAWDOWN: 0.05,     // 5% rolling DD = pause trading
    KILL_SWITCH_DURATION_DAYS: 5,   // Pause for 5 days

    // Position Sizing
    MIN_POSITION_SIZE: 1,           // Minimum 1 share
    MAX_POSITION_PCT: 0.10,         // Max 10% of capital in one stock

    // Trailing Stop
    TRAILING_ATR_MULT: 1.5,         // Trail at 1.5x ATR

    // Trade Quality
    MIN_TRADE_SCORE: 0.7,           // Minimum quality score (0-1)

    // No-Trade Day Filter
    MIN_FIRST_HOUR_RANGE_ATR: 0.4,  // Skip if first hour < 0.4 ATR

    // Trend Gate
    MIN_EMA_SLOPE: 0.001,           // Minimum EMA slope for strong trend
};

// ============================================
// Risk State (In-Memory for Session)
// ============================================

interface RiskState {
    dailyPnL: number;
    dailyTradeCount: number;
    rollingDrawdown: number;
    peakEquity: number;
    currentEquity: number;
    lastTradeDate: string;
    tradingDisabled: boolean;
    disabledUntil: Date | null;
    monthlyR: number;
}

let riskState: RiskState = {
    dailyPnL: 0,
    dailyTradeCount: 0,
    rollingDrawdown: 0,
    peakEquity: 100000,
    currentEquity: 100000,
    lastTradeDate: '',
    tradingDisabled: false,
    disabledUntil: null,
    monthlyR: 0,
};

// ============================================
// Core Risk Functions
// ============================================

/**
 * Initialize or reset the risk engine for a new day
 */
export function initRiskEngine(equity: number): void {
    const today = new Date().toISOString().split('T')[0];

    // Reset daily counters if new day
    if (riskState.lastTradeDate !== today) {
        riskState.dailyPnL = 0;
        riskState.dailyTradeCount = 0;
        riskState.lastTradeDate = today;
    }

    // Update equity tracking
    riskState.currentEquity = equity;
    if (equity > riskState.peakEquity) {
        riskState.peakEquity = equity;
    }

    // Calculate rolling drawdown
    riskState.rollingDrawdown = (riskState.peakEquity - equity) / riskState.peakEquity;

    // Check kill switch
    checkKillSwitch();
}

/**
 * Check if trading is allowed based on all risk rules
 */
export function canTrade(): { allowed: boolean; reason: string } {
    // Kill switch check
    if (riskState.tradingDisabled) {
        if (riskState.disabledUntil && new Date() < riskState.disabledUntil) {
            return { allowed: false, reason: `KILL SWITCH: Paused until ${riskState.disabledUntil.toISOString().split('T')[0]}` };
        } else {
            // Re-enable trading
            riskState.tradingDisabled = false;
            riskState.disabledUntil = null;
        }
    }

    // Daily loss limit
    const dailyLossPct = Math.abs(Math.min(0, riskState.dailyPnL)) / riskState.currentEquity;
    if (dailyLossPct >= RISK_CONFIG.MAX_DAILY_LOSS) {
        return { allowed: false, reason: `DAILY LOSS LIMIT: ${(dailyLossPct * 100).toFixed(2)}% >= ${RISK_CONFIG.MAX_DAILY_LOSS * 100}%` };
    }

    // Trade count limit
    if (riskState.dailyTradeCount >= RISK_CONFIG.MAX_TRADES_PER_DAY) {
        return { allowed: false, reason: `TRADE LIMIT: ${riskState.dailyTradeCount} trades today (max ${RISK_CONFIG.MAX_TRADES_PER_DAY})` };
    }

    return { allowed: true, reason: 'OK' };
}

/**
 * Check and activate kill switch if needed
 */
function checkKillSwitch(): void {
    if (riskState.rollingDrawdown >= RISK_CONFIG.KILL_SWITCH_DRAWDOWN && !riskState.tradingDisabled) {
        riskState.tradingDisabled = true;
        const pauseUntil = new Date();
        pauseUntil.setDate(pauseUntil.getDate() + RISK_CONFIG.KILL_SWITCH_DURATION_DAYS);
        riskState.disabledUntil = pauseUntil;
        console.log(`🛑 KILL SWITCH ACTIVATED: ${(riskState.rollingDrawdown * 100).toFixed(2)}% drawdown. Paused until ${pauseUntil.toISOString().split('T')[0]}`);
    }
}

/**
 * Calculate position size based on risk parameters
 */
export function calculatePositionSize(
    capital: number,
    entryPrice: number,
    stopLoss: number
): number {
    const riskAmount = capital * RISK_CONFIG.MAX_RISK_PER_TRADE;
    const riskPerShare = Math.abs(entryPrice - stopLoss);

    if (riskPerShare <= 0) {
        return RISK_CONFIG.MIN_POSITION_SIZE;
    }

    let shares = Math.floor(riskAmount / riskPerShare);

    // Apply max position constraint
    const maxShares = Math.floor((capital * RISK_CONFIG.MAX_POSITION_PCT) / entryPrice);
    shares = Math.min(shares, maxShares);

    // If we can't afford even 1 share based on max pct (or capital is 0), return 0
    if (maxShares < RISK_CONFIG.MIN_POSITION_SIZE) {
        return 0;
    }

    // Apply minimum
    shares = Math.max(shares, RISK_CONFIG.MIN_POSITION_SIZE);

    return shares;
}

/**
 * Record a completed trade and update risk state
 */
export function recordTrade(pnl: number, rMultiple: number): void {
    riskState.dailyPnL += pnl;
    riskState.dailyTradeCount += 1;
    riskState.currentEquity += pnl;
    riskState.monthlyR += rMultiple;

    // Update peak equity
    if (riskState.currentEquity > riskState.peakEquity) {
        riskState.peakEquity = riskState.currentEquity;
    }

    // Update rolling drawdown
    riskState.rollingDrawdown = (riskState.peakEquity - riskState.currentEquity) / riskState.peakEquity;

    // Check kill switch after trade
    checkKillSwitch();
}

/**
 * Get current risk state summary
 */
export function getRiskSummary(): {
    dailyPnL: number;
    dailyTrades: number;
    rollingDD: string;
    tradingEnabled: boolean;
    monthlyR: number;
} {
    return {
        dailyPnL: riskState.dailyPnL,
        dailyTrades: riskState.dailyTradeCount,
        rollingDD: `${(riskState.rollingDrawdown * 100).toFixed(2)}%`,
        tradingEnabled: !riskState.tradingDisabled,
        monthlyR: riskState.monthlyR,
    };
}

/**
 * Reset monthly R tracker (call at start of each month)
 */
export function resetMonthlyR(): void {
    riskState.monthlyR = 0;
}

/**
 * Get current equity
 */
export function getCurrentEquity(): number {
    return riskState.currentEquity;
}

/**
 * Force reset risk state (for testing/debugging)
 */
export function resetRiskState(equity: number = 100000): void {
    riskState = {
        dailyPnL: 0,
        dailyTradeCount: 0,
        rollingDrawdown: 0,
        peakEquity: equity,
        currentEquity: equity,
        lastTradeDate: '',
        tradingDisabled: false,
        disabledUntil: null,
        monthlyR: 0,
    };
}
