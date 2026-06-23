import { redirect } from 'next/navigation';

// Account settings moved into the unified settings page as the "Account" tab.
export default function AccountPage() {
  redirect('/settings?tab=account');
}
