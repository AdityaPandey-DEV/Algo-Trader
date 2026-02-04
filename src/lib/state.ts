// Shared Trading State (Module-Level Singleton)
// Refactored for Per-Broker Data Isolation ("Virtual Environments")

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

// 1. Broker-Specific State (The "Virtual Environment")
export interface BrokerState {
    pnl: number;
    risk_consumed: number;
    max_drawdown: number;
    broker_balance: number;
    initial_capital: number;
    positions: Position[];
    planned_trades: PlannedTrade[];
    equity_history: Array<{ time: string; equity: number }>;
    kill_switch: boolean;
    logs: string[]; // Isolated logs
}

// 2. Global State (Shared across all brokers)
interface InternalState {
    broker_mode: BrokerMode;
    regime: MarketRegime | string;
    tsd_count: number;
    watchlist: string[];
    // logs removed from global
    current_symbol: string;
    system_state: SystemState;

    // The Isolated Environments
    brokers: Record<BrokerMode, BrokerState>;
}

// 3. Public Interface (Backward Compatible View)
export interface TradingState extends BrokerState {
    broker_mode: BrokerMode;
    regime: MarketRegime | string;
    tsd_count: number;
    watchlist: string[];
    // logs included via BrokerState extension
    current_symbol: string;
    system_state: SystemState;
    paper_mode: boolean; // Computed
    quotes: Record<string, any>; // Market data quotes for dashboard display

    // Expose raw brokers for advanced frontend features
    all_brokers?: Record<BrokerMode, BrokerState>;
}

const defaultBrokerState: BrokerState = {
    pnl: 0,
    risk_consumed: 0,
    max_drawdown: 1.5,
    broker_balance: 0,
    initial_capital: 0,
    positions: [],
    planned_trades: [],
    equity_history: [],
    kill_switch: false,
    logs: ['[SYSTEM] Algo Trader Engine initialized.']
};

const initialState: InternalState = {
    broker_mode: 'PAPER',
    regime: 'RANGE_NEUTRAL',
    tsd_count: 0,
    current_symbol: 'MULTI',
    system_state: 'IDLE',
    watchlist: [
        'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
        'SBIN', 'LT', 'AXISBANK', 'BHARTIARTL', 'ITC',
        'GOLDBEES', 'SILVERBEES', 'NIFTYBEES', 'BANKBEES', 'LIQUIDBEES'
    ],
    // Global logs removed
    brokers: {
        PAPER: { ...defaultBrokerState, initial_capital: 100000, broker_balance: 100000, equity_history: [{ time: new Date().toLocaleTimeString(), equity: 100000 }] },
        DHAN: { ...defaultBrokerState },
        UPSTOX: { ...defaultBrokerState }
    }
};

// Global state reference
let state: InternalState = JSON.parse(JSON.stringify(initialState)); // Deep copy to avoid ref issues

// Computed View for Backward Compatibility
export function getState(): TradingState {
    const activeBroker = state.brokers[state.broker_mode];
    return {
        ...activeBroker,
        broker_mode: state.broker_mode,
        regime: state.regime,
        tsd_count: state.tsd_count,
        watchlist: state.watchlist,
        current_symbol: state.current_symbol,
        system_state: state.system_state,
        paper_mode: state.broker_mode === 'PAPER',
        quotes: (state as any).quotes || {}, // Market data quotes
        all_brokers: state.brokers
    };
}

// Update Functions - Now target the ACTIVE broker
export function updateState(partial: Partial<TradingState>) {
    // Separate global props from broker props
    const globalKeys = ['broker_mode', 'regime', 'tsd_count', 'watchlist', 'current_symbol', 'system_state', 'quotes'];
    const activeBroker = state.brokers[state.broker_mode];

    Object.keys(partial).forEach(key => {
        if (globalKeys.includes(key)) {
            (state as any)[key] = (partial as any)[key];
        } else if (key in activeBroker) {
            (activeBroker as any)[key] = (partial as any)[key];
        }
    });
}

export function resetState() {
    state = JSON.parse(JSON.stringify(initialState));
}

export function addLog(message: string) {
    const timestamp = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const active = state.brokers[state.broker_mode];
    active.logs = [`[${timestamp}] ${message}`, ...active.logs.slice(0, 49)];
}

export function updateEquity() {
    // Updates equity history for the ACTIVE broker only
    const active = state.brokers[state.broker_mode];
    const equity = active.initial_capital + active.pnl;
    active.equity_history = [
        ...active.equity_history.slice(-99),
        { time: new Date().toLocaleTimeString(), equity }
    ];
}

// Kill Switch is now Per-Broker
export function setKillSwitch(active: boolean) {
    state.brokers[state.broker_mode].kill_switch = active;
    if (active) {
        addLog(`🚨 KILL SWITCH ACTIVATED (${state.broker_mode})`);
    } else {
        addLog(`✅ Kill switch deactivated (${state.broker_mode})`);
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
    const active = state.brokers[state.broker_mode];
    active.positions = [];
    active.pnl = 0;
    active.risk_consumed = 0;
}

export function getDailyPnL(): number {
    return state.brokers[state.broker_mode].pnl;
}

export function getRiskConsumed(): number {
    return state.brokers[state.broker_mode].risk_consumed;
}

export function isKillSwitchActive(): boolean {
    return state.brokers[state.broker_mode].kill_switch;
}

export function setBrokerMode(mode: BrokerMode) {
    if (state.broker_mode !== mode) {
        state.broker_mode = mode;
        // No need to reset history anymore! Each broker has its own persistent history.
        addLog(`🔄 Switched to ${mode} broker`);
    }
}

export function updateBrokerBalance(balance: number) {
    const active = state.brokers[state.broker_mode];
    active.broker_balance = balance;
    // Sync initial capital for live brokers to ensure equity curve is accurate
    // Only necessary if PnL is reset or if we treat balance as starting point
    if (state.broker_mode !== 'PAPER') {
        active.initial_capital = balance;
    }
}

export function getBrokerMode(): BrokerMode {
    return state.broker_mode;
}

// Helper to access specific broker state (internal use)
export function getBrokerState(mode: BrokerMode): BrokerState {
    return state.brokers[mode];
}
