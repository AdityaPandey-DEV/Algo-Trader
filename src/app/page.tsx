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
      {/* Market Status Banner - Only in LIVE mode */}
      {showMarketBanner && !data.paper_mode && (
        <div style={{
          background: data.market_status === 'OPEN' ? '#10b981' : '#ef4444',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <span style={{ color: '#fff', fontWeight: 700 }}>
            {data.market_status === 'OPEN' ? '🟢 MARKET OPEN' : '🔴 MARKET CLOSED'} — {data.data_source || 'MOCK'}
          </span>
          <button
            onClick={() => setShowMarketBanner(false)}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              color: '#fff',
              padding: '4px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 700
            }}
          >
            ✕
          </button>
        </div>
      )}

      <header>
        <div className="title-section">
          <h1><Shield size={32} /> AG_TRADER <span className="badge badge-long">{data.regime}</span></h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          {data.paper_mode && (
            <div className="glass-card" style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', border: '1px solid #334155' }}>
              <Coins size={16} color="#fbbf24" />
              <input
                type="number"
                placeholder={`₹${data.initial_capital}`}
                value={capitalInput}
                onChange={(e) => setCapitalInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && updateCapital()}
                style={{ background: 'transparent', border: 'none', color: '#fff', width: '90px', fontSize: '0.85rem', outline: 'none' }}
              />
              <button onClick={updateCapital} style={{ background: 'rgba(99, 102, 241, 0.2)', border: '1px solid #6366f1', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer' }}>
                <TrendingUp size={14} color="#6366f1" />
              </button>
            </div>
          )}

          {/* Paper/Live Mode Toggle - Always enabled */}
          <button
            onClick={togglePaperMode}
            style={{
              backgroundColor: data.paper_mode ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: data.paper_mode ? '#10b981' : '#ef4444',
              color: data.paper_mode ? '#10b981' : '#ef4444',
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 16px', borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            <MousePointer2 size={16} />
            {data.paper_mode ? 'PAPER MODE' : '🔥 LIVE MODE'}
          </button>

          <button
            className={`primary ${data.kill_switch ? 'danger' : ''}`}
            onClick={toggleKillSwitch}
            style={{ backgroundColor: data.kill_switch ? '#ef4444' : '#6366f1', border: 'none' }}
          >
            <Power size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
            {data.kill_switch ? 'SYSTEM STOPPED' : 'SYSTEM ARMED'}
          </button>

          <div className="live-tag">
            <span className="pulse"></span> LIVE: {data.current_symbol} {new Date().toLocaleTimeString()}
          </div>
        </div>
      </header>

      <div className="stats-grid">
        <div className="glass-card">
          <p className="stat-label">Daily Net PnL</p>
          <p className="stat-value" style={{ color: pnlColor }}>
            ₹{data.pnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className="glass-card">
          <p className="stat-label">Risk Consumed</p>
          <p className="stat-value">
            {data.risk_consumed.toFixed(2)}% <span style={{ fontSize: '0.8rem', color: '#64748b' }}>/ {data.max_drawdown}%</span>
          </p>
          <div style={{ width: '100%', height: '4px', background: '#1e293b', marginTop: '10px', borderRadius: '2px' }}>
            <div style={{ width: `${(data.risk_consumed / data.max_drawdown) * 100}%`, height: '100%', background: 'var(--primary)', borderRadius: '2px' }}></div>
          </div>
        </div>
        <div className="glass-card">
          <p className="stat-label">Market Regime</p>
          <p className="stat-value" style={{ borderBottom: `2px solid var(--primary)`, display: 'inline-block' }}>
            {data.regime.replace('_', ' ')}
          </p>
          <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '8px' }}>TSD Count: {data.tsd_count} Days</p>
        </div>
        <div className="glass-card">
          <p className="stat-label">Execution Engine</p>
          <p className="stat-value" style={{ color: data.paper_mode ? '#94a3b8' : '#fbbf24' }}>
            {data.paper_mode ? 'PAPER (MOCK)' : 'DHAN LIVE'}
          </p>
          <p style={{ fontSize: '0.7rem', color: '#10b981', marginTop: '8px' }}>● Connected</p>
        </div>
      </div>

      <main className="main-layout">
        <div className="center-panel">
          <div className="glass-card">
            <h3 className="stat-label"><BarChart3 size={16} style={{ marginBottom: '-3px', marginRight: '8px' }} /> Session Equity Curve</h3>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.equity_history || []}>
                  <defs>
                    <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" hide={true} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px' }} itemStyle={{ color: '#fff' }} />
                  <Area type="monotone" dataKey="equity" stroke="#6366f1" fillOpacity={1} fill="url(#colorEquity)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="glass-card">
            <h3 className="stat-label"><Briefcase size={16} style={{ marginBottom: '-3px', marginRight: '8px' }} /> Active Positions</h3>
            <table className="position-table">
              <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>LTP</th><th>Qty</th><th>PnL</th></tr></thead>
              <tbody>
                {data.positions?.map((pos, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 700 }}>{pos.symbol}</td>
                    <td><span className={`badge ${pos.side === 'SHORT' ? 'badge-short' : 'badge-long'}`}>{pos.side}</span></td>
                    <td>{pos.entry.toFixed(2)}</td>
                    <td>{pos.current.toFixed(2)}</td>
                    <td>{pos.qty}</td>
                    <td style={{ color: pos.pnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>₹{pos.pnl.toFixed(2)}</td>
                  </tr>
                ))}
                {(!data.positions || data.positions.length === 0) && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: '#64748b', padding: '2rem' }}>No active positions</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Strategic Trade Planning */}
          <div className="glass-card" style={{ marginTop: '1.5rem' }}>
            <h3 className="stat-label"><Zap size={16} style={{ marginBottom: '-3px', marginRight: '8px' }} /> Strategic Trade Planning</h3>
            <div className="split-tables">
              {/* LONG SETUPS */}
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '0.7rem', color: '#10b981', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={12} /> BULLISH SETUPS (LONG)
                </p>
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #1e293b', borderRadius: '4px' }}>
                  <table className="position-table">
                    <thead style={{ position: 'sticky', top: 0, background: '#0f172a', zIndex: 1 }}>
                      <tr><th>Symbol</th><th>LTP</th><th>Entry</th><th>Target</th><th>SL</th></tr>
                    </thead>
                    <tbody>
                      {data.planned_trades?.filter((t: any) => t.side === 'LONG').slice(0, 10).map((trade: any, i: number) => (
                        <tr key={`${trade.symbol}-LONG-${i}`}>
                          <td style={{ fontWeight: 700 }}>{trade.symbol}</td>
                          <td style={{ color: '#94a3b8' }}>₹{trade.current?.toFixed(2) || '--'}</td>
                          <td style={{ color: '#10b981', fontWeight: 600 }}>₹{trade.entry}</td>
                          <td style={{ color: '#34d399', fontSize: '0.75rem' }}>{trade.target}</td>
                          <td style={{ color: '#f87171', fontSize: '0.75rem' }}>{trade.stop}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SHORT SETUPS */}
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '0.7rem', color: '#ef4444', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={12} style={{ transform: 'rotate(90deg)' }} /> BEARISH SETUPS (SHORT)
                </p>
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #1e293b', borderRadius: '4px' }}>
                  <table className="position-table">
                    <thead style={{ position: 'sticky', top: 0, background: '#0f172a', zIndex: 1 }}>
                      <tr><th>Symbol</th><th>LTP</th><th>Entry</th><th>Target</th><th>SL</th></tr>
                    </thead>
                    <tbody>
                      {data.planned_trades?.filter((t: any) => t.side === 'SHORT').slice(0, 10).map((trade: any, i: number) => (
                        <tr key={`${trade.symbol}-SHORT-${i}`}>
                          <td style={{ fontWeight: 700 }}>{trade.symbol}</td>
                          <td style={{ color: '#94a3b8' }}>₹{trade.current?.toFixed(2) || '--'}</td>
                          <td style={{ color: '#ef4444', fontWeight: 600 }}>₹{trade.entry}</td>
                          <td style={{ color: '#34d399', fontSize: '0.75rem' }}>{trade.target}</td>
                          <td style={{ color: '#f87171', fontSize: '0.75rem' }}>{trade.stop}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="side-panel">
          <div className="glass-card">
            <h3 className="stat-label" style={{ marginBottom: '1rem' }}><Search size={16} style={{ marginBottom: '-3px', marginRight: '8px' }} /> Live Watchlist</h3>
            <div className="watchlist-grid" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {data.watchlist?.map((symbol, i) => (
                <div className="watchlist-item" key={i}>
                  <div>
                    <p style={{ fontWeight: 700, fontSize: '0.9rem' }}>{symbol}</p>
                    <p style={{ fontSize: '0.7rem', color: '#64748b' }}>Ready</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p className="badge badge-long">NSE</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-card" style={{ marginTop: '1.5rem' }}>
            <h3 className="stat-label"><Database size={16} style={{ marginBottom: '-3px', marginRight: '8px' }} /> System Logs</h3>
            <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontFamily: 'monospace', maxHeight: '180px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {data.logs?.map((log, i) => (
                <p key={i} style={{ borderLeft: '2px solid var(--primary)', paddingLeft: '8px', background: 'rgba(255,255,255,0.02)' }}>{log}</p>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
