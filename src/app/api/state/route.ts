import { NextResponse } from 'next/server';
import { getState, updateState, addLog, updateEquity } from '@/lib/state';
import { getMarketInfo, isMarketOpen } from '@/lib/marketHours';
import { isDhanConfigured } from '@/lib/dhanApi';

export async function GET() {
    const state = getState();
    const marketInfo = getMarketInfo();
    const dhanConfigured = isDhanConfigured();

    // Determine data source indicator
    let dataSource = 'MOCK';
    if (isMarketOpen() && dhanConfigured) {
        dataSource = state.paper_mode ? 'DHAN_PAPER' : 'DHAN_LIVE';
    }

    // Update equity on each poll
    updateEquity();

    return NextResponse.json({
        ...state,
        market_status: marketInfo.status,
        market_message: marketInfo.message,
        data_source: dataSource,
        dhan_configured: dhanConfigured
    });
}
