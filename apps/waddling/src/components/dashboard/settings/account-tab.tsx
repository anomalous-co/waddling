'use client';

/**
 * Account settings — extracted from the former /dashboard/account page so it can render
 * as the "Account" tab of the unified settings page. Self-loads the session user.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { cpUrl } from '@/lib/control-api';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

interface SessionUser {
  id: string;
  name?: string | null;
  email: string;
  image?: string | null;
}

function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

function ProfileCard({ user }: { user: SessionUser }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(user.name ?? '');
  const [image, setImage] = useState(user.image ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const dirty = name.trim() !== (user.name ?? '');
  const initial = (user.name || user.email).charAt(0).toUpperCase();

  const saveName = async () => {
    setSaving(true);
    const { error } = await authClient.updateUser({ name: name.trim() });
    setSaving(false);
    if (error) {
      toast.error(error.message ?? 'Could not update profile');
      return;
    }
    toast.success('Profile updated');
    router.refresh();
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Choose an image file');
      return;
    }
    if (file.size > 1_000_000) {
      toast.error('Image must be under 1 MB');
      return;
    }
    void uploadAvatar(file);
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    let url: string;
    try {
      const res = await fetch(cpUrl('/api/cp/account/avatar'), {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? 'Upload failed');
      url = body.url;
    } catch (err) {
      setUploading(false);
      toast.error(err instanceof Error ? err.message : 'Upload failed');
      return;
    }
    const { error } = await authClient.updateUser({ image: url });
    setUploading(false);
    if (error) {
      toast.error(error.message ?? 'Could not save avatar');
      return;
    }
    setImage(url);
    toast.success('Avatar updated');
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your display name and avatar across the dashboard.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 pb-6">
          <Avatar className="size-16">
            {image ? <AvatarImage src={image} alt={name} /> : null}
            <AvatarFallback className="text-lg">{initial}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Upload data-icon="inline-start" />
              )}
              Upload new avatar
            </Button>
            <p className="text-xs text-muted-foreground">PNG, JPG or GIF, up to 1&nbsp;MB.</p>
          </div>
        </div>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Display name</FieldLabel>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
            <FieldDescription>{user.email}</FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={() => void saveName()} disabled={!dirty || saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
          Save changes
        </Button>
      </CardFooter>
    </Card>
  );
}

function EmailCard({ user }: { user: SessionUser }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>The address you sign in with.</CardDescription>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel htmlFor="email">Email address</FieldLabel>
          <Input id="email" value={user.email} readOnly disabled />
          <FieldDescription>
            Changing your sign-in email requires verification — contact support to update it.
          </FieldDescription>
        </Field>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !saving;

  const change = async () => {
    setSaving(true);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message ?? 'Could not change password');
      return;
    }
    toast.success('Password changed — other sessions signed out');
    setCurrent('');
    setNext('');
    setConfirm('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Change your password. This signs out your other sessions.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="current">Current password</FieldLabel>
            <Input
              id="current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="next">New password</FieldLabel>
            <Input
              id="next"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <FieldDescription>At least 8 characters.</FieldDescription>
          </Field>
          <Field data-invalid={mismatch ? true : undefined}>
            <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={mismatch || undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch ? (
              <FieldDescription className="text-destructive">Passwords don’t match.</FieldDescription>
            ) : null}
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={() => void change()} disabled={!canSubmit}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
          Change password
        </Button>
      </CardFooter>
    </Card>
  );
}

export function AccountTab() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void authClient.getSession().then((res) => {
      if (cancelled) return;
      const u = res.data?.user as SessionUser | undefined;
      setUser(u ?? null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <AccountSkeleton />;
  if (!user) return null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <ProfileCard user={user} />
      <EmailCard user={user} />
      <PasswordCard />
    </div>
  );
}
