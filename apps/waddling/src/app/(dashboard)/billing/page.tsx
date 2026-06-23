import { redirect } from 'next/navigation';

// Billing moved into the unified settings page as the "Billing" tab.
export default function BillingPage() {
  redirect('/settings?tab=billing');
}
