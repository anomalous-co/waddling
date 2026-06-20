import { redirect } from 'next/navigation';

// "endpoint" → "data lake" rename: redirect the old detail path, preserving id.
export default async function EndpointDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/datalakes/${id}`);
}
