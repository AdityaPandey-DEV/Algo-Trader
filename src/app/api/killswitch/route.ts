// import { getDescription } from '@/lib/regimeEngine'; // Removed invalid import
import { loadTradingState, saveTradingState } from '@/lib/storage';
import { getState, updateState, addLog } from '@/lib/state';
import { NextResponse } from 'next/server';
import { isDhanConfigured } from '@/lib/dhanApi';
import { isUpstoxAuthenticatedAsync } from '@/lib/upstoxApi';

export async function POST() {
    // 0. Hydrate state logic
    const persistedState = await loadTradingState();
    if (persistedState) {
        updateState(persistedState);
    }

    const state = getState();
    const isCurrentlyStopped = state.kill_switch;
    const willBeRunning = isCurrentlyStopped; // Toggling: Stopped -> Running (true -> false is wrong logic in prev code? Let's check)
    // Actually state.kill_switch = true means STOPPED.
    // So if we want to START, we are setting kill_switch to FALSE.
    const targetKillSwitchState = !state.kill_switch;

    // IF WE ARE TRYING TO RESUME (Target = FALSE), CHECK CONNECTION
    if (targetKillSwitchState === false) {
        if (state.broker_mode === 'DHAN') {
            if (!isDhanConfigured()) {
                return NextResponse.json({
                    status: 'error',
                    message: '❌ Cannot Resume: Dhan configuration missing (Env vars)'
                }, { status: 400 });
            }
        } else if (state.broker_mode === 'UPSTOX') {
            const isConnected = await isUpstoxAuthenticatedAsync();
            if (!isConnected) {
                return NextResponse.json({
                    status: 'error',
                    message: '❌ Cannot Resume: Upstox Token missing or expired. Please Login.'
                }, { status: 400 });
            }
        }
    }

    updateState({ kill_switch: targetKillSwitchState });
    addLog(`Kill Switch ${targetKillSwitchState ? 'ACTIVATED' : 'DEACTIVATED'}`);

    // Persist immediately so it survives restart
    await saveTradingState(getState());

    return NextResponse.json({ status: targetKillSwitchState ? "STOPPED" : "ARMED", kill_switch: targetKillSwitchState });
}
