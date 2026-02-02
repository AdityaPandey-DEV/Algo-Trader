#!/usr/bin/env python3
"""
TVDatafeed Data Exporter for AG Trader - Extended Version
Fetches NSE 5-minute intraday data for 20 symbols, 10,000 bars each
"""

import json
import os
from datetime import datetime
from pathlib import Path

try:
    from tvDatafeed import TvDatafeed, Interval
except ImportError:
    print("Installing tvdatafeed...")
    os.system("pip install git+https://github.com/rongardF/tvdatafeed.git")
    from tvDatafeed import TvDatafeed, Interval

# Extended list of liquid NSE stocks (20 symbols)
SYMBOLS = [
    # Original 10
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
    "SBIN", "BHARTIARTL", "ITC", "LT", "AXISBANK",
    # Additional 10 - High liquidity
    "KOTAKBANK", "WIPRO", "MARUTI", "TITAN", "SUNPHARMA",
    "BAJFINANCE", "NESTLEIND", "TATASTEEL", "POWERGRID", "ADANIENT"
]

# Output directory
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "tv_data"
BARS_PER_SYMBOL = 20000  # 20K bars = ~260 trading days of 5-min data (covers 2024+2025)


def fetch_symbol_data(tv: TvDatafeed, symbol: str, bars: int = BARS_PER_SYMBOL) -> list:
    """Fetch 5-minute data for a symbol from TradingView"""
    try:
        print(f"Fetching {symbol} ({bars} bars)...")
        df = tv.get_hist(
            symbol=symbol,
            exchange="NSE",
            interval=Interval.in_5_minute,
            n_bars=bars
        )
        
        if df is None or df.empty:
            print(f"  No data for {symbol}")
            return []
        
        # Convert to list of candles
        candles = []
        for idx, row in df.iterrows():
            candles.append({
                "symbol": symbol,
                "timestamp": idx.isoformat(),
                "open": round(row["open"], 2),
                "high": round(row["high"], 2),
                "low": round(row["low"], 2),
                "close": round(row["close"], 2),
                "volume": int(row["volume"])
            })
        
        print(f"  Got {len(candles)} candles for {symbol}")
        return candles
        
    except Exception as e:
        print(f"  Error fetching {symbol}: {e}")
        return []


def group_by_day(candles: list) -> dict:
    """Group candles by trading day"""
    days = {}
    for candle in candles:
        dt = datetime.fromisoformat(candle["timestamp"])
        day_key = dt.strftime("%Y-%m-%d")
        
        if day_key not in days:
            days[day_key] = []
        days[day_key].append(candle)
    
    return days


def main():
    """Main function to fetch and export extended data"""
    print("=" * 60)
    print("TVDatafeed NSE Data Exporter - EXTENDED")
    print(f"Symbols: {len(SYMBOLS)}")
    print(f"Bars per symbol: {BARS_PER_SYMBOL}")
    print("=" * 60)
    
    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # Initialize TVDatafeed
    tv = TvDatafeed()
    
    all_data = {}
    summary = {
        "fetched_at": datetime.now().isoformat(),
        "symbols": {},
        "total_candles": 0,
        "total_days": 0
    }
    
    for symbol in SYMBOLS:
        candles = fetch_symbol_data(tv, symbol)
        
        if candles:
            days = group_by_day(candles)
            all_data[symbol] = days
            
            summary["symbols"][symbol] = {
                "total_candles": len(candles),
                "days": len(days),
                "date_range": f"{min(days.keys())} to {max(days.keys())}"
            }
            summary["total_candles"] += len(candles)
            summary["total_days"] += len(days)
            
            # Save individual symbol file
            symbol_file = OUTPUT_DIR / f"{symbol}.json"
            with open(symbol_file, "w") as f:
                json.dump({"symbol": symbol, "days": days}, f, indent=2)
            print(f"  Saved to {symbol_file}")
    
    # Save combined data file
    combined_file = OUTPUT_DIR / "all_symbols.json"
    with open(combined_file, "w") as f:
        json.dump(all_data, f)
    print(f"\nSaved combined data to {combined_file}")
    
    # Save summary
    summary_file = OUTPUT_DIR / "summary.json"
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2)
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Symbols fetched: {len(summary['symbols'])}")
    print(f"Total candles: {summary['total_candles']:,}")
    print(f"Total trading days: {summary['total_days']}")
    print(f"Output directory: {OUTPUT_DIR}")
    
    return summary


if __name__ == "__main__":
    main()
