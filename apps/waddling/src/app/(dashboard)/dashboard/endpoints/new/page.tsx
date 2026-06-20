import { redirect } from 'next/navigation';

// "endpoint" → "data lake" rename: redirect the old create path.
export default function NewEndpointRedirect() {
  redirect('/dashboard/datalakes/new');
}
