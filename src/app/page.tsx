"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart, Area, XAxis, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  Shield, TrendingUp, BarChart3, Database,
  Search, Briefcase, Zap, Power, Coins, MousePointer2
} from 'lucide-react';

// Types
interface TradingState {
  pnl: number;
  risk_consumed: number;
  max_drawdown: number;
  regime: string;
  tsd_count: number;
  paper_mode: boolean;
  initial_capital: number;
  kill_switch: boolean;
  current_symbol: string;
  positions: Array<{ symbol: string; side: string; entry: number; current: number; qty: number; pnl: number }>;
  planned_trades: Array<{ symbol: string; side: string; entry: number; target: string; stop: string; current?: number }>;
  watchlist: string[];
  logs: string[];
  equity_history: Array<{ time: string; equity: number }>;
  market_status?: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'POST_MARKET';
  market_message?: string;
  data_source?: string;
  dhan_configured?: boolean;
  quotes?: Record<string, { close: number; change: number; changePercent: number }>;
}

// Initial Mock State
const INITIAL_STATE: TradingState = {
  pnl: 0, risk_consumed: 0, max_drawdown: 1.5, regime: "REGIME_A", tsd_count: 0,
  paper_mode: true, initial_capital: 100000, kill_switch: false, current_symbol: "MULTI",
  positions: [], planned_trades: [], watchlist: ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK"],
  logs: ["[SYSTEM] Engine initialized."], equity_history: []
};

