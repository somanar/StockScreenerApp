alter table stock_signals
  add column if not exists market text,
  add column if not exists symbol text,
  add column if not exists ticker text,
  add column if not exists name text,
  add column if not exists exchange text,
  add column if not exists sector text,
  add column if not exists price numeric,
  add column if not exists pre_market_price numeric,
  add column if not exists post_market_price numeric,
  add column if not exists change_amount numeric,
  add column if not exists change_percent numeric,
  add column if not exists pre_market_change_percent numeric,
  add column if not exists post_market_change_percent numeric,
  add column if not exists volume numeric,
  add column if not exists signal_rank integer,
  add column if not exists source text,
  add column if not exists scanned_at timestamptz,
  add column if not exists raw jsonb;

alter table stock_signals
  drop constraint if exists stock_signals_ticker_key;

drop index if exists stock_signals_ticker_key;

create index if not exists stock_signals_market_scanned_at_idx
  on stock_signals (market, scanned_at desc);

create index if not exists stock_signals_symbol_scanned_at_idx
  on stock_signals (symbol, scanned_at desc);

create index if not exists stock_signals_market_sector_scanned_at_idx
  on stock_signals (market, sector, scanned_at desc);

create unique index if not exists stock_signals_market_ticker_key
  on stock_signals (market, ticker);
