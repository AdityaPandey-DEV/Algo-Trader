// Market Hours Utility for NSE
// Trading Hours: 9:15 AM - 3:30 PM IST (Mon-Fri)

export type MarketStatus = 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'POST_MARKET';

interface MarketInfo {
    status: MarketStatus;
    message: string;
    nextOpen?: string;
    timeToClose?: string;
}

// Get current IST time
function getISTTime(): Date {
    const now = new Date();
    // Convert to IST (UTC+5:30)
    const istOffset = 5.5 * 60 * 60 * 1000;
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    return new Date(utcTime + istOffset);
}

// Check if today is a trading day (Mon-Fri, excluding holidays)
function isTradingDay(): boolean {
    const ist = getISTTime();
    const day = ist.getDay();
    // 0 = Sunday, 6 = Saturday
    return day >= 1 && day <= 5;
}

// Market hours in IST
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 15;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MINUTE = 30;
const PRE_MARKET_START_HOUR = 9;
const PRE_MARKET_START_MINUTE = 0;

export function isMarketOpen(): boolean {
    if (!isTradingDay()) return false;

    const ist = getISTTime();
    const hour = ist.getHours();
    const minute = ist.getMinutes();
    const currentMinutes = hour * 60 + minute;

    const openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;

    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

export function getMarketStatus(): MarketStatus {
    const ist = getISTTime();
    const day = ist.getDay();

    // Weekend
    if (day === 0 || day === 6) return 'CLOSED';

    const hour = ist.getHours();
    const minute = ist.getMinutes();
    const currentMinutes = hour * 60 + minute;

    const preMarketMinutes = PRE_MARKET_START_HOUR * 60 + PRE_MARKET_START_MINUTE;
    const openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;

    if (currentMinutes >= openMinutes && currentMinutes < closeMinutes) {
        return 'OPEN';
    } else if (currentMinutes >= preMarketMinutes && currentMinutes < openMinutes) {
        return 'PRE_MARKET';
    } else if (currentMinutes >= closeMinutes && currentMinutes < closeMinutes + 60) {
        return 'POST_MARKET';
    }
    return 'CLOSED';
}

export function getMarketInfo(): MarketInfo {
    const status = getMarketStatus();
    const ist = getISTTime();

    switch (status) {
        case 'OPEN':
            const closeTime = new Date(ist);
            closeTime.setHours(MARKET_CLOSE_HOUR, MARKET_CLOSE_MINUTE, 0);
            const remaining = closeTime.getTime() - ist.getTime();
            const hours = Math.floor(remaining / (60 * 60 * 1000));
            const mins = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
            return {
                status: 'OPEN',
                message: 'Market is OPEN',
                timeToClose: `${hours}h ${mins}m`
            };
        case 'PRE_MARKET':
            return {
                status: 'PRE_MARKET',
                message: 'Pre-market session (9:00-9:15)',
                nextOpen: '9:15 AM'
            };
        case 'POST_MARKET':
            return {
                status: 'POST_MARKET',
                message: 'Post-market session',
                nextOpen: 'Tomorrow 9:15 AM'
            };
        default:
            return {
                status: 'CLOSED',
                message: 'Market is CLOSED',
                nextOpen: isTradingDay() ? '9:15 AM' : 'Monday 9:15 AM'
            };
    }
}
