'use client';

import { DuckField } from '@/components/duck-field/duck-field';
import { cubeLattice } from '@/components/duck-field/layouts';

interface DuckSceneProps {
  className?: string;
}

// The /memory hero: a 5×5×5 duck lattice rendered through the ASCII/dither engine.
// All the machinery now lives in components/duck-field; this is just the layout.
export function DuckScene({ className }: DuckSceneProps) {
  return <DuckField spec={cubeLattice()} className={className} />;
}
