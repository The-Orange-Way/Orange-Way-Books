export interface MockWallet {
  id: string;
  name: string;
  balance: number;
  asset: 'BTC' | 'USD';
  usdValue: number;
}

export interface MockTransaction {
  id: string;
  date: string;
  wallet: string;
  type: 'Buy' | 'Sell' | 'Receive' | 'Send' | 'Transfer';
  asset: string;
  amount: number;
  usdValue: number;
}

export interface MockFinancials {
  totalSats: number;
  totalFiat: number;
  totalRevenue: number;
  totalExpenses: number;
  currentAssets: { sats: number; usd: number };
  currentLiabilities: { sats: number; usd: number };
}

export const mockWallets: MockWallet[] = [
  { id: 'w1', name: '[Encrypted]', balance: 1.452, asset: 'BTC', usdValue: 97840 },
  { id: 'w2', name: '[Encrypted]', balance: 0.085, asset: 'BTC', usdValue: 5729 },
  { id: 'w3', name: '[Encrypted]', balance: 24500, asset: 'USD', usdValue: 24500 },
  { id: 'w4', name: '[Encrypted]', balance: 0.25, asset: 'BTC', usdValue: 16850 },
];

export const mockTransactions: MockTransaction[] = [
  { id: 't1', date: '2026-04-12', wallet: '[Encrypted]', type: 'Buy', asset: 'BTC', amount: 0.05, usdValue: 3370 },
  { id: 't2', date: '2026-04-11', wallet: '[Encrypted]', type: 'Receive', asset: 'BTC', amount: 0.12, usdValue: 8088 },
  { id: 't3', date: '2026-04-10', wallet: '[Encrypted]', type: 'Transfer', asset: 'USD', amount: 5000, usdValue: 5000 },
  { id: 't4', date: '2026-04-09', wallet: '[Encrypted]', type: 'Sell', asset: 'BTC', amount: 0.03, usdValue: 2022 },
  { id: 't5', date: '2026-04-08', wallet: '[Encrypted]', type: 'Send', asset: 'BTC', amount: 0.015, usdValue: 1011 },
  { id: 't6', date: '2026-04-07', wallet: '[Encrypted]', type: 'Buy', asset: 'BTC', amount: 0.1, usdValue: 6740 },
  { id: 't7', date: '2026-04-06', wallet: '[Encrypted]', type: 'Receive', asset: 'BTC', amount: 0.5, usdValue: 33700 },
  { id: 't8', date: '2026-04-05', wallet: '[Encrypted]', type: 'Transfer', asset: 'USD', amount: 12000, usdValue: 12000 },
  { id: 't9', date: '2026-04-04', wallet: '[Encrypted]', type: 'Sell', asset: 'BTC', amount: 0.08, usdValue: 5392 },
  { id: 't10', date: '2026-04-03', wallet: '[Encrypted]', type: 'Buy', asset: 'BTC', amount: 0.2, usdValue: 13480 },
];

export const mockFinancials: MockFinancials = {
  totalSats: 145230000,
  totalFiat: 97840,
  totalRevenue: 52300,
  totalExpenses: 18750,
  currentAssets: { sats: 178200000, usd: 120069 },
  currentLiabilities: { sats: 32970000, usd: 22229 },
};