export default function Dashboard() {
  const [data, setData] = useState<TradingState | null>(null);
  const [capitalInput, setCapitalInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [showMarketBanner, setShowMarketBanner] = useState(true);

  // Fetch State from API
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const state = await res.json();
        setData(state);
      }
    } catch (e) {
      console.error("Failed to fetch state:", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Trigger tick and poll state every 5 seconds
  useEffect(() => {
    const runTick = async () => {
      try {
        await fetch('/api/tick', { method: 'POST' });
      } catch (e) {
        console.error('Tick failed:', e);
      }
      fetchState();
    };

    runTick(); // Initial tick
    const interval = setInterval(runTick, 5000);
    return () => clearInterval(interval);
  }, [fetchState]);

  const toggleKillSwitch = async () => {
    await fetch('/api/killswitch', { method: 'POST' });
    fetchState();
  };

  const togglePaperMode = async () => {
    await fetch('/api/toggle_paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !data?.paper_mode })
    });
    fetchState();
  };

  const updateCapital = async () => {
    if (!capitalInput) return;
    try {
      await fetch('/api/set_capital', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: parseFloat(capitalInput) })
      });
      setCapitalInput("");
      fetchState();
    } catch (e) {
      alert("Failed to update capital: " + e);
    }
  };

  if (isLoading || !data) return (
    <div className="loading">
      <div className="spinner"></div>
      <p>Syncing with Trading Engine...</p>
    </div>
  );

  const pnlColor = data.pnl >= 0 ? '#10b981' : '#ef4444';

  return (
    <div className="dashboard-container">
      {/* 1. PORTFOLIO HEALTH HEADER */}
      <header className="portfolio-header">
        <div className="header-left">
          <h1><Shield size={28} className="icon-shield" /> Algo Trader <span className="text-muted">Pro</span></h1>
          <div className="regime-badge">
            <span className="label">MARKET REGIME</span>
            <span className={`value ${data.regime === 'TRENDING' ? 'trend' : 'chop'}`}>
              {data.regime.replace('_', ' ')}
            </span>
          </div>
        </div>

        <div className="header-right">
          <div className="status-pill live">
            <span className="dot"></span> {data.market_status === 'OPEN' ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </div>
          <button className="mode-toggle" onClick={togglePaperMode}>
            {data.paper_mode ? '📝 PAPER TRADING' : '🔥 LIVE EXECUTION'}
          </button>
        </div>
      </header>

      {/* 2. CAPITAL ALLOCATION BAR */}
      <section className="allocation-section">
        <div className="allocation-bar">
          <div className="segment swing" style={{ width: '70%' }}>
            <span>V2 SWING ENGINE (70%)</span>
          </div>
          <div className="segment intraday" style={{ width: '30%' }}>
            <span>V3 INTRADAY (30%)</span>
          </div>
        </div>
      </section>

      {/* 3. ENGINE GRID */}
      <div className="engine-grid">
        {/* V2 SWING ENGINE */}
        <div className="engine-card swing-card">
          <div className="card-header">
            <h3><TrendingUp size={20} /> V2 SWING ENGINE</h3>
            <span className="badge">WEALTH</span>
          </div>
          <div className="card-metrics">
            <div className="metric">
              <span className="label">Allocation</span>
              <span className="value">₹{(data.initial_capital * 0.7).toLocaleString()}</span>
            </div>
            <div className="metric">
              <span className="label">Status</span>
              <span className="value status-active">ACTIVE</span>
            </div>
            <div className="metric">
              <span className="label">Open Risk</span>
              <span className="value text-neutral">0.00%</span>
            </div>
          </div>
        </div>

        {/* V3 INTRADAY ENGINE */}
        <div className="engine-card intraday-card">
          <div className="card-header">
            <h3><Shield size={20} /> V3 INTRADAY ENGINE</h3>
            <span className="badge">SAFETY</span>
          </div>
          <div className="card-metrics">
            <div className="metric">
              <span className="label">Allocation</span>
              <span className="value">₹{(data.initial_capital * 0.3).toLocaleString()}</span>
            </div>
            <div className="metric">
              <span className="label">Risk Consumed</span>
              <span className="value">{data.risk_consumed.toFixed(2)}% <span className="sub">/ {data.max_drawdown}%</span></span>
            </div>
            <div className="metric">
              <span className="label">Daily P&L</span>
              <span className="value" style={{ color: pnlColor }}>₹{data.pnl.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      <main className="main-layout">
        <div className="center-panel">
          {/* EQUITY CURVE */}
          <div className="glass-card">
            <h3 className="section-title"><BarChart3 size={18} /> Portfolio Equity Curve</h3>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={data.equity_history && data.equity_history.length > 0 ? data.equity_history : [{ time: 'Now', equity: data.initial_capital }]}>
                  <defs>
                    <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" hide={true} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b' }} itemStyle={{ color: '#fff' }} />
                  <Area type="monotone" dataKey="equity" stroke="#6366f1" fillOpacity={1} fill="url(#colorEquity)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* COMBINED POSITIONS */}
          <div className="glass-card mt-4">
            <h3 className="section-title"><Briefcase size={18} /> Active Portfolio Positions</h3>
            <table className="position-table">
              <thead><tr><th>Engine</th><th>Symbol</th><th>Side</th><th>Entry</th><th>LTP</th><th>PnL</th></tr></thead>
              <tbody>
                {data.positions?.map((pos, i) => (
                  <tr key={i}>
                    <td><span className="badge-engine">V3 INT</span></td>
                    <td className="font-bold">{pos.symbol}</td>
                    <td><span className={`badge ${pos.side === 'SHORT' ? 'badge-short' : 'badge-long'}`}>{pos.side}</span></td>
                    <td>{pos.entry.toFixed(2)}</td>
                    <td>{pos.current.toFixed(2)}</td>
                    <td style={{ color: pos.pnl >= 0 ? '#10b981' : '#ef4444' }} className="font-bold">₹{pos.pnl.toFixed(2)}</td>
                  </tr>
                ))}
                {(!data.positions || data.positions.length === 0) && (
                  <tr><td colSpan={6} className="text-center text-muted p-4">No active positions across engines</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* RESTORED: STRATEGIC PLANNING (V3 Opportunity Map) */}
          <div className="glass-card mt-4">
            <h3 className="section-title"><Zap size={18} /> V3 Intraday Scanners</h3>
            <div className="split-tables">
              {/* LONG */}
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <TrendingUp size={14} /> BULLISH ZONES
                </p>
                <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid var(--glass-border)', borderRadius: '6px', background: 'rgba(0,0,0,0.2)' }}>
                  <table className="position-table" style={{ margin: 0 }}>
                    <thead style={{ position: 'sticky', top: 0, background: '#0f172a', zIndex: 1 }}>
                      <tr><th>Symbol</th><th>LTP</th><th>Trigger</th><th>Target</th></tr>
                    </thead>
                    <tbody>
                      {data.planned_trades?.filter((t: any) => t.side === 'LONG').length > 0 ? (
                        data.planned_trades?.filter((t: any) => t.side === 'LONG').map((trade: any, i: number) => (
                          <tr key={`${trade.symbol}-LONG-${i}`}>
                            <td className="font-bold">{trade.symbol}</td>
                            <td className="text-muted">₹{trade.current?.toFixed(2) || '--'}</td>
                            <td style={{ color: '#10b981', fontWeight: 600 }}>₹{trade.entry}</td>
                            <td style={{ color: '#34d399', fontSize: '0.75rem' }}>{trade.target}</td>
                          </tr>
                        ))) : (
                        <tr><td colSpan={4} className="text-center text-muted" style={{ padding: '2rem' }}>No bullish setups detected</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SHORT */}
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '0.75rem', color: '#ef4444', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <TrendingUp size={14} style={{ transform: 'rotate(90deg)' }} /> BEARISH ZONES
                </p>
                <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid var(--glass-border)', borderRadius: '6px', background: 'rgba(0,0,0,0.2)' }}>
                  <table className="position-table" style={{ margin: 0 }}>
                    <thead style={{ position: 'sticky', top: 0, background: '#0f172a', zIndex: 1 }}>
                      <tr><th>Symbol</th><th>LTP</th><th>Trigger</th><th>Target</th></tr>
                    </thead>
                    <tbody>
                      {data.planned_trades?.filter((t: any) => t.side === 'SHORT').length > 0 ? (
                        data.planned_trades?.filter((t: any) => t.side === 'SHORT').map((trade: any, i: number) => (
                          <tr key={`${trade.symbol}-SHORT-${i}`}>
                            <td className="font-bold">{trade.symbol}</td>
                            <td className="text-muted">₹{trade.current?.toFixed(2) || '--'}</td>
                            <td style={{ color: '#ef4444', fontWeight: 600 }}>₹{trade.entry}</td>
                            <td style={{ color: '#34d399', fontSize: '0.75rem' }}>{trade.target}</td>
                          </tr>
                        ))) : (
                        <tr><td colSpan={4} className="text-center text-muted" style={{ padding: '2rem' }}>No bearish setups detected</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* SIDEBAR: LOGS & WATCHLIST */}
        <div className="side-panel">
          <div className="glass-card">
            <h3 className="section-title"><Search size={18} /> Engine Watchlist</h3>
            <div className="watchlist-grid" style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '4px' }}>
              {data.watchlist?.map((symbol, i) => {
                const quote = data.quotes?.[symbol];
                const isPositive = (quote?.change || 0) > 0;
                return (
                  <div className="watchlist-item" key={i}>
                    <div>
                      <p className="symbol-name">{symbol}</p>
                      {quote ? (
                        <p className="symbol-status" style={{ fontSize: '0.8rem' }}>
                          <span style={{ color: '#fff', fontWeight: 600 }}>₹{quote.close.toFixed(2)}</span>
                          <span style={{ marginLeft: '6px', color: isPositive ? '#10b981' : '#ef4444' }}>
                            {isPositive ? '+' : ''}{quote.changePercent?.toFixed(2)}%
                          </span>
                        </p>
                      ) : (
                        <p className="symbol-status">Monitoring</p>
                      )}
                    </div>
                    <span className="badge-engine">V3</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="glass-card mt-4">
            <h3 className="section-title"><Database size={18} /> System Logs</h3>
            <div className="logs-container" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {data.logs?.map((log, i) => (
                <div key={i} className="log-entry">
                  <span className="log-marker"></span> {log}
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      <div className="footer-control" style={{ marginTop: '2rem', display: 'flex', justifyContent: 'center' }}>
        <button
          className={`primary-btn ${data.kill_switch ? 'danger' : ''}`}
          onClick={toggleKillSwitch}
          style={{ width: '200px' }}
        >
          <Power size={18} style={{ marginRight: '8px' }} />
          {data.kill_switch ? 'RESUME TRADING' : 'EMERGENCY STOP'}
        </button>
      </div>
    </div>
  );
}
