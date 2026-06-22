'use client';

/**
 * A next/link that fires a `signup_cta_clicked` funnel event on click.
 *
 * forwardRef + prop spread so it composes with Radix Slot (`<Button asChild>`):
 * Slot clones its child and injects className/onClick, which we forward onto the
 * underlying Link and compose with our capture. Use it anywhere a signup-intent
 * CTA links out — directly as a styled link (pricing cards) or as the asChild
 * child of a Button (landing CTAs).
 */
import Link from 'next/link';
import { forwardRef, type ComponentProps, type MouseEvent } from 'react';
import { useFunnel } from '@/lib/funnel';

type TrackedLinkProps = ComponentProps<typeof Link> & {
  /** Where the CTA lives, e.g. 'landing_footer', 'pricing'. */
  location: string;
  /** The visible CTA label, e.g. 'start free'. */
  text: string;
  /** Plan key for pricing CTAs. */
  plan?: string;
};

export const TrackedLink = forwardRef<HTMLAnchorElement, TrackedLinkProps>(
  function TrackedLink({ location, text, plan, onClick, ...props }, ref) {
    const { signupCtaClicked } = useFunnel();
    return (
      <Link
        ref={ref}
        {...props}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          signupCtaClicked({ cta_location: location, cta_text: text, ...(plan ? { plan } : {}) });
          onClick?.(e);
        }}
      />
    );
  },
);
