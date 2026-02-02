import { NextResponse } from 'next/server';
import { getState, updateState, updateEquity } from '@/lib/state';
import { getMarketInfo, isMarketOpen } from '@/lib/marketHours';
import { isDhanConfigured, getBalance } from '@/lib/dhanApi';

// Cache for balance to avoid too many API calls
let cachedBalance = 0;
let lastBalanceFetch = 0;
const BALANCE_CACHE_MS = 60000; // 1 minute cache

export async function GET() {
    const state = getState();
    const marketInfo = getMarketInfo();
    const dhanConfigured = isDhanConfigured();

    // Determine data source indicator
    let dataSource = 'MOCK';
    if (dhanConfigured) {
        // Always show Dhan connection if configured, regardless of market hours
        dataSource = state.paper_mode ? 'PAPER' : 'DHAN_LIVE';
    }

    // Fetch real balance from Dhan in LIVE mode (even when market closed!)
    let effectiveCapital = state.initial_capital;

    if (!state.paper_mode && dhanConfigured) {
        const now = Date.now();
        if (now - lastBalanceFetch > BALANCE_CACHE_MS || cachedBalance === 0) {
            try {
                const balanceResult = await getBalance();
                const realBalance = balanceResult?.available ?? null;
                if (realBalance !== null && realBalance > 0) {
                    cachedBalance = realBalance;
                    lastBalanceFetch = now;
                    // Update state with real balance
                    updateState({ initial_capital: realBalance });
                    effectiveCapital = realBalance;
                }
            } catch (e) {
                console.error('Balance fetch error:', e);
                // Use cached balance if fetch fails
                if (cachedBalance > 0) {
                    effectiveCapital = cachedBalance;
                }
            }
        } else {
            effectiveCapital = cachedBalance;
        }
    }

    // Update equity on each poll
    updateEquity();

    return NextResponse.json({
        ...state,
        initial_capital: effectiveCapital,
        market_status: marketInfo.status,
        market_message: marketInfo.message,
        data_source: dataSource,
        dhan_configured: dhanConfigured
    });
}
