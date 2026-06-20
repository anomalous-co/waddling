'use client';

import { DuckField } from '@/components/duck-field/duck-field';
import { singleDuck } from '@/components/duck-field/layouts';

interface Props { className?: string; }

// The /memory mobile hero: a single duck through the ASCII/dither engine. Routing
// through the shared engine also gives mobile the UTF-8 glyph atlas and theme-aware
// coloring that this component used to lack with its own inlined shader.
export function SingleDuckScene({ className }: Props) {
  return <DuckField spec={singleDuck()} className={className} />;
}
