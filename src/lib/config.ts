// Trading Configuration
export const CONFIG = {
    // Strategy Parameters
    TARGET_TREND_MULT: 0.5,
    WICK_RATIO: 0.3,  // Relaxed from 1.0
    VOLUME_RATIO: 0.7, // Relaxed from 1.0

    // Risk Management
    MAX_DRAWDOWN: 1.5,
    MAX_DAILY_LOSS: 5000, // ₹5,000 max loss per day
    RISK_PER_TRADE: 0.01, // 1% of capital per trade

    // Regime Thresholds
    TSD_THRESHOLD_A: 3,
    TSD_THRESHOLD_B: 7,

    // Watchlist (Top NSE Stocks + ETFs)
    WATCHLIST: [
        "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
        "SBIN", "AXISBANK", "BHARTIARTL", "ITC", "LT",
        "KOTAKBANK", "WIPRO", "MARUTI", "TITAN", "SUNPHARMA",
        "BAJFINANCE", "NESTLEIND", "ADANIENT", "TATASTEEL", "POWERGRID",
        // ETFs for V2 Swing Engine
        "GOLDBEES", "SILVERBEES", "NIFTYBEES", "BANKBEES", "LIQUIDBEES"
    ]
};
