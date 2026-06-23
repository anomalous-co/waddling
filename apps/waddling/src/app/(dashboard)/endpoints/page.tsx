import { redirect } from 'next/navigation';

// The user-facing concept "endpoint" was renamed to "data lake". Keep old
// bookmarked/external links working by redirecting to the new path.
export default function EndpointsRedirect() {
  redirect('/datalakes');
}
