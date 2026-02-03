import { NextResponse } from 'next/server';
import { getState, updateState, updateEquity } from '@/lib/state';
import { getMarketInfo } from '@/lib/marketHours';
import { isDhanConfigured, getBalance } from '@/lib/dhanApi';
import { fetchUpstoxFullQuotes, isUpstoxAuthenticatedAsync } from '@/lib/upstoxApi';
import { initRiskEngine } from '@/lib/riskEngine';

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
    const hasUpstoxToken = await isUpstoxAuthenticatedAsync();

    if (dhanConfigured) {
        // Always show Dhan connection if configured, regardless of market hours
        dataSource = state.paper_mode ? 'PAPER' : 'DHAN_LIVE';
    } else if (hasUpstoxToken) {
        // Upstox is connected (even if market closed)
        dataSource = state.paper_mode ? 'UPSTOX_PAPER' : 'UPSTOX_LIVE';
    }

    // Fetch real balance from Dhan in LIVE mode (even when market closed!)
    let effectiveCapital = state.initial_capital;

    if (!state.paper_mode && dhanConfigured) {
        const now = Date.now();
        if (now - lastBalanceFetch > BALANCE_CACHE_MS || cachedBalance === 0) {
            try {
                const balanceResult = await getBalance();
                const realBalance = balanceResult?.available ?? null;

                // FIXED: Allow 0 balance (for empty accounts)
                if (realBalance !== null && realBalance >= 0) {
                    cachedBalance = realBalance;
                    lastBalanceFetch = now;
                    // Update state and sync Risk Engine
                    updateState({ initial_capital: realBalance });
                    initRiskEngine(realBalance);
                    effectiveCapital = realBalance;
                }
            } catch (e) {
                console.error('Balance fetch error:', e);
                // Use cached balance if fetch fails (only if we have a valid cache)
                if (cachedBalance >= 0 && lastBalanceFetch > 0) {
                    effectiveCapital = cachedBalance;
                }
            }
        } else {
            effectiveCapital = cachedBalance;
        }
    }

    // NEW: Fetch live quotes using UPSTOX (User's preferred data source)
    let quotes: Record<string, any> = {};

    // Always attempt Upstox fetch if we have a watchlist, regardless of Dhan status
    if (state.watchlist.length > 0) {
        try {
            // Assume User has Upstox configured if they are asking for it
            const upstoxQuotes = await fetchUpstoxFullQuotes(state.watchlist);

            // Transform Upstox format to match UI expected format
            Object.keys(upstoxQuotes).forEach(sym => {
                const q = upstoxQuotes[sym];
                if (q) {
                    quotes[sym] = {
                        close: q.lastPrice,
                        // Use net_change from Upstox, or calculate if missing
                        change: q.change,
                        changePercent: (q.change / (q.lastPrice - q.change)) * 100
                    };
                }
            });
        } catch (e) {
            console.error('Upstox quote fetch failed:', e);
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
        dhan_configured: dhanConfigured,
        has_upstox_token: await isUpstoxAuthenticatedAsync(), // DEBUG: Check if token exists
        quotes: quotes // Return the Upstox quotes
    });
}
