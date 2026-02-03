// Shared Trading State (Module-Level Singleton)
// This state persists across API calls within the same serverless instance lifetime.
// For true persistence across deployments, use Vercel KV or a database.

import { MarketRegime } from './regimeEngine';
import { SystemState } from './stateMachine';

export interface Position {
    symbol: string;
    side: string;
    entry: number;
    current: number;
    qty: number;
    pnl: number;
}

export interface PlannedTrade {
    symbol: string;
    side: string;
    entry: number;
    target: string;
    stop: string;
    current?: number;
}

export type BrokerMode = 'PAPER' | 'DHAN' | 'UPSTOX';

export interface TradingState {
    // Core metrics
    pnl: number;
    risk_consumed: number;
    max_drawdown: number;

    // Regime tracking
    regime: MarketRegime | string;
    tsd_count: number;

    // Broker & Mode controls
    broker_mode: BrokerMode;
    broker_balance: number;
    paper_mode: boolean; // Deprecated - use broker_mode === 'PAPER'
    initial_capital: number;
    kill_switch: boolean;

    // Current activity
    current_symbol: string;
    system_state: SystemState;

    // Positions & trades
    positions: Position[];
    planned_trades: PlannedTrade[];
    watchlist: string[];

    // Logging
    logs: string[];
    equity_history: Array<{ time: string; equity: number }>;
}

const initialState: TradingState = {
    pnl: 0,
    risk_consumed: 0,
    max_drawdown: 1.5,
    regime: 'RANGE_NEUTRAL',
    tsd_count: 0,
    broker_mode: 'PAPER',
    broker_balance: 100000,
    paper_mode: true,
    initial_capital: 100000,
    kill_switch: false,
    current_symbol: 'MULTI',
    system_state: 'IDLE',
    positions: [],
    planned_trades: [],
    watchlist: [
        'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
        'SBIN', 'LT', 'AXISBANK', 'BHARTIARTL', 'ITC',
        'GOLDBEES', 'SILVERBEES', 'NIFTYBEES', 'BANKBEES', 'LIQUIDBEES'
    ],
    logs: ['[SYSTEM] Algo Trader Engine initialized.'],
    equity_history: [{ time: new Date().toLocaleTimeString(), equity: 100000 }]
};

// Global state reference
let state: TradingState = { ...initialState };

export function getState(): TradingState {
    return state;
}

export function updateState(partial: Partial<TradingState>) {
    state = { ...state, ...partial };
}

export function resetState() {
    state = { ...initialState };
}

export function addLog(message: string) {
    const timestamp = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    state.logs = [`[${timestamp}] ${message}`, ...state.logs.slice(0, 49)];
}

export function updateEquity() {
    const equity = state.initial_capital + state.pnl;
    state.equity_history = [
        ...state.equity_history.slice(-99),
        { time: new Date().toLocaleTimeString(), equity }
    ];
}

// New helper functions for workflow

export function setKillSwitch(active: boolean) {
    state.kill_switch = active;
    if (active) {
        addLog('🚨 KILL SWITCH ACTIVATED');
    } else {
        addLog('✅ Kill switch deactivated');
    }
}

export function setRegime(regime: MarketRegime, tsdCount: number) {
    state.regime = regime;
    state.tsd_count = tsdCount;
}

export function setSystemState(systemState: SystemState) {
    state.system_state = systemState;
}

export function clearPositions() {
    state.positions = [];
    state.pnl = 0;
    state.risk_consumed = 0;
}

export function getDailyPnL(): number {
    return state.pnl;
}

export function getRiskConsumed(): number {
    return state.risk_consumed;
}

export function isKillSwitchActive(): boolean {
    return state.kill_switch;
}

export function setBrokerMode(mode: BrokerMode) {
    state.broker_mode = mode;
    state.paper_mode = mode === 'PAPER';
    addLog(`🔄 Switched to ${mode} broker`);
}

export function updateBrokerBalance(balance: number) {
    state.broker_balance = balance;
}

export function getBrokerMode(): BrokerMode {
    return state.broker_mode;
}
