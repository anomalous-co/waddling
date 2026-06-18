import type { Metadata } from 'next';
import { CustomersContent } from './customers-content';

export const metadata: Metadata = {
  title: 'Who waddling is for — waddling',
  description:
    'The agents (and the people behind them) waddling keeps in line: engineers, analysts, model wranglers — and the rogue agent you are guarding against.',
};

export default function CustomersPage() {
  return <CustomersContent />;
}
